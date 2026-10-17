import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

/** Test-only captured-frame viewer, not a terminal emulator or an application UI. No URL activation. */
const directory = resolve(process.argv[2]!);
const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const palettes = {
  dark: { background: "#1e1e1e", foreground: "#dedede", ansi: ["#1e1e1e", "#f48771", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#dedede"] },
  light: { background: "#ffffff", foreground: "#242424", ansi: ["#242424", "#b02424", "#48691f", "#806000", "#225ea8", "#85439b", "#006b70", "#ffffff"] },
};

function renderLine(line: string, palette: typeof palettes.dark): string {
  // OSC-8 metadata is inert in these previews, as in the client (no openUrl callback).
  const source = line.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  let bold = false; let italic = false; let underline = false; let strike = false;
  let foreground = palette.foreground;
  const chunks: string[] = [];
  for (const token of source.split(/(\x1b\[[0-9;]*m)/)) {
    if (token.startsWith("\x1b[")) {
      const codes = token.slice(2, -1).split(";").map(Number);
      for (let index = 0; index < codes.length; index++) {
        const code = codes[index]!;
        if (code === 0) { bold = italic = underline = strike = false; foreground = palette.foreground; }
        else if (code === 1) bold = true;
        else if (code === 22) bold = false;
        else if (code === 3 || code === 23) italic = code === 3;
        else if (code === 4 || code === 24) underline = code === 4;
        else if (code === 9 || code === 29) strike = code === 9;
        else if (code === 39) foreground = palette.foreground;
        else if (code === 38 && codes[index + 1] === 5) {
          const color = codes[index + 2]!;
          assert.ok(color >= 0 && color < 8, `unexpected palette index ${color}`);
          foreground = palette.ansi[color]!; index += 2;
        } else throw new Error(`Unsupported captured SGR ${code}; do not silently approximate it`);
      }
    } else {
      assert.doesNotMatch(token, /[\x00-\x1f\x7f]/, "no unresolved terminal controls in preview");
      const style = `color:${foreground};font-weight:${bold ? 700 : 400};font-style:${italic ? "italic" : "normal"};text-decoration:${[underline && "underline", strike && "line-through"].filter(Boolean).join(" ") || "none"}`;
      // Native measured cell widths keep CJK and emoji aligned despite browser fallback fonts.
      for (const { segment } of segmenter.segment(token)) {
        chunks.push(`<span style="${style};width:${visibleWidth(segment)}ch">${escapeHtml(segment)}</span>`);
      }
    }
  }
  return chunks.join("");
}

const names = (await readdir(directory)).filter((name) => name.endsWith(".ansi")).sort();
assert.ok(names.length > 0, "capture frames first");
for (const [mode, palette] of Object.entries(palettes)) {
  const figures: string[] = [];
  for (const name of names) {
    const source = await readFile(join(directory, name), "utf8");
    const plain = await readFile(join(directory, name.replace(/\.ansi$/, ".txt")), "utf8");
    assert.equal(stripTerminalSequences(source), plain, `${name}: ANSI/plain evidence must match exactly`);
    const lines = source.trimEnd().split("\n");
    assert.equal(lines.length, 20, `${name}: only complete current 20-row frames are previewed`);
    const columns = Math.max(...lines.map(visibleWidth));
    const id = name.slice(0, -5);
    figures.push(`<figure id="${escapeHtml(id)}"><figcaption>${escapeHtml(id)} · ${columns}×20</figcaption><pre style="width:${columns}ch">${lines.map((line) => `<div>${renderLine(line, palette)}</div>`).join("")}</pre></figure>`);
  }
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Captured native terminal frames — ${mode}</title><style>body{margin:16px;background:${palette.background};color:${palette.foreground};font:14px monospace}header{margin-bottom:20px;max-width:85ch}figure{margin:0 0 24px;width:max-content}figcaption{margin-bottom:8px}pre{margin:0;background:${palette.background};color:${palette.foreground};font:14px/20px Menlo,monospace;font-variant-ligatures:none}pre div{height:20px;white-space:pre}pre span{display:inline-block;vertical-align:top;height:20px;white-space:pre}</style><header>Captured-frame rendering, not human terminal usage. Exact native getScreenLines() frames; illustrative ${mode} terminal ANSI palette, inherited body foreground/background. Links are inert. Browser font rasterization is not a hardware-terminal claim.</header>${figures.join("\n")}`;
  await writeFile(join(directory, `preview-${mode}.html`), html);
}
console.log(`Validated ${names.length} complete ANSI/plain frame pairs; generated preview-dark.html and preview-light.html in ${directory}`);
