import { RTCPeerConnection } from 'werift';
import WebSocket from 'ws';
import { randomUUID, randomBytes } from 'node:crypto';
import { ChannelWire, mac, sign, verify } from './protocol.js';
import { guardDuplicateHelloVerify } from './dtls-compat.js';
import { RelayWire } from './relay.js';
import { isIP } from 'node:net';

export class Peer {
  constructor({ pair, role, iceServers = [], hostAddresses, relayOnly = false, dispatch, timeout = 120_000, fallbackDelay = 8000 }) {
    this.pair = pair; this.role = role; this.dispatch = dispatch; this.timeout = timeout;
    this.state = 'connecting'; this.pending = new Map(); this.running = new Map(); this.seen = new Set();
    this.sequence = 0; this.inSequence = 0; this.signalQueue = Promise.resolve();
    this.diagnostics = {};
    this.mode = pair.mode ?? 'auto'; this.relayOnly = relayOnly;
    this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: relayOnly ? 'relay' : 'all',
      // Android restricts native interface enumeration. Use Android's active
      // network addresses instead of Node's os.networkInterfaces() there.
      ...(hostAddresses ? { iceUseIpv4: false, iceUseIpv6: false, iceAdditionalHostAddresses: hostAddresses } : {}),
    });
    const record = () => {
      this.diagnostics.connectionState = this.pc.connectionState;
      this.diagnostics.iceState = this.pc.iceConnectionState;
      this.diagnostics.localCandidates = (this.pc.localDescription?.sdp.match(/^a=candidate:/gm) ?? []).length;
      this.diagnostics.remoteCandidates = (this.pc.remoteDescription?.sdp.match(/^a=candidate:/gm) ?? []).length;
    };
    this.pc.oniceconnectionstatechange = record;
    this.pc.onconnectionstatechange = () => {
      record();
      if (this.usingRelay || this.relaySession) return;
      if (this.pc.connectionState === 'failed' && this.relaySupported && this.mode === 'auto' && !relayOnly && this.state !== 'connected') {
        if (role === 'host') this.beginRelay();
        return;
      }
      if (['failed', 'closed'].includes(this.pc.connectionState)) void this.close(`Peer connection ${this.pc.connectionState} (ICE ${this.pc.iceConnectionState}); action outcome may be unknown`);
    };
    this.pc.ondatachannel = ({ channel }) => this.attach(channel);
    if (role === 'host') this.attach(this.pc.createDataChannel('dsh-peer-v1', { ordered: true }));
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // An idle host need not await pairing; avoid an unhandled rejection.
    this.ready.catch(() => {});
    this.connectTimer = setTimeout(() => void this.close('Pair timed out'), timeout);
    const websocketOptions = { maxPayload: 128 * 1024, handshakeTimeout: 20_000 };
    if (pair.signalingAddress) {
      // Keep HTTP Host and TLS SNI/certificate validation on the configured
      // domain; only the socket destination is pinned to the user's FRP server.
      websocketOptions.lookup = (_hostname, options, callback) => {
        const address = { address: pair.signalingAddress, family: isIP(pair.signalingAddress) };
        if (options.all) callback(null, [address]); else callback(null, address.address, address.family);
      };
    }
    this.ws = new WebSocket(pair.server, websocketOptions);
    this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'join', room: pair.room, role, access: mac(pair.secret, 'join:' + pair.room) })));
    this.ws.on('error', error => { this.diagnostics.signalingError = error.message; void this.close('Signaling connection failed: ' + error.message); });
    this.ws.on('close', (code, reason) => { if ((this.usingRelay || this.state !== 'connected') && this.state !== 'closed') void this.close(`Signaling disconnected (${code}: ${reason.toString()})`); });
    this.ws.on('message', data => {
      // Relay RPC must not queue behind an in-progress tool or ICE operation.
      let message;
      try { message = JSON.parse(data.toString()); } catch { void this.close('Invalid signaling message'); return; }
      if (message.type === 'relay-data') {
        this.signalQueue = this.signalQueue.then(() => {
          if (this.state === 'closed') return;
          if (!this.usingRelay) throw new Error('Unexpected relay data');
          this.wire.accept(message);
        }).catch(error => this.close(error.message));
        return;
      }
      this.signalQueue = this.signalQueue.then(async () => {
        if (this.state === 'closed') return;
        if (message.type === 'ready') {
          this.relaySupported = message.relay === true;
          if (this.mode === 'relay' && !this.relaySupported) throw new Error('Signaling server does not support encrypted relay; update the server');
          if (role !== 'host') return;
          if (this.mode === 'relay') { this.beginRelay(); return; }
          if (this.relaySupported && this.mode === 'auto' && !relayOnly) this.fallbackTimer = setTimeout(() => this.beginRelay(), fallbackDelay);
          try {
            const offer = await this.pc.createOffer(); this.watchDtls();
            await this.pc.setLocalDescription(offer);
            this.signal({ type: 'offer', sdp: this.pc.localDescription.sdp });
          } catch (error) { this.transportUnavailable(error); }
        } else if (message.type === 'signal') {
          const body = verify(pair, role === 'host' ? 'guest' : 'host', this.inSequence++, message);
          if (body.type === 'relay') {
            if (role !== 'guest' || this.mode === 'p2p' || relayOnly || !this.relaySupported || !/^[a-f0-9]{32}$/.test(body.session)) throw new Error('Invalid relay negotiation');
            this.relaySession = body.session;
            this.signal({ type: 'relay-ack', session: body.session });
            this.activateRelay(); return;
          }
          if (body.type === 'relay-ack') {
            if (role !== 'host' || !this.relaySession || body.session !== this.relaySession) throw new Error('Invalid relay acknowledgement');
            this.activateRelay(); return;
          }
          if (this.usingRelay || this.relaySession) return;
          if (body.type !== (role === 'host' ? 'answer' : 'offer') || typeof body.sdp !== 'string') throw new Error('Unexpected peer description');
          try {
            await this.pc.setRemoteDescription(body);
            this.watchDtls();
            if (role === 'guest') {
              await this.pc.setLocalDescription(await this.pc.createAnswer());
              this.signal({ type: 'answer', sdp: this.pc.localDescription.sdp });
            }
          } catch (error) { this.transportUnavailable(error); }
        }
      }).catch(error => this.close(error.message));
    });
  }
  transportUnavailable(error) {
    this.diagnostics.webrtcError = error.message;
    if (this.usingRelay || this.relaySession || this.state === 'closed') return;
    if (this.relaySupported && this.mode === 'auto' && !this.relayOnly && this.state !== 'connected') {
      if (this.role === 'host') this.beginRelay();
      return;
    }
    throw error;
  }
  beginRelay() {
    if (this.state === 'closed' || this.state === 'connected' || this.relaySession || !this.relaySupported) return;
    this.relaySession = randomBytes(16).toString('hex');
    try { this.signal({ type: 'relay', session: this.relaySession }); }
    catch (error) { void this.close(error.message); }
  }
  activateRelay() {
    if (this.pending.size || this.running.size) { void this.close('Transport changed during a call; action outcome may be unknown'); return; }
    this.usingRelay = true; clearTimeout(this.fallbackTimer);
    this.diagnostics.relayReason = this.mode === 'relay' ? 'Encrypted relay requested' : 'P2P unavailable; encrypted relay selected';
    this.wire?.close();
    this.wire = new RelayWire(this.ws, this.pair, this.role, this.relaySession,
      message => this.receive(message), error => void this.close(error.message));
    this.state = 'connected'; clearTimeout(this.connectTimer); this.resolveReady();
    void this.pc.close().catch(() => {});
  }
  signal(body) {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('Signaling disconnected');
    this.ws.send(JSON.stringify({ type: 'signal', ...sign(this.pair, this.role, this.sequence++, body) }));
  }
  watchDtls() {
    for (const transport of this.pc.dtlsTransports) {
      if (transport.peerDiagnostic) continue;
      transport.peerDiagnostic = true;
      const start = transport.start.bind(transport);
      transport.start = async () => {
        try {
          const operation = start();
          guardDuplicateHelloVerify(transport.dtls);
          return await operation;
        }
        catch (error) { this.diagnostics.dtlsError = error.message || error.name || 'DTLS handshake failed'; throw error; }
      };
    }
  }
  attach(channel) {
    if (this.usingRelay || this.relaySession || this.state === 'closed') { channel.close(); return; }
    if (this.channel || channel.label !== 'dsh-peer-v1') { channel.close(); return; }
    this.channel = channel;
    this.wire = new ChannelWire(channel, message => this.receive(message), error => void this.close(error.message));
    channel.onopen = () => {
      if (this.usingRelay || this.relaySession) return;
      if (this.state === 'closed') { channel.close(); return; }
      clearTimeout(this.connectTimer); clearTimeout(this.fallbackTimer); this.state = 'connected'; this.resolveReady();
    };
    channel.onclose = () => { if (!this.usingRelay && !this.relaySession) void this.close('Peer disconnected; action outcome may be unknown'); };
    channel.onerror = () => { if (!this.usingRelay && !this.relaySession) void this.close('Data channel failed; action outcome may be unknown'); };
  }
  async request(method, args, signal) {
    signal?.throwIfAborted();
    if (this.state !== 'connected') throw new Error('Peer is not connected');
    if (this.pending.size >= 16) throw new Error('Too many peer requests');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id); clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        this.wire.send({ type: 'cancel', id }).catch(() => {});
        reject(new Error('Remote call canceled or timed out; action outcome may be unknown. Inspect before retrying.'));
      };
      const timer = setTimeout(cancel, this.timeout);
      this.pending.set(id, { resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); } });
      signal?.addEventListener('abort', cancel, { once: true });
      this.wire.send({ type: 'request', id, method, args }).catch(error => {
        const entry = this.pending.get(id);
        if (entry) { entry.cleanup(); this.pending.delete(id); reject(error); }
      });
    });
  }
  async receive(message) {
    if (!message || typeof message.id !== 'string' || message.id.length > 80) throw new Error('Invalid RPC');
    if (message.type === 'response') {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id); entry.cleanup();
      if (typeof message.error === 'string') entry.reject(new Error(message.error)); else entry.resolve(message.result);
    } else if (message.type === 'cancel') {
      this.running.get(message.id)?.abort();
    } else if (message.type === 'request') {
      if (this.seen.has(message.id)) throw new Error('Repeated request rejected');
      if (this.running.size >= 16 || this.seen.size >= 10000) throw new Error('Peer request limit; reconnect');
      this.seen.add(message.id);
      const controller = new AbortController(); this.running.set(message.id, controller);
      const timer = setTimeout(() => controller.abort(), this.timeout);
      let response;
      try { response = { type: 'response', id: message.id, result: await this.dispatch(message.method, message.args, controller.signal) }; }
      catch (error) { response = { type: 'response', id: message.id, error: error.message || 'Remote tool failed' }; }
      finally { clearTimeout(timer); this.running.delete(message.id); }
      await this.wire.send(response);
    } else throw new Error('Unknown RPC message');
  }
  close(reason = 'Peer disconnected') {
    if (this.closing) return this.closing;
    this.state = 'closed'; this.error = reason; clearTimeout(this.connectTimer); clearTimeout(this.fallbackTimer); this.rejectReady(new Error(reason));
    for (const entry of this.pending.values()) { entry.cleanup(); entry.reject(new Error(reason + '; remote action outcome may be unknown. Inspect before retrying.')); }
    this.pending.clear(); for (const controller of this.running.values()) controller.abort();
    this.wire?.close(); this.ws?.terminate();
    this.closing = this.pc.close().catch(() => {});
    return this.closing;
  }
  status() { return { state: this.state, transport: this.usingRelay ? 'FRP/WebSocket relay (AES-256-GCM)' : 'WebRTC ICE/DTLS/SCTP', relayOnly: this.relayOnly, diagnostics: this.diagnostics, error: this.error ?? null }; }
}
