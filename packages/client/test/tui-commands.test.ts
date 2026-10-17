import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Editor, ScrollView, stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import type { RemoteView } from "@sof/durable-remote-protocol";
import { NotConnectedError, RemoteClient, runRemoteTui } from "../src/index.ts";
import { terminalText, transcriptText } from "../src/render.ts";
import { operatorResponse } from "../src/tui.ts";
import type { ConnectionState } from "../src/remote.ts";
import { startDurableServer } from "../../server/src/index.ts";
import { fixture, waitUntil } from "../../server/test/helpers.ts";
import { faultProxy } from "./fixtures/fault-proxy.ts";
import { TestTerminal } from "./fixtures/test-terminal.ts";

const userEntries = (client: RemoteClient) => client.views.current().conversation.entries.filter((entry) => entry.kind === "pi.user").length;
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const tick = (ms = 25) => new Promise((done) => setTimeout(done, ms));

/** Minimal authoritative RemoteView; the helper reads only session, model and tasks. */
const makeView = (options: { cwd?: string; databasePath?: string; provider?: string; modelId?: string; tasks?: Record<string, unknown> } = {}): RemoteView => ({
  session: { cwd: options.cwd ?? "/vm/work", databasePath: options.databasePath ?? "/vm/data/session.sqlite" },
  model: { provider: options.provider ?? "radius", modelId: options.modelId ?? "deepseek-v4.1-flash" },
  conversation: { conversation: { id: 1 }, entries: [] } as unknown as RemoteView["conversation"],
  tasks: { tasks: options.tasks ?? {} } as unknown as RemoteView["tasks"],
});

/** Fake of exactly the RemoteClient surface operatorResponse reads; current() throws like the real source. */
const fakeClient = (options: { state?: ConnectionState; epoch?: string; revision?: number; view?: RemoteView } = {}) => {
  const view = options.view;
  return {
    state: options.state ?? "connected",
    epoch: options.epoch ?? (view ? "epoch-9" : undefined),
    revision: options.revision ?? (view ? 42 : -1),
    views: {
      hasSnapshot: () => view !== undefined,
      current: () => {
        if (!view) throw new NotConnectedError();
        return view;
      },
    },
  } as unknown as Parameters<typeof operatorResponse>[0];
};

const SHORT_MARKERS = ["Local response", "Status · connection", "Configured model", "Remote cwd", "Remote database", "Work: idle", "Epoch/revision"];

test("operatorResponse: /status shows full authoritative values, work text and transport metadata while connected", () => {
  const response = operatorResponse(fakeClient({ view: makeView({ tasks: { "task-1": { abortRequested: false } } }) }), "/status");
  assert.equal(response?.command, "status");
  const text = response?.text ?? "";
  assert.ok(text.includes("radius/deepseek-v4.1-flash"), "the full provider and model id are shown");
  assert.ok(text.includes("/vm/work") && text.includes("/vm/data/session.sqlite"), "remote cwd and database path are shown untruncated");
  assert.ok(text.includes("1 active tasks"), "work state comes from sessionWorkText");
  assert.ok(text.includes("epoch-9") && text.includes("42"), "epoch and revision are shown");
  assert.ok(text.includes("transport metadata") && text.includes("not durable commit positions"), "epoch/revision are labeled as transport metadata");
  assert.ok(text.includes("fresh snapshot"), "a connected fresh snapshot is labeled as such");
});

test("operatorResponse: task work text distinguishes idle, active and cancelling", () => {
  const text = (tasks: Record<string, unknown>) => operatorResponse(fakeClient({ view: makeView({ tasks }) }), "/status")?.text ?? "";
  assert.ok(text({}).includes("Work: idle"));
  assert.ok(text({ a: {}, b: {} }).includes("2 active tasks"));
  assert.ok(text({ a: { abortRequested: true } }).includes("2 active tasks (cancelling)".replace("2", "1")));
});

test("operatorResponse: /model is read-only, shows the full configured model and refuses to hint at switching", () => {
  const response = operatorResponse(fakeClient({ view: makeView({ provider: "radius", modelId: "界🙂模型".repeat(3) }) }), "/model");
  assert.equal(response?.command, "model");
  const text = response?.text ?? "";
  assert.ok(text.includes("radius/界🙂模型界🙂模型界🙂模型"), "the full provider/modelId are shown untruncated");
  assert.ok(text.includes("switching is unsupported"), "the response explicitly states switching is unsupported");
  assert.ok(text.includes("server startup configuration"), "model selection is attributed to server startup only");
});

