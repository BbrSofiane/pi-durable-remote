import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { WebSocketServer, WebSocket } from "ws";
import type { ClientMessage, Command, ServerMessage } from "@sof/durable-remote-protocol";
import { CommandOutcomeUnknownError, RemoteClient, transcriptText } from "../src/index.ts";
import type { CommandReply } from "../src/remote.ts";
import { RecoveryState, defaultReceiptCapacity, frozenCommand } from "../src/recovery.ts";
import { conversationIdentity } from "../src/wire.ts";
import { deferred, fixture, waitUntil } from "../../server/test/helpers.ts";

type FaultMode = "drop-admitted-reply" | "drop-admitted-replies" | "fail-admitted-reply" | "drop-completed-reply" | "drop-first-submit" | "withhold-admitted-reply";
type RecordedCommand = { id: string; raw: string };

// A transport fault proxy, not another implementation of the client/controller protocol.
async function faultProxy(t: test.TestContext, upstream: string, mode: FaultMode) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const sockets = new Set<WebSocket>();
  const commands: RecordedCommand[] = [];
  const holds = new Map<string, { resolveReceived: () => void; released: Promise<void>; raw?: string }>();
  let viewGate: { queued: string[] } | undefined;
  let faulted = false;
  let firstSubmitDropped = false;
  let activeFront: WebSocket | undefined;
  server.on("connection", (front) => {
    activeFront = front;
    const back = new WebSocket(upstream);
    sockets.add(front); sockets.add(back);
    const queued: string[] = [];
    const toBack = (text: string) => { if (back.readyState === WebSocket.OPEN) back.send(text); else queued.push(text); };
    front.on("error", () => {}); back.on("error", () => {});
    front.on("message", (raw) => {
      const text = raw.toString();
      let parsed: ClientMessage | undefined;
      try { parsed = JSON.parse(text) as ClientMessage; } catch { parsed = undefined; }
      if (parsed?.type === "command") {
        commands.push({ id: parsed.id, raw: text });
        const hold = holds.get(parsed.id);
        if (hold) {
          holds.delete(parsed.id);
          hold.raw = text;
          hold.resolveReceived();
          void hold.released.then(() => toBack(hold.raw!));
          return;
        }
        if (mode === "drop-first-submit" && parsed.command.name === "submit" && !firstSubmitDropped) {
          firstSubmitDropped = true;
          front.terminate(); back.terminate(); // The frame is never forwarded; the server cannot have admitted it.
          return;
        }
      }
      toBack(text);
    });
    back.on("open", () => { for (const text of queued) back.send(text); });
    back.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as ServerMessage;
      const drops = mode === "drop-admitted-replies" ||
        (mode === "drop-admitted-reply" || mode === "fail-admitted-reply" || mode === "drop-completed-reply" || mode === "withhold-admitted-reply") && !faulted;
      const faults = drops && frame.type === "reply" && frame.ok &&
        (mode === "drop-completed-reply" ? frame.status === "completed" : frame.status === "admitted");
      if (faults) {
        faulted = true;
        if (mode === "fail-admitted-reply") {
          front.send(JSON.stringify({ ...frame, ok: false, code: "COMMAND_FAILED", error: "Command failed; resync before retrying" }));
          return;
        }
        if (mode === "withhold-admitted-reply") return; // The reply never reaches the client; the connection stays open.
        front.terminate(); back.terminate();
        return;
      }
      if (viewGate && (frame.type === "snapshot" || frame.type === "view")) { viewGate.queued.push(raw.toString()); return; }
      if (front.readyState === WebSocket.OPEN) front.send(raw.toString());
    });
    front.on("close", () => { sockets.delete(front); back.terminate(); });
    back.on("close", () => { sockets.delete(back); front.terminate(); });
  });
  t.after(async () => { for (const socket of sockets) socket.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `ws://127.0.0.1:${address.port}/`,
    commands,
    // Queue every server snapshot/view from arm time until release; used to prove recovery really waits for a
    // post-uncertainty snapshot instead of trusting the pre-uncertainty one. The resync reply is a snapshot.
    holdViews(): { release: () => void } {
      const queued: string[] = [];
      let open!: () => void;
      const released = new Promise<void>((done) => { open = done; });
      const gate = { queued };
      viewGate = gate;
      void released.then(() => {
        if (viewGate === gate) viewGate = undefined;
        for (const text of queued) if (activeFront?.readyState === WebSocket.OPEN) activeFront.send(text);
      });
      return { release: () => open() };
    },
    hold(requestId: string): { received: Promise<void>; release: () => void } {
      let resolveReceived!: () => void;
      let doRelease!: () => void;
      const received = new Promise<void>((done) => { resolveReceived = done; });
      const released = new Promise<void>((done) => { doRelease = done; });
      holds.set(requestId, { resolveReceived, released });
      return { received, release: doRelease };
    },
  };
}

