import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, Editor, Input, stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import type { EditorTheme } from "@earendil-works/pi-tui";
import { terminalText } from "../src/render.ts";
import { waitUntil } from "../../server/test/helpers.ts";
import { TestTerminal } from "./fixtures/test-terminal.ts";

const plain = (text: string) => text;
const theme: EditorTheme = {
  borderColor: plain,
  selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
};

test("released Editor and Input APC cursor markers are zero-width and sanitized outside a TUI", () => {
  const tui = new TuiAltScreen(new TestTerminal(), true);
  const editor = new Editor(tui, theme);
  const input = new Input();
  editor.setText("世界🙂");
  input.setValue("世界🙂");
  for (const component of [editor, input]) {
    component.focused = true;
    const lines = component.render(12);
    assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
    assert.ok(lines.every((line) => visibleWidth(line) <= 12));
    const stripped = lines.map(stripTerminalSequences).join("\n");
    assert.match(stripped, /世界🙂/);
    assert.doesNotMatch(stripped, /\x1b|pi:/);
    assert.equal(terminalText(lines.join("\n")), stripped, "remote sanitization also removes APC cursor metadata");
  }
});

for (const hardwareCursor of [true, false]) {
  test(`released TUI resolves APC editor cursors with hardware cursor ${hardwareCursor ? "enabled" : "disabled"}`, async (t) => {
    const terminal = new TestTerminal();
    terminal.columns = 12;
    const tui = new TuiAltScreen(terminal, hardwareCursor);
    const editor = new Editor(tui, theme);
    tui.addChild(editor);
    tui.setFocus(editor);
    t.after(() => tui.stop());
    tui.start();
    terminal.type("世界🙂");
    await waitUntil(() => stripTerminalSequences(tui.getScreenLines().join("\n")).includes("世界🙂"));
    const frame = tui.getScreenLines();
    assert.ok(frame.every((line) => visibleWidth(line) <= terminal.columns));
    assert.doesNotMatch(terminal.output, /\x1b_pi:/, "private APC markers never reach the terminal");
    if (hardwareCursor) assert.doesNotMatch(frame.join("\n"), /\x1b\[7m/, "hardware cursor suppresses the fake reverse-video cursor");
    else assert.match(frame.join("\n"), /\x1b\[7m/, "software cursor is resolved to reverse video");
  });
}