test("operatorResponse: without a snapshot values are honestly unavailable and current() is never called", () => {
  const client = fakeClient({ state: "connecting" });
  assert.throws(() => client.views.current(), NotConnectedError, "the fake mirrors the real source: no snapshot throws");
  const status = operatorResponse(client, "/status");
  assert.equal(status?.command, "status");
  assert.match(status?.text ?? "", /No server snapshot received yet/);
  assert.match(status?.text ?? "", /unavailable/);
  assert.match(status?.text ?? "", /Epoch\/revision.*unavailable \/ unavailable/);
  const model = operatorResponse(client, "/model");
  assert.match(model?.text ?? "", /unavailable/);
  assert.match(model?.text ?? "", /Switching is unsupported/);
  // /help works without any snapshot: it describes implemented commands and controls only.
  const help = operatorResponse(client, "/help");
  assert.equal(help?.command, "help");
  for (const marker of ["/status", "/model", "/recover or /discard", "submitted literally"]) assert.ok(help?.text.includes(marker));
});

test("operatorResponse: a cached view while disconnected/connecting/closed is labeled last-known/stale", () => {
  for (const state of ["disconnected", "connecting", "closed"] as const) {
    const status = operatorResponse(fakeClient({ state, view: makeView() }), "/status")?.text ?? "";
    assert.ok(status.includes(state), `the ${state} transport state is named`);
    assert.ok(status.includes("last-known/stale"), `the ${state} cached view is labeled last-known/stale, not fresh`);
    const model = operatorResponse(fakeClient({ state, view: makeView() }), "/model")?.text ?? "";
    assert.ok(model.includes("last-known/stale"), `the ${state} cached /model value is labeled last-known/stale, not fresh`);
    assert.ok(!model.includes("fresh"), `the ${state} /model response never claims freshness`);
  }
});

test("operatorResponse: remote strings are sanitized; metadata values are never truncated or inferred", () => {
  const response = operatorResponse(fakeClient({ epoch: "epoch\u001b[31m\u0007bad", view: makeView({ cwd: "/vm/\u001b[31;1m\u0007evil\u001b[0m", modelId: "mod\u0002el" }) }), "/status");
  const text = response?.text ?? "";
  assert.ok(!text.includes("\u001b") && !text.includes("\u0007") && !text.includes("\u0002"), "terminal-control bytes never reach the response");
  assert.ok(text.includes("evil") && text.includes("model") && text.includes("epochbad"), "the underlying values survive sanitization");
});

test("operatorResponse: the advertised search shortcut matches the released pi-tui binding", () => {
  const help = operatorResponse(fakeClient({ view: makeView() }), "/help")?.text ?? "";
  assert.ok(help.includes("Ctrl+Shift+F search"), "help advertises Ctrl+Shift+F, the released tui.altScreen.search binding");
  assert.ok(!/\^F\b/.test(help), "help never advertises ^F, which is the editor cursor-right shortcut");
});

test("operatorResponse: argument-bearing forms return local usage output and never pretend to act", () => {
  for (const [input, command] of [["/status now", "status"], ["/status\textra", "status"], ["/help me\nmore", "help"], ["/model gpt-5", "model"]] as const) {
    const response = operatorResponse(fakeClient({ view: makeView() }), input);
    assert.equal(response?.command, command, input);
    assert.match(response?.text ?? "", /takes no arguments/);
    assert.match(response?.text ?? "", /not sent/);
  }
});

test("operatorResponse: only the three exact command words are handled; everything else passes through", () => {
  const client = fakeClient({ view: makeView() });
  for (const input of ["/status-extra", "/statuses", "/Status", "/MODELS", "/modelx", "/models", "/help!", "/hel p", "/status/", "/etc/passwd", "/home", "status", "", "/recover", "/discard", "/recover now", "/discard now", "//status", "/statusful help"]) {
    assert.equal(operatorResponse(client, input), undefined, JSON.stringify(input));
  }
});

