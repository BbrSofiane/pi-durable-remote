import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Editor, ScrollView, stripTerminalSequences, Text, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import type { RemoteView } from "@sof/durable-remote-protocol";
import { RemoteClient } from "../src/remote.ts";
import { toolPrimary, transcriptSections, transcriptText } from "../src/render.ts";
import { presentationTheme } from "../src/theme.ts";
import { RemoteTranscript } from "../src/transcript.ts";
import { runRemoteTui } from "../src/tui.ts";
import { fixture, waitUntil } from "../../server/test/helpers.ts";
import { TestTerminal } from "./fixtures/test-terminal.ts";

const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const call = (id: string, command: string) => ({ type: "toolCall", id, name: "bash", arguments: { command, timeout: 20 } });
const assistant = (...content: unknown[]) => ({ role: "assistant", content });
const result = (id: string, output: string, more = {}) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: output }], ...more });
function viewWith(base: RemoteView, messages: unknown[], tools: unknown[] = []): RemoteView {
  return { ...structuredClone(base), conversation: { ...structuredClone(base.conversation), entries: messages.map((message, index) => ({ id: index + 1, model: [message] })), docs: { "pi.live": { tools } } } } as unknown as RemoteView;
}
function freeze(value: unknown): void {
  if (!value || typeof value !== "object") return;
  Object.values(value).forEach(freeze); Object.freeze(value);
}

test("tool blocks: round-scoped reused IDs, reversed parallel results, live slots and orphans never cross-attach", async (t) => {
  const f = await fixture(t); const server = await f.start(); const base = server.currentView();
  const view = viewWith(base, [
    assistant(call("same", "find . -name '*.sqlite'"), call("parallel", "pwd")),
    result("parallel", "parallel-output"), result("same", "first-output", { durationMs: 17 }),
    assistant(call("same", "ls -la")), result("same", "second-output", { isError: true }),
    result("orphan", "orphan-output"),
  ], [{ callId: "same", name: "bash", entry: 5, status: "done" }, { callId: "unmatched", name: "read", taskId: 99, status: "running", output: "orphan-live" }]);
  freeze(view); const before = JSON.stringify(view);
  const sections = transcriptSections(view); const tools = sections.filter((section) => section.execution);
  assert.equal(tools.length, 5); assert.equal(sections.filter((section) => section.label === "Assistant").length, 0, "no redundant tool-only assistant labels");
  const text = (index: number) => tools[index]!.blocks.map((block) => block.text).join("\n");
  assert.match(text(0), /first-output/); assert.doesNotMatch(text(0), /second-output|parallel-output/);
  assert.match(text(1), /parallel-output/); assert.match(text(2), /second-output/); assert.match(text(3), /orphan-output/); assert.match(text(4), /orphan-live/);
  assert.match(tools[0]!.label, /done.*17ms/); assert.match(tools[2]!.label, /error/);
  assert.doesNotMatch(tools[1]!.label, /ms/); assert.equal(new Set(tools.map((section) => section.key)).size, tools.length);
  assert.equal(JSON.stringify(view), before, "frozen committed payload is untouched");
  assert.deepEqual(transcriptSections(structuredClone(view)).map((section) => section.key), sections.map((section) => section.key));

  for (const status of ["pending", "running", "done"]) {
    const current = viewWith(base, [assistant(call("same", "pwd"))], [{ callId: "same", name: "bash", status, output: "progress", diagnostics: [{ code: "warning", message: "committed diagnostic" }], details: { diff: "original diff" } }]);
    const grouped = transcriptSections(current);
    assert.equal(grouped.length, 1); assert.match(grouped[0]!.label, new RegExp(status === "done" ? "interrupted" : status));
    const content = grouped[0]!.blocks.map((block) => block.text).join("\n");
    for (const marker of ["progress", "original diff", "committed diagnostic"]) assert.ok(content.includes(marker), marker);
  }
  const unavailable = transcriptSections(viewWith(base, [assistant(call("same", "pwd")), assistant({ type: "text", text: "later round" }), result("same", "late orphan")]));
  assert.doesNotMatch(unavailable[0]!.blocks.map((block) => block.text).join("\n"), /late orphan/);
  assert.match(unavailable[0]!.label, /unavailable/);
  const notRun = viewWith(base, [assistant(call("same", "pwd")), result("same", "blocked", { isError: true })]);
  (notRun.conversation.entries[1] as unknown as { data: unknown }).data = { diagnostics: [{ code: "blocked", message: "policy" }] };
  assert.match(transcriptSections(notRun)[0]!.label, /not-run/);
});

