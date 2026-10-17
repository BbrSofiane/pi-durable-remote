import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import type { ServerMessage } from "@sof/durable-remote-protocol";
import { SnapshotPeer } from "../src/peer.ts";
import { fixture, waitUntil } from "./helpers.ts";

/** Simulates write callbacks stalled by a transport, not an invented Harness state. */
class StalledSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: ServerMessage[] = [];
  callbacks: ((error?: Error) => void)[] = [];
  terminated = false;
  send(payload: string, callback: (error?: Error) => void): void {
    this.sent.push(JSON.parse(payload) as ServerMessage);
    this.callbacks.push(callback);
  }
  terminate(): void { this.terminated = true; this.emit("close"); }
}

test("SnapshotPeer retains only newest whole view, preserves resync, and prioritizes bounded replies", async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const socket = new StalledSocket();
  t.after(() => socket.terminate());
  const peer = new SnapshotPeer(socket as unknown as WebSocket, 5);
  const envelope = { protocolVersion: 1 as const, epoch: server.epoch };
  peer.view({ ...envelope, type: "snapshot", revision: 0, view: server.currentView() });
  for (let revision = 1; revision <= 500; revision++) {
    peer.view({ ...envelope, type: revision === 250 ? "snapshot" : "view", revision, view: server.currentView() });
  }
  peer.control({ ...envelope, type: "reply", id: "control", ok: true, status: "completed" });
  assert.equal(socket.sent.length, 1, "exactly one frame may be in flight");
  socket.callbacks.shift()!();
  assert.equal(socket.sent[1].type, "reply");
  socket.callbacks.shift()!();
  await waitUntil(() => socket.sent.length === 3);
  const latest = socket.sent[2];
  assert.ok(latest.type === "snapshot");
  assert.equal(latest.revision, 500);
  socket.callbacks.shift()!();
  await new Promise((done) => setTimeout(done, 15));
  assert.equal(socket.sent.length, 3, "intermediate whole views are coalesced, never queued");
});

test("SnapshotPeer disconnects rather than growing an unbounded control-frame backlog", async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const socket = new StalledSocket();
  t.after(() => socket.terminate());
  const peer = new SnapshotPeer(socket as unknown as WebSocket, 5);
  peer.view({ protocolVersion: 1, epoch: server.epoch, type: "snapshot", revision: 0, view: server.currentView() });
  for (let id = 0; id < 33; id++) peer.control({ protocolVersion: 1, epoch: server.epoch, type: "reply", id: String(id), ok: true, status: "completed" });
  assert.equal(socket.terminated, true);
  assert.equal(socket.sent.length, 1);
});

test("SnapshotPeer times out even a single stalled snapshot without further updates", async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const socket = new StalledSocket();
  t.after(() => socket.terminate());
  const peer = new SnapshotPeer(socket as unknown as WebSocket, 5);
  let now = Date.now();
  const clock = t.mock.method(Date, "now", () => now);
  try {
    peer.view({ protocolVersion: 1, epoch: server.epoch, type: "snapshot", revision: 0, view: server.currentView() });
    now += 10_001;
    await new Promise((done) => setTimeout(done, 25));
    assert.equal(socket.terminated, true);
  } finally { clock.mock.restore(); }
});