const ambiguousSubmit = async (client: RemoteClient, text: string, whenBusy: "steer" | "followUp" | "reject" = "reject") => {
  let unknown: CommandOutcomeUnknownError | undefined;
  await assert.rejects(client.controller.submit(text, whenBusy), (error: unknown) => {
    if (!(error instanceof CommandOutcomeUnknownError)) return false;
    unknown = error; return true;
  });
  assert.ok(unknown?.requestId);
  return unknown;
};

const userEntries = (client: RemoteClient) => client.views.current().conversation.entries.filter((entry) => entry.kind === "pi.user").length;

for (const mode of ["drop-admitted-reply", "fail-admitted-reply"] as const) {
  test(`after-admission loss (${mode}) then explicit recovery resends the exact original submission; mutation cannot alter it`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(t);
    const entered = deferred(); const release = deferred();
    f.beforeClose.push(() => release.resolve());
    f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("recovered-final"); }]);
    const server = await f.start();
    const proxy = await faultProxy(t, server.url, mode);
    const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
    t.after(() => client.close());
    client.start();
    await client.ready();
    const identity = conversationIdentity(client.views.current());
    assert.ok(identity, "a real session publishes a persisted pi.provider identity");
    const unknown = await ambiguousSubmit(client, "Exactly one admission");
    assert.equal(unknown.command.name, "submit");
    await entered.promise; // The original submission was durably admitted and started a run.
    await client.ready();
    const receipt = client.recovery.list().find((entry) => entry.requestId === unknown.requestId);
    assert.ok(receipt, "the ambiguous submission is retained");
    assert.equal(receipt.status, "uncertain");
    assert.equal(receipt.conversationIdentity, identity);
    // Recovery may only run against a snapshot delivered after the uncertain outcome (the resync view for a
    // COMMAND_FAILED, the reconnect snapshot for a lost reply).
    await waitUntil(() => client.recovery.list().find((entry) => entry.requestId === unknown.requestId)?.snapshotFresh === true, 10_000);
    // Live state mutations must not reach the resend: the error carries the caller's object, the store a frozen clone.
    if (unknown.command.name === "submit") unknown.command.text = "MUTATED-ERROR-COMMAND";
    assert.throws(() => { (receipt.command as { text: string }).text = "MUTATED-RECEIPT"; }, TypeError);
    await assert.rejects(client.recovery.recover("not-a-receipt"), /No recoverable submission/); // Unknown IDs are not recoverable.
    assert.equal(client.recovery.list().length, 1);
    const admitted = await client.recovery.recover(receipt.requestId);
    assert.ok(admitted.ok && admitted.status === "admitted");
    assert.equal(proxy.commands.length, 2, "exactly the original send plus the explicit recovery resend");
    assert.equal(proxy.commands[0].raw, proxy.commands[1].raw, "recovery resends the exact original wire frame");
    assert.equal(proxy.commands[1].id, receipt.requestId);
    assert.equal(client.recovery.list().length, 0, "success removes exactly the recovered receipt");
    release.resolve();
    await waitUntil(() => transcriptText(client.views.current()).includes("recovered-final") && Object.keys(client.views.current().tasks.tasks).length === 0, 10_000);
    assert.equal(f.faux.state.callCount, 1, "the harness deduplicated the same request ID; no second run or input");
    assert.equal(userEntries(client), 1);
  });
}

