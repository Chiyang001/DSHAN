import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

export const MAX_BYTES = 16 * 1024 * 1024;
export const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const SHORT_CODE_LENGTH = 8;
export const SHORT_CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
const SHORT_PAIR_TTL_MS = 120_000;

export function endpoint(value, allowHttp = false) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || !['ws:', 'wss:'].includes(url.protocol)) throw new Error('Invalid signaling URL');
  if (!allowHttp && url.protocol !== 'wss:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Public signaling requires wss://; for an explicitly configured HTTP FRP entrance, enable allow_http_signaling');
  return url.href;
}

export function createPair(server, allowHttp = false) {
  return { v: 1, server: endpoint(server, allowHttp), room: randomBytes(16).toString('hex'), secret: randomBytes(32).toString('base64url') };
}

export function isShortCode(value) {
  return typeof value === 'string' && SHORT_CODE_RE.test(value.trim().toUpperCase());
}

export function normalizeShortCode(value) {
  const code = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!SHORT_CODE_RE.test(code)) throw new Error('配对码无效');
  return code;
}

export function generateShortCode() {
  let code = '';
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) code += SHORT_CODE_ALPHABET[randomBytes(1)[0] % SHORT_CODE_ALPHABET.length];
  return code;
}

export function signalingHttpBase(signalingUrl) {
  const url = new URL(signalingUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

function validatePairObject(pair, allowHttp = false) {
  if (pair.v !== 1 || !/^[a-f0-9]{32}$/.test(pair.room) || !/^[A-Za-z0-9_-]{43}$/.test(pair.secret)) throw new Error('Invalid pairing code');
  if (pair.mode !== undefined && !['auto', 'relay', 'p2p'].includes(pair.mode)) throw new Error('Invalid connection mode');
  if (pair.signalingAddress !== undefined && !isIP(pair.signalingAddress)) throw new Error('Invalid signaling address');
  pair.server = endpoint(pair.server, allowHttp);
  return pair;
}

export function encodePair(pair) { return 'dsh-peer:' + Buffer.from(JSON.stringify(pair)).toString('base64url'); }

export function decodePair(code, allowHttp = false) {
  if (typeof code !== 'string' || !code.startsWith('dsh-peer:') || code.length > 4096) throw new Error('Invalid pairing code');
  return validatePairObject(JSON.parse(Buffer.from(code.slice(9), 'base64url').toString()), allowHttp);
}

async function pairingRequest(url, options, address) {
  try {
    if (!address) return await fetch(url, options);
    if (!isIP(address)) throw new Error('Invalid signaling address');
    return await new Promise((resolve, reject) => {
      const target = new URL(url);
      const request = (target.protocol === 'https:' ? https : http).request(target, {
        method: options.method || 'GET',
        headers: { ...options.headers, ...(options.body !== undefined ? { 'content-length': Buffer.byteLength(options.body) } : {}) },
        signal: options.signal,
        lookup: (_hostname, settings, callback) => {
          const result = { address, family: isIP(address) };
          if (settings.all) callback(null, [result]); else callback(null, result.address, result.family);
        },
      }, response => {
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 65536) { response.destroy(new Error('Pairing response too large')); return; }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => resolve({
          status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
          json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }));
      });
      request.on('error', reject);
      request.setTimeout(15000, () => request.destroy(Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' })));
      request.end(options.body);
    });
  } catch (error) {
    const detail = error.cause || error;
    const timedOut = options.signal?.reason?.name === 'TimeoutError' || error.name === 'TimeoutError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(detail.code);
    const reason = timedOut ? '请求超时' : detail.code === 'ECONNRESET' ? '连接被重置' : error.name === 'AbortError' || detail.code === 'ABORT_ERR' ? '请求已取消' : detail.code || error.name;
    throw new Error(`无法访问配对服务器 ${new URL(url).host}（${reason}），请检查网络和服务器入口。`, { cause: error });
  }
}

export async function registerShortPair(pair, signal) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateShortCode();
    const response = await pairingRequest(`${signalingHttpBase(pair.server)}/pair/${code}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pair),
      signal,
    }, pair.signalingAddress);
    if (response.status === 409) continue;
    if (!response.ok) throw new Error(`无法注册配对码（HTTP ${response.status}），请检查服务器配对接口与 FRP 转发配置。`);
    return code;
  }
  throw new Error('无法生成配对码，请稍后重试');
}

export async function lookupShortPair(code, signalingUrl, allowHttp = true, signal, signalingAddress) {
  const normalized = normalizeShortCode(code);
  const response = await pairingRequest(`${signalingHttpBase(signalingUrl)}/pair/${normalized}`, { signal }, signalingAddress);
  if (response.status === 404) throw new Error('配对码无效或已过期');
  if (!response.ok) throw new Error(`无法查询配对码（HTTP ${response.status}），请检查服务器配对接口。`);
  return validatePairObject(await response.json(), allowHttp);
}

export async function resolvePair(code, options = {}) {
  const value = code.trim();
  const allowHttp = options.allowHttp !== false;
  const signal = options.signal;
  if (isShortCode(value)) {
    if (!options.signalingUrl) throw new Error('未配置配对服务器');
    return lookupShortPair(value, options.signalingUrl, allowHttp, signal, options.signalingAddress);
  }
  if (value.startsWith('dsh-peer:')) return decodePair(value, allowHttp);
  throw new Error('配对码无效');
}

export { SHORT_PAIR_TTL_MS };

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
