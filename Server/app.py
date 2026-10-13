"""Public DSH pairing/relay service. Tool content stays encrypted by the peers."""
import hmac
import json
import os
import queue
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field

from flask import Flask, Response, jsonify, request
from flask_sock import Sock
from simple_websocket import ConnectionClosed

MAX_FRAME = 128 * 1024
SHORT_CODE_RE = re.compile(r"^[A-HJ-NP-Z2-9]{8}$")
SHORT_PAIR_TTL = 120


class Rejected(Exception):
    pass


def hexadecimal(value, length):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{%d}" % length, value) is not None


def valid_pair(pair):
    return (
        isinstance(pair, dict)
        and pair.get("v") == 1
        and hexadecimal(pair.get("room"), 32)
        and isinstance(pair.get("secret"), str)
        and re.fullmatch(r"[A-Za-z0-9_-]{43}", pair.get("secret", ""))
        and isinstance(pair.get("server"), str)
        and len(pair.get("server", "")) <= 2048
        and pair.get("mode") in (None, "auto", "relay", "p2p")
    )


@dataclass
class Room:
    access: str
    expires: float
    peers: dict = field(default_factory=dict)
    used: bool = False


class Hub:
    def __init__(self, ttl=600, max_rooms=1000, max_clients=96, clock=time.monotonic):
        self.ttl, self.max_rooms, self.max_clients, self.clock = ttl, max_rooms, max_clients, clock
        self.rooms, self.retired = {}, OrderedDict()
        self.short_pairs = {}
        self.clients = set()
        self.lock = threading.RLock()

    def register_short(self, code, pair):
        if not SHORT_CODE_RE.fullmatch(code):
            raise Rejected("Invalid pairing code")
        if not valid_pair(pair):
            raise Rejected("Invalid pair")
        with self.lock:
            now = self.clock()
            existing = self.short_pairs.get(code)
            if existing and existing["expires"] > now:
                raise Rejected("Pair unavailable")
            self.short_pairs[code] = {"pair": pair, "expires": now + SHORT_PAIR_TTL}

    def lookup_short(self, code):
        if not SHORT_CODE_RE.fullmatch(code):
            raise Rejected("Invalid pairing code")
        with self.lock:
            entry = self.short_pairs.get(code)
            if not entry or self.clock() >= entry["expires"]:
                raise Rejected("Pair unavailable")
            return entry["pair"]

    def sweep_short_pairs(self):
        with self.lock:
            now = self.clock()
            expired = [code for code, entry in self.short_pairs.items() if now >= entry["expires"]]
            for code in expired:
                del self.short_pairs[code]

    def accept(self, peer):
        with self.lock:
            if len(self.clients) >= self.max_clients:
                raise Rejected("Service busy")
            self.clients.add(peer)

    def join(self, peer, message):
        room_id, access, role = (message.get(key) for key in ("room", "access", "role"))
        if message.get("type") != "join" or not hexadecimal(room_id, 32) or not hexadecimal(access, 64) or role not in ("host", "guest"):
            raise Rejected("Invalid join")
        with self.lock:
            now = self.clock()
            while self.retired and next(iter(self.retired.values())) <= now:
                self.retired.popitem(last=False)
            if room_id in self.retired:
                raise Rejected("Pair unavailable")
            room = self.rooms.get(room_id)
            if room is None:
                if len(self.rooms) >= self.max_rooms:
                    raise Rejected("Room limit")
                room = Room(access, now + self.ttl)
                self.rooms[room_id] = room
            if not hmac.compare_digest(room.access, access) or role in room.peers or room.used or now >= room.expires:
                raise Rejected("Pair unavailable")
            peer.room_id, peer.role = room_id, role
            room.peers[role] = peer
            peer.send({"type": "waiting"})
            if len(room.peers) == 2:
                room.used = True
                for member in room.peers.values():
                    member.send({"type": "ready", "relay": True})

    def relay(self, peer, message):
        with self.lock:
            room = self.rooms.get(peer.room_id)
            if not room or room.peers.get(peer.role) is not peer:
                raise Rejected("Pair unavailable")
            other = room.peers.get("guest" if peer.role == "host" else "host")
            if not other:
                raise Rejected("Peer unavailable")
            kind = message.get("type")
            if kind == "signal":
                if not isinstance(message.get("payload"), str) or not hexadecimal(message.get("tag"), 64):
                    raise Rejected("Invalid signal")
                outgoing = {"type": kind, "payload": message["payload"], "tag": message["tag"]}
            elif kind == "relay-data":
                data, seq = message.get("data"), message.get("seq")
                if (not room.used or not isinstance(seq, str) or re.fullmatch(r"[0-9]{1,20}", seq) is None
                        or not isinstance(data, str) or len(data) > 48000
                        or re.fullmatch(r"[A-Za-z0-9+/]*={0,2}", data) is None
                        or not hexadecimal(message.get("tag"), 32) or type(message.get("end")) is not bool):
                    raise Rejected("Invalid relay frame")
                outgoing = {key: message[key] for key in ("type", "seq", "data", "tag", "end")}
            else:
                raise Rejected("Invalid message")
            other.send(outgoing)

    def expired(self, peer):
        with self.lock:
            room = self.rooms.get(peer.room_id)
            return not room or (not room.used and self.clock() >= room.expires)

    def leave(self, peer):
        with self.lock:
            self.clients.discard(peer)
            room = self.rooms.get(peer.room_id)
            if not room or room.peers.get(peer.role) is not peer:
                return
            del self.rooms[peer.room_id]
            self.retired[peer.room_id] = self.clock() + self.ttl
            while len(self.retired) > self.max_rooms * 4:
                self.retired.popitem(last=False)
            others = [member for member in room.peers.values() if member is not peer]
        for member in others:
            member.close(1000, "Peer left")


