import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { RemoteView } from "@sof/durable-remote-protocol";
import { transcriptSections } from "./render.ts";
import type { TranscriptSection } from "./render.ts";
import type { PresentationTheme } from "./theme.ts";

type CachedPart = { kind: "text" | "markdown"; text: string; component: Text | Markdown };

/** Released Text.setText invalidates wrapping even for identical text; retain warm tool caches. */
class CachedToolText extends Text {
  private value = "";
  constructor() { super("", 0, 0); }
  override setText(text: string): void {
    if (this.value === text) return;
    super.setText(text);
    this.value = text;
  }
}

/** A measured preview of native Text rows, not logical lines or UTF-16 characters. */
class ToolPreview extends Container {
  private readonly primary = new CachedToolText();
  private readonly output = new CachedToolText();
  private readonly argumentsAndDetails = new CachedToolText();
  private readonly hint = new CachedToolText();
  private readonly subordinated: (text: string) => string;
  expanded = false;
  constructor(theme: PresentationTheme) {
    super();
    this.subordinated = theme.toolOutput;
  }
  update(section: TranscriptSection): void {
    this.primary.setText(section.execution!.primary);
    this.output.setText(section.blocks.filter((block) => block.kind !== "tool").map((block) => block.text).join("\n"));
    this.argumentsAndDetails.setText(section.blocks.filter((block) => block.kind === "tool").map((block) => `${block.label}\n${block.text}`).join("\n"));
  }
  override render(width: number): string[] {
    const primary = this.primary.render(width);
    const output = this.output.render(width);
    const details = this.argumentsAndDetails.render(width);
    // Primary intent keeps the surface's paired foreground; committed output, retained arguments/details and
    // expansion hints are subordinate but still ≥4.5:1 on the owned background.
    if (this.expanded) {
      return [...primary, ...styledRows(output, this.subordinated), ...styledRows(details, this.subordinated), ...this.expansionHint(width, "Ctrl+O: collapse tools")];
    }
    const omitted = Math.max(0, primary.length - 2) + Math.max(0, output.length - 5) + details.length;
    return [...primary.slice(0, 2), ...styledRows(output.slice(0, 5), this.subordinated), ...(omitted ? this.expansionHint(width, `… ${omitted} more rows · Ctrl+O to expand`) : [])];
  }
  private expansionHint(width: number, text: string): string[] {
    this.hint.setText(text);
    return styledRows(this.hint.render(width), this.subordinated);
  }
}

type ToolCard = { box: Box; label: Text; preview: ToolPreview };

/**
 * Style committed rows for subordination inside a painted Box surface, reapplying the SGR per rendered row
 * because pi-tui resets styling after every line. Only fg is set, so the row's reset never clears the Box
 * background that `applyBg` adds around the padded line afterwards.
 */
const styledRows = (rows: string[], style: (text: string) => string): string[] => rows.map(style);

/** Native composition only. Unchanged blocks keep their Markdown parse/width caches on every partial update. */
export class RemoteTranscript extends Container {
  private parts = new Map<string, CachedPart>();
  private tools = new Map<string, ToolCard>();
  private surfaces = new Map<string, Box>();
  private readonly gap = new Spacer(1);
  private readonly theme: PresentationTheme;
  private expanded = false;
  constructor(theme: PresentationTheme) {
    super();
    this.theme = theme;
    this.addChild(new Text("Waiting for the server snapshot…", 1, 0));
  }
  /** Local view preference, retained across whole snapshots, completion and reconnect. */
  toggleExpanded(): void {
    this.expanded = !this.expanded;
    for (const card of this.tools.values()) card.preview.expanded = this.expanded;
  }
  update(view: RemoteView): void {
    const next = new Map<string, CachedPart>();
    const nextTools = new Map<string, ToolCard>();
    const nextSurfaces = new Map<string, Box>();
    const children: Container["children"] = [];
    let target = children;
    const part = (key: string, text: string, kind: CachedPart["kind"] = "text") => {
      let cached = this.parts.get(key);
      if (!cached || cached.kind !== kind) {
        cached = { kind, text, component: kind === "markdown" ? new Markdown(text, 1, 0, this.theme.markdown) : new Text(text, 1, 0) };
      } else if (cached.text !== text) {
        cached.component.setText(text);
        cached.text = text;
      }
      next.set(key, cached);
      target.push(cached.component);
    };
    for (const section of transcriptSections(view)) {
      if (children.length) children.push(this.gap);
      if (section.execution) {
        let card = this.tools.get(section.key);
        if (!card) {
          const label = new CachedToolText(); const preview = new ToolPreview(this.theme);
          const box = new Box(1, 0, this.theme.toolSurface);
          box.addChild(label); box.addChild(preview);
          card = { box, label, preview };
        }
        card.box.setBgFn(section.tone === "error" ? this.theme.errorSurface : section.tone === "working" ? this.theme.workingSurface : this.theme.toolSurface);
        card.label.setText(this.theme.strong(section.label));
        card.preview.update(section); card.preview.expanded = this.expanded;
        nextTools.set(section.key, card); children.push(card.box);
        continue;
      }
      target = children;
      if (section.tone === "user") {
        const box = this.surfaces.get(section.key) ?? new Box(0, 0, this.theme.userSurface);
        box.children = []; target = box.children;
        nextSurfaces.set(section.key, box); children.push(box);
      }
      const labelStyle = section.tone === "error" ? this.theme.error : section.tone === "user" ? this.theme.strong
        : section.tone === "working" ? this.theme.warning : this.theme.accent;
      part(`${section.key}:label`, labelStyle(section.label));
      section.blocks.forEach((block, index) => {
        const key = `${section.key}:${index}`;
        if (block.kind === "thinking" || block.kind === "tool") {
          part(`${key}:label`, this.theme.strong(block.kind === "thinking" ? "Thinking" : block.label!));
        }
        part(key, block.text, section.markdown && block.kind === "text" ? "markdown" : "text");
      });
    }
    target = children;
    if (!children.length) part("empty", "No messages yet. Enter a follow-up below.");
    this.parts = next; this.tools = nextTools; this.surfaces = nextSurfaces;
    this.children = children;
  }
}