test("ambiguous COMMAND_FAILED refuses recovery until the resync snapshot actually arrives", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.beforeClose.push(() => release.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("held-resync-final"); }]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "fail-admitted-reply");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
  t.after(() => client.close());
  client.start();
  await client.ready();
  // Armed before submitting: the client receives no server snapshot or view at all until the gate opens.
  const gate = proxy.holdViews();
  const unknown = await ambiguousSubmit(client, "Wait for the resync");
  await entered.promise;
  await new Promise((resolve) => setTimeout(resolve, 100)); // The resync response and any pushes stay withheld.
  assert.equal(client.state, "connected");
  const receipt = client.recovery.list().find((entry) => entry.requestId === unknown.requestId);
  assert.ok(receipt);
  assert.equal(receipt.snapshotFresh, false, "no snapshot delivered so far postdates the uncertain outcome");
  await assert.rejects(client.recovery.recover(receipt.requestId), /fresh snapshot/);
  assert.equal(client.recovery.list().length, 1, "the refused attempt keeps the receipt");
  assert.equal(proxy.commands.length, 1, "no recovery frame is sent against a stale snapshot");
  gate.release();
  await waitUntil(() => client.recovery.list()[0]?.snapshotFresh === true, 10_000);
  const admitted = await client.recovery.recover(receipt.requestId);
  assert.ok(admitted.ok && admitted.status === "admitted");
  assert.equal(proxy.commands[1].raw, proxy.commands[0].raw, "the delayed recovery still resends the exact original frame");
  assert.equal(client.recovery.list().length, 0);
  release.resolve();
  await waitUntil(() => transcriptText(client.views.current()).includes("held-resync-final") && Object.keys(client.views.current().tasks.tasks).length === 0, 10_000);
  assert.equal(f.faux.state.callCount, 1, "the harness deduplicated the same request ID");
  assert.equal(userEntries(client), 1);
});

test("a reply timeout while connected also refuses recovery until a fresh snapshot arrives", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.beforeClose.push(() => release.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("withheld-reply-final"); }]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "withhold-admitted-reply");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100, commandTimeoutMs: 400 });
  t.after(() => client.close());
  client.start();
  await client.ready();
  const gate = proxy.holdViews(); // Armed before the timeout fires so the resync response is captured, not consumed.
  const unknown = await ambiguousSubmit(client, "Timeout then resync");
  await entered.promise;
  await new Promise((resolve) => setTimeout(resolve, 100)); // The timeout resync's snapshot stays withheld.
  assert.equal(client.state, "connected");
  const receipt = client.recovery.list().find((entry) => entry.requestId === unknown.requestId);
  assert.ok(receipt, "the timed-out submission is retained as uncertain");
  assert.equal(receipt.snapshotFresh, false);
  await assert.rejects(client.recovery.recover(receipt.requestId), /fresh snapshot/);
  assert.equal(client.recovery.list().length, 1);
  assert.equal(proxy.commands.length, 1, "no recovery frame is sent before the post-uncertainty snapshot");
  gate.release();
  await waitUntil(() => client.recovery.list()[0]?.snapshotFresh === true, 10_000);
  const admitted = await client.recovery.recover(receipt.requestId);
  assert.ok(admitted.ok && admitted.status === "admitted");
  assert.equal(proxy.commands[1].raw, proxy.commands[0].raw);
  assert.equal(client.recovery.list().length, 0);
  release.resolve();
  await waitUntil(() => transcriptText(client.views.current()).includes("withheld-reply-final") && Object.keys(client.views.current().tasks.tasks).length === 0, 10_000);
  assert.equal(f.faux.state.callCount, 1);
  assert.equal(userEntries(client), 1);
});

test("before-admission loss then explicit recovery admits exactly once", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.beforeClose.push(() => release.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("before-admission-final"); }]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "drop-first-submit");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
  t.after(() => client.close());
  client.start();
  await client.ready();
  const unknown = await ambiguousSubmit(client, "Admit only on retry");
  await client.ready();
  const receipt = client.recovery.list().find((entry) => entry.requestId === unknown.requestId);
  assert.ok(receipt, "the lost submission is retained even though it was never forwarded");
  assert.equal(proxy.commands.length, 1);
  assert.equal(f.faux.state.callCount, 0, "the server never received the lost frame");
  const admitted = await client.recovery.recover(receipt.requestId);
  assert.ok(admitted.ok && admitted.status === "admitted");
  await entered.promise;
  release.resolve();
  await waitUntil(() => transcriptText(client.views.current()).includes("before-admission-final") && Object.keys(client.views.current().tasks.tasks).length === 0, 10_000);
  assert.equal(f.faux.state.callCount, 1, "exactly one admission and one run");
  assert.equal(userEntries(client), 1);
  assert.equal(client.recovery.list().length, 0);
  assert.equal(proxy.commands.length, 2, "exactly the lost send plus the explicit resend");
  assert.equal(proxy.commands[0].raw, proxy.commands[1].raw, "the resend is the exact original wire frame");
});

