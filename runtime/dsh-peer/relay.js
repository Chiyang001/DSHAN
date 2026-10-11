import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
import { MAX_BYTES } from './protocol.js';

// The relay never receives the pairing secret or plaintext. Separate directional
// keys and monotonic nonces prevent reflection/replay and AES-GCM nonce reuse.
export class RelayWire {
  constructor(ws, pair, role, session, receive, fail) {
    this.ws = ws; this.receive = receive; this.fail = fail;
    this.sent = 0n; this.received = 0n; this.parts = []; this.bytes = 0;
    this.closed = false; this.queue = Promise.resolve();
    const key = direction => Buffer.from(hkdfSync('sha256', Buffer.from(pair.secret, 'base64url'),
      Buffer.from(pair.room + session), Buffer.from('dsh-peer-relay-v1:' + direction), 32));
    this.sendKey = key(role); this.receiveKey = key(role === 'host' ? 'guest' : 'host');
  }
  nonce(sequence) { const nonce = Buffer.alloc(12); nonce.writeBigUInt64BE(sequence, 4); return nonce; }
  accept(frame) {
    try {
      if (this.closed || frame.seq !== this.received.toString() || typeof frame.data !== 'string'
          || frame.data.length > 48000 || typeof frame.tag !== 'string' || !/^[a-f0-9]{32}$/.test(frame.tag)
          || typeof frame.end !== 'boolean') throw new Error('Invalid or replayed relay frame');
      const decipher = createDecipheriv('aes-256-gcm', this.receiveKey, this.nonce(this.received));
      decipher.setAAD(Buffer.from(frame.end ? 'end' : 'part'));
      decipher.setAuthTag(Buffer.from(frame.tag, 'hex'));
      const bytes = Buffer.concat([decipher.update(Buffer.from(frame.data, 'base64')), decipher.final()]);
      this.received++; this.bytes += bytes.length;
      if (this.bytes > MAX_BYTES) throw new Error('Peer message exceeds 16 MiB');
      this.parts.push(bytes);
      if (frame.end) {
        const value = JSON.parse(Buffer.concat(this.parts).toString());
        this.parts = []; this.bytes = 0;
        Promise.resolve(this.receive(value)).catch(this.fail);
      }
    } catch (error) { this.fail(error); }
  }
  send(value) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > MAX_BYTES) return Promise.reject(new Error('Peer message exceeds 16 MiB'));
    const operation = async () => {
      for (let at = 0; at < bytes.length; at += 32768) {
        if (this.closed || this.ws.readyState !== 1) throw new Error('Relay disconnected');
        const end = at + 32768 >= bytes.length;
        const cipher = createCipheriv('aes-256-gcm', this.sendKey, this.nonce(this.sent));
        cipher.setAAD(Buffer.from(end ? 'end' : 'part'));
        const data = Buffer.concat([cipher.update(bytes.subarray(at, at + 32768)), cipher.final()]);
        const frame = { type: 'relay-data', seq: (this.sent++).toString(), end,
          data: data.toString('base64'), tag: cipher.getAuthTag().toString('hex') };
        await new Promise((resolve, reject) => this.ws.send(JSON.stringify(frame), error => error ? reject(error) : resolve()));
      }
    };
    const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result;
  }
  close() { this.closed = true; this.parts = []; this.bytes = 0; this.sendKey.fill(0); this.receiveKey.fill(0); }
}
