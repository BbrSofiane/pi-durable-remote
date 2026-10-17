import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Command, RemoteView, ServerMessage } from "@sof/durable-remote-protocol";
import { transcriptText } from "../../client/src/index.ts";
import { Probe } from "../../server/test/helpers.ts";
import { integrationFixture, waitUntil } from "./helpers.ts";

const expected = "durable server bytes ✓\n";
const inputCount = (view: RemoteView) => view.conversation.entries.filter((entry) => entry.kind === "pi.user").length;

// Actual server/client Node processes, actual SQLite, published faux provider and CodingTools.
test("process integration: graceful face exit leaves zero clients; all four remote tools finish and reconnect replaces the same final state", { timeout: 20_000 }, async (t) => {
  const f = await integrationFixture(t);
  const server = await f.startServer("held-turn");
  const face = await f.startClient(server.url);
  face.send({ type: "submit", text: "Create, edit, read and verify the server file" });
  const admission = (await face.message("admitted")).reply as Extract<ServerMessage, { type: "reply"; ok: true }>;
  assert.equal(admission.status, "admitted");
  await server.child.message("model-held");
  await face.close();
  assert.equal(face.stopped, true, "face process exited before tools/model could continue");
  server.child.send({ type: "release" });
  const completed = await server.child.message("finished");
  const final = completed.view as RemoteView;
  assert.equal(completed.callCount, 5);
  assert.equal(inputCount(final), 1);
  assert.equal(Object.keys(final.tasks.tasks).length, 0);
  assert.match(transcriptText(final), /integration-final: server bytes verified/);
  const toolNames = final.conversation.entries.flatMap((entry) => entry.model ?? []).filter((message) => message.role === "toolResult").map((message) => message.toolName);
  assert.deepEqual(toolNames, ["write", "edit", "read", "bash"]);
  assert.equal(await readFile(join(f.serverCwd, "result.txt"), "utf8"), expected);
  assert.deepEqual(await readdir(f.clientCwd), [], "client cwd is still empty after all tools");
  const reconnect = await f.faceAt(server.url);
  assert.equal(reconnect.epoch, server.epoch);
  assert.deepEqual(reconnect.views.current(), final, "fresh whole snapshot is the identical final remote state");
  reconnect.close();
  await server.child.close();
});

test("process integration: SIGKILL mid-unsafe-bash yields interrupted output without replay; exact SQLite session and admission survive", { timeout: 25_000 }, async (t) => {
  const f = await integrationFixture(t);
  const first = await f.startServer("unsafe");
  const client = await f.faceAt(first.url);
  const initial = client.views.current();
  const admission = await client.controller.submit("Run the unsafe controlled tool", "reject");
  assert.equal(admission.status, "admitted");
  await waitUntil(async () => (await readFile(f.toolOwnerPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return "";
  })).length > 0);
  await waitUntil(() => transcriptText(client.views.current()).includes("unsafe-committed-partial"));
  const owner = JSON.parse(await readFile(f.toolOwnerPath, "utf8")) as { pid: number; cwd: string };
  assert.equal(owner.cwd, f.serverCwd);
  assert.equal(await readFile(join(f.serverCwd, "unsafe-executions.txt"), "utf8"), "executed\n");
  client.close();
  await first.child.kill();
  assert.deepEqual(await first.child.exited, { code: null, signal: "SIGKILL" });
  // Standalone PID death is NOT a service cgroup kill: the owned external process may live on.
  assert.doesNotThrow(() => process.kill(owner.pid, 0), "external tool outlives standalone server SIGKILL");
  await f.killTool(); // exact recorded test-only PID, before reopening the session
  const reopened = await f.startServer("resume-tool");
  assert.notEqual(reopened.epoch, first.epoch);
  const completed = await reopened.child.message("finished");
  const final = completed.view as RemoteView;
  const face = await f.faceAt(reopened.url);
  assert.deepEqual(face.views.current(), final);
  assert.equal(final.session.databasePath, f.databasePath);
  assert.equal(final.conversation.conversation.id, initial.conversation.conversation.id);
  assert.equal(inputCount(final), 1, "no duplicate admitted input");
  assert.equal(completed.callCount, 2, "recovered tool result then write result lead to two model calls");
  const recovery = await reopened.child.message("recovery-context");
  assert.match(JSON.stringify(recovery.result), /interrupted/i);
  const results = final.conversation.entries.flatMap((entry) => entry.model ?? []).filter((message) => message.role === "toolResult");
  assert.equal(results.length, 2);
  assert.equal(results[0].toolName, "bash");
  assert.equal(results[0].isError, true);
  assert.match(JSON.stringify(results[0]), /interrupted/i);
  assert.match(JSON.stringify(results[0]), /unsafe-committed-partial/, "committed running output survives in interrupted result");
  assert.equal(await readFile(join(f.serverCwd, "unsafe-executions.txt"), "utf8"), "executed\n", "unsafe bash never replayed or completed");
  assert.equal(await readFile(join(f.serverCwd, "result.txt"), "utf8"), expected);
  face.close();
  await reopened.child.close();
});

test("process integration: server dies after durable admission BEFORE reply; explicit same-ID protocol retry deduplicates", { timeout: 25_000 }, async (t) => {
  const f = await integrationFixture(t);
  const first = await f.startServer("crash-before-reply");
  const client = await f.startClient(first.url);
  client.send({ type: "submit", text: "Exactly one input despite missing reply" });
  const unknown = await client.message("unknown");
  assert.deepEqual(await first.child.exited, { code: null, signal: "SIGKILL" });
  assert.equal(client.messages.some((message) => message.type === "admitted"), false);
  const admission = JSON.parse(await readFile(join(f.serverCwd, "crash-admission.json"), "utf8")) as Extract<ServerMessage, { type: "reply"; ok: true }>;
  assert.equal(admission.status, "admitted");
  assert.equal(unknown.requestId, admission.id);
  const command = unknown.command as Extract<Command, { name: "submit" }>;
  assert.equal(command.text, "Exactly one input despite missing reply");
  await client.close(); // release actual adapter before raw-peer manual resend; never automatic replay
  const reopened = await f.startServer("resume-input");
  const completed = await reopened.child.message("finished");
  assert.equal(completed.callCount, 1);
  const final = completed.view as RemoteView;
  assert.equal(inputCount(final), 1);
  assert.equal(command.conversationId, final.conversation.conversation.id);
  assert.notEqual(reopened.epoch, first.epoch);
  const manual = await Probe.connect(reopened.url, t);
  await manual.hello();
  manual.send({ type: "command", protocolVersion: 1, id: admission.id, command });
  const retried = await manual.wait((frame) => frame.type === "reply" && frame.id === admission.id);
  assert.ok(retried.type === "reply" && retried.ok && retried.status === "admitted");
  assert.equal(retried.submissionId, admission.submissionId);
  reopened.child.send({ type: "inspect" });
  const inspection = await reopened.child.message("inspection");
  assert.equal(inspection.callCount, 1, "deduplication does not invoke another model turn");
  assert.equal(inputCount(inspection.view as RemoteView), 1);
  assert.deepEqual(inspection.view, final);
  await manual.disconnect();
  const face = await f.faceAt(reopened.url);
  assert.deepEqual(face.views.current(), final);
  face.close();
  await reopened.child.close();
});