test("second loss retains the same receipt for another explicit attempt", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.beforeClose.push(() => release.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("repeat-uncertain-final"); }]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "drop-admitted-replies");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
  t.after(() => client.close());
  client.start();
  await client.ready();
  const unknown = await ambiguousSubmit(client, "Uncertain twice");
  await client.ready();
  await assert.rejects(client.recovery.recover(unknown.requestId), CommandOutcomeUnknownError);
  await client.ready();
  const receipts = client.recovery.list();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].requestId, unknown.requestId, "repeated uncertainty preserves the original receipt");
  assert.equal(receipts[0].conversationIdentity, conversationIdentity(client.views.current()));
  assert.equal(receipts[0].status, "uncertain");
  assert.equal(proxy.commands.length, 2);
  assert.equal(proxy.commands[0].raw, proxy.commands[1].raw);
  release.resolve();
  await waitUntil(() => transcriptText(client.views.current()).includes("repeat-uncertain-final") && Object.keys(client.views.current().tasks.tasks).length === 0, 10_000);
  assert.equal(f.faux.state.callCount, 1);
});

test("server restart with a new epoch and the same persisted identity permits recovery of the original submission", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.beforeClose.push(() => release.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("restart-final"); }]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "drop-admitted-reply");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
  t.after(() => client.close());
  client.start();
  await client.ready();
  const epochBefore = client.epoch;
  const identityBefore = conversationIdentity(client.views.current());
  const unknown = await ambiguousSubmit(client, "Survives restart");
  await entered.promise;
  release.resolve();
  await waitUntil(() => transcriptText(client.views.current()).includes("restart-final") && Object.keys(client.views.current().tasks.tasks).length === 0, 10_000);
  // Restart the same SQLite session: a new epoch, the same persisted pi.provider identity.
  await server.close();
  await waitUntil(() => client.state !== "connected");
  f.options.port = server.port;
  const restarted = await f.start();
  await client.ready();
  assert.notEqual(client.epoch, epochBefore);
  assert.equal(client.epoch, restarted.epoch);
  assert.equal(conversationIdentity(client.views.current()), identityBefore);
  const receipt = client.recovery.list().find((entry) => entry.requestId === unknown.requestId);
  assert.ok(receipt, "the receipt outlived the epoch replacement");
  const admitted = await client.recovery.recover(receipt.requestId);
  assert.ok(admitted.ok && admitted.status === "admitted");
  assert.equal(proxy.commands[1].raw, proxy.commands[0].raw);
  assert.equal(client.recovery.list().length, 0);
  assert.equal(f.faux.state.callCount, 1);
  assert.equal(userEntries(client), 1);
});

test("a recreated database with the same numeric conversation id is refused", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.beforeClose.push(() => release.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("different-db-final"); }]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "drop-admitted-reply");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
  t.after(() => client.close());
  client.start();
  await client.ready();
  const identityBefore = conversationIdentity(client.views.current());
  const unknown = await ambiguousSubmit(client, "Bound to one identity");
  await entered.promise;
  await client.ready();
  release.resolve(); // Let the admitted run finish before closing the server; close drains live work.
  await waitUntil(() => transcriptText(client.views.current()).includes("different-db-final") && Object.keys(client.views.current().tasks.tasks).length === 0, 10_000);
  // Recreate the session on the same port from an empty database: same numeric root id, different persisted identity.
  f.options.databasePath = `${f.cwd}/recreated.sqlite`;
  f.options.port = server.port;
  await server.close();
  await waitUntil(() => client.state !== "connected");
  await f.start();
  await client.ready();
  const identityAfter = conversationIdentity(client.views.current());
  assert.ok(identityBefore && identityAfter);
  assert.notEqual(identityAfter, identityBefore, "a recreated database has a fresh persisted identity");
  assert.equal(client.views.current().conversation.conversation.id, unknown.command.conversationId, "the numeric conversation id alone is not an identity");
  const receipt = client.recovery.list().find((entry) => entry.requestId === unknown.requestId);
  assert.ok(receipt);
  // The published view is caller-mutable; forging the retained identity onto it must not authorize recovery.
  const docs = client.views.current().conversation.docs as Record<string, unknown>;
  docs["pi.provider"] = { sessionId: identityBefore };
  assert.equal(conversationIdentity(client.views.current()), identityBefore, "the test really mutated the public view");
  await assert.rejects(client.recovery.recover(receipt.requestId), /different conversation/);
  assert.equal(client.recovery.list().length, 1, "a forged view identity still keeps the receipt");
  assert.equal(proxy.commands.length, 1, "a forged view identity sends nothing");
  assert.equal(client.recovery.list().length, 1, "a refused recovery keeps the receipt");
  assert.equal(receipt.status, "uncertain");
  assert.equal(proxy.commands.length, 1, "a refused recovery sends nothing");
  release.resolve();
});

