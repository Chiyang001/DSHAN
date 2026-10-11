import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const MAX_BYTES = 16 * 1024 * 1024;
export function endpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || !['ws:', 'wss:'].includes(url.protocol)) throw new Error('Invalid signaling URL');
  if (url.protocol !== 'wss:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Public signaling requires wss://');
  return url.href;
}
export function createPair(server) {
  return { v: 1, server: endpoint(server), room: randomBytes(16).toString('hex'), secret: randomBytes(32).toString('base64url') };
}
export function encodePair(pair) { return 'dsh-peer:' + Buffer.from(JSON.stringify(pair)).toString('base64url'); }
export function decodePair(code) {
  if (typeof code !== 'string' || !code.startsWith('dsh-peer:') || code.length > 4096) throw new Error('Invalid pairing code');
  const pair = JSON.parse(Buffer.from(code.slice(9), 'base64url').toString());
  if (pair.v !== 1 || !/^[a-f0-9]{32}$/.test(pair.room) || !/^[A-Za-z0-9_-]{43}$/.test(pair.secret)) throw new Error('Invalid pairing code');
  pair.server = endpoint(pair.server);
  return pair;
}
export function mac(secret, value) { return createHmac('sha256', secret).update(value).digest('hex'); }
export function sign(pair, role, sequence, body) {
  const payload = JSON.stringify({ room: pair.room, role, sequence, body });
  return { payload, tag: mac(pair.secret, payload) };
}
export function verify(pair, role, sequence, message) {
  if (typeof message.payload !== 'string' || typeof message.tag !== 'string' || !/^[a-f0-9]{64}$/.test(message.tag)) throw new Error('Invalid signal');
  if (!timingSafeEqual(Buffer.from(mac(pair.secret, message.payload), 'hex'), Buffer.from(message.tag, 'hex'))) throw new Error('Pair authentication failed');
  const data = JSON.parse(message.payload);
  if (data.room !== pair.room || data.role !== role || data.sequence !== sequence) throw new Error('Signal replay or wrong peer');
  return data.body;
}

// Keep SCTP messages small; screenshots may be much larger than one message.
export class ChannelWire {
  constructor(channel, receive, fail) {
    this.channel = channel; this.receive = receive; this.fail = fail;
    this.parts = []; this.bytes = 0; this.queue = Promise.resolve(); this.closed = false;
    channel.onmessage = event => {
      try {
        const frame = JSON.parse(Buffer.isBuffer(event.data) ? event.data.toString() : event.data);
        if (typeof frame.data !== 'string' || frame.data.length > 16384 || typeof frame.end !== 'boolean') throw new Error('Invalid frame');
        const bytes = Buffer.from(frame.data, 'base64');
        this.bytes += bytes.length;
        if (this.bytes > MAX_BYTES) throw new Error('Peer message exceeds 16 MiB');
        this.parts.push(bytes);
        if (frame.end) {
          const value = JSON.parse(Buffer.concat(this.parts).toString());
          this.parts = []; this.bytes = 0;
          Promise.resolve(receive(value)).catch(fail);
        }
      } catch (error) { fail(error); }
    };
  }
  send(value) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > MAX_BYTES) return Promise.reject(new Error('Peer message exceeds 16 MiB'));
    const operation = async () => {
      for (let at = 0; at < bytes.length; at += 8192) {
        while (this.channel.bufferedAmount > 256 * 1024) {
          if (this.closed || this.channel.readyState !== 'open') throw new Error('Peer disconnected');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (this.closed || this.channel.readyState !== 'open') throw new Error('Peer disconnected');
        this.channel.send(JSON.stringify({ data: bytes.subarray(at, at + 8192).toString('base64'), end: at + 8192 >= bytes.length }));
      }
    };
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  close() { this.closed = true; this.parts = []; this.bytes = 0; }
}