class Client:
    def __init__(self, ws):
        self.ws, self.room_id, self.role = ws, None, None
        self.outbox = queue.Queue(maxsize=128)
        self.closed = threading.Event()
        self.writer = None

    def start(self):
        self.writer = threading.Thread(target=self.write, daemon=True)
        self.writer.start()

    def send(self, message):
        if self.closed.is_set():
            raise Rejected("Peer unavailable")
        try:
            self.outbox.put_nowait(json.dumps(message, separators=(",", ":")))
        except queue.Full:
            raise Rejected("Relay capacity exceeded") from None

    def write(self):
        try:
            while not self.closed.is_set():
                try:
                    message = self.outbox.get(timeout=0.5)
                except queue.Empty:
                    continue
                self.ws.send(message)
        except Exception:
            self.close(1011, "Send failed")

    def close(self, code=1000, reason="Closed"):
        if not self.closed.is_set():
            self.closed.set()
            try:
                self.ws.close(reason=code, message=reason)
            except Exception:
                pass


def create_app(hub=None):
    app = Flask(__name__)
    app.config["SOCK_SERVER_OPTIONS"] = {"ping_interval": 25, "max_message_size": MAX_FRAME}
    app.config["MAX_CONTENT_LENGTH"] = MAX_FRAME
    hub = hub or Hub(max_clients=int(os.environ.get("MAX_CLIENTS", "96")))
    app.extensions["peer_hub"] = hub
    sock = Sock(app)

    @app.get("/health")
    def health():
        return Response("ok", headers={"X-DSH-Peer-Relay": "1", "Cache-Control": "no-store"}, mimetype="text/plain")

    @app.get("/")
    def index():
        return Response("DSHAN Server is online. Connect the Harness plugin to wss://your-domain/peer.\n", mimetype="text/plain")

    @app.get("/pair/<code>")
    def pair_lookup(code):
        hub.sweep_short_pairs()
        try:
            return jsonify(hub.lookup_short(code.upper()))
        except Rejected:
            return Response("{}", status=404, mimetype="application/json")

    @app.put("/pair/<code>")
    def pair_register(code):
        hub.sweep_short_pairs()
        if not request.is_json:
            return Response("{}", status=400, mimetype="application/json")
        try:
            hub.register_short(code.upper(), request.get_json())
            return Response(status=204)
        except Rejected as error:
            status = 409 if str(error) == "Pair unavailable" else 400
            return Response("{}", status=status, mimetype="application/json")

    def pairing(ws):
        peer = Client(ws)
        started = window_start = time.monotonic()
        window_bytes = signals = 0
        try:
            hub.accept(peer)
            peer.start()
            while not peer.closed.is_set():
                if not peer.room_id and time.monotonic() - started >= 5:
                    raise Rejected("Join timeout")
                if peer.room_id and hub.expired(peer):
                    raise Rejected("Pair expired")
                raw = ws.receive(timeout=0.5)
                if raw is None:
                    continue
                if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_FRAME:
                    raise Rejected("Invalid frame")
                message = json.loads(raw)
                if not isinstance(message, dict):
                    raise Rejected("Invalid message")
                if time.monotonic() - window_start >= 1:
                    window_start, window_bytes = time.monotonic(), 0
                window_bytes += len(raw.encode("utf-8"))
                if window_bytes > 32 * 1024 * 1024:
                    raise Rejected("Relay capacity exceeded")
                if message.get("type") != "relay-data":
                    signals += 1
                    if signals > 100:
                        raise Rejected("Signal limit")
                if peer.room_id:
                    hub.relay(peer, message)
                else:
                    hub.join(peer, message)
        except ConnectionClosed:
            pass
        except (Rejected, ValueError, TypeError, KeyError):
            peer.close(1008, "Pair rejected")
        finally:
            hub.leave(peer)
            peer.close()

    # Flask-Sock decorators do not return the original function, so register separately.
    sock.route("/peer", endpoint="pairing")(pairing)
    sock.route("/", endpoint="pairing_legacy")(pairing)
    return app


app = create_app()

if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "16580")), threaded=True, debug=False, use_reloader=False)