test("absent persisted identity disables recovery without breaking ordinary submit", { timeout: 10_000 }, async (t) => {
  // A minimal protocol-faithful ws server whose snapshot has no pi.provider doc.
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const snapshot = {
    protocolVersion: 1, epoch: "identityless-epoch", type: "snapshot", revision: 1,
    view: {
      session: { databasePath: "/tmp/identityless.sqlite", cwd: "/tmp" },
      model: { provider: "faux", modelId: "faux-model" },
      conversation: { conversation: { id: 7 }, entries: [], docs: {} },
      tasks: { tasks: {} },
    },
  };
  server.on("connection", (ws) => {
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ClientMessage;
      if (message.type === "hello") ws.send(JSON.stringify(snapshot));
      else if (message.type === "command") ws.send(JSON.stringify({ protocolVersion: 1, epoch: snapshot.epoch, type: "reply", id: message.id, ok: false, code: "COMMAND_FAILED", error: "ambiguous" }));
    });
  });
  const client = new RemoteClient({ url: `ws://127.0.0.1:${address.port}/` });
  t.after(() => client.close()); // Registered first so it runs before the WebSocketServer close, which waits for peers.
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  client.start();
  await client.ready();
  const unknown = await ambiguousSubmit(client, "Cannot be recovered", "followUp");
  assert.ok(client.notices.some((notice) => notice.includes("No persisted conversation identity")));
  assert.equal(client.recovery.list().length, 0, "no receipt is invented without a persisted identity");
  await assert.rejects(client.recovery.recover("not-a-receipt"), /No recoverable submission/);
  // Ordinary submit/answer flow is unchanged even though no receipt can exist.
  const second = await ambiguousSubmit(client, "Ordinary flow", "followUp");
  assert.ok(second.requestId);
  assert.equal(client.recovery.list().length, 0);
});

test("abort outcomes are never recoverable", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.beforeClose.push(() => release.resolve());
  f.faux.setResponses([async (_context, options) => {
    entered.resolve();
    options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
    await release.promise;
    return fauxAssistantMessage("abort-drain-final");
  }]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "drop-completed-reply");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100, commandTimeoutMs: 400 });
  t.after(() => client.close());
  client.start();
  await client.ready();
  await client.controller.submit("Abort target", "reject");
  await entered.promise;
  await assert.rejects(client.controller.abort(), CommandOutcomeUnknownError);
  assert.equal(client.recovery.list().length, 0, "abort is never retained as a recoverable submission");
  const abortFrames = proxy.commands.filter((command) => (JSON.parse(command.raw) as Extract<ClientMessage, { type: "command" }>).command.name === "abort");
  assert.equal(abortFrames.length, 1, "the abort was sent once by the user and never replayed");
});

test("recovery is rejected while the client is not connected; receipts do not transfer between clients", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.beforeClose.push(() => release.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("disconnected-final"); }]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "drop-admitted-reply");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
  t.after(() => client.close());
  client.start();
  await client.ready();
  const unknown = await ambiguousSubmit(client, "One attempt at a time");
  client.close();
  await assert.rejects(client.recovery.recover(unknown.requestId), /fresh connected snapshot/);
  const second = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
  t.after(() => second.close());
  second.start();
  await second.ready();
  assert.equal(second.recovery.list().length, 0, "receipts live in the owning client's memory only");
  release.resolve();
});