test("valid and invalid operator commands are purely local: no wire frame, model call, receipt, history or user entry", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("unused-final")]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "pass");
  const client = new RemoteClient({ url: proxy.url });
  const terminal = new TestTerminal();
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; client.close(); });
  await client.ready();
  const visible = () => terminalText(terminal.output);
  terminal.type("/status"); terminal.input!("\r");
  await waitUntil(() => visible().includes("Status · connection: connected"));
  terminal.type("/help"); terminal.input!("\r");
  await waitUntil(() => visible().includes("Local commands (never forwarded"));
  terminal.type("/model"); terminal.input!("\r");
  await waitUntil(() => visible().includes("Model (read-only"));
  terminal.type("/status now"); terminal.input!("\r");
  await waitUntil(() => visible().split("takes no arguments").length >= 2);
  terminal.type("/help me"); terminal.input!("\r");
  await waitUntil(() => visible().split("takes no arguments").length >= 3);
  terminal.type("/model x"); terminal.input!("\r");
  await waitUntil(() => visible().split("takes no arguments").length >= 4);
  assert.equal(proxy.commands.length, 0, "no operator command reached the server");
  assert.equal(f.faux.state.callCount, 0, "no model call was made");
  assert.equal(client.recovery.list().length, 0, "no recovery receipt was created");
  assert.equal(userEntries(client), 0, "no durable user entry was created");
  // The commands never entered editor history either.
  const before = terminal.output.length;
  terminal.input!("\x1b[A"); // Up arrow.
  await tick(100);
  const delta = terminalText(terminal.output.slice(before));
  for (const command of ["/status", "/help", "/model"]) assert.ok(!delta.includes(command), "operator commands never enter editor history");
});

test("unknown slash words, absolute paths and non-exact recovery/discard input still submit literally", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  f.faux.setResponses(["one-final", "two-final", "three-final", "four-final"].map((text) => fauxAssistantMessage(text)));
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "pass");
  const client = new RemoteClient({ url: proxy.url });
  const terminal = new TestTerminal();
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; client.close(); });
  await client.ready();
  const literals = ["/modelx please", "/etc/passwd", "/recover now", "/discard now"];
  const finals = ["one-final", "two-final", "three-final", "four-final"];
  for (const [index, text] of literals.entries()) {
    terminal.type(text);
    terminal.input!("\r");
    await waitUntil(() => proxy.commands.length === index + 1, 10_000);
    await waitUntil(() => transcriptText(client.views.current()).includes(finals[index]!) && Object.keys(client.views.current().tasks.tasks).length === 0, 20_000);
  }
  assert.deepEqual(proxy.commands.map((command) => (JSON.parse(command.raw) as { command: { text?: string; name: string } }).command.name === "submit" ? (JSON.parse(command.raw) as { command: { text: string } }).command.text : (JSON.parse(command.raw) as { command: { name: string } }).command.name), literals, "each ambiguous form was forwarded as exact literal text");
  assert.equal(f.faux.state.callCount, 4, "each literal submission made one model call");
});

test("/help, /status and /model work before the first snapshot and stay local and honest while unavailable", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "pass");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
  const terminal = new TestTerminal();
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; client.close(); });
  const gate = proxy.holdViews(); // Gate the initial snapshot.
  client.start();
  await waitUntil(() => client.state === "connecting");
  terminal.type("/help"); terminal.input!("\r");
  await waitUntil(() => terminalText(terminal.output).includes("Local commands (never forwarded"));
  assert.equal(proxy.commands.length, 0, "/help before readiness sends nothing");
  terminal.type("/status"); terminal.input!("\r");
  await waitUntil(() => terminalText(terminal.output).includes("No server snapshot received yet"));
  terminal.type("/model"); terminal.input!("\r");
  await waitUntil(() => terminalText(terminal.output).includes("Model: unavailable"));
  assert.equal(proxy.commands.length, 0, "/status and /model without a snapshot send nothing");
  gate.release();
  await client.ready();
  terminal.type("/status"); terminal.input!("\r");
  await waitUntil(() => terminalText(terminal.output).includes("Status · connection: connected"));
  assert.ok(terminalText(terminal.output).includes("faux/faux-1"), "the authoritative model appears after the snapshot");
});

