import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Editor, ScrollView, stripTerminalSequences, Text, TuiAltScreen, visibleWidth, VStack } from "@earendil-works/pi-tui";
import type { EditorTheme } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { WebSocketServer } from "ws";
import type { ClientMessage, Command } from "@sof/durable-remote-protocol";
import { RemoteClient, runRemoteTui, terminalText, transcriptText } from "../src/index.ts";
import { RecoveryState } from "../src/recovery.ts";
import { recoveryPanelMaxRows, recoveryStatusText, tuiLayoutRoot } from "../src/tui.ts";
import { deferred, fixture, waitUntil } from "../../server/test/helpers.ts";
import { faultProxy } from "./fixtures/fault-proxy.ts";
import { TestTerminal } from "./fixtures/test-terminal.ts";

const userEntries = (client: RemoteClient) => client.views.current().conversation.entries.filter((entry) => entry.kind === "pi.user").length;

/**
 * Monochrome editor theme matching the TUI's plain styling, for tests that construct a released Editor directly.
 */
const monochromeEditorTheme: EditorTheme = {
  borderColor: (text) => text,
  selectList: { selectedPrefix: (t) => t, selectedText: (t) => t, description: (t) => t, scrollInfo: (t) => t, noMatch: (t) => t },
};

/** Current rendered recovery-panel frame (released layout components at the panel's real row budget), one row per entry. */
const panelFrame = (client: Pick<RemoteClient, "recovery">, columns: number): string[] => {
  const panel = new Text(recoveryStatusText(client), 0, 0);
  return new VStack([{ component: panel, basis: "auto", maxSize: recoveryPanelMaxRows }]).render(columns)
    .map((line) => stripTerminalSequences(line).trimEnd());
};

/** The submit text (or command name) inside one recorded wire frame. */
const frameText = (raw: string): string => {
  const parsed = JSON.parse(raw) as Extract<ClientMessage, { type: "command" }>;
  return parsed.command.name === "submit" ? parsed.command.text : parsed.command.name;
};

test("the TUI shows the unconfirmed input and /recover resends the exact original submission once", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.beforeClose.push(() => release.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("recovered-final"); }]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "drop-admitted-reply");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
  const terminal = new TestTerminal();
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; client.close(); });
  await client.ready();
  terminal.type("One original 世界");
  terminal.input!("\r");
  await entered.promise; // The original submission was durably admitted; its reply was lost by the transport.
  await client.ready();
  await waitUntil(() => client.recovery.list().length === 1);
  await waitUntil(() => client.recovery.list()[0]?.snapshotFresh === true, 10_000);
  assert.equal(proxy.commands.length, 1, "nothing is recovered automatically");
  const visible = () => terminalText(terminal.output);
  await waitUntil(() => visible().includes("Unconfirmed: 1"));
  assert.ok(visible().includes("One original 世界"), "the panel previews the original unconfirmed input");
  assert.ok(visible().includes("may duplicate work"), "the panel explains original-ID recovery vs re-entry");
  assert.ok(visible().includes("never aborts remote work"), "the panel explains the local-only discard scope");
  assert.ok(client.notices.some((notice) => notice.includes("Use /recover to resend the original input")));
  // A typed draft is cleared and must never substitute for the retained original intent.
  terminal.type("draft never sent");
  terminal.input!("\x15"); // Ctrl+U deletes to line start.
  terminal.type("/recover");
  terminal.input!("\r");
  await waitUntil(() => proxy.commands.length === 2, 10_000);
  assert.equal(proxy.commands[1].raw, proxy.commands[0].raw, "recovery resends the exact original wire frame");
  for (const command of proxy.commands) assert.ok(!frameText(command.raw).includes("draft never sent"), "the editor draft was not substituted");
  await waitUntil(() => client.notices.some((notice) => notice.includes("Recovered input durably admitted")));
  assert.ok(client.notices.some((notice) => notice.includes("not an answer-completion acknowledgement")), "admission wording is distinct from a final answer");
  assert.equal(client.recovery.list().length, 0, "success removes exactly the recovered receipt");
  release.resolve();
  await waitUntil(() => transcriptText(client.views.current()).includes("recovered-final") && Object.keys(client.views.current().tasks.tasks).length === 0, 10_000);
  assert.equal(f.faux.state.callCount, 1, "one input; the harness deduplicated the original request ID");
  assert.equal(userEntries(client), 1);
});

