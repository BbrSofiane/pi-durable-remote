import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";
import { RemoteClient } from "../src/index.ts";
import { parseServerMessage } from "../src/wire.ts";
import { fixture, waitUntil } from "../../server/test/helpers.ts";

test("wire validation and incompatible/malformed startup frames produce notices and reconnect, not unhandled failures", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const durable = await f.start();
  const view = durable.currentView();
  const snapshot = { type: "snapshot", protocolVersion: 1, epoch: "test-epoch", revision: 5, view };
  assert.deepEqual(parseServerMessage(JSON.stringify(snapshot)), snapshot);
  for (const raw of ["not-json", "null", JSON.stringify({ ...snapshot, protocolVersion: 2 }), JSON.stringify({ ...snapshot, view: {} }), JSON.stringify({ ...snapshot, revision: -1 }), JSON.stringify({ type: "reply", protocolVersion: 1, epoch: "test", id: "id", ok: true, status: "admitted" })]) assert.throws(() => parseServerMessage(raw));
  const transport = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => transport.once("listening", resolve));
  t.after(async () => { for (const socket of transport.clients) socket.terminate(); await new Promise<void>((resolve) => transport.close(() => resolve())); });
  let connections = 0;
  transport.on("connection", (socket) => {
    connections++;
    const number = connections;
    socket.on("error", () => {});
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "hello") {
        if (number === 1) socket.send(JSON.stringify({ ...snapshot, protocolVersion: 2 }));
        else if (number === 2) socket.send("not-json");
        else if (number === 3) socket.send(JSON.stringify({ ...snapshot, type: "view" })); // No startup snapshot.
        else socket.send(JSON.stringify(snapshot));
      } else if (message.type === "resync") {
        socket.send(JSON.stringify({ ...snapshot, type: "view", revision: 4, view: { ...view, session: { ...view.session, cwd: "/stale" } } }));
        socket.send(JSON.stringify(snapshot));
      }
    });
  });
  const address = transport.address(); assert.ok(address && typeof address !== "string");
  const client = new RemoteClient({ url: `ws://127.0.0.1:${address.port}/`, reconnectMinMs: 10, reconnectMaxMs: 20 });
  t.after(() => client.close());
  client.start(); await client.ready(5000);
  assert.equal(connections, 4);
  assert.ok(client.notices.filter((notice) => notice.includes("Invalid/incompatible")).length >= 3);
  let sawStale = false; let updates = 0;
  client.views.subscribe(() => { updates++; if (client.views.current().session.cwd === "/stale") sawStale = true; });
  client.resync();
  await waitUntil(() => updates > 0);
  assert.equal(sawStale, false);
  assert.equal(client.revision, 5);
  client.close();
});

test("direct transport refuses public endpoints, URLs carrying auth, and non-root paths", () => {
  for (const url of ["ws://example.com/", "wss://127.0.0.1/", "ws://user:password@127.0.0.1/", "ws://127.0.0.1/path", "ws://127.0.0.1/?token=secret"]) assert.throws(() => new RemoteClient({ url }));
});