test("an open response goes visibly stale while disconnected and refreshes from the reconnected snapshot", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("stale-final")]);
  const server = await f.start();
  const proxy = await faultProxy(t, server.url, "pass");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 });
  const terminal = new TestTerminal();
  let tui!: TuiAltScreen;
  const start = TuiAltScreen.prototype.start;
  t.mock.method(TuiAltScreen.prototype, "start", function(this: TuiAltScreen) { tui = this; return start.call(this); });
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; client.close(); });
  await client.ready();
  terminal.type("/status"); terminal.input!("\r");
  await waitUntil(() => terminalText(terminal.output).includes("(fresh snapshot)"));
  const gate = proxy.holdViews();
  client.reconnectNow();
  await waitUntil(() => client.state !== "connected", 10_000);
  await waitUntil(() => plain(tui.getScreenLines()).includes("last-known/stale"), 10_000);
  assert.ok(terminalText(terminal.output).includes("faux/faux-1"), "cached values are labeled, not hidden");
  assert.equal(proxy.commands.length, 0, "the stale response sent nothing");
  gate.release();
  await client.ready();
  // The open response refreshes itself from the fresh snapshot without retyping, and notices cannot erase it.
  await waitUntil(() => plain(tui.getScreenLines()).includes("(fresh snapshot)"), 10_000);
  for (let index = 0; index < 25; index++) client.notice(`noise ${index}`);
  await waitUntil(() => client.notices.slice(-1)[0] === "noise 24", 10_000);
  await tick(100);
  assert.ok(plain(tui.getScreenLines()).includes("(fresh snapshot)"), "notice churn does not erase the open response");
});

