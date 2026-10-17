import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import type { ServerMessage } from "@sof/durable-remote-protocol";
import { CommandOutcomeUnknownError, CommandRejectedError, NotConnectedError, RemoteClient, transcriptText } from "../src/index.ts";
import { deferred, fixture, waitUntil } from "../../server/test/helpers.ts";

const clientAt = (url: string) => new RemoteClient({ url, reconnectMinMs: 20, reconnectMaxMs: 100, snapshotTimeoutMs: 1000 });

// A transport fault proxy, not another implementation of the client/controller protocol.
async function faultProxy(t: test.TestContext, upstream: string, fault: "drop" | "failed" | "timeout") {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const sockets = new Set<WebSocket>();
  let faulted = false;
  server.on("connection", (front) => {
    const back = new WebSocket(upstream);
    sockets.add(front); sockets.add(back);
    const queued: string[] = [];
    front.on("error", () => {}); back.on("error", () => {});
    front.on("message", (raw) => {
      const text = raw.toString();
      if (back.readyState === WebSocket.OPEN) back.send(text); else queued.push(text);
    });
    back.on("open", () => { for (const raw of queued) back.send(raw); });
    back.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as ServerMessage;
      if (!faulted && frame.type === "reply" && frame.ok && frame.status === "admitted") {
        faulted = true;
        if (fault === "drop") { front.terminate(); back.terminate(); return; }
        if (fault === "timeout") return;
        front.send(JSON.stringify({ ...frame, ok: false, code: "COMMAND_FAILED", error: "Command failed; resync before retrying" }));
        return;
      }
      if (front.readyState === WebSocket.OPEN) front.send(raw.toString());
    });
    front.on("close", () => { sockets.delete(front); back.terminate(); });
    back.on("close", () => { sockets.delete(back); front.terminate(); });
  });
  t.after(async () => { for (const socket of sockets) socket.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `ws://127.0.0.1:${address.port}/`;
}

test("RemoteClient startup snapshot, durable admission, tool progress, partial/final, resync, reconnect and epoch replacement", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const slow = fauxProvider({ tokensPerSecond: 100, tokenSize: { min: 5, max: 5 } });
  f.models.setProvider(slow.provider);
  const entered = deferred();
  const release = deferred();
  f.beforeClose.push(() => release.resolve());
  slow.setResponses([
    async () => { entered.resolve(); await release.promise; return fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'client-tool-start\\n'; sleep 0.4; printf 'client-tool-end\\n'" }), { stopReason: "toolUse" }); },
    fauxAssistantMessage("client-final " + "committed streamed response ".repeat(15)),
  ]);
  const server = await f.start();
  const client = clientAt(server.url);
  t.after(() => client.close());
  assert.throws(() => client.views.current(), NotConnectedError);
  await assert.rejects(client.controller.submit("offline"), NotConnectedError);
  client.start();
  const initial = await client.ready();
  assert.equal(initial.conversation.conversation.id, server.currentView().conversation.conversation.id);
  const epoch = client.epoch;
  const rendered: string[] = [];
  client.views.subscribe(() => rendered.push(transcriptText(client.views.current())));
  const admitted = await client.controller.submit("Run the isolated tool", "reject");
  assert.ok(admitted.ok && admitted.status === "admitted");
  await entered.promise;
  await waitUntil(() => Object.keys(client.views.current().tasks.tasks).length > 0);
  await assert.rejects(client.controller.submit("Busy input", "reject"), (error: unknown) => error instanceof CommandRejectedError && error.code === "CONVERSATION_BUSY");
  await assert.rejects(client.command({ name: "abort", conversationId: (initial.conversation.conversation.id + 1) as typeof initial.conversation.conversation.id }), (error: unknown) => error instanceof CommandRejectedError && error.code === "WRONG_CONVERSATION");
  client.reconnectNow();
  await waitUntil(() => client.state === "disconnected" || client.state === "connecting");
  await client.ready();
  assert.equal(client.epoch, epoch);
  assert.ok(Object.keys(client.views.current().tasks.tasks).length > 0, "disconnect did not abort");
  release.resolve();
  await waitUntil(() => transcriptText(client.views.current()).includes("client-final") && Object.keys(client.views.current().tasks.tasks).length === 0, 10_000);
  assert.ok(rendered.some((text) => text.includes("Tool bash [running]") && text.includes("client-tool-start")), "committed running tool output is rendered");
  assert.ok(rendered.some((text) => text.includes("Committed partial") && text.includes("client-final")), "committed generation partial is rendered");
  assert.match(transcriptText(client.views.current()), /Tool bash \[done\][\s\S]*client-tool-end/);
  const beforeResync = client.views.current();
  let refreshed = false;
  const unsubscribe = client.views.subscribe(() => { refreshed = true; });
  client.resync();
  await waitUntil(() => refreshed);
  unsubscribe();
  assert.deepEqual(client.views.current(), beforeResync);
  const priorRevision = client.revision;
  await server.close();
  await waitUntil(() => client.state !== "connected");
  f.options.port = server.port;
  const restarted = await f.start();
  await client.ready();
  assert.equal(client.epoch, restarted.epoch);
  assert.notEqual(client.epoch, epoch);
  assert.deepEqual(client.views.current(), beforeResync);
  assert.ok(client.revision < priorRevision, "a fresh epoch replaces even a lower revision");
  assert.ok(client.notices.some((notice) => notice.includes("new epoch")));
  assert.equal(slow.state.callCount, 2);
  assert.ok(priorRevision > 0);
  assert.ok(client.notices.some((notice) => notice.includes("Disconnected")));
});

for (const fault of ["drop", "failed", "timeout"] as const) {
  test(`RemoteClient ${fault === "drop" ? "lost admission reply" : fault === "timeout" ? "reply timeout" : "ambiguous failed reply"} never replays admitted input`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    const entered = deferred(); const release = deferred();
    f.beforeClose.push(() => release.resolve());
    f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("unknown-outcome-final"); }]);
    const server = await f.start();
    const proxy = await faultProxy(t, server.url, fault);
    const client = new RemoteClient({ url: proxy, reconnectMinMs: 20, reconnectMaxMs: 100, commandTimeoutMs: 200 });
    t.after(() => client.close());
    client.start(); await client.ready();
    let unknown: CommandOutcomeUnknownError | undefined;
    await assert.rejects(client.controller.submit("Exactly one admission", "reject"), (error: unknown) => {
      if (!(error instanceof CommandOutcomeUnknownError)) return false;
      unknown = error; return true;
    });
    assert.ok(unknown?.requestId);
    assert.equal(unknown.command.name, "submit");
    if (unknown.command.name === "submit") assert.equal(unknown.command.text, "Exactly one admission");
    await entered.promise;
    await client.ready();
    release.resolve();
    await waitUntil(() => transcriptText(client.views.current()).includes("unknown-outcome-final") && Object.keys(client.views.current().tasks.tasks).length === 0);
    assert.equal(client.views.current().conversation.entries.filter((entry) => entry.kind === "pi.user").length, 1);
    assert.equal(f.faux.state.callCount, 1);
    assert.ok(client.notices.some((notice) => /unknown|ambiguous/.test(notice)));
  });
}