test("multiple retained receipts are counted, targeted oldest-first, and discarded without loss", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.beforeClose.push(() => release.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("first-final"); }, fauxAssistantMessage("second-final")]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "drop-admitted-replies");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
  const terminal = new TestTerminal();
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; client.close(); });
  await client.ready();
  terminal.type("First retained input");
  terminal.input!("\r");
  await entered.promise;
  await client.ready();
  await waitUntil(() => client.recovery.list().length === 1);
  await waitUntil(() => client.recovery.list()[0]?.snapshotFresh === true, 10_000);
  terminal.type("second uncertain input");
  terminal.input!("\r");
  await waitUntil(() => client.notices.some((notice) => notice.includes("remain unconfirmed and retained")));
  await client.ready();
  await waitUntil(() => client.recovery.list().length === 2, 10_000);
  const [oldest, second] = client.recovery.list();
  assert.ok(oldest && second && oldest.requestId !== second.requestId);
  const visible = () => terminalText(terminal.output);
  await waitUntil(() => visible().includes("Unconfirmed: 2"));
  await client.ready(); // The panel can first render during the reconnect window; wait for a settled connection.
  assert.ok(visible().includes("Unconfirmed: 2; /recover → oldest"), "the retained count without loss is visible");
  assert.ok(visible().includes('"First retained input"'), "the detailed /recover target is the oldest receipt");
  terminal.type("/discard");
  terminal.input!("\r");
  await waitUntil(() => client.recovery.list().length === 1, 10_000);
  assert.equal(client.recovery.list()[0].requestId, second.requestId, "discard removed exactly the oldest and re-targeted the next");
  assert.equal(proxy.commands.length, 2, "discard sent no remote message");
  terminal.type("/recover");
  terminal.input!("\r");
  await waitUntil(() => proxy.commands.length === 3, 10_000);
  assert.equal(proxy.commands[2].raw, proxy.commands[1].raw, "recovery of the remaining receipt resends its exact original frame");
  // The proxy drops this resend's admitted reply too, so the same receipt is honestly retained as uncertain again.
  await waitUntil(() => client.notices.some((notice) => notice.includes("Recovery outcome still unknown")));
  assert.equal(client.recovery.list().length, 1);
  assert.equal(client.recovery.list()[0].requestId, second.requestId);
  release.resolve();
  await waitUntil(() => transcriptText(client.views.current()).includes("second-final"), 10_000);
  assert.equal(userEntries(client), 2, "no duplicate input was created by the recovery resend");
});

test("a disconnected client refuses /recover, keeps the receipt, and reconnect never auto-recovers", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.beforeClose.push(() => release.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("disconnect-final"); }]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "drop-admitted-reply");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
  const terminal = new TestTerminal();
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; client.close(); });
  await client.ready();
  terminal.type("Disconnect probe");
  terminal.input!("\r");
  await entered.promise;
  await client.ready();
  await waitUntil(() => client.recovery.list().length === 1 && client.recovery.list()[0]?.snapshotFresh === true, 10_000);
  // Gate the replacement snapshot so the connection cannot become fresh before the refused attempt is asserted.
  const gate = proxy.holdViews();
  client.reconnectNow();
  await waitUntil(() => client.state !== "connected");
  terminal.type("/recover");
  terminal.input!("\r");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(proxy.commands.length, 1, "nothing is sent while disconnected");
  assert.equal(client.recovery.list().length, 1, "the refused attempt keeps the receipt");
  assert.ok(client.notices.some((notice) => notice.includes("Recovery refused") && notice.includes("fresh connected snapshot")));
  gate.release();
  await waitUntil(() => client.state === "connected" && client.recovery.list()[0]?.snapshotFresh === true, 10_000);
  assert.equal(proxy.commands.length, 1, "reconnect and the fresh snapshot never auto-recover");
  terminal.type("/recover");
  terminal.input!("\r");
  await waitUntil(() => proxy.commands.length === 2, 10_000);
  assert.equal(proxy.commands[1].raw, proxy.commands[0].raw, "the explicit action resends the exact original frame");
  await waitUntil(() => client.notices.some((notice) => notice.includes("Recovered input durably admitted")));
  assert.equal(client.recovery.list().length, 0);
  release.resolve();
});

