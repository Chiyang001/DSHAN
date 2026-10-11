import { RTCPeerConnection } from 'werift';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { ChannelWire, mac, sign, verify } from './protocol.js';

export class Peer {
  constructor({ pair, role, iceServers = [], hostAddresses, relayOnly = false, dispatch, timeout = 120_000 }) {
    this.pair = pair; this.role = role; this.dispatch = dispatch; this.timeout = timeout;
    this.state = 'connecting'; this.pending = new Map(); this.running = new Map(); this.seen = new Set();
    this.sequence = 0; this.inSequence = 0; this.signalQueue = Promise.resolve();
    this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: relayOnly ? 'relay' : 'all',
      // Android restricts native interface enumeration. Use Android's active
      // network addresses instead of Node's os.networkInterfaces() there.
      ...(hostAddresses ? { iceUseIpv4: false, iceUseIpv6: false, iceAdditionalHostAddresses: hostAddresses } : {}),
    });
    this.pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(this.pc.connectionState)) void this.close('Peer disconnected; action outcome may be unknown'); };
    this.pc.ondatachannel = ({ channel }) => this.attach(channel);
    if (role === 'host') this.attach(this.pc.createDataChannel('dsh-peer-v1', { ordered: true }));
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // An idle host need not await pairing; avoid an unhandled rejection.
    this.ready.catch(() => {});
    this.connectTimer = setTimeout(() => void this.close('Pair timed out'), timeout);
    this.ws = new WebSocket(pair.server, { maxPayload: 128 * 1024, handshakeTimeout: 10_000 });
    this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'join', room: pair.room, role, access: mac(pair.secret, 'join:' + pair.room) })));
    this.ws.on('error', () => void this.close('Signaling connection failed'));
    this.ws.on('close', () => { if (this.state !== 'connected' && this.state !== 'closed') void this.close('Pair rejected or signaling disconnected'); });
    this.ws.on('message', data => {
      this.signalQueue = this.signalQueue.then(async () => {
        if (this.state === 'closed') return;
        const message = JSON.parse(data.toString());
        if (message.type === 'ready' && role === 'host') {
          await this.pc.setLocalDescription(await this.pc.createOffer());
          this.signal({ type: 'offer', sdp: this.pc.localDescription.sdp });
        } else if (message.type === 'signal') {
          const body = verify(pair, role === 'host' ? 'guest' : 'host', this.inSequence++, message);
          if (body.type !== (role === 'host' ? 'answer' : 'offer') || typeof body.sdp !== 'string') throw new Error('Unexpected peer description');
          await this.pc.setRemoteDescription(body);
          if (role === 'guest') {
            await this.pc.setLocalDescription(await this.pc.createAnswer());
            this.signal({ type: 'answer', sdp: this.pc.localDescription.sdp });
          }
        }
      }).catch(error => this.close(error.message));
    });
  }
  signal(body) {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('Signaling disconnected');
    this.ws.send(JSON.stringify({ type: 'signal', ...sign(this.pair, this.role, this.sequence++, body) }));
  }
  attach(channel) {
    if (this.channel || channel.label !== 'dsh-peer-v1') { channel.close(); return; }
    this.channel = channel;
    this.wire = new ChannelWire(channel, message => this.receive(message), error => void this.close(error.message));
    channel.onopen = () => {
      if (this.state === 'closed') { channel.close(); return; }
      clearTimeout(this.connectTimer); this.state = 'connected'; this.resolveReady();
    };
    channel.onclose = () => void this.close('Peer disconnected; action outcome may be unknown');
    channel.onerror = () => void this.close('Data channel failed; action outcome may be unknown');
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
    this.state = 'closed'; this.error = reason; clearTimeout(this.connectTimer); this.rejectReady(new Error(reason));
    for (const entry of this.pending.values()) { entry.cleanup(); entry.reject(new Error(reason + '; remote action outcome may be unknown. Inspect before retrying.')); }
    this.pending.clear(); for (const controller of this.running.values()) controller.abort();
    this.wire?.close(); this.ws?.terminate();
    this.closing = this.pc.close().catch(() => {});
    return this.closing;
  }
  status() { return { state: this.state, transport: 'WebRTC ICE/DTLS/SCTP', relayOnly: this.pc.config?.iceTransportPolicy === 'relay', error: this.error ?? null }; }
}