test("RemoteClient abort completion waits for drain; client exit never aborts work", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const cancelled = deferred(); const drain = deferred();
  f.beforeClose.push(() => drain.resolve());
  f.faux.setResponses([async (_context, options) => {
    entered.resolve(); options?.signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
    await drain.promise; return fauxAssistantMessage("not-final");
  }]);
  const server = await f.start();
  const client = clientAt(server.url); t.after(() => client.close());
  client.start(); await client.ready();
  await client.controller.submit("Wait", "reject"); await entered.promise;
  let completed = false;
  const abort = client.controller.abort().then((reply) => { completed = true; return reply; });
  await cancelled.promise;
  await waitUntil(() => Object.values(client.views.current().tasks.tasks).some((task) => task.abortRequested));
  assert.equal(completed, false);
  drain.resolve();
  assert.equal((await abort).status, "completed");
  client.close();
  await assert.rejects(client.controller.submit("After close"), NotConnectedError);
  // Separate admitted run, then close the face rather than sending abort.
  const pending = deferred(); const finish = deferred();
  f.beforeClose.push(() => finish.resolve());
  let aborted = false;
  f.faux.setResponses([async (_context, options) => {
    options?.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
    pending.resolve(); await finish.promise; return fauxAssistantMessage("work-outlived-client");
  }]);
  const face = clientAt(server.url); t.after(() => face.close()); face.start(); await face.ready();
  await face.controller.submit("Keep working"); await pending.promise;
  face.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(aborted, false);
  assert.ok(Object.keys(server.currentView().tasks.tasks).length > 0);
  finish.resolve();
  await waitUntil(() => transcriptText(server.currentView()).includes("work-outlived-client"));
});