test("/recover is refused while the post-uncertainty snapshot is still pending", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.beforeClose.push(() => release.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("stale-final"); }]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "fail-admitted-reply");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
  const terminal = new TestTerminal();
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; client.close(); });
  await client.ready();
  const gate = proxy.holdViews(); // Armed before submitting: the resync snapshot stays withheld.
  terminal.type("Stale probe");
  terminal.input!("\r");
  await entered.promise;
  await waitUntil(() => client.recovery.list().length === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(client.recovery.list()[0].snapshotFresh, false, "no snapshot postdates the uncertain outcome yet");
  terminal.type("/recover");
  terminal.input!("\r");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(proxy.commands.length, 1, "no recovery frame is sent against a stale snapshot");
  assert.equal(client.recovery.list().length, 1, "the refused attempt keeps the receipt");
  assert.ok(client.notices.some((notice) => notice.includes("Recovery refused") && notice.includes("fresh snapshot")));
  gate.release();
  await waitUntil(() => client.recovery.list()[0]?.snapshotFresh === true, 10_000);
  assert.equal(proxy.commands.length, 1, "the arriving snapshot does not auto-recover");
  terminal.type("/recover");
  terminal.input!("\r");
  await waitUntil(() => proxy.commands.length === 2, 10_000);
  assert.equal(proxy.commands[1].raw, proxy.commands[0].raw, "the delayed explicit recovery still resends the exact original frame");
  await waitUntil(() => client.notices.some((notice) => notice.includes("Recovered input durably admitted")));
  assert.equal(client.recovery.list().length, 0);
  release.resolve();
});

test("/recover refuses a different persisted identity and /discard still forgets locally", { timeout: 10_000 }, async (t) => {
  // A minimal protocol-faithful ws server whose persisted identity can change between resyncs.
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const epoch = "identity-epoch";
  let identity = "session-A";
  let sentCommands = 0;
  const snapshot = () => JSON.stringify({
    protocolVersion: 1, epoch, type: "snapshot", revision: 1,
    view: {
      session: { databasePath: "/tmp/tui-identity.sqlite", cwd: "/tmp" },
      model: { provider: "faux", modelId: "faux-model" },
      conversation: { conversation: { id: 11 }, entries: [], docs: { "pi.provider": { sessionId: identity } } },
      tasks: { tasks: {} },
    },
  });
  server.on("connection", (ws) => {
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ClientMessage;
      if (message.type === "hello" || message.type === "resync") ws.send(snapshot());
      else if (message.type === "command") {
        sentCommands++;
        ws.send(JSON.stringify({ protocolVersion: 1, epoch, type: "reply", id: message.id, ok: false, code: "COMMAND_FAILED", error: "ambiguous" }));
      }
    });
  });
  const client = new RemoteClient({ url: `ws://127.0.0.1:${address.port}/` });
  t.after(() => client.close()); // Registered first so it runs before the WebSocketServer close, which waits for peers.
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const terminal = new TestTerminal();
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; });
  await client.ready();
  terminal.type("Identity probe");
  terminal.input!("\r");
  await waitUntil(() => client.recovery.list().length === 1);
  await waitUntil(() => client.recovery.list()[0]?.snapshotFresh === true, 10_000); // The auto-resync delivered snapshot A.
  identity = "session-B";
  terminal.input!("\x12"); // Ctrl+R resync delivers snapshot B: same epoch, different persisted identity.
  await waitUntil(() => (client.views.current().conversation.docs["pi.provider"] as { sessionId?: unknown } | undefined)?.sessionId === "session-B", 10_000);
  terminal.type("/recover");
  terminal.input!("\r");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sentCommands, 1, "a mismatched identity sends nothing");
  assert.equal(client.recovery.list().length, 1, "the refused attempt keeps the receipt");
  assert.ok(client.notices.some((notice) => notice.includes("different conversation")));
  terminal.type("/discard");
  terminal.input!("\r");
  await waitUntil(() => client.recovery.list().length === 0, 10_000);
  assert.equal(sentCommands, 1, "discard still sends no remote message");
});

