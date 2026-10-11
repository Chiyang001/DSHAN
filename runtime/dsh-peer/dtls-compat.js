// werift 0.25.0's Flight3 throws on a duplicate HelloVerifyRequest while its
// cookie-bearing ClientHello is already being retransmitted. Real UDP paths
// can deliver that duplicate. Leave retransmission to the existing Flight3
// timer. Buffer the three client-authentication messages in wire order so an
// out-of-order key exchange cannot derive a secret from an incomplete transcript.
// Certificate/fingerprint checks still run in the original implementation.
// DTLS retransmissions: https://www.rfc-editor.org/rfc/rfc6347#section-4.2.4
export function guardDuplicateHelloVerify(socket) {
  if (!socket?.dtls || typeof socket.onHandleHandshakes !== 'function') return;
  const original = socket.onHandleHandshakes.bind(socket);
  const pending = new Map();
  const order = [11, 16, 15];
  let next = 0;
  const serverFlight = new Map();
  let serverSequence = 1;
  socket.onHandleHandshakes = async assembled => {
    for (const handshake of assembled) {
      if (handshake.msg_type === 3 && socket.dtls.flight >= 3) continue;
      if (socket.sessionType === 2 && handshake.msg_type === 1 && socket.dtls.flight >= 4) continue;
      if (socket.sessionType === 1 && [2, 11, 12, 13, 14].includes(handshake.msg_type)
          && Number.isInteger(handshake.message_seq)) {
        if (handshake.message_seq < serverSequence) continue;
        if (handshake.message_seq > 5) throw new Error('Unexpected DTLS server flight sequence');
        serverFlight.set(handshake.message_seq, handshake);
        while (serverFlight.has(serverSequence)) {
          const message = serverFlight.get(serverSequence);
          serverFlight.delete(serverSequence++);
          await original([message]);
        }
        continue;
      }
      // UDP may reorder the client's certificate, key exchange and proof.
      // werift derives the master secret immediately on key exchange, so the
      // certificate must already be in the transcript at that point.
      if (socket.sessionType === 2 && socket.options?.certificateRequest !== false && order.includes(handshake.msg_type)) {
        if (order.indexOf(handshake.msg_type) < next) continue;
        pending.set(handshake.msg_type, handshake);
        while (pending.has(order[next])) {
          const message = pending.get(order[next]);
          pending.delete(order[next++]);
          await original([message]);
        }
        continue;
      }
      await original([handshake]);
    }
  };
}
