import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { RemoteView, ServerMessage } from "@sof/durable-remote-protocol";
import { RemoteClient, runRemoteTui, terminalText } from "../../client/src/index.ts";
import { TestTerminal } from "../../client/test/fixtures/test-terminal.ts";
import { integrationFixture, waitUntil } from "./helpers.ts";
import { recoveryProxy } from "./fixtures/recovery-proxy.ts";

const inputCount = (view: RemoteView) => view.conversation.entries.filter((entry) => entry.kind === "pi.user").length;
const identity = (view: RemoteView) => (view.conversation.docs["pi.provider"] as { sessionId: string }).sessionId;
const enter = (terminal: TestTerminal, text: string) => { terminal.type(text); terminal.input!("\r"); };
const freshReceipt = (client: RemoteClient) => client.state === "connected" && client.recovery.list()[0]?.snapshotFresh === true;

test("TUI process recovery: server dies after admission, same live Editor recovers original submission across SQLite reopen and repeated lost replies", { timeout: 30_000 }, async (t) => {
  const f = await integrationFixture(t);
  const first = await f.startServer("crash-before-reply");
  const proxy = await recoveryProxy(t, first.url);
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 30, reconnectMaxMs: 100 });
  const terminal = new TestTerminal();
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; });
  await client.ready();
  const originalIdentity = identity(client.views.current());
  enter(terminal, "  Same original 世界 input  ");
  await first.child.exited;
  await waitUntil(() => client.recovery.list().length === 1);
  const original = client.recovery.list()[0]!;
  const admission = JSON.parse(await readFile(join(f.serverCwd, "crash-admission.json"), "utf8")) as Extract<ServerMessage, { type: "reply"; ok: true; status: "admitted" }>;
  assert.equal(admission.id, original.requestId);
  assert.equal(original.conversationIdentity, originalIdentity);
  assert.equal(proxy.commands.length, 1);
  assert.equal(original.command.name === "submit" && original.command.whenBusy, "followUp");
  // Receipt views and commands cannot be changed even though the pinned Harness does not compare text on dedup.
  assert.equal(Reflect.set(original.command, "text", "changed draft"), false, "frozen original payload rejects mutation");
  assert.equal(Reflect.set(original.command, "conversationId", 999), false);
  assert.equal(Reflect.set(original.command, "whenBusy", "reject"), false);
  assert.throws(() => { Object.assign(original, { requestId: "new-id", conversationIdentity: "new-session" }); }, TypeError);
  enter(terminal, "/recover"); // Disconnected: retain without transmission.
  await waitUntil(() => client.notices.some((notice) => notice.includes("Recovery refused")));
  assert.equal(proxy.commands.length, 1);
  const reopened = await f.startServer("resume-input", Number(new URL(first.url).port));
  const finished = await reopened.child.message("finished");
  const final = finished.view as RemoteView;
  await waitUntil(() => freshReceipt(client), 10_000);
  assert.notEqual(client.epoch, first.epoch);
  assert.equal(client.epoch, reopened.epoch);
  assert.equal(identity(client.views.current()), originalIdentity, "persisted public pi.provider.sessionId survives process restart");
  assert.equal(client.views.current().session.databasePath, f.databasePath);
  assert.equal(inputCount(final), 1);
  assert.equal(proxy.commands.length, 1, "restart/resume/fresh snapshot never replay the input");
  assert.equal(terminal.stopped, false, "same local TUI stayed alive throughout server death");
  proxy.loseAdmittedReplies(2);
  for (let attempt = 0; attempt < 2; attempt++) {
    enter(terminal, "/recover");
    await waitUntil(() => proxy.commands.length === attempt + 2 && client.recovery.list()[0]?.status === "uncertain" && freshReceipt(client), 10_000);
    assert.equal(client.recovery.list()[0]!.requestId, original.requestId, "repeated uncertainty retains the same receipt");
    assert.deepEqual(proxy.commands.at(-1), proxy.commands[0], "every explicit attempt uses the exact ID/conversation/text/whenBusy");
    assert.equal(proxy.replies.at(-1)?.ok, true, "the lost retry reply was an actual successful Harness admission");
  }
  enter(terminal, "/recover");
  await waitUntil(() => client.recovery.list().length === 0);
  assert.equal(proxy.commands.length, 4);
  assert.ok(proxy.commands.every((frame) => JSON.stringify(frame) === JSON.stringify(proxy.commands[0])));
  assert.ok(proxy.replies.every((reply) => reply.ok && reply.status === "admitted" && reply.submissionId === admission.submissionId), "actual Harness returns the original submission for every retry");
  reopened.child.send({ type: "inspect" });
  const inspected = await reopened.child.message("inspection");
  assert.equal(inspected.callCount, finished.callCount, "explicit dedup retries cause no additional model run; restart resume is measured separately");
  assert.deepEqual(inspected.view, final, "retry adds no admission, task or transcript entry");
  assert.match(terminalText(terminal.output), /Unconfirmed: 1/);
  assert.ok(client.notices.some((notice) => notice.includes("not an answer-completion acknowledgement")));
  terminal.input!("\x03"); await ui;
  assert.equal(terminal.stopped, true);
  assert.equal(client.state, "closed");
  assert.ok(proxy.commands.every((frame) => frame.command.name === "submit"), "exit and local commands never send abort");
  assert.deepEqual(await readdir(f.clientCwd), [], "no client outbox or workspace files");
  await reopened.child.close();
});