test("repeated /recover and /discard during an in-flight attempt are refused without losing the receipt", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.beforeClose.push(() => release.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("in-flight-final"); }]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "drop-admitted-reply");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
  const terminal = new TestTerminal();
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; client.close(); });
  await client.ready();
  terminal.type("In-flight probe");
  terminal.input!("\r");
  await entered.promise;
  await client.ready();
  await waitUntil(() => client.recovery.list().length === 1 && client.recovery.list()[0]?.snapshotFresh === true, 10_000);
  const held = proxy.hold(client.recovery.list()[0].requestId); // Arm before /recover so the resend is held at the proxy.
  terminal.type("/recover");
  terminal.input!("\r");
  await held.received;
  await waitUntil(() => terminalText(terminal.output).includes("Recovery in flight"), 5000);
  const afterResend = proxy.commands.length;
  assert.equal(afterResend, 2, "the original send plus the held explicit resend");
  terminal.type("/recover");
  terminal.input!("\r");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(proxy.commands.length, afterResend, "no third transmission while one attempt is in flight");
  assert.ok(client.notices.some((notice) => notice.includes("already in flight")));
  terminal.type("/discard");
  terminal.input!("\r");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(proxy.commands.length, afterResend);
  assert.ok(client.notices.some((notice) => notice.includes("Discard refused") && notice.includes("in flight")));
  assert.equal(client.recovery.list().length, 1, "the receipt survived both refused actions");
  held.release();
  await waitUntil(() => client.notices.some((notice) => notice.includes("Recovered input durably admitted")), 10_000);
  assert.equal(client.recovery.list().length, 0);
  release.resolve();
  await waitUntil(() => transcriptText(client.views.current()).includes("in-flight-final") && Object.keys(client.views.current().tasks.tasks).length === 0, 10_000);
  assert.equal(f.faux.state.callCount, 1);
  assert.equal(userEntries(client), 1);
});

test("notice churn cannot erase the receipt or its panel source; /discard still clears it", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.beforeClose.push(() => release.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("churn-final"); }]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "drop-admitted-reply");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
  const terminal = new TestTerminal();
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; client.close(); });
  await client.ready();
  terminal.type("Churn probe");
  terminal.input!("\r");
  await entered.promise;
  await client.ready();
  await waitUntil(() => client.recovery.list().length === 1 && client.recovery.list()[0]?.snapshotFresh === true, 10_000);
  for (let index = 0; index < 25; index++) client.notice(`noise ${index}`);
  await waitUntil(() => client.notices.slice(-1)[0] === "noise 24");
  assert.ok(client.notices.slice(-3).every((notice) => !notice.includes("Churn probe")), "the old bounded-notice record churned out of view");
  assert.ok(recoveryStatusText(client).includes("Churn probe"), "the panel still renders from the receipt store");
  assert.match(recoveryStatusText(client), /Unconfirmed: 1/);
  // The churned-out panel content is still fully visible as a current rendered frame at narrow width.
  const narrowFrame = panelFrame(client, 36).join("\n");
  assert.ok(narrowFrame.includes("Churn probe") && narrowFrame.includes("local receipt only") && narrowFrame.includes("never aborts remote work"));
  terminal.type("/discard");
  terminal.input!("\r");
  await waitUntil(() => client.recovery.list().length === 0, 10_000);
  assert.equal(recoveryStatusText(client), "", "the panel source is empty after the local-only discard");
  assert.equal(proxy.commands.length, 1, "discard sent no remote message");
  release.resolve();
});

