import assert from "node:assert/strict";
import test from "node:test";
import { okhslColor } from "@earendil-works/pi-tui";
import type { Color } from "@earendil-works/pi-tui";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { presentationTheme, resolveAppearance } from "../src/theme.ts";

/**
 * Deterministic resolved/emitted color checks for the single theme seam: no servers, no terminals. Every
 * contrast number is measured against the RGB the theme actually emits — truecolor triples directly, and the
 * 256-color fallback against the standard xterm cube/grayscale palette those indices expand to — not just the
 * source okhsl values.
 */

const srgbLuminance = ({ r, g, b }: { r: number; g: number; b: number }): number => {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (first: { r: number; g: number; b: number }, second: { r: number; g: number; b: number }): number => {
  const rgb = (color: { r: number; g: number; b: number }): { r: number; g: number; b: number } => color;
  const l1 = srgbLuminance(rgb(first));
  const l2 = srgbLuminance(rgb(second));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
};

/** Standard xterm palette expansion for indices the theme can emit; indices 0–15 are terminal-custom and banned. */
const xtermPaletteRgb = (index: number): { r: number; g: number; b: number } => {
  assert.ok(index >= 16, `UI colors must resolve to deterministic cube/grayscale indices, not terminal-custom 0–15 (got ${index})`);
  if (index >= 232) { const value = 8 + (index - 232) * 10; return { r: value, g: value, b: value }; }
  const cube = [0, 95, 135, 175, 215, 255];
  const cells = index - 16;
  return { r: cube[Math.floor(cells / 36)], g: cube[Math.floor((cells % 36) / 6)], b: cube[cells % 6] };
};

interface Emission { fg?: { r: number; g: number; b: number } | number; bg?: { r: number; g: number; b: number } | number; }
/** Parse the SGR sequences a style function actually emitted, not the palette it was built from. */
const emitted = (styled: string): Emission => {
  const result: Emission = {};
  for (const match of styled.matchAll(/\x1b\[([0-9;]+)m/g)) {
    const params = match[1].split(";");
    for (let index = 0; index < params.length; index++) {
      const slot = params[index] === "38" || params[index] === "48" ? Number(params[index]) : undefined;
      if (slot === undefined) continue;
      const target: "fg" | "bg" = slot === 38 ? "fg" : "bg";
      if (params[index + 1] === "2") {
        result[target] = { r: Number(params[index + 2]), g: Number(params[index + 3]), b: Number(params[index + 4]) };
        index += 4;
      } else if (params[index + 1] === "5") {
        result[target] = Number(params[index + 2]);
        index += 2;
      }
    }
  }
  return result;
};
const emittedRgb = (color: Emission["fg" | "bg"]): { r: number; g: number; b: number } =>
  typeof color === "number" ? xtermPaletteRgb(color) : color!;

const surfaces = (theme: ReturnType<typeof presentationTheme>) =>
  [["user", theme.userSurface, theme.palette.userBg], ["success", theme.toolSurface, theme.palette.successBg],
    ["pending", theme.workingSurface, theme.palette.pendingBg], ["error", theme.errorSurface, theme.palette.errorBg]] as const;

for (const appearance of ["dark", "light"] as const) {
  for (const colorMode of ["truecolor", "256color"] as const) {
    test(`theme ${appearance}/${colorMode}: published Pi tokens, semantic surface distinction and measured ≥4.5:1 emitted contrast`, () => {
      const theme = presentationTheme(false, { appearance, colorMode });
      const published = appearance === "dark"
        ? { text: [234, 0.03, 0.89], muted: [229, 0.06, 0.67], violet: [295, 0.50, 0.67], blue: [232, 0.54, 0.67], green: [159, 0.59, 0.67], red: [20, 0.72, 0.67], yellow: [83, 0.88, 0.67], userBg: [233, 0.41, 0.24], pendingBg: [229, 0.05, 0.24], successBg: [158, 0.46, 0.25], errorBg: [19, 0.54, 0.25] }
        : { text: [225, 0.05, 0.27], muted: [229, 0.08, 0.47], violet: [295, 0.60, 0.46], blue: [231, 0.68, 0.47], green: [159, 0.75, 0.46], red: [20, 0.91, 0.47], yellow: [83, 0.99, 0.47], userBg: [235, 0.19, 0.91], pendingBg: [248, 0.03, 0.91], successBg: [156, 0.21, 0.91], errorBg: [24, 0.23, 0.91] };
      for (const [token, [h, s, l]] of Object.entries(published)) {
        const resolved = theme.palette[token as keyof typeof theme.palette];
        if (colorMode === "256color" && resolved.kind === "indexed") {
          assert.ok(resolved.index >= 16, `256-color override for ${appearance} ${token} stays out of terminal-custom 0–15`);
          continue;
        }
        assert.deepEqual(resolved, okhslColor(h, s, l), `${appearance} ${token} must equal the published Pi color`);
      }

      const backgrounds = new Set<string>();
      for (const [name, surface, sourceBg] of surfaces(theme)) {
        const emission = emitted(surface("body"));
        assert.ok(emission.fg && emission.bg, `${name} surface pairs explicit fg/bg`);
        if (colorMode === "truecolor") {
          assert.equal(sourceBg.kind, "rgb");
          assert.deepEqual(emittedRgb(emission.bg), { r: Math.round(sourceBg.r), g: Math.round(sourceBg.g), b: Math.round(sourceBg.b) }, `${name} background is emitted`);
          assert.equal(theme.palette.text.kind, "rgb");
          assert.deepEqual(emittedRgb(emission.fg), { r: Math.round(theme.palette.text.r), g: Math.round(theme.palette.text.g), b: Math.round(theme.palette.text.b) }, `${name} foreground is the paired text color`);
        } else {
          assert.equal(typeof emission.bg, "number", "256-color fallback emits deterministic cube/grayscale indices");
          assert.equal(typeof emission.fg, "number", "256-color fallback emits deterministic cube/grayscale indices");
        }
        backgrounds.add(JSON.stringify(emittedRgb(emission.bg)));
        assert.equal(contrast(emittedRgb(emission.fg), emittedRgb(emission.bg)) >= 4.5, true, `${name} text ≥4.5:1 (got ${contrast(emittedRgb(emission.fg), emittedRgb(emission.bg)).toFixed(2)})`);
        const output = emitted(theme.toolOutput("output"));
        assert.ok(output.fg, "tool output foreground is emitted");
        assert.equal(JSON.stringify(output).includes("49m"), false, "output style resets fg only so Box padding keeps its background");
        assert.equal(contrast(emittedRgb(output.fg), emittedRgb(emission.bg)) >= 4.5, true, `${name} output ≥4.5:1 (got ${contrast(emittedRgb(output.fg), emittedRgb(emission.bg)).toFixed(2)})`);
      }
      assert.equal(backgrounds.size, 4, "user/success/pending/error surfaces stay semantically distinct even in 256-color space");
    });
  }
}

test("theme: 256-color fallback keeps semantic accents distinct and never uses terminal-custom indices 0–15", () => {
  const theme = presentationTheme(false, { appearance: "dark", colorMode: "256color" });
  const accents = [theme.accent, theme.success, theme.warning, theme.error].map((style) => emitted(style("x")).fg) as number[];
  assert.equal(new Set(accents).size, 4, "violet/green/yellow/red stay separable in 256-color space");
  const markdown = [theme.markdown.heading, theme.markdown.link, theme.markdown.code, theme.markdown.codeBlock].map((style) => emitted(style("x")).fg) as number[];
  assert.equal(new Set(markdown).size, 4, "Markdown roles keep distinct semantic hues");
});

test("theme: light 256-color fallback keeps semantic surface hues, not only numeric distinctness", () => {
  const theme = presentationTheme(false, { appearance: "light", colorMode: "256color" });
  const bgIndex = (surface: (text: string) => string) => emitted(surface("x")).bg as number;
  const user = xtermPaletteRgb(bgIndex(theme.userSurface));
  const success = xtermPaletteRgb(bgIndex(theme.toolSurface));
  const pending = xtermPaletteRgb(bgIndex(theme.workingSurface));
  const error = xtermPaletteRgb(bgIndex(theme.errorSurface));
  assert.ok(success.g > success.r && success.g > success.b, `emitted success surface is green-dominant, not achromatic (${JSON.stringify(success)})`);
  assert.ok(error.r > error.g && error.r > error.b, `emitted error surface is warm-red-dominant (${JSON.stringify(error)})`);
  assert.ok(user.b >= user.r && user.b >= user.g, `emitted user surface is blue-tinted (${JSON.stringify(user)})`);
  assert.ok(pending.r === pending.g && pending.g === pending.b, `emitted pending surface stays neutral (${JSON.stringify(pending)})`);
});

test("theme: NO_COLOR removes every UI-added SGR including attributes while labels and structure remain", () => {
  const theme = presentationTheme(true, { appearance: "dark", colorMode: "truecolor" });
  const samples = [theme.strong("a"), theme.accent("a"), theme.success("a"), theme.warning("a"), theme.error("a"), theme.muted("a"),
    theme.userSurface("a"), theme.toolSurface("a"), theme.workingSurface("a"), theme.errorSurface("a"), theme.toolOutput("a"),
    theme.markdown.heading("a"), theme.markdown.code("a"), theme.markdown.listBullet("a"), theme.markdown.bold("a"), theme.markdown.italic("a"),
    theme.editor.borderColor("a"), theme.editor.selectList.selectedPrefix("a"), theme.editor.selectList.noMatch("a")];
  for (const sample of samples) assert.equal(sample, "a", "NO_COLOR strips all presentation SGR and attributes");
});

test("theme: appearance selection is an explicit override, a conservative COLORFGBG hint, else dark", () => {
  assert.equal(resolveAppearance({}), "dark");
  assert.equal(resolveAppearance({ PI_UI_APPEARANCE: "light" }), "light");
  assert.equal(resolveAppearance({ PI_UI_APPEARANCE: "DARK" }), "dark");
  assert.equal(resolveAppearance({ PI_UI_APPEARANCE: "light", COLORFGBG: "0;15" }), "light", "explicit override wins");
  assert.equal(resolveAppearance({ COLORFGBG: "15;0" }), "dark");
  assert.equal(resolveAppearance({ COLORFGBG: "0;15" }), "light");
  assert.equal(resolveAppearance({ COLORFGBG: "0;7" }), "light");
  assert.equal(resolveAppearance({ COLORFGBG: "7;13" }), "dark", "unknown background indices stay on the dark default");
  assert.equal(resolveAppearance({ COLORFGBG: "15;0,0" }), "dark");
});

test("theme: subordinate output rows keep their Box background across padding and row resets", () => {
  for (const colorMode of ["truecolor", "256color"] as const) {
    const theme = presentationTheme(false, { appearance: "dark", colorMode });
    const box = new Box(1, 0, theme.toolSurface);
    const line = new Text(theme.toolOutput("committed output"), 0, 0);
    box.addChild(line);
    const rows = box.render(40);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.match(row, /\x1b\[48;[0-9;]+m/, "every rendered row, including padded rows, repaints the surface background");
      assert.ok(visibleWidth(row) <= 40);
    }
    const plain = theme.toolSurface(theme.toolOutput("inside"));
    assert.match(plain, /\x1b\[48;/, "outer surface background is applied after inner styling");
    assert.match(plain, /\x1b\[39m/, "inner fg reset is selective");
    assert.doesNotMatch(plain, /\x1b\[49m.*\x1b\[48;/, "inner reset never clears the Box background before padding");
  }
});