test("tool blocks: decoded sanitized intent, measured Unicode previews and all original arguments/details stay accessible", async (t) => {
  const f = await fixture(t); const server = await f.start();
  const command = "find . -name '*.sqlite'\n# 世界 👩🏽‍💻 é\x1b]52;c;unsafe\x07";
  assert.equal(toolPrimary("bash", { command }), "$ find . -name '*.sqlite'\n# 世界 👩🏽‍💻 é");
  for (const name of ["read", "write", "edit"]) assert.equal(toolPrimary(name, { path: "/remote/src/index.ts" }), `${name} /remote/src/index.ts`);
  assert.equal(toolPrimary("unknown", { arbitrary: true }), "unknown");
  const output = "界🙂é👩🏽‍💻".repeat(120) + "\nFINAL-OUTPUT";
  const view = viewWith(server.currentView(), [assistant(call("a", command)), result("a", output, { details: { diff: "FULL-DIFF", diagnostic: "FULL-DIAGNOSTIC" } })]);
  freeze(view);
  for (const noColor of [true, false]) {
    const theme = presentationTheme(noColor, { colorMode: "truecolor" });
    for (const surface of [theme.userSurface, theme.toolSurface, theme.workingSurface, theme.errorSurface]) {
      const styled = surface("readable on light or dark canvas");
      if (noColor) assert.equal(styled, "readable on light or dark canvas");
      else {
        assert.match(styled, /\x1b\[38;2;[0-9;]+m/); assert.match(styled, /\x1b\[48;2;[0-9;]+m/, "every surface pairs an explicit foreground and background");
      }
    }
    const transcript = new RemoteTranscript(theme); transcript.update(view);
    for (const width of [36, 80, 100]) {
      const collapsed = transcript.render(width); const text = plain(collapsed);
      assert.ok(collapsed.every((line) => visibleWidth(line) <= width));
      assert.match(text, /\$ find \. -name/); assert.doesNotMatch(text, /FINAL-OUTPUT|FULL-DIFF|"timeout"|unsafe/);
      assert.match(text, /\d+ more rows · Ctrl\+O/);
      assert.ok(collapsed.length <= 11, "wide single logical output line is bounded by rendered rows");
      if (noColor) assert.doesNotMatch(collapsed.join("\n"), /\x1b/);
      else { assert.match(collapsed.join("\n"), /\x1b\[38;2;/); assert.match(collapsed.join("\n"), /\x1b\[48;2;/, "tool surfaces keep their paired colors in real renders"); }
    }
    transcript.update(viewWith(server.currentView(), [assistant(call("a", command))], [{ callId: "a", name: "bash", status: "running", output: "committed progress" }]));
    transcript.toggleExpanded();
    assert.match(plain(transcript.render(100)), /Arguments/);
    transcript.update(structuredClone(view)); // Finishing a tool must not reset the global choice.
    const expanded = plain(transcript.render(100));
    for (const marker of ["FINAL-OUTPUT", "FULL-DIFF", "FULL-DIAGNOSTIC", '"timeout": 20', "Arguments", "Committed details"]) assert.ok(expanded.includes(marker), marker);
    assert.doesNotMatch(expanded, /\x1b|\x07/);
    assert.match(expanded, /\\u001b\]52;c;unsafe\\u0007/, "original control bytes remain inert JSON escapes in full arguments");
    for (const marker of ["FINAL-OUTPUT", "FULL-DIFF", "FULL-DIAGNOSTIC", '"timeout":20']) assert.ok(transcriptText(view).includes(marker), `full plain diagnostics: ${marker}`);
    transcript.toggleExpanded(); assert.doesNotMatch(plain(transcript.render(36)), /FINAL-OUTPUT/);
  }
});

test("tool blocks: unchanged snapshots retain native tool wrapping caches, including labels and expansion hints", async (t) => {
  const f = await fixture(t); const server = await f.start(); const base = server.currentView();
  const messages: unknown[] = [];
  for (let index = 0; index < 100; index++) {
    messages.push(assistant(call(`cache-${index}`, `printf 'execution ${index}'`)));
    messages.push(result(`cache-${index}`, `execution ${index}: ` + "retained output row 世界🙂é\n".repeat(1024)));
  }
  const view = viewWith(base, messages);
  freeze(view);
  const transcript = new RemoteTranscript(presentationTheme(true)); transcript.update(view);
  const linesByText = new Map<Text, string[]>();
  const nativeRender = Text.prototype.render; const nativeSetText = Text.prototype.setText;
  const retainedInvalidations: Text[] = [];
  t.mock.method(Text.prototype, "render", function(this: Text, width: number) {
    const lines = nativeRender.call(this, width); linesByText.set(this, lines); return lines;
  });
  const warm = new Map<Text, string[]>();
  t.mock.method(Text.prototype, "setText", function(this: Text, text: string) {
    if (warm.has(this)) retainedInvalidations.push(this);
    nativeSetText.call(this, text);
  });
  const collapsed = transcript.render(80);
  for (const [component, lines] of linesByText) warm.set(component, lines);
  assert.equal(warm.size, 500, "each execution warms five native Text caches: label, primary, output, details, hint");
  for (let index = 0; index < 3; index++) {
    const cloned = structuredClone(view);
    const replacement: RemoteView = { ...cloned, conversation: { ...cloned.conversation, docs: { ...cloned.conversation.docs, "pi.live": { generation: { attempt: 1, retry: { at: index + 1, error: "unrelated retry update" } } } } } };
    transcript.update(replacement); transcript.render(80);
    assert.equal(retainedInvalidations.length, 0, "unchanged historical tools never call native setText, even during unrelated live changes");
    for (const [component, lines] of warm) assert.equal(linesByText.get(component), lines, "native wrapped-row array is retained, not just component identity");
  }
  transcript.update(structuredClone(view));
  assert.deepEqual(transcript.render(80), collapsed, "cache reuse preserves collapsed rendering");
  transcript.toggleExpanded(); transcript.render(80);
  // Expansion changes hints only; the full primary/output/details wrapping caches remain warm.
  assert.equal(retainedInvalidations.length, 100);
  for (const [component, lines] of warm) {
    if (!retainedInvalidations.includes(component)) assert.equal(linesByText.get(component), lines);
  }
  const changed = viewWith(base, [assistant(call("cache-0", "printf 'updated command'")), result("cache-0", "updated output", { isError: true, details: { diff: "updated diff" } })]);
  transcript.update(changed);
  const updated = plain(transcript.render(80));
  for (const marker of ["[error]", "updated command", "updated output", "updated diff"]) assert.ok(updated.includes(marker), marker);
});

test("tool blocks: real Ctrl+O stays local, preserves native draft/cursor/manual scroll and expansion through reconnect", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const command = "find . -maxdepth 1 -type f -name '*.sqlite*'; i=0; while [ \"$i\" -lt 24 ]; do printf 'tool row 世界 👩🏽‍💻 é\\n'; i=$((i+1)); done; printf 'FINAL-OUTPUT\\n'";
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command, timeout: 20 })], { stopReason: "toolUse" }), fauxAssistantMessage("Done.")]);
  const server = await f.start(); const client = new RemoteClient({ url: server.url, reconnectMinMs: 10 });
  const terminal = new TestTerminal(); terminal.rows = 20;
  let editor!: Editor; let tui!: TuiAltScreen; let scroll!: ScrollView;
  const editorInput = Editor.prototype.handleInput; const start = TuiAltScreen.prototype.start; const updateLayout = ScrollView.prototype.updateLayout;
  t.mock.method(Editor.prototype, "handleInput", function(this: Editor, data: string) { editor = this; editorInput.call(this, data); });
  t.mock.method(TuiAltScreen.prototype, "start", function(this: TuiAltScreen) { tui = this; return start.call(this); });
  t.mock.method(ScrollView.prototype, "updateLayout", function(this: ScrollView, ...args: Parameters<ScrollView["updateLayout"]>) { scroll = this; return updateLayout.apply(this, args); });
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; client.close(); });
  await client.ready(); await client.controller.submit("Show shell output");
  await waitUntil(() => Object.keys(client.views.current().tasks.tasks).length === 0 && transcriptText(client.views.current()).includes("Done."));
  terminal.type("draft 世界🙂"); terminal.input!("\x1b[D"); // Move left in the real Editor.
  await waitUntil(() => !!editor && !!scroll);
  const draft = editor.getExpandedText(); const cursor = editor.getCursor();
  scroll.scrollToStart(); tui.requestRender(); await new Promise((done) => setTimeout(done, 30));
  const send = t.mock.method(WebSocket.prototype, "send");
  const capture = async (name: string) => {
    const directory = process.env.PI_UI_FRAME_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lines = tui.getScreenLines();
    await writeFile(join(directory, `${name}.ansi`), lines.join("\n") + "\n", { mode: 0o600 });
    await writeFile(join(directory, `${name}.txt`), plain(lines) + "\n", { mode: 0o600 });
  };
  for (const width of [36, 80, 100]) {
    terminal.columns = width; tui.requestRender();
    await waitUntil(() => plain(tui.getScreenLines()).includes("$ find ."));
    await new Promise((done) => setTimeout(done, 30));
    // Establish genuinely manual, non-following history AFTER this width's frame is measured: native
    // scrollToStart keeps follow-end enabled while content is unmeasured, so a baseline taken then silently
    // re-follows on the next taller layout (observed 2 -> 3 under gate load). disableFollow pins scrollTop 0.
    scroll.scrollTo(0, { disableFollow: true }); tui.requestRender(); await new Promise((done) => setTimeout(done, 30));
    const top = scroll.scrollTop;
    await capture(`toolblocks-collapsed-${width}`);
    const calls = send.mock.callCount(); terminal.input!("\x0f"); // Real Ctrl+O.
    // At pinned scrollTop 0 the collapsed hint row is on screen; its disappearance is the laid-out expanded
    // frame ("Arguments" sits below the fold and cannot be a viewport predicate).
    await waitUntil(() => !plain(tui.getScreenLines()).includes("Ctrl+O to expand"));
    assert.equal(send.mock.callCount(), calls, "Ctrl+O sends no network frame of any kind");
    assert.equal(editor.getExpandedText(), draft); assert.deepEqual(editor.getCursor(), cursor);
    assert.equal(scroll.scrollTop, top, "expansion resets neither manual scroll history nor its follow suppression");
    scroll.scrollToEnd(); tui.requestRender(); await new Promise((done) => setTimeout(done, 30));
    assert.match(plain(tui.getScreenLines()), /FINAL-OUTPUT|Committed details|Arguments/);
    await capture(`toolblocks-expanded-${width}`);
    assert.ok(tui.getScreenLines().every((line) => visibleWidth(line) <= width));
    terminal.input!("\x0f"); scroll.scrollTo(0, { disableFollow: true }); tui.requestRender(); await new Promise((done) => setTimeout(done, 30));
  }
  terminal.input!("\x0f"); client.reconnectNow(); await client.ready();
  scroll.scrollToEnd(); tui.requestRender(); await new Promise((done) => setTimeout(done, 30));
  assert.match(plain(tui.getScreenLines()), /Arguments|FINAL-OUTPUT|Committed details/, "expanded preference survives fresh whole snapshot and reconnect");
  assert.equal(editor.getExpandedText(), draft); assert.deepEqual(editor.getCursor(), cursor);
  assert.equal(f.faux.state.callCount, 2); assert.equal(client.recovery.list().length, 0);
});
