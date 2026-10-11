import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export function createSignalServer({ port = 8787, host = '127.0.0.1', ttl = 10 * 60_000, maxRooms = 1000 } = {}) {
  const rooms = new Map();
  const http = createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end(req.url === '/health' ? 'ok' : 'Not found'); });
  const wss = new WebSocketServer({ server: http, maxPayload: 128 * 1024, perMessageDeflate: false });
  wss.on('connection', ws => {
    let room, role, count = 0;
    const joinTimer = setTimeout(() => ws.close(1008, 'Join timeout'), 5000);
    ws.on('message', raw => {
      try {
        if (++count > 100) throw new Error('Signal limit');
        const msg = JSON.parse(raw.toString());
        if (!room) {
          if (msg.type !== 'join' || !/^[a-f0-9]{32}$/.test(msg.room) || !/^[a-f0-9]{64}$/.test(msg.access) || !['host', 'guest'].includes(msg.role)) throw new Error('Invalid join');
          room = rooms.get(msg.room);
          if (!room) {
            if (rooms.size >= maxRooms) throw new Error('Room limit');
            room = { id: msg.room, access: msg.access, peers: {}, expires: Date.now() + ttl };
            rooms.set(msg.room, room);
          }
          if (room.access !== msg.access || room.peers[msg.role] || room.used || Date.now() >= room.expires) throw new Error('Pair unavailable');
          role = msg.role; room.peers[role] = ws; clearTimeout(joinTimer);
          ws.send(JSON.stringify({ type: 'waiting' }));
          if (room.peers.host && room.peers.guest) {
            room.used = true;
            for (const peer of Object.values(room.peers)) peer.send(JSON.stringify({ type: 'ready' }));
          }
        } else {
          if (msg.type !== 'signal' || typeof msg.payload !== 'string' || typeof msg.tag !== 'string') throw new Error('Invalid signal');
          const other = room.peers[role === 'host' ? 'guest' : 'host'];
          if (!other || other.readyState !== WebSocket.OPEN) throw new Error('Peer unavailable');
          other.send(JSON.stringify({ type: 'signal', payload: msg.payload, tag: msg.tag }));
        }
      } catch { ws.close(1008, 'Pair rejected'); }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(joinTimer);
      if (room && room.peers[role] === ws) {
        for (const other of Object.values(room.peers)) if (other !== ws) other.close(1000, 'Peer left');
        rooms.delete(room.id);
      }
    });
  });
  const timer = setInterval(() => {
    for (const room of rooms.values()) if (Date.now() >= room.expires) {
      for (const peer of Object.values(room.peers)) peer.close(1000, 'Pair expired');
      rooms.delete(room.id);
    }
  }, 1000);
  timer.unref();
  http.listen(port, host);
  return { http, rooms, async close() { clearInterval(timer); for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => http.close(resolve)); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createSignalServer({ port: Number(process.env.PORT || 8787), host: process.env.HOST || '127.0.0.1' });
  server.http.on('listening', () => console.log('DSH Peer signaling ready'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
}
