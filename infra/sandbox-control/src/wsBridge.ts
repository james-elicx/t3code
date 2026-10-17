/** Accepts both ends of a proxied WebSocket in the Durable Object and relays between them. */
export function bridgeWebSocket(upstream: WebSocket): Response {
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  upstream.binaryType = "arraybuffer";
  server.binaryType = "arraybuffer";
  upstream.accept();
  server.accept();
  // A listener that throws drops the connection, so these never throw.
  const relay = (from: WebSocket, to: WebSocket) => {
    from.addEventListener("message", (event) => {
      try {
        to.send(event.data);
      } catch {
        from.close(1011, "The other side closed");
      }
    });
    from.addEventListener("close", (event) => {
      // 1005 and 1006 report a missing or abnormal close and cannot be sent.
      const code = event.code === 1005 || event.code === 1006 ? 1000 : event.code;
      try {
        to.close(code, event.reason);
      } catch {}
    });
  };
  relay(server, upstream);
  relay(upstream, server);
  return new Response(null, { status: 101, webSocket: client });
}
