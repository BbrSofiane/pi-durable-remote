import { getTerminalColorMode, indexedColor, okhslColor, styleText } from "@earendil-works/pi-tui";
import type { IndexedColor, RgbColorValue, TerminalCapabilities, TerminalColorMode } from "@earendil-works/pi-tui";
import type { EditorTheme, MarkdownTheme, TextStyle } from "@earendil-works/pi-tui";

/**
 * Single color seam. Semantic tokens mirror the released Pi dark/light palettes
 * (node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/{dark,light}.json, read-only
 * reference): violet accent, green success, warm red error, yellow warning, blue-tinted user surface,
 * restrained green/pending/red tool surfaces. Canvas and assistant prose stay terminal-owned; only small
 * surfaces pair their own foreground/background. Unlike the previous arbitrary ANSI 0–15 slots, every color
 * resolves to concrete RGB so hues no longer depend on the terminal's palette customization on truecolor
 * terminals, while the 256-color fallback stays deterministic (cube/grayscale indices only, never 0–15).
 */
export type Appearance = "dark" | "light";

/** Truecolor okhsl-resolved RGB everywhere, except the three documented 256-color indexed overrides. */
type PaletteColor = RgbColorValue | IndexedColor;
interface SemanticPalette {
  text: PaletteColor; muted: PaletteColor; output: PaletteColor;
  violet: PaletteColor; blue: PaletteColor; green: PaletteColor; red: PaletteColor; yellow: PaletteColor;
  userBg: PaletteColor; pendingBg: PaletteColor; successBg: PaletteColor; errorBg: PaletteColor;
}

/** Published Pi values; `output` is the published `muted` nudged one lightness step (dark 67→69, light 47→42) so tool output keeps ≥4.5:1 on every owned surface (published muted measured 4.46 dark / 3.95 light worst-case). */
const palettes: Record<Appearance, SemanticPalette> = {
  dark: {
    text: okhslColor(234, 0.03, 0.89), muted: okhslColor(229, 0.06, 0.67), output: okhslColor(229, 0.06, 0.69),
    violet: okhslColor(295, 0.50, 0.67), blue: okhslColor(232, 0.54, 0.67), green: okhslColor(159, 0.59, 0.67),
    red: okhslColor(20, 0.72, 0.67), yellow: okhslColor(83, 0.88, 0.67),
    userBg: okhslColor(233, 0.41, 0.24), pendingBg: okhslColor(229, 0.05, 0.24), successBg: okhslColor(158, 0.46, 0.25), errorBg: okhslColor(19, 0.54, 0.25),
  },
  light: {
    text: okhslColor(225, 0.05, 0.27), muted: okhslColor(229, 0.08, 0.47), output: okhslColor(229, 0.08, 0.42),
    violet: okhslColor(295, 0.60, 0.46), blue: okhslColor(231, 0.68, 0.47), green: okhslColor(159, 0.75, 0.46),
    red: okhslColor(20, 0.91, 0.47), yellow: okhslColor(83, 0.99, 0.47),
    userBg: okhslColor(235, 0.19, 0.91), pendingBg: okhslColor(248, 0.03, 0.91), successBg: okhslColor(156, 0.21, 0.91), errorBg: okhslColor(24, 0.23, 0.91),
  },
};

/**
 * Deterministic 256-color overrides for the entries whose nearest-cube quantization would otherwise degrade the
 * UI (measured: dark userBg/output and light output drop below 4.5:1; light successBg quantizes to achromatic
 * gray 188 (215,215,215), losing the green-success vs neutral-pending distinction). Explicit high xterm indices
 * expand to fixed standard cube/grayscale RGB — never terminal-custom 0–15 — and keep every owned pair ≥4.5:1,
 * all four surfaces distinct and the success surface green-dominant (packages/client/test/theme.test.ts).
 */
