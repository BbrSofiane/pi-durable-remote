import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { mock } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { backgroundAnsi, Editor, ScrollView, stripTerminalSequences, Text, TuiAltScreen, visibleWidth, VStack } from "@earendil-works/pi-tui";
import type { TerminalColorMode } from "@earendil-works/pi-tui";
import type { RemoteView } from "@sof/durable-remote-protocol";
import { CommandOutcomeUnknownError, RemoteClient } from "../src/remote.ts";
import { sessionText, terminalText, transcriptSections, transcriptText } from "../src/render.ts";
import { presentationTheme } from "../src/theme.ts";
import type { Appearance } from "../src/theme.ts";
import { RemoteTranscript } from "../src/transcript.ts";
import { recoveryStatusText, RemoteFooter, tuiHelpText, tuiLayoutRoot, updateTuiChrome } from "../src/tui.ts";
import { fixture, waitUntil } from "../../server/test/helpers.ts";
import { faultProxy } from "./fixtures/fault-proxy.ts";
import { TestTerminal } from "./fixtures/test-terminal.ts";

const prose = "## Readable result\n\nA **clear answer** with `inline code` and 世界 👩🏽‍💻.\n\n- First action\n- Second action\n\n```ts\nconst greeting = '世界 👩🏽‍💻';\n" + "const longToken = '" + "界🙂".repeat(100) + "';\n```\n\n[Reference](https://example.test/docs)\n\nAnswer complete.";

