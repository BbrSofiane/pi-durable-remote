import assert from "node:assert/strict";
import { readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import WebSocket from "ws";
import type { ServerMessage } from "@sof/durable-remote-protocol";
import { MAX_CLIENT_MESSAGE_BYTES } from "@sof/durable-remote-protocol";
import { ServerConfigurationError, startDurableServer } from "../src/index.ts";
import { deferred, fixture, Probe, waitUntil } from "./helpers.ts";

const isView = (frame: ServerMessage): frame is Extract<ServerMessage, { type: "snapshot" | "view" }> => frame.type === "snapshot" || frame.type === "view";
const hasText = (frame: ServerMessage, text: string) => isView(frame) && frame.view.conversation.entries.some((entry) => entry.kind === "pi.assistant" && (entry.model ?? []).some((message) => message.role === "assistant" && message.content.some((block) => block.type === "text" && block.text.includes(text))));

async function upgradeStatus(url: string, origin?: string): Promise<number> {
  const ws = new WebSocket(url, origin ? { origin } : undefined);
  return new Promise((done, fail) => {
    ws.on("error", fail);
    ws.on("open", () => { ws.terminate(); fail(new Error("Unexpected upgrade acceptance")); });
    ws.on("unexpected-response", (_request, response) => { response.resume(); ws.terminate(); done(response.statusCode!); });
  });
}

test("server SQLite admission, all CodingTools, disconnect, reconnect, resync and restart", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  const release = deferred();
  f.beforeClose.push(() => release.resolve());
  f.faux.setResponses([
    async () => { entered.resolve(); await release.promise; return fauxAssistantMessage(fauxToolCall("write", { path: "result.txt", content: "first\n" }), { stopReason: "toolUse" }); },
    fauxAssistantMessage(fauxToolCall("read", { path: "result.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("edit", { path: "result.txt", oldText: "first", newText: "edited" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("bash", { command: "cat result.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("verified-final-answer"),
  ]);
  const server = await f.start();
  const client = await Probe.connect(server.url, t);
  const initial = await client.hello();
  const id = initial.view.conversation.conversation.id;
  assert.equal(initial.epoch, server.epoch);
  assert.deepEqual(initial.view.tasks, { tasks: {} });
  client.send({ type: "command", protocolVersion: 1, id: "durable-request-1", command: { name: "submit", conversationId: id, text: "Make and verify a file", whenBusy: "reject" } });
  const reply = await client.wait((frame) => frame.type === "reply" && frame.id === "durable-request-1");
  assert.ok(reply.type === "reply" && reply.ok && reply.status === "admitted");
  const submissionId = reply.submissionId;
  await entered.promise;
  assert.equal(client.frames.some((frame) => hasText(frame, "verified-final-answer")), false, "admission must not wait for answer");
  const live = await client.wait((frame) => isView(frame) && Object.keys(frame.view.tasks.tasks).length > 0);
  assert.ok(isView(live) && live.view.conversation.docs["pi.live"], "published live/task values are visible");
  client.send({ type: "command", protocolVersion: 1, id: "busy-rejected", command: { name: "submit", conversationId: id, text: "Do not queue this", whenBusy: "reject" } });
  const busy = await client.wait((frame) => frame.type === "reply" && frame.id === "busy-rejected");
  assert.ok(busy.type === "reply" && !busy.ok && busy.code === "CONVERSATION_BUSY");
  await client.disconnect();
  const reconnected = await Probe.connect(server.url, t);
  const resumed = await reconnected.hello();
  assert.equal(resumed.epoch, initial.epoch);
  assert.ok(Object.keys(resumed.view.tasks.tasks).length > 0);
  release.resolve();
  const final = await reconnected.wait((frame) => hasText(frame, "verified-final-answer") && isView(frame) && Object.keys(frame.view.tasks.tasks).length === 0);
  assert.ok(isView(final));
  assert.equal(await readFile(join(f.cwd, "result.txt"), "utf8"), "edited\n");
  const results = final.view.conversation.entries.filter((entry) => entry.kind === "pi.tool-result");
  assert.equal(results.length, 4);
  for (const result of results) {
    const message = result.model?.[0];
    assert.ok(message?.role === "toolResult");
    assert.equal(message.isError, false);
  }
  assert.equal(f.faux.state.callCount, 5);
  assert.equal(f.faux.getPendingResponseCount(), 0);
  const after = reconnected.frames.length;
  reconnected.send({ type: "resync", protocolVersion: 1 });
  const resync = await reconnected.wait((frame) => frame.type === "snapshot", after);
  assert.ok(isView(resync));
  assert.deepEqual(resync.view, final.view);
  await reconnected.disconnect();
  await server.close();
  const restarted = await f.start();
  assert.notEqual(restarted.epoch, server.epoch);
  const next = await Probe.connect(restarted.url, t);
  const restored = await next.hello();
  assert.ok(Number.isSafeInteger(restored.revision) && restored.revision >= 0);
  assert.deepEqual(restored.view, resync.view);
  next.send({ type: "command", protocolVersion: 1, id: "durable-request-1", command: { name: "submit", conversationId: id, text: "Make and verify a file", whenBusy: "reject" } });
  const duplicate = await next.wait((frame) => frame.type === "reply" && frame.id === "durable-request-1");
  assert.ok(duplicate.type === "reply" && duplicate.ok && duplicate.status === "admitted");
  assert.equal(duplicate.submissionId, submissionId, "request ID deduplicates across SQLite restart");
  assert.equal(f.faux.state.callCount, 5);
  const revisions = reconnected.frames.filter(isView).map((frame) => frame.revision);
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b));
});

test("server rejects Origins, extra controllers, invalid commands, targets and payloads", async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  assert.equal(await upgradeStatus(server.url, "https://evil.example"), 403);
  assert.equal(await upgradeStatus(server.url, "null"), 403);
  assert.equal(await upgradeStatus(`${server.url}unexpected-path`), 404);
  const client = await Probe.connect(server.url, t);
  assert.equal(await upgradeStatus(server.url), 409);
  client.send({ type: "resync", protocolVersion: 1 });
  const early = await client.wait((frame) => frame.type === "error");
  assert.ok(early.type === "error" && early.code === "HELLO_REQUIRED");
  client.ws.send(JSON.stringify({ type: "hello", protocolVersion: 2, clientId: "test" }));
  await client.wait((frame) => frame.type === "error" && frame.code === "PROTOCOL_VERSION");
  const initial = await client.hello();
  client.ws.send("not json");
  await client.wait((frame) => frame.type === "error" && frame.code === "INVALID_MESSAGE");
  client.ws.send(JSON.stringify({ type: "command", protocolVersion: 1, id: "invalid-command", command: { name: "submit", text: "bad" } }));
  const invalid = await client.wait((frame) => frame.type === "reply" && frame.id === "invalid-command");
  assert.ok(invalid.type === "reply" && !invalid.ok && invalid.code === "INVALID_MESSAGE");
  client.send({ type: "command", protocolVersion: 1, id: "wrong-target", command: { name: "abort", conversationId: (initial.view.conversation.conversation.id + 1) as typeof initial.view.conversation.conversation.id } });
  const wrong = await client.wait((frame) => frame.type === "reply" && frame.id === "wrong-target");
  assert.ok(wrong.type === "reply" && !wrong.ok && wrong.code === "WRONG_CONVERSATION");
  assert.equal(f.faux.state.callCount, 0);
  const closed = new Promise<number>((done) => client.ws.once("close", (code) => done(code)));
  client.ws.send("x".repeat(MAX_CLIENT_MESSAGE_BYTES + 1));
  assert.equal(await closed, 1009);
});