test("one in-flight attempt per receipt on a live connection", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.beforeClose.push(() => release.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("held-final"); }]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "drop-admitted-reply");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
  t.after(() => client.close());
  client.start();
  await client.ready();
  const unknown = await ambiguousSubmit(client, "No duplicate attempts");
  await client.ready();
  const receipt = client.recovery.list().find((entry) => entry.requestId === unknown.requestId);
  assert.ok(receipt);
  const held = proxy.hold(receipt.requestId);
  const attempt = client.recovery.recover(receipt.requestId);
  await held.received;
  assert.equal(client.recovery.list()[0].status, "recovering");
  await assert.rejects(client.recovery.recover(receipt.requestId), /already in flight/);
  await assert.rejects(async () => client.recovery.discard(receipt.requestId), /Cannot discard while a recovery attempt is in flight/);
  held.release();
  const admitted = await attempt;
  assert.ok(admitted.ok && admitted.status === "admitted");
  assert.equal(client.recovery.list().length, 0);
  release.resolve();
});

test("definite recovery rejection keeps the receipt; local discard sends no remote message", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.beforeClose.push(() => release.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("busy-holder-final"); }]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "drop-first-submit");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
  t.after(() => client.close());
  client.start();
  await client.ready();
  const unknown = await ambiguousSubmit(client, "Not admitted this time", "reject");
  await client.ready();
  // Make the conversation busy; the recovery resend with whenBusy "reject" is then definitely rejected.
  await client.controller.submit("Busy holder", "reject");
  await entered.promise;
  await assert.rejects(client.recovery.recover(unknown.requestId), (error: unknown) => {
    const rejected = error as { name?: string; code?: string };
    return rejected.name === "CommandRejectedError" && rejected.code === "CONVERSATION_BUSY";
  });
  const receipt = client.recovery.list().find((entry) => entry.requestId === unknown.requestId);
  assert.ok(receipt, "a definite rejection honestly reports not-admitted and keeps the receipt");
  assert.equal(receipt.status, "uncertain");
  assert.equal(proxy.commands.length, 3, "lost submit, busy-holder submit and the rejected resend");
  assert.equal(proxy.commands[2].raw, proxy.commands[0].raw, "the rejected resend was still the exact original frame");
  client.recovery.discard(unknown.requestId);
  assert.equal(client.recovery.list().length, 0);
  assert.equal(proxy.commands.length, 3, "discard sends no remote abort or withdrawal");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(Object.values(client.views.current().tasks.tasks).every((task) => !task.abortRequested), "the busy run was not aborted by the discard");
  release.resolve();
});