test("long unicode metadata and complete help are fully reachable through native paging, with Escape restoring the transcript", { timeout: 30_000 }, async (t) => {
  // Dedicated fixture: long Unicode cwd, database path and model id exercise real wrapping/scroll reachability.
  const cwd = await mkdtemp(join(tmpdir(), "durable-世界🙂-"));
  const databasePath = join(cwd, "session-模型存储.sqlite");
  const unicodeModelId = "界🙂模型".repeat(9);
  const faux = fauxProvider({ models: [{ id: unicodeModelId }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const server = await startDurableServer({ cwd, databasePath, models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id }, port: 0 });
  t.after(async () => { await server.close(); await rm(cwd, { recursive: true, force: true }); });
  faux.setResponses([fauxAssistantMessage(Array.from({ length: 40 }, (_, index) => `transcript-row-${index} 世界🙂`).join("\n"))]);
  const client = new RemoteClient({ url: server.url });
  const terminal = new TestTerminal(); terminal.rows = 20;
  let editor!: Editor; let tui!: TuiAltScreen;
  const scrolls: ScrollView[] = [];
  const editorInput = Editor.prototype.handleInput; const start = TuiAltScreen.prototype.start; const updateLayout = ScrollView.prototype.updateLayout;
  t.mock.method(Editor.prototype, "handleInput", function(this: Editor, data: string) { editor = this; editorInput.call(this, data); });
  t.mock.method(TuiAltScreen.prototype, "start", function(this: TuiAltScreen) { tui = this; return start.call(this); });
  t.mock.method(ScrollView.prototype, "updateLayout", function(this: ScrollView, ...args: Parameters<ScrollView["updateLayout"]>) { if (!scrolls.includes(this)) scrolls.push(this); return updateLayout.apply(this, args); });
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; client.close(); });
  await client.ready();
  await client.controller.submit("Make a long transcript");
  await waitUntil(() => transcriptText(client.views.current()).includes("transcript-row-") && Object.keys(client.views.current().tasks.tasks).length === 0, 20_000);
  const transcriptScroll = scrolls[0]!; // Constructed first inside runRemoteTui.
  transcriptScroll.scrollTo(10, { disableFollow: true }); tui.requestRender(); await tick();
  const scrollBefore = transcriptScroll.scrollTop;
  const capture = async (name: string) => {
    const directory = process.env.PI_UI_FRAME_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, `${name}.ansi`), tui.getScreenLines().join("\n") + "\n", { mode: 0o600 });
    await writeFile(join(directory, `${name}.txt`), plain(tui.getScreenLines()) + "\n", { mode: 0o600 });
  };
  const draftText = Array.from({ length: 12 }, (_, index) => `Draft line ${index + 1} 世界🙂`).join("\n");
  for (const width of [36, 80]) {
    terminal.columns = width; tui.requestRender();
    await tick();
    if (editor) editor.setText(""); // Clear any leftover draft so the command word is exact.
    // A new response starts at its beginning: the hint and first status rows are on the opening screen.
    terminal.type("/status"); terminal.input!("\r");
    await waitUntil(() => plain(tui.getScreenLines()).includes("Local response"));
    await tick();
    await capture(`commands-status-${width}`);
    assert.ok(plain(tui.getScreenLines()).includes("Status · connection"), "the response starts at its beginning");
    assert.ok(tui.getScreenLines().every((line) => visibleWidth(line) <= width), `every status line fits ${width} columns`);
    // A tall multiline draft squeezes the response scroll area, so paging must traverse real wrapped rows.
    editor.setText(draftText); terminal.input!("\x1b[D"); // Move left in the real Editor.
    const draft = editor.getExpandedText(); const cursor = editor.getCursor();
    await tick();
    const seen: string[] = [];
    for (let page = 0; page < 60; page++) {
      seen.push(...tui.getScreenLines().map((line) => stripTerminalSequences(line).trimEnd()));
      const beforeTop = scrolls[1]?.scrollTop ?? -1;
      terminal.input!("\x1b[6~"); // Real PageDown against the primary response ScrollView.
      await tick(15);
      if ((scrolls[1]?.scrollTop ?? -1) === beforeTop) break;
    }
    await capture(`commands-status-end-${width}`);
    const reached = seen.join("\n");
    for (const marker of SHORT_MARKERS) assert.ok(reached.includes(marker), `paging at ${width} columns reaches "${marker}"`);
    assert.ok(seen.filter((line) => line.includes("界")).length >= 2, `the long Unicode model id spans several reachable rows at ${width} columns`);
    assert.ok(plain(tui.getScreenLines()).includes("Epoch/revision"), "the final status line is on screen at the bottom");
    assert.ok(!plain(tui.getScreenLines()).includes("Local response"), "the top scrolled past: paging moved through real content");
    // Escape restores the retained transcript ScrollView without touching draft, cursor or its scroll state.
    terminal.input!("\x1b"); // Escape.
    await waitUntil(() => plain(tui.getScreenLines()).includes("transcript-row-"));
    assert.ok(!plain(tui.getScreenLines()).includes("Local response"), "escape closes the response");
    assert.equal(editor.getExpandedText(), draft); assert.deepEqual(editor.getCursor(), cursor);
    assert.equal(transcriptScroll.scrollTop, scrollBefore, "the original transcript scroll position is restored exactly");
    assert.equal(scrolls.length, 2, "the retained transcript ScrollView was reused, not rebuilt");
  }
  // Complete help is reachable the same way, at the narrow size, squeezed by the same draft.
  terminal.columns = 36; tui.requestRender(); await tick();
  editor.setText(""); // Clear the draft; the command word must be exact.
  terminal.type("/help"); terminal.input!("\r");
  await waitUntil(() => plain(tui.getScreenLines()).includes("Local commands"));
  editor.setText(draftText); terminal.input!("\x1b[D");
  await tick();
  const helpSeen: string[] = [];
  for (let page = 0; page < 60; page++) {
    helpSeen.push(...tui.getScreenLines().map((line) => stripTerminalSequences(line).trimEnd()));
    const beforeTop = scrolls[1]?.scrollTop ?? -1;
    terminal.input!("\x1b[6~");
    await tick(15);
    if ((scrolls[1]?.scrollTop ?? -1) === beforeTop) break;
  }
  const helpText = operatorResponse(client, "/help")?.text ?? "";
  for (const line of helpText.split("\n")) {
    const marker = line.length > 20 ? line.slice(0, 20) : line;
    assert.ok(helpSeen.some((row) => row.includes(marker)), `paging reaches the help line starting "${marker}"`);
  }
  await capture("commands-help-end-36");
  terminal.input!("\x1b");
  await waitUntil(() => plain(tui.getScreenLines()).includes("transcript-row-"));
});