test("server abort reports completion after drain and survives its caller disconnecting", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  const signalSeen = deferred();
  const drain = deferred();
  f.beforeClose.push(() => drain.resolve());
  f.faux.setResponses([async (_context, options) => {
    entered.resolve();
    options?.signal?.addEventListener("abort", () => signalSeen.resolve(), { once: true });
    await drain.promise;
    return fauxAssistantMessage("must-not-complete");
  }]);
  const server = await f.start();
  const client = await Probe.connect(server.url, t);
  const initial = await client.hello();
  const id = initial.view.conversation.conversation.id;
  client.send({ type: "command", protocolVersion: 1, id: "abort-input", command: { name: "submit", conversationId: id, text: "Wait", whenBusy: "reject" } });
  await client.wait((frame) => frame.type === "reply" && frame.id === "abort-input");
  await entered.promise;
  client.send({ type: "command", protocolVersion: 1, id: "abort-request", command: { name: "abort", conversationId: id } });
  await signalSeen.promise;
  await client.wait((frame) => isView(frame) && Object.values(frame.view.tasks.tasks).some((task) => task.abortRequested));
  assert.equal(client.frames.some((frame) => frame.type === "reply" && frame.id === "abort-request"), false);
  await client.disconnect();
  const next = await Probe.connect(server.url, t);
  await next.hello();
  drain.resolve();
  await next.wait((frame) => isView(frame) && Object.keys(frame.view.tasks.tasks).length === 0);
  next.send({ type: "command", protocolVersion: 1, id: "idle-abort", command: { name: "abort", conversationId: id } });
  const completed = await next.wait((frame) => frame.type === "reply" && frame.id === "idle-abort");
  assert.ok(completed.type === "reply" && completed.ok && completed.status === "completed");
  assert.equal(next.frames.some((frame) => hasText(frame, "must-not-complete")), false);
});

test("server lease excludes canonical database aliases on another port, then releases on close", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const alias = join(f.cwd, "alias.sqlite");
  await symlink(f.databasePath, alias);
  await assert.rejects(startDurableServer({ ...f.options, databasePath: alias, port: server.port === 65535 ? 65534 : server.port + 1 }), (error: unknown) => (error as NodeJS.ErrnoException).code === "ELOCKED");
  await server.close();
  const replacement = await f.start();
  assert.notEqual(replacement.epoch, server.epoch);
});

test("server startup fails closed for mismatched config and public binding", async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  await server.close();
  await assert.rejects(startDurableServer({ ...f.options, cwd: join(f.cwd, "..") }), ServerConfigurationError);
  await assert.rejects(startDurableServer({ ...f.options, host: "0.0.0.0" as "127.0.0.1" }), ServerConfigurationError);
  await assert.rejects(startDurableServer({ ...f.options, cwd: f.databasePath }), ServerConfigurationError);
  const dangling = join(f.cwd, "dangling.sqlite");
  await symlink(join(f.cwd, "not-created.sqlite"), dangling);
  await assert.rejects(startDurableServer({ ...f.options, databasePath: dangling }), ServerConfigurationError);
  const resumed = await f.start();
  assert.ok(resumed.port > 0, "failed startup released its lease");
});

test("server compromised lease closes sockets and fails closed", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  let fatal: string | undefined;
  const server = await startDurableServer({ ...f.options, onFatal: (message) => { fatal = message; } });
  t.after(() => server.close());
  const client = await Probe.connect(server.url, t);
  await client.hello();
  await rm(`${f.databasePath}.lock`, { recursive: true });
  await waitUntil(() => fatal !== undefined);
  await waitUntil(() => client.ws.readyState === WebSocket.CLOSED);
  assert.match(fatal!, /lease compromised/);
  await server.close();
});

test("published ModelRuntime bridge can use an injected credential store with no auth file or network", async () => {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  assert.ok(runtime.getProviders().length > 0);
});