test("TUI before-admission recovery: bounded multiple receipts survive, capacity refuses without eviction, discard is local and one explicit retry admits one input", { timeout: 20_000 }, async (t) => {
  const f = await integrationFixture(t);
  const server = await f.startServer("resume-input");
  const proxy = await recoveryProxy(t, server.url);
  proxy.loseBeforeAdmission(2);
  const client = new RemoteClient({ url: proxy.url, receiptCapacity: 2, reconnectMinMs: 30, reconnectMaxMs: 100 });
  const terminal = new TestTerminal();
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; });
  await client.ready();
  for (const [index, text] of ["First never admitted", "Second never admitted"].entries()) {
    enter(terminal, text);
    await waitUntil(() => client.recovery.list().length === index + 1 && freshReceipt(client));
  }
  const [first, second] = client.recovery.list();
  assert.ok(first && second);
  assert.equal(inputCount(client.views.current()), 0, "transport losses occurred before Harness admission");
  assert.equal(proxy.commands.length, 2, "reconnect did not replay either input");
  enter(terminal, "Must not evict retained inputs");
  await waitUntil(() => client.notices.some((notice) => notice.includes("capacity (2) reached")));
  assert.deepEqual(client.recovery.list().map((receipt) => receipt.requestId), [first.requestId, second.requestId]);
  assert.equal(proxy.commands.length, 2, "capacity failure sent nothing");
  terminal.input!("\x15"); // Clear the restored refused draft before the local action.
  enter(terminal, "/discard");
  assert.equal(client.recovery.list().length, 1);
  assert.equal(client.recovery.list()[0]!.requestId, second.requestId);
  assert.equal(proxy.commands.length, 2, "discard sends neither abort nor submit");
  enter(terminal, "/recover");
  await waitUntil(() => client.recovery.list().length === 0);
  assert.equal(proxy.commands.length, 3);
  assert.deepEqual(proxy.commands[2], proxy.commands[1]);
  const finished = await server.child.message("finished");
  assert.equal(inputCount(finished.view as RemoteView), 1);
  assert.equal(finished.callCount, 1, "exactly one originally unadmitted input now runs");
  terminal.input!("\x03"); await ui;
  await server.child.close();
});

test("TUI actual-server snapshots: same numeric ID with wrong UUID or absent stable identity fails closed; local discard and exit never abort", { timeout: 20_000 }, async (t) => {
  const f = await integrationFixture(t);
  const server = await f.startServer("resume-input");
  const proxy = await recoveryProxy(t, server.url);
  proxy.loseBeforeAdmission();
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 30, reconnectMaxMs: 100 });
  const terminal = new TestTerminal();
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; });
  await client.ready();
  const originalId = client.views.current().conversation.conversation.id;
  enter(terminal, "Guarded original");
  await waitUntil(() => freshReceipt(client));
  const receipt = client.recovery.list()[0]!;
  for (const [override, message] of [["99999999-9999-4999-8999-999999999999", "different conversation"], [null, "no persisted conversation identity"]] as const) {
    proxy.snapshotIdentity(override);
    client.reconnectNow(); await client.ready();
    assert.equal(client.views.current().conversation.conversation.id, originalId);
    assert.equal(client.epoch, server.epoch);
    // Mutating the public view to resemble the old session cannot bypass authoritative wire identity.
    Reflect.set(client.views.current().conversation.docs, "pi.provider", { sessionId: receipt.conversationIdentity });
    enter(terminal, "/recover");
    await waitUntil(() => client.notices.some((notice) => notice.includes("Recovery refused") && notice.includes(message)));
    assert.equal(proxy.commands.length, 1);
    assert.equal(client.recovery.list()[0]!.requestId, receipt.requestId);
  }
  enter(terminal, "/discard");
  assert.equal(client.recovery.list().length, 0);
  assert.equal(proxy.commands.length, 1);
  terminal.input!("\x03"); await ui;
  const witness = await f.faceAt(server.url);
  assert.equal(witness.recovery.list().length, 0);
  assert.equal(inputCount(witness.views.current()), 0);
  witness.close();
  await server.child.close();
});
