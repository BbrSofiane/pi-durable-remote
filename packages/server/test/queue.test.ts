import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { deferred, fixture, Probe } from "./helpers.ts";

test("server bounds its admission queue while an abort is draining", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  const aborted = deferred();
  const drain = deferred();
  f.beforeClose.push(() => drain.resolve());
  f.faux.setResponses([async (_context, options) => {
    entered.resolve();
    options?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
    await drain.promise;
    return fauxAssistantMessage("not-an-answer");
  }]);
  const server = await f.start();
  const client = await Probe.connect(server.url, t);
  const snapshot = await client.hello();
  const conversationId = snapshot.view.conversation.conversation.id;
  client.send({ type: "command", protocolVersion: 1, id: "queue-input", command: { name: "submit", conversationId, text: "Hold", whenBusy: "reject" } });
  await client.wait((frame) => frame.type === "reply" && frame.id === "queue-input");
  await entered.promise;
  client.send({ type: "command", protocolVersion: 1, id: "queue-abort", command: { name: "abort", conversationId } });
  await aborted.promise;
  for (let id = 0; id < 8; id++) client.send({ type: "command", protocolVersion: 1, id: `queued-${id}`, command: { name: "abort", conversationId } });
  const rejected = await client.wait((frame) => frame.type === "reply" && frame.id === "queued-7");
  assert.ok(rejected.type === "reply" && !rejected.ok && rejected.code === "SERVER_BUSY");
  assert.equal(client.frames.some((frame) => frame.type === "reply" && frame.id === "queue-abort"), false);
  // Resync still functions while abort is pending and the admission queue is full.
  const after = client.frames.length;
  client.send({ type: "resync", protocolVersion: 1 });
  await client.wait((frame) => frame.type === "snapshot", after);
  drain.resolve();
  const completed = await client.wait((frame) => frame.type === "reply" && frame.id === "queue-abort");
  assert.ok(completed.type === "reply" && completed.ok && completed.status === "completed");
  await client.wait((frame) => frame.type === "reply" && frame.id === "queued-6");
});