/** Exact production native composition; before uses the pre-redesign Text transcript/chrome/theme. */
async function frame(client: RemoteClient, view: RemoteView, columns: number, noColor: boolean, before = false, options: { appearance?: Appearance; colorMode?: TerminalColorMode } = {}) {
  const terminal = new TestTerminal(); terminal.columns = columns; terminal.rows = 20;
  const tui = new TuiAltScreen(terminal, true);
  const theme = presentationTheme(noColor, options);
  const rich = new RemoteTranscript(theme); rich.update(view);
  const content = before ? new Text(transcriptText(view), 0, 0) : rich;
  const scroll = new ScrollView(content, { follow: "end", primary: true });
  const header = before ? new Text("", 0, 0) : new RemoteFooter("", 0, 0); const recoveries = new Text("", 0, 0); const notices = new Text("", 0, 0);
  // Historical transcript fixtures must derive work/model/cwd chrome from that same snapshot.
  const capturedView = mock.method(client.views, "current", () => view);
  try { updateTuiChrome(client, theme, header, recoveries, notices); }
  finally { capturedView.mock.restore(); }
  if (before) {
    header.setText(`${client.state.toUpperCase()}\n${sessionText(view)}`);
    recoveries.setText(recoveryStatusText(client));
    notices.setText(client.notices.slice(-3).map(terminalText).join("\n"));
  }
  const editor = new Editor(tui, before ? presentationTheme(true).editor : theme.editor);
  editor.setText("Draft 世界 👩🏽‍💻");
  const help = new Text(before ? "Enter: follow-up | Shift+Enter: newline | /recover or /discard: resolve unconfirmed input | Ctrl+A: abort | Ctrl+R: resync | Ctrl+C: exit (work continues) | PageUp/Down: scroll" : tuiHelpText, 0, 0);
  const root = before ? new VStack([
    { component: header, basis: "auto", maxSize: 3 },
    { component: scroll, basis: 0, grow: 1, minSize: 1 },
    { component: recoveries, basis: "auto", maxSize: 7, shrink: 0 },
    { component: notices, basis: "auto", maxSize: 4 },
    { component: editor, basis: "auto", maxSize: 10, minSize: 3 },
    { component: help, basis: "auto", maxSize: 2 },
  ]) : tuiLayoutRoot(header, scroll, recoveries, notices, editor, help);
  tui.setLayoutRoot(root); tui.setFocus(editor); tui.start();
  await waitUntil(() => tui.getScreenLines().length === 20);
  return { tui, rich, scroll, editor, terminal, header, recoveries, notices };
}
async function artifact(name: string, lines: string[]) {
  const directory = process.env.PI_UI_FRAME_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.ansi`), lines.join("\n") + "\n");
  await writeFile(join(directory, `${name}.txt`), lines.map(stripTerminalSequences).join("\n") + "\n");
}

test("presentation: real committed Markdown, thinking and tools retain native caches, complete output and Unicode widths", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const paced = fauxProvider({ api: f.faux.api, tokensPerSecond: 200, tokenSize: { min: 8, max: 8 } });
  f.models.setProvider(paced.provider);
  paced.setResponses([
    fauxAssistantMessage([fauxThinking("Check the committed evidence, not local files."), fauxToolCall("bash", { command: "printf 'tool running 世界\\n'; sleep 0.3; printf 'tool done\\n'" })], { stopReason: "toolUse" }),
    fauxAssistantMessage(prose),
  ]);
  const server = await f.start();
  const client = new RemoteClient({ url: server.url }); t.after(() => client.close());
  let busy: RemoteView | undefined; let partial: RemoteView | undefined;
  const unsubscribe = client.views.subscribe(() => {
    const view = client.views.current();
    const sections = transcriptSections(view);
    if (sections.some((section) => section.label.includes("streaming"))) partial = view;
    if (sections.some((section) => section.label.includes("running") && section.blocks.some((block) => block.text.includes("tool running")))) busy = view;
  }); t.after(unsubscribe);
  client.start(); await client.ready(); await client.controller.submit("Explain the result 世界");
  await waitUntil(() => transcriptText(client.views.current()).includes("Answer complete.") && Object.keys(client.views.current().tasks.tasks).length === 0, 10_000);
  assert.ok(busy, "a real committed running tool snapshot was observed");
  assert.ok(partial, "a real committed partial was observed");
  const view = client.views.current();
  const theme = presentationTheme(false); const rich = new RemoteTranscript(theme); rich.update(view);
  rich.toggleExpanded(); // Full-output proof explicitly exercises the accessible expanded view.
  const rendered = rich.render(36).map((line) => stripTerminalSequences(line).trimEnd()).join("\n");
  assert.match(rendered, /Thinking\n/); assert.match(rendered, /Arguments\n/);
  assert.match(rendered, /\$ printf/); assert.equal(transcriptSections(view).filter((section) => section.execution).length, 1);
  assert.match(rendered, /Tool bash \[done\]/); assert.match(rendered, /tool done/);
  assert.match(rendered, /Readable result/); assert.doesNotMatch(rendered, /## Readable|\*\*clear answer\*\*/);
  assert.match(rendered, /const greeting/); assert.match(rendered, /Answer complete/);
  assert.ok(rich.render(36).every((line) => visibleWidth(line) <= 36));
  const retained = [...rich.children];
  rich.update(structuredClone(view));
  rich.children.forEach((component, index) => assert.equal(component, retained[index], "unchanged native components retain their parse and width caches across whole snapshots"));
  assert.match(transcriptText(view), /## Readable result/); // Plain diagnostics remain source-like.
  for (const width of [36, 80, 100]) {
    for (const noColor of [false, true]) {
      const ui = await frame(client, view, width, noColor);
      try {
        const lines = ui.tui.getScreenLines();
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.doesNotMatch(ui.terminal.output, /\x1b_Gpi:c/);
        if (noColor) assert.doesNotMatch(ui.rich.render(width).join("\n"), /\x1b\[[0-9;]*m/, "NO_COLOR suppresses presentation SGR styles; native inert OSC-8 links are not color");
        await artifact(`after-${width}-${noColor ? "no-color" : "palette"}-end`, lines);
        ui.scroll.scrollToStart(); ui.tui.requestRender();
        await waitUntil(() => ui.tui.getScreenLines().some((line) => stripTerminalSequences(line).includes("You")));
        await artifact(`after-${width}-${noColor ? "no-color" : "palette"}-start`, ui.tui.getScreenLines());
        // Capture actual current viewports at content landmarks, not concatenated terminal writes.
        for (const [name, marker] of [["markdown", "Readable result"], ["code", "const greeting"], ["tool", "Tool bash [done]"]] as const) {
          const row = ui.rich.render(ui.scroll.getContentWidth(width)).findIndex((line) => stripTerminalSequences(line).includes(marker));
          assert.ok(row >= 0, `native content contains ${marker}`);
          ui.scroll.scrollTo(Math.max(0, row - 1)); ui.tui.requestRender();
          await waitUntil(() => ui.tui.getScreenLines().some((line) => stripTerminalSequences(line).includes(marker)));
          await artifact(`after-${width}-${noColor ? "no-color" : "palette"}-${name}`, ui.tui.getScreenLines());
        }
        assert.doesNotMatch(ui.rich.render(width).join("\n"), /\x1b\[2m/, "primary prose and code are never dimmed");
        ui.scroll.scrollToStart(); ui.tui.requestRender();
        await waitUntil(() => ui.scroll.scrollTop === 0);
        const top = ui.scroll.scrollTop;
        ui.rich.update(busy!); ui.tui.requestRender();
        await new Promise((done) => setTimeout(done, 30));
        assert.equal(ui.scroll.scrollTop, top, "an explicit history position is not forced to end by updates");
        ui.rich.update(view); ui.scroll.scrollToEnd(); ui.tui.requestRender();
        await new Promise((done) => setTimeout(done, 30));
        assert.equal(ui.scroll.isFollowingEnd, true);
      } finally { ui.tui.stop(); }
    }
    const before = await frame(client, view, width, true, true);
    try {
      await artifact(`before-${width}-end`, before.tui.getScreenLines());
      before.scroll.scrollToStart(); before.tui.requestRender();
      await new Promise((done) => setTimeout(done, 30));
      await artifact(`before-${width}-start`, before.tui.getScreenLines());
      for (const [name, marker] of [["markdown", "Readable result"], ["code", "const greeting"], ["tool", "Tool bash [done]"]] as const) {
        const row = new Text(transcriptText(view), 0, 0).render(before.scroll.getContentWidth(width)).findIndex((line) => stripTerminalSequences(line).includes(marker));
        assert.ok(row >= 0);
        before.scroll.scrollTo(Math.max(0, row - 1)); before.tui.requestRender();
        await waitUntil(() => before.tui.getScreenLines().some((line) => stripTerminalSequences(line).includes(marker)));
        await artifact(`before-${width}-${name}`, before.tui.getScreenLines());
      }
    } finally { before.tui.stop(); }
    for (const [name, snapshot] of [["busy", busy!], ["streaming", partial!]] as const) {
      const ui = await frame(client, snapshot, width, false);
      try {
        const lines = ui.tui.getScreenLines();
        assert.match(lines.map(stripTerminalSequences).join("\n"), /CONNECTED · \d+ active tasks/, `${name} chrome reflects its captured active snapshot, not the now-idle client`);
        await artifact(`${name}-${width}`, lines);
        if (name === "streaming") {
          const row = ui.rich.render(ui.scroll.getContentWidth(width)).findIndex((line) => stripTerminalSequences(line).includes("Assistant · streaming"));
          assert.ok(row >= 0);
          ui.scroll.scrollTo(row); ui.tui.requestRender();
          await waitUntil(() => ui.tui.getScreenLines().some((line) => stripTerminalSequences(line).includes("Assistant · streaming")));
          await artifact(`streaming-${width}-label`, ui.tui.getScreenLines());
        }
      } finally { ui.tui.stop(); }
    }
  }
});

test("presentation: current narrow recovery frame keeps every instruction, readiness and draft visible while stale", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t); f.faux.setResponses([fauxAssistantMessage("Recovery answer.")]);
  const server = await f.start(); const proxy = await faultProxy(t, server.url, "drop-admitted-reply");
  const client = new RemoteClient({ url: proxy.url, reconnectMinMs: 20, reconnectMaxMs: 100 }); t.after(() => client.close());
  client.start(); await client.ready();
  await assert.rejects(client.controller.submit("Retained 世界"), CommandOutcomeUnknownError);
  await client.ready(); await waitUntil(() => client.recovery.list()[0]?.snapshotFresh === true);
  for (const width of [36, 80]) {
  const ui = await frame(client, client.views.current(), width, false);
  try {
    const check = (lines: string[]) => {
      const plain = lines.map(stripTerminalSequences).join("\n");
      for (const line of recoveryStatusText(client).split("\n")) assert.ok(plain.includes(line), `visible: ${line}`);
      assert.match(plain, /Draft 世界/); assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.equal(lines.length, 20);
    };
    check(ui.tui.getScreenLines()); await artifact(`recovery-ready-${width}`, ui.tui.getScreenLines());
    const gate = proxy.holdViews(); client.reconnectNow();
    try {
      updateTuiChrome(client, presentationTheme(false), ui.header, ui.recoveries, ui.notices); ui.tui.requestRender();
      await waitUntil(() => ui.tui.getScreenLines().some((line) => stripTerminalSequences(line).includes("stale view")));
      check(ui.tui.getScreenLines()); await artifact(`recovery-stale-${width}`, ui.tui.getScreenLines());
    } finally { gate.release(); }
  } finally { ui.tui.stop(); }
  await client.ready(); await waitUntil(() => client.recovery.list()[0]?.snapshotFresh === true);
  }
});

test("presentation: sanitize before Markdown and styling; errors stay explicit without color", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("## Safe\n\n**hello**\x1b]52;c;secret\x07世界\x1b[2J\r\x00", { stopReason: "error", errorMessage: "Provider failed\x1b[31m" })]);
  const server = await f.start(); const client = new RemoteClient({ url: server.url }); t.after(() => client.close());
  client.start(); await client.ready(); await client.controller.submit("safe");
  await waitUntil(() => Object.keys(client.views.current().tasks.tasks).length === 0 && transcriptText(client.views.current()).includes("hello"));
  const rich = new RemoteTranscript(presentationTheme(true)); rich.update(client.views.current());
  const text = rich.render(36).join("\n");
  assert.match(text, /Assistant · error/); assert.match(text, /Provider failed/);
  assert.doesNotMatch(text, /\x1b|\x07|\r|\x00|secret|\*\*hello\*\*/);
  for (const width of [36, 80]) for (const noColor of [true, false]) {
    const ui = await frame(client, client.views.current(), width, noColor);
    try {
      const lines = ui.tui.getScreenLines();
      assert.match(lines.map(stripTerminalSequences).join("\n"), /Assistant · error/);
      assert.match(lines.map(stripTerminalSequences).join("\n"), /Provider failed/);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      await artifact(`error-${noColor ? "no-color" : "palette"}-${width}`, lines);
    } finally { ui.tui.stop(); }
  }
});

test("presentation: light appearance, error tool surface and expanded tools keep truthful paired frames", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const paced = fauxProvider({ api: f.faux.api, tokensPerSecond: 200, tokenSize: { min: 8, max: 8 } });
  f.models.setProvider(paced.provider);
  paced.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "printf 'light tool output\\n'" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Light appearance answer."),
  ]);
  const server = await f.start();
  const client = new RemoteClient({ url: server.url }); t.after(() => client.close());
  client.start(); await client.ready(); await client.controller.submit("Show 世界");
  await waitUntil(() => transcriptText(client.views.current()).includes("Light appearance answer.") && Object.keys(client.views.current().tasks.tasks).length === 0, 10_000);
  const view = client.views.current();
  const errorView = {
    ...structuredClone(view),
    conversation: {
      ...structuredClone(view.conversation),
      entries: [
        { id: 1, model: [{ role: "user", content: [{ type: "text", text: "Trigger an error" }] }] },
        { id: 2, model: [{ role: "assistant", content: [{ type: "toolCall", id: "boom", name: "bash", arguments: { command: "exit 3" } }] }] },
        { id: 3, model: [{ role: "toolResult", toolCallId: "boom", toolName: "bash", content: [{ type: "text", text: "command failed with exit 3" }], isError: true, durationMs: 9 }] },
      ],
    },
  } as unknown as RemoteView;
  for (const width of [36, 80, 100]) {
    for (const appearance of ["dark", "light"] as const) {
      for (const colorMode of ["truecolor", "256color"] as const) {
        const theme = presentationTheme(false, { appearance, colorMode });
        const expect = (color: typeof theme.palette.userBg) => new RegExp(backgroundAnsi(color, colorMode).replaceAll("[", "\\[").replaceAll(";", "\\;"));
        const ui = await frame(client, view, width, false, false, { appearance, colorMode });
        try {
          const lines = ui.tui.getScreenLines();
          assert.ok(lines.every((line) => visibleWidth(line) <= width));
          const rendered = ui.rich.render(width).join("\n");
          assert.match(rendered, expect(theme.palette.userBg), `${appearance}/${colorMode} user surface background is emitted`);
          await artifact(`${appearance}-${colorMode === "truecolor" ? "" : "256-"}${width}-end`, lines);
          const row = ui.rich.render(ui.scroll.getContentWidth(width)).findIndex((line) => stripTerminalSequences(line).includes("Tool bash"));
          assert.ok(row >= 0, `${appearance} content contains the tool card`);
          ui.scroll.scrollTo(Math.max(0, row - 1)); ui.tui.requestRender();
          await waitUntil(() => ui.tui.getScreenLines().some((line) => stripTerminalSequences(line).includes("Tool bash")));
          const toolLines = ui.tui.getScreenLines();
          assert.match(toolLines.join("\n"), expect(theme.palette.successBg), `${appearance}/${colorMode} success surface background is emitted`);
          await artifact(`${appearance}-${colorMode === "truecolor" ? "" : "256-"}${width}-tool`, toolLines);
          ui.rich.toggleExpanded(); ui.tui.requestRender();
          await waitUntil(() => ui.tui.getScreenLines().some((line) => stripTerminalSequences(line).includes("Arguments")));
          await artifact(`${appearance}-${colorMode === "truecolor" ? "" : "256-"}${width}-expanded`, ui.tui.getScreenLines());
          ui.rich.toggleExpanded(); ui.tui.requestRender();
        } finally { ui.tui.stop(); }
        const failing = await frame(client, errorView, width, false, false, { appearance, colorMode });
        try {
          const plainLines = failing.tui.getScreenLines().map(stripTerminalSequences).join("\n");
          assert.match(plainLines, /error/); assert.match(plainLines, /command failed with exit 3/);
          const row = failing.rich.render(failing.scroll.getContentWidth(width)).findIndex((line) => stripTerminalSequences(line).includes("command failed"));
          assert.ok(row >= 0, `${appearance} error content is rendered`);
          assert.match(failing.rich.render(width).join("\n"), expect(theme.palette.errorBg), `${appearance}/${colorMode} error surface background is emitted`);
          await artifact(`error-tool-${appearance}-${colorMode === "truecolor" ? "" : "256-"}${width}`, failing.tui.getScreenLines());
        } finally { failing.tui.stop(); }
      }
    }
  }
});