test("RecoveryState store semantics: bounded capacity without eviction, cloning, and discard rules", async () => {
  assert.ok(Number.isInteger(defaultReceiptCapacity) && defaultReceiptCapacity >= 1);
  const sent: { id: string; command: { name: string; text?: string } }[] = [];
  let connected = true;
  let identity: string | undefined = "session-A";
  let transmitThrows = false;
  const host = {
    connected: () => connected,
    identity: () => identity,
    transmit: (requestId: string, command: { name: string; text?: string }) => {
      if (transmitThrows) throw new Error("transport refused the send");
      sent.push({ id: requestId, command });
      return Promise.reject(new Error("ambiguous for the unit test"));
    },
  };
  const store = new RecoveryState(host, 1);
  const original = { name: "submit", conversationId: 0, text: "original text", whenBusy: "reject" } as unknown as Command;
  store.provision("id-1", original, "session-A");
  (original as { text: string }).text = "mutated after provision"; // Callers cannot corrupt the captured intent.
  store.settled("id-1", "ambiguous");
  await assert.rejects(store.recover("id-1"), /fresh snapshot/, "an ambiguous outcome waits for a post-uncertainty snapshot");
  assert.equal(store.list()[0].snapshotFresh, false);
  store.markFreshSnapshot();
  const [receipt] = store.list();
  assert.ok(receipt);
  assert.equal((receipt.command as { text: string }).text, "original text");
  assert.throws(() => { (receipt.command as { text: string }).text = "x"; }, TypeError);
  assert.equal((frozenCommand(original) as { text: string }).text, "mutated after provision", "frozenCommand clones the current value");
  assert.equal(receipt.snapshotFresh, true, "a snapshot arrived after the uncertain outcome");
  // A second receipt cannot silently evict the first.
  assert.throws(() => store.provision("id-2", original, "session-A"), /capacity/);
  assert.equal(store.list().length, 1);
  // Recovery transmits the frozen clone, never the caller's object.
  const attempt = store.recover("id-1");
  await assert.rejects(store.recover("id-1"), /already in flight/);
  assert.deepEqual(sent, [{ id: "id-1", command: { name: "submit", conversationId: 0, text: "original text", whenBusy: "reject" } }]);
  assert.notEqual(sent[0].command, original, "recovery transmits the captured clone, not the caller's live object");
  assert.equal(sent[0].command, receipt.command, "the list view and the resend share the same frozen intent");
  await assert.rejects(attempt);
  assert.equal(store.list().length, 1, "repeated uncertainty keeps the receipt");
  // Pre-send failure returns the receipt to uncertain, keeping it.
  transmitThrows = true;
  await assert.rejects(store.recover("id-1"), /transport refused/);
  assert.equal(store.list()[0].status, "uncertain");
  transmitThrows = false;
  // Guards: disconnected, absent identity, changed identity.
  connected = false;
  await assert.rejects(store.recover("id-1"), /disconnected/);
  connected = true;
  identity = undefined;
  await assert.rejects(store.recover("id-1"), /no persisted conversation identity/);
  identity = "session-B";
  await assert.rejects(store.recover("id-1"), /different conversation/);
  assert.equal(store.list().length, 1, "every refused attempt keeps the receipt");
  identity = "session-A";
  // The client's reply hook settles a recovering receipt before the rejection propagates to the awaiting recover().
  const settledStore = new RecoveryState({ connected: () => true, identity: () => "session-A", transmit: () => Promise.reject(new Error("definite")) }, 8);
  settledStore.provision("id-9", original, "session-A");
  settledStore.settled("id-9", "ambiguous");
  settledStore.markFreshSnapshot();
  const definiteAttempt = settledStore.recover("id-9");
  settledStore.settled("id-9", "rejected");
  await assert.rejects(definiteAttempt);
  assert.equal(settledStore.list().length, 1, "a definite rejection of a recovery keeps the receipt for an explicit operator choice");
  // Local discard is exact and refuses unknown receipts.
  assert.throws(() => settledStore.discard("missing"), /No recoverable submission/);
  settledStore.discard("id-9");
  assert.equal(settledStore.list().length, 0);
  store.discard("id-1");
  assert.equal(store.list().length, 0);
});

test("an earlier attempt's settled rejection cannot unlock or reset a newer in-flight attempt", async () => {
  let calls = 0;
  const host = {
    connected: () => true,
    identity: () => "session-A",
    transmit: (): Promise<CommandReply> => {
      calls++;
      // The first attempt is definitely rejected; the attempt started afterwards stays in flight.
      if (calls === 1) return Promise.reject(new Error("definite rejection"));
      return new Promise<CommandReply>(() => {});
    },
  };
  const store = new RecoveryState(host, 8);
  const command = { name: "submit", conversationId: 0, text: "attempt ordering", whenBusy: "reject" } as unknown as Command;
  store.provision("id-ordering", command, "session-A");
  store.settled("id-ordering", "ambiguous");
  store.markFreshSnapshot();
  const first = store.recover("id-ordering");
  // The client's reply hook settles the definite rejection and synchronously notifies observers before the awaiting
  // recover() catch runs; an observer may start the next explicit attempt inside that window.
  store.settled("id-ordering", "rejected");
  const second = store.recover("id-ordering"); // A permitted new attempt after the definite rejection.
  assert.ok(second);
  await assert.rejects(first, /definite rejection/);
  assert.equal(store.list()[0].status, "recovering", "the earlier catch must not reset the newer in-flight attempt");
  await assert.rejects(store.recover("id-ordering"), /already in flight/, "one in-flight attempt per receipt");
  assert.throws(() => store.discard("id-ordering"), /Cannot discard while a recovery attempt is in flight/);
  assert.equal(calls, 2, "no third transmission was unlocked by the earlier attempt's cleanup");
});