test("with nothing retained, /recover and /discard are local notices that are never forwarded or re-entered", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("unused-final")]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "pass");
  const client = new RemoteClient({ url: proxy.url });
  const terminal = new TestTerminal();
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; client.close(); });
  await client.ready();
  terminal.type("/recover");
  terminal.input!("\r");
  terminal.type("/discard");
  terminal.input!("\r");
  await waitUntil(() => client.notices.some((notice) => notice.includes("/recover: no unconfirmed submission")));
  assert.ok(client.notices.some((notice) => notice.includes("/discard: no unconfirmed submission")));
  assert.equal(proxy.commands.length, 0, "local commands never reach the server");
  terminal.type("history marker α");
  terminal.input!("\r");
  await waitUntil(() => client.notices.some((notice) => notice.includes("durably admitted")));
  await waitUntil(() => transcriptText(client.views.current()).includes("unused-final") && Object.keys(client.views.current().tasks.tasks).length === 0, 10_000);
  terminal.type("/recover");
  terminal.input!("\r");
  await waitUntil(() => client.notices.filter((notice) => notice.includes("/recover: no unconfirmed submission")).length === 2);
  assert.equal(proxy.commands.length, 1, "only the real submit was sent");
  await new Promise((resolve) => setTimeout(resolve, 150)); // Let the notice's render land before the delta window.
  const before = terminal.output.length;
  terminal.input!("\x1b[A"); // Up arrow loads editor history.
  const delta = () => terminalText(terminal.output.slice(before)); // Editor cursor styling splits raw strings.
  await waitUntil(() => delta().includes("history marker α"));
  assert.ok(!delta().includes("/recover"), "the local command was never added to editor history");
});

test("closing the TUI loses the in-memory receipt without aborting the remote run", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.beforeClose.push(() => release.resolve());
  f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("close-final"); }]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "drop-admitted-reply");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
  const terminal = new TestTerminal();
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; client.close(); });
  await client.ready();
  terminal.type("Close probe");
  terminal.input!("\r");
  await entered.promise;
  await client.ready();
  await waitUntil(() => client.recovery.list().length === 1, 10_000);
  terminal.input!("\x03"); // Ctrl+C: exit without abort.
  await ui;
  assert.equal(client.state, "closed");
  assert.equal(proxy.commands.length, 1, "exit sent nothing further");
  assert.ok(proxy.commands.every((command) => frameText(command.raw) !== "abort"), "no abort was ever sent");
  release.resolve(); // The remote run continues and completes after the client is gone.
  await waitUntil(() => transcriptText(server.currentView()).includes("close-final") && Object.keys(server.currentView().tasks.tasks).length === 0, 10_000);
  const witness = new RemoteClient({ url: server.url });
  t.after(() => witness.close());
  witness.start();
  await witness.ready();
  assert.equal(witness.recovery.list().length, 0, "receipts live only in the closed client's memory");
});

test("the current recovery panel frame keeps count and safety guidance visible at narrow widths", () => {
  // Actual receipt store, released layout components, no sockets: the same presentation repro shape reviewers use.
  const identity = "12345678-1234-4123-8123-123456789abc";
  const state = new RecoveryState({
    connected: () => true,
    identity: () => identity,
    transmit: () => { throw new Error("no transmission in a presentation test"); },
  }, 8);
  const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
  for (const [index, text] of ["First retained input", "second uncertain input"].entries()) {
    state.provision(ids[index]!, { name: "submit", conversationId: 1, text, whenBusy: "reject" } as unknown as Command, identity);
    state.settled(ids[index]!, "ambiguous");
  }
  state.markFreshSnapshot();
  const client = { recovery: state };
  for (const columns of [36, 100]) {
    const frame = panelFrame(client, columns);
    const visible = frame.join("\n");
    assert.ok(frame.length <= recoveryPanelMaxRows, `the panel frame fits its layout budget at ${columns} columns (${frame.length} rows)`);
    assert.ok(visible.includes("Unconfirmed: 2; /recover → oldest"), "count and deterministic oldest target are visible");
    assert.ok(visible.includes("may duplicate work"), "the duplicate-work warning is visible in the current frame");
    assert.ok(visible.includes("never aborts remote work") && visible.includes("local receipt only"), "the local-only discard instruction is visible");
    assert.ok(visible.includes('"First retained input"') && visible.includes("aaaaaaaa…"), "the oldest target's preview and original request ID are visible");
    assert.ok(visible.includes("Ready"), "a connected fresh-snapshot same-identity target reads as ready");
  }
});

