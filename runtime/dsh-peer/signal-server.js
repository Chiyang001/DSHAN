import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { SHORT_CODE_RE, SHORT_PAIR_TTL_MS } from './protocol.js';

function validatePair(pair) {
  return pair && pair.v === 1 && /^[a-f0-9]{32}$/.test(pair.room) && /^[A-Za-z0-9_-]{43}$/.test(pair.secret)
    && typeof pair.server === 'string' && pair.server.length <= 2048
    && (pair.mode === undefined || ['auto', 'relay', 'p2p'].includes(pair.mode));
}

export function createSignalServer({ port = 8787, host = '127.0.0.1', ttl = 10 * 60_000, maxRooms = 1000, shortPairTtl = SHORT_PAIR_TTL_MS } = {}) {
  const rooms = new Map();
  const shortPairs = new Map();
  const http = createServer((req, res) => {
    const headers = { 'X-DSH-Peer-Relay': '1', 'Cache-Control': 'no-store' };
    if (req.url === '/health') {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }
    const match = req.url?.match(/^\/pair\/([A-HJ-NP-Z2-9]{8})$/);
    if (!match) {
      res.writeHead(404, headers);
      res.end('Not found');
      return;
    }
    const code = match[1];
    if (req.method === 'GET') {
      const entry = shortPairs.get(code);
      if (!entry || Date.now() >= entry.expires) {
        res.writeHead(404, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(entry.pair));
      return;
    }
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', chunk => {
        chunks.push(chunk);
        if (chunks.reduce((sum, item) => sum + item.length, 0) > 8192) req.destroy();
      });
      req.on('end', () => {
        try {
          const pair = JSON.parse(Buffer.concat(chunks).toString());
          if (!validatePair(pair)) throw new Error('Invalid pair');
          const existing = shortPairs.get(code);
          if (existing && Date.now() < existing.expires) {
            res.writeHead(409, headers);
            res.end('{}');
            return;
          }
          shortPairs.set(code, { pair, expires: Date.now() + shortPairTtl });
          res.writeHead(204, headers);
          res.end();
        } catch {
          res.writeHead(400, headers);
          res.end('{}');
        }
      });
      return;
    }
    res.writeHead(405, headers);
    res.end('{}');
  });
  const wss = new WebSocketServer({ server: http, maxPayload: 128 * 1024, perMessageDeflate: false });
  wss.on('connection', ws => {
    let room, role, count = 0;
    let windowStart = Date.now(), windowBytes = 0;
    const joinTimer = setTimeout(() => ws.close(1008, 'Join timeout'), 5000);
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== 'relay-data' && ++count > 100) throw new Error('Signal limit');
        if (!room) {
          if (msg.type !== 'join' || !/^[a-f0-9]{32}$/.test(msg.room) || !/^[a-f0-9]{64}$/.test(msg.access) || !['host', 'guest'].includes(msg.role)) throw new Error('Invalid join');
          room = rooms.get(msg.room);
          if (!room) {
            if (rooms.size >= maxRooms) throw new Error('Room limit');
            room = { id: msg.room, access: msg.access, peers: {}, resumes: {}, nonces: {}, expires: Date.now() + ttl };
            rooms.set(msg.room, room);
          }
          if (room.access !== msg.access || room.revoked || (room.used && room.resumes[msg.role] !== msg.resume) || (room.used && !msg.resume) || Date.now() >= room.expires) throw new Error('Pair unavailable');
          if (msg.resume !== undefined && !/^[a-f0-9]{64}$/.test(msg.resume)) throw new Error('Invalid resume token');
          if (msg.nonce !== undefined && !/^[a-f0-9]{32}$/.test(msg.nonce)) throw new Error('Invalid nonce');
          if (room.peers[msg.role]) {
            if (!room.used || !msg.resume || room.resumes[msg.role] !== msg.resume || !msg.nonce || room.nonces[msg.role] === msg.nonce) throw new Error('Pair unavailable');
            const previous = Object.values(room.peers); room.peers = {}; room.expires = Date.now() + 24 * 60 * 60_000;
            for (const member of previous) member.close(1012, 'Authenticated network handover');
          }
          role = msg.role; room.nonces[role] = msg.nonce; room.resumes[role] ??= msg.resume; room.peers[role] = ws; clearTimeout(joinTimer);
          ws.send(JSON.stringify({ type: 'waiting' }));
          if (room.peers.host && room.peers.guest) {
            room.used = true; room.expires = Number.POSITIVE_INFINITY;
            const epoch = randomBytes(16).toString('hex');
            for (const peer of Object.values(room.peers)) peer.send(JSON.stringify({ type: 'ready', relay: true, epoch, ...(room.nonces.host && room.nonces.guest ? { nonces: room.nonces } : {}) }));
          }
        } else {
          if (msg.type === 'leave') {
            room.revoked = true;
            for (const peer of Object.values(room.peers)) peer.close(4001, 'Sharing revoked');
            return;
          }
          const other = room.peers[role === 'host' ? 'guest' : 'host'];
          if (!other || other.readyState !== WebSocket.OPEN) throw new Error('Peer unavailable');
          if (msg.type === 'relay-data') {
            if (!room.used || typeof msg.seq !== 'string' || msg.seq.length > 20 || typeof msg.data !== 'string'
                || msg.data.length > 48000 || typeof msg.tag !== 'string' || !/^[a-f0-9]{32}$/.test(msg.tag)
                || typeof msg.end !== 'boolean') throw new Error('Invalid relay frame');
            if (Date.now() - windowStart > 1000) { windowStart = Date.now(); windowBytes = 0; }
            if ((windowBytes += raw.length) > 32 * 1024 * 1024 || other.bufferedAmount > 32 * 1024 * 1024) throw new Error('Relay capacity exceeded');
            other.send(JSON.stringify({ type: 'relay-data', seq: msg.seq, data: msg.data, tag: msg.tag, end: msg.end }));
          } else {
            if (msg.type !== 'signal' || typeof msg.payload !== 'string' || typeof msg.tag !== 'string') throw new Error('Invalid signal');
            other.send(JSON.stringify({ type: 'signal', payload: msg.payload, tag: msg.tag }));
          }
        }
      } catch { ws.close(1008, 'Pair rejected'); }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(joinTimer);
      if (room && room.peers[role] === ws) {
        const others = Object.values(room.peers).filter(other => other !== ws);
        room.peers = {};
        if (!room.revoked && room.used && room.resumes.host && room.resumes.guest) room.expires = Date.now() + 24 * 60 * 60_000;
        else if (rooms.get(room.id) === room) rooms.delete(room.id);
        for (const other of others) other.close(room.revoked ? 4001 : 1012, room.revoked ? 'Sharing revoked' : 'Peer left');
      }
    });
  });
  const timer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) if (now >= room.expires) {
      for (const peer of Object.values(room.peers)) peer.close(1000, 'Pair expired');
      rooms.delete(room.id);
    }
    for (const [code, entry] of shortPairs.entries()) if (now >= entry.expires) shortPairs.delete(code);
  }, 1000);
  timer.unref();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
    }
  }, 30000);
  heartbeat.unref();
  http.listen(port, host);
  return { http, rooms, shortPairs, async close() { clearInterval(timer); clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => http.close(resolve)); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createSignalServer({ port: Number(process.env.PORT || 8787), host: process.env.HOST || '127.0.0.1' });
  server.http.on('listening', () => console.log('DSH Peer signaling ready'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
}