const quantizedFallbacks: Record<Appearance, Partial<Record<keyof SemanticPalette, IndexedColor>>> = {
  dark: { userBg: indexedColor(24), output: indexedColor(253) },
  light: { successBg: indexedColor(194), output: indexedColor(239) },
};

/**
 * Appearance selection without terminal queries or theme watchers: explicit presentation-only env override
 * wins, then a conservative COLORFGBG hint (light background indices 7/15 only), else the dark default. This
 * is a guess, not detection; a wrong guess keeps surfaces readable because every surface pairs its own
 * foreground with its background.
 */
export function resolveAppearance(env: { PI_UI_APPEARANCE?: string; COLORFGBG?: string } = { PI_UI_APPEARANCE: process.env.PI_UI_APPEARANCE, COLORFGBG: process.env.COLORFGBG }): Appearance {
  const override = env.PI_UI_APPEARANCE?.trim().toLowerCase();
  if (override === "light" || override === "dark") return override;
  const background = env.COLORFGBG?.split(";").pop()?.trim();
  return background === "7" || background === "15" ? "light" : "dark";
}

/**
 * Presentation theme resolved once per session. `noColor` removes every UI-added SGR including text
 * attributes. The color mode comes from the public pi-tui capability detection (truecolor where announced,
 * deterministic 256-color cube fallback otherwise); tests pass explicit overrides instead of env sniffing.
 */
export function presentationTheme(
  noColor = process.env.NO_COLOR !== undefined,
  options: { appearance?: Appearance; colorMode?: TerminalColorMode; capabilities?: TerminalCapabilities } = {},
) {
  const appearance = options.appearance ?? resolveAppearance();
  const colorMode = options.colorMode ?? (options.capabilities ? getTerminalColorMode(options.capabilities) : getTerminalColorMode());
  const palette: SemanticPalette = { ...palettes[appearance], ...(colorMode === "256color" ? quantizedFallbacks[appearance] : []) };
  const style = (options: TextStyle) => (text: string): string => noColor ? text : styleText(text, options, colorMode);
  const strong = style({ bold: true });
  const accent = style({ fg: palette.violet, bold: true });
  const success = style({ fg: palette.green, bold: true });
  const warning = style({ fg: palette.yellow, bold: true });
  const error = style({ fg: palette.red, bold: true });
  const muted = style({ fg: palette.muted });
  const plain = (text: string) => text;
  const markdown: MarkdownTheme = {
    heading: style({ fg: palette.yellow }), link: style({ fg: palette.blue }), linkUrl: muted,
    code: style({ fg: palette.violet }), codeBlock: style({ fg: palette.green }), codeBlockBorder: muted,
    quote: muted, quoteBorder: muted, hr: muted, listBullet: style({ fg: palette.violet }),
    bold: strong, italic: style({ italic: true }), strikethrough: style({ strikethrough: true }),
    underline: style({ underline: true }),
  };
  const editor: EditorTheme = {
    borderColor: accent,
    selectList: { selectedPrefix: accent, selectedText: strong, description: muted, scrollInfo: muted, noMatch: warning },
  };
  // Every painted surface pairs its own foreground: explicit text on semantic backgrounds, measured ≥4.5:1
  // in both truecolor and the 256-color fallback (packages/client/test/theme.test.ts).
  const surface = (bg: PaletteColor) => style({ fg: palette.text, bg });
  // Subordinate output/annotation foreground used per rendered row inside tool surfaces. It is fg-only, so
  // the selective 39m reset never clears the Box background behind padded rows.
  const toolOutput = style({ fg: palette.output });
  return {
    appearance, colorMode, noColor, palette,
    strong, accent, success, warning, error, muted, markdown, editor, toolOutput,
    userSurface: surface(palette.userBg), toolSurface: surface(palette.successBg),
    workingSurface: surface(palette.pendingBg), errorSurface: surface(palette.errorBg),
  };
}
export type PresentationTheme = ReturnType<typeof presentationTheme>;