test("panel readiness matches authoritative eligibility for mismatched, missing identity and disconnection", async () => {
  const identity = "12345678-1234-4123-8123-123456789abc";
  let currentIdentity: string | undefined = identity;
  let connected = true;
  const state = new RecoveryState({
    connected: () => connected,
    identity: () => currentIdentity,
    transmit: () => { throw new Error("no transmission in a presentation test"); },
  }, 8);
  state.provision("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { name: "submit", conversationId: 1, text: "Identity probe", whenBusy: "reject" } as unknown as Command, identity);
  state.settled("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "ambiguous");
  state.markFreshSnapshot();
  const client = { recovery: state };
  const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  for (const [nextIdentity, nextConnected, expectedEligibility, expectedStatus, expectedRefusal] of [
    ["99999999-9999-4999-8999-999999999999", true, "different-identity", "Refused (different conversation)", /different conversation; recovery is refused/],
    [undefined, true, "missing-identity", "Refused (no conversation identity)", /no persisted conversation identity; recovery is refused/],
    [identity, false, "disconnected", "Needs a connected snapshot", /fresh connected snapshot/],
  ] as const) {
    currentIdentity = nextIdentity;
    connected = nextConnected;
    const visible = panelFrame(client, 36).join("\n");
    assert.equal(state.eligibility(requestId), expectedEligibility, "the read-only eligibility check agrees with recover()'s guard");
    assert.ok(visible.includes(expectedStatus), `"${expectedStatus}" is shown in the current rendered frame`);
    assert.ok(visible.includes('"Identity probe"'), "the refused target's original input preview stays visible beside its refusal status");
    assert.ok(!visible.includes("Ready"), "the panel never displays readiness while recovery would be refused");
    await assert.rejects(state.recover(requestId), expectedRefusal);
    assert.equal(state.list().length, 1, "the refused recovery keeps the receipt");
  }
});

test("the complete height-constrained 36×20 layout keeps the refused /recover target's preview visible", () => {
  // Reproduces the released viewport squeeze: two retained receipts, wrapped notices and a multiline editor draft
  // at 36×20, where the panel previously lost the preview row exactly when readiness read as a refusal.
  const identity = "12345678-1234-4123-8123-123456789abc";
  const constrainedFrame = (currentIdentity: string | undefined, expectedStatus: string, original: string, count: number): string[] => {
    const state = new RecoveryState({
      connected: () => true,
      identity: () => currentIdentity,
      transmit: () => { throw new Error("no transmission in a presentation test"); },
    }, 8);
    const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
    for (const [index, text] of [original, "second uncertain input"].slice(0, count).entries()) {
      state.provision(ids[index]!, { name: "submit", conversationId: 1, text, whenBusy: "reject" } as unknown as Command, identity);
      state.settled(ids[index]!, "ambiguous");
    }
    state.markFreshSnapshot();
    const terminal = new TestTerminal();
    terminal.rows = 20;
    terminal.columns = 36;
    const editor = new Editor(new TuiAltScreen(terminal, true), monochromeEditorTheme);
    editor.setText(Array.from({ length: 12 }, (_, index) => `Multiline draft line ${index + 1}`).join("\n"));
    const root = tuiLayoutRoot(
      new Text("CONNECTED\nfaux/faux-model | /tmp | 1 active tasks", 0, 0),
      new ScrollView(new Text("Committed transcript example"), { follow: "end", primary: true }),
      new Text(recoveryStatusText({ recovery: state }), 0, 0),
      new Text("Long notice one that wraps across two lines\nLong notice two that also wraps", 0, 0),
      editor,
      new Text("Enter: follow-up | Shift+Enter: newline | /recover or /discard: resolve unconfirmed input | Ctrl+A: abort | Ctrl+R: resync | Ctrl+C: exit (work continues) | PageUp/Down: scroll", 0, 0),
    );
    const frame = renderLayoutFrame(root, 36, 20, () => {}).lines.map((line) => stripTerminalSequences(line).trimEnd());
    // The panel's full content must appear contiguously: every line stays one rendered row and none is clipped.
    const panel = recoveryStatusText({ recovery: state }).split("\n");
    assert.equal(panel.length, recoveryPanelMaxRows, "the panel renders exactly one row per line at its budget");
    const start = frame.indexOf(panel[0]!);
    assert.ok(start !== -1, "the panel count row is visible in the constrained frame");
    assert.deepEqual(frame.slice(start, start + panel.length), panel, "the complete panel (readiness and preview included) is visible without clipping");
    assert.equal(panel[1], expectedStatus);
    assert.ok(panel.every((line) => visibleWidth(line) <= 36), "each panel line fits the actual terminal columns");
    assert.ok(panel[0]!.includes(`Unconfirmed: ${count}`));
    assert.ok(panel[2]!.includes("aaaaaaaa…"), "the original ID remains visible");
    const preview = panel[2]!.split('"')[1]!;
    const untruncated = preview.endsWith("…") ? preview.slice(0, -1) : preview;
    assert.ok(original.startsWith(untruncated), "the preview is an original prefix");
    const boundaries = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(original)]
      .map(({ index, segment }) => index + segment.length);
    assert.ok(boundaries.includes(untruncated.length), "the preview ends on a complete grapheme");
    const retainedCommand = state.list()[0]!.command;
    assert.equal(retainedCommand.name === "submit" && retainedCommand.text, original, "presentation never changes the frozen original");
    return frame;
  };
  for (const [currentIdentity, expectedStatus] of [
    [identity, "Ready"],
    ["99999999-9999-4999-8999-999999999999", "Refused (different conversation)"],
    [undefined, "Refused (no conversation identity)"],
  ] as const) {
    for (const original of ["First retained input", "界".repeat(21), "👩🏽‍💻".repeat(21), "e\u0301".repeat(30), "界👩🏽‍💻e\u0301".repeat(10)]) {
      for (const count of [1, 2]) {
        const frame = constrainedFrame(currentIdentity, expectedStatus, original, count);
        assert.equal(frame.length, 20, "the frame is the full constrained viewport");
      }
    }
  }
});

for (const scenario of ["whitespace-only", "cleared draft", "cleared /recover", "expanded paste"] as const) {
  test(`blocked Enter preserves the current Editor draft: ${scenario}`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(t);
    f.faux.setResponses([fauxAssistantMessage("current-draft-final")]);
    const server = await f.start();
    const proxy = await faultProxy(t, server.url, "pass");
    const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
    const terminal = new TestTerminal();
    let editor: Editor | undefined;
    const originalRender = Editor.prototype.render;
    Editor.prototype.render = function (width) { editor = this; return originalRender.call(this, width); };
    t.after(() => { Editor.prototype.render = originalRender; });
    const ui = runRemoteTui(client, terminal);
    t.after(async () => { terminal.input?.("\x03"); await ui; client.close(); });
    await client.ready();
    await waitUntil(() => editor !== undefined);
    if (scenario === "cleared /recover") {
      terminal.type("/recover");
      terminal.input!("\r");
      assert.equal(editor!.getText(), "");
    }
    const gate = proxy.holdViews();
    t.after(() => gate.release());
    client.reconnectNow();
    let expected = "";
    if (scenario === "whitespace-only") {
      terminal.type("   ");
      expected = "   ";
    } else if (scenario === "expanded paste") {
      expected = `  ${Array.from({ length: 12 }, (_, i) => `paste line ${i}`).join("\n")}  `;
      terminal.input!(`\x1b[200~${expected}\x1b[201~`);
      assert.ok(editor!.getText().includes("[paste #"), "the actual Editor uses a paste marker");
      assert.equal(editor!.getExpandedText(), expected);
    } else {
      terminal.type(scenario === "cleared draft" ? "  obsolete draft  " : "/recover");
      terminal.input!("\x15"); // A genuine clear must replace, not preserve, earlier cached input.
      assert.equal(editor!.getText(), "");
    }
    terminal.input!("\r");
    assert.equal(editor!.getExpandedText(), expected, "blocked Enter retains exactly the current raw draft");
    assert.equal(proxy.commands.length, 0, "disconnected input is not transmitted");
    terminal.type("!");
    assert.equal(editor!.getExpandedText(), `${expected}!`);
    gate.release();
    await client.ready();
    assert.equal(editor!.getExpandedText(), `${expected}!`, "reconnect never substitutes another draft");
    terminal.input!("\r");
    await waitUntil(() => proxy.commands.length === 1);
    assert.equal(frameText(proxy.commands[0]!.raw), `${expected}!`.trim(), "ordinary transmission still trims");
    await waitUntil(() => transcriptText(client.views.current()).includes("current-draft-final") && Object.keys(client.views.current().tasks.tasks).length === 0);
  });
}