test("recovery refuses to register a resend when the transport is no longer OPEN despite a connected state", { timeout: 10_000 }, async (t) => {
  // A minimal protocol-faithful ws server whose second resync reply is deliberately invalid, forcing the client's
  // invalid-frame terminate() while its connection state still reads "connected".
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const snapshot = {
    protocolVersion: 1, epoch: "window-epoch", type: "snapshot", revision: 1,
    view: {
      session: { databasePath: "/tmp/window.sqlite", cwd: "/tmp" },
      model: { provider: "faux", modelId: "faux-model" },
      conversation: { conversation: { id: 9 }, entries: [], docs: { "pi.provider": { sessionId: "window-identity" } } },
      tasks: { tasks: {} },
    },
  };
  let sentCommands = 0;
  let poisonResync = false;
  server.on("connection", (ws) => {
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ClientMessage;
      if (message.type === "hello" || (message.type === "resync" && !poisonResync)) ws.send(JSON.stringify(snapshot));
      else if (message.type === "command") {
        sentCommands++;
        ws.send(JSON.stringify({ protocolVersion: 1, epoch: snapshot.epoch, type: "reply", id: message.id, ok: false, code: "COMMAND_FAILED", error: "ambiguous" }));
      } else if (message.type === "resync") ws.send("not a protocol frame");
    });
  });
  const client = new RemoteClient({ url: `ws://127.0.0.1:${address.port}/` });
  t.after(() => client.close()); // Registered first so it runs before the WebSocketServer close, which waits for peers.
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  client.start();
  await client.ready();
  const unknown = await ambiguousSubmit(client, "Window probe");
  await waitUntil(() => client.recovery.list()[0]?.snapshotFresh === true, 10_000);
  const receipt = client.recovery.list().find((entry) => entry.requestId === unknown.requestId);
  assert.ok(receipt);
  // A synchronous observer attempts recovery inside the notify() that follows the invalid-frame terminate(), while
  // state still reads "connected" but the terminated socket can no longer transmit.
  let armed = false;
  let probe: Promise<{ settled: "fulfilled"; error?: unknown } | { settled: "rejected"; error: unknown }> | undefined;
  client.subscribe(() => {
    if (!armed || probe) return;
    armed = false;
    probe = client.recovery.recover(receipt.requestId).then(
      () => ({ settled: "fulfilled" as const, error: undefined as unknown }),
      (error: unknown) => ({ settled: "rejected" as const, error }),
    );
  });
  armed = true;
  poisonResync = true;
  client.resync();
  await waitUntil(() => probe !== undefined, 10_000);
  const outcome = await probe!;
  assert.equal(outcome.settled, "rejected");
  assert.match(String(outcome.error), /disconnected/, "recovery refuses without an OPEN transport");
  assert.equal(client.recovery.list().length, 1, "the definite local refusal preserves the receipt");
  assert.equal(client.recovery.list()[0].status, "uncertain");
  assert.equal(sentCommands, 1, "no recovery frame was registered or sent against the dead transport");
});

test("conversationIdentity reads only the persisted pi.provider session id", async (t) => {
  const { parseServerMessage } = await import("../src/wire.ts");
  const base = { session: { databasePath: "/tmp/x.sqlite", cwd: "/tmp" }, model: { provider: "p", modelId: "m" }, tasks: { tasks: {} } };
  const view = (docs: Record<string, unknown>) => {
    const frame = parseServerMessage(JSON.stringify({
      protocolVersion: 1, epoch: "e", type: "snapshot", revision: 1,
      view: { ...base, conversation: { conversation: { id: 0 }, entries: [], docs } },
    }));
    if (frame.type !== "snapshot") throw new Error("Expected a snapshot");
    return frame.view;
  };
  assert.equal(conversationIdentity(view({ "pi.provider": { sessionId: "persisted-1" } })), "persisted-1");
  assert.equal(conversationIdentity(view({})), undefined, "missing doc");
  assert.equal(conversationIdentity(view({ "pi.provider": { sessionId: 42 } })), undefined, "non-string session id");
  assert.equal(conversationIdentity(view({ "pi.provider": { sessionId: "" } })), undefined, "empty session id");
  assert.equal(conversationIdentity(view({ "pi.provider": "not-a-doc" })), undefined, "non-record doc");
});
