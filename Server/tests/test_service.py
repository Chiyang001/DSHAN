import pytest
from app import Client, Hub, Rejected, create_app


class Peer:
    room_id = role = None

    def __init__(self):
        self.messages = []
        self.closed = False

    def send(self, value):
        self.messages.append(value)

    def close(self, *_args):
        self.closed = True


def join(hub, peer, role="host", room="a" * 32, access="b" * 64):
    hub.join(peer, {"type": "join", "room": room, "access": access, "role": role})


def test_short_pair_lookup_and_register():
    app = create_app()
    pair = {"v": 1, "room": "a" * 32, "secret": "A" * 43, "server": "wss://example.com/peer"}
    with app.test_client() as client:
        assert client.put("/pair/AB12CD34", json=pair).status_code == 204
        assert client.get("/pair/AB12CD34").get_json() == pair
        assert client.get("/pair/MISSING1").status_code == 404


def test_health_and_public_root_do_not_expose_rooms():
    app = create_app()
    with app.test_client() as client:
        response = client.get("/health")
        assert response.status_code == 200 and response.data == b"ok"
        assert response.headers["X-DSH-Peer-Relay"] == "1"
        assert b"online" in client.get("/").data
        assert client.get("/rooms").status_code == 404


def test_authenticated_pair_and_duplicate_or_bad_access_rejected():
    hub, host, guest = Hub(), Peer(), Peer()
    join(hub, host)
    with pytest.raises(Rejected):
        join(hub, Peer())
    with pytest.raises(Rejected):
        join(hub, Peer(), "guest", access="c" * 64)
    join(hub, guest, "guest")
    assert host.messages[-1] == guest.messages[-1] == {"type": "ready", "relay": True}
    assert hub.rooms[host.room_id].used


def test_room_isolation_and_forwarding_without_private_key():
    hub = Hub()
    hosts, guests = [Peer(), Peer()], [Peer(), Peer()]
    for i, room in enumerate(("a" * 32, "c" * 32)):
        join(hub, hosts[i], room=room)
        join(hub, guests[i], "guest", room=room)
    message = {"type": "relay-data", "seq": "0", "data": "QUJD", "tag": "e" * 32, "end": True, "discard": "unknown"}
    before = len(guests[1].messages)
    hub.relay(hosts[0], message)
    assert guests[0].messages[-1] == {k: v for k, v in message.items() if k != "discard"}
    assert len(guests[1].messages) == before
    assert not hasattr(hub.rooms[hosts[0].room_id], "secret")


@pytest.mark.parametrize("changes", [{"seq": "-1"}, {"data": "x" * 48001}, {"end": 1}, {"tag": "invalid"}, {"type": "admin"}])
def test_invalid_relay_frames_rejected(changes):
    hub, host, guest = Hub(), Peer(), Peer()
    join(hub, host)
    join(hub, guest, "guest")
    with pytest.raises(Rejected):
        hub.relay(host, {"type": "relay-data", "seq": "0", "data": "QUJD", "tag": "e" * 32, "end": True, **changes})


def test_waiting_expires_but_paired_connection_survives():
    now = [0]
    hub, host = Hub(ttl=10, clock=lambda: now[0]), Peer()
    join(hub, host)
    now[0] = 11
    assert hub.expired(host)
    with pytest.raises(Rejected):
        join(hub, Peer(), "guest")
    paired, other = Peer(), Peer()
    now[0] = 0
    join(hub, paired, room="c" * 32)
    join(hub, other, "guest", room="c" * 32)
    now[0] = 100
    assert not hub.expired(paired)


def test_disconnect_revokes_both_ends_and_recent_code_reuse():
    hub, host, guest = Hub(), Peer(), Peer()
    hub.accept(host)
    hub.accept(guest)
    join(hub, host)
    join(hub, guest, "guest")
    hub.leave(host)
    assert guest.closed and not hub.rooms
    with pytest.raises(Rejected):
        join(hub, Peer())
    hub.leave(guest)
    assert not hub.clients


def test_capacity_reserves_service_resources():
    hub = Hub(max_clients=1, max_rooms=1)
    hub.accept(Peer())
    with pytest.raises(Rejected):
        hub.accept(Peer())
    join(hub, Peer())
    with pytest.raises(Rejected):
        join(hub, Peer(), room="c" * 32)
    peer = Client(None)
    for _ in range(128):
        peer.send({"type": "waiting"})
    with pytest.raises(Rejected):
        peer.send({"type": "waiting"})