test("a local async rejection never restores over newer typing or a genuine clear", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "pass");
  const client = new RemoteClient({ url: proxy.url });
  const terminal = new TestTerminal();
  let editor: Editor | undefined;
  const originalRender = Editor.prototype.render;
  Editor.prototype.render = function (width) { editor = this; return originalRender.call(this, width); };
  t.after(() => { Editor.prototype.render = originalRender; });
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; client.close(); });
  await client.ready();
  await waitUntil(() => editor !== undefined);
  for (const clearNewDraft of [false, true]) {
    terminal.input!("\x15");
    terminal.type("   ");
    const previousNotices = client.notices.length;
    terminal.input!("\r"); // Trimmed empty submission rejects locally on a promise, before any wire send.
    terminal.type("newer typing");
    if (clearNewDraft) terminal.input!("\x15");
    await waitUntil(() => client.notices.length > previousNotices && !editor!.disableSubmit);
    assert.equal(editor!.getText(), clearNewDraft ? "" : "newer typing", "the rejected draft cannot replace a newer edit, even when now empty");
    assert.equal(proxy.commands.length, 0);
    assert.equal(client.recovery.list().length, 0);
  }
});

test("a blocked ordinary submission preserves the exact typed draft, whitespace included", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.beforeClose.push(() => release.resolve());
  f.faux.setResponses([
    async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("draft-final"); },
    fauxAssistantMessage("reentry-final"),
  ]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "drop-admitted-reply");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
  const terminal = new TestTerminal();
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; client.close(); });
  await client.ready();
  terminal.type("Draft probe");
  terminal.input!("\r");
  await entered.promise;
  await client.ready();
  await waitUntil(() => client.recovery.list().length === 1 && client.recovery.list()[0]?.snapshotFresh === true, 10_000);
  // Gate the replacement snapshot so ordinary submissions are refused while disconnected.
  const gate = proxy.holdViews();
  client.reconnectNow();
  await waitUntil(() => client.state !== "connected");
  terminal.type("  original draft  ");
  terminal.input!("\r"); // Blocked: the Editor already trimmed and cleared, so the restore must reuse the raw draft.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(proxy.commands.length, 1, "nothing is sent while disconnected");
  // Appending one character exposes exactly what the editor retained: lost whitespace would alter the re-entry text.
  terminal.type("!");
  gate.release();
  await waitUntil(() => client.state === "connected" && client.recovery.list()[0]?.snapshotFresh === true, 10_000);
  terminal.input!("\r"); // Ordinary re-entry of the retained draft.
  await waitUntil(() => proxy.commands.length === 2, 10_000);
  assert.equal(frameText(proxy.commands[1].raw), "original draft  !", "the blocked Enter preserved the exact typed draft including surrounding whitespace");
  release.resolve();
  await waitUntil(() => transcriptText(client.views.current()).includes("reentry-final") && Object.keys(client.views.current().tasks.tasks).length === 0, 10_000);
  assert.equal(f.faux.state.callCount, 2, "ordinary re-entry deliberately creates a second submission");
  assert.equal(userEntries(client), 2);
});
