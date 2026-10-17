import type { RemoteView } from "@sof/durable-remote-protocol";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { record } from "./wire.ts";

/** Remote text is data, never terminal instructions (OSC/CSI, carriage returns, C0/C1). */
export function terminalText(text: string): string {
  return stripTerminalSequences(text).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, (char) => char === "\t" ? "    " : "");
}
const json = (value: unknown): string => terminalText(JSON.stringify(value) ?? "");

export type TranscriptBlock = { kind: "text" | "thinking" | "tool" | "image"; text: string; label?: string; plain: string };
export type TranscriptSection = {
  key: string;
  label: string;
  tone: "user" | "assistant" | "tool" | "error" | "working";
  markdown: boolean;
  blocks: TranscriptBlock[];
  execution?: { primary: string };
};

/** Sanitize all wire strings before either plain rendering or trusted Markdown/styling. */
function contentBlocks(content: unknown): TranscriptBlock[] {
  if (typeof content === "string") return [{ kind: "text", text: terminalText(content), plain: terminalText(content) }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown): TranscriptBlock[] => {
    if (!record(block)) return [];
    if (block.type === "text" && typeof block.text === "string") {
      const text = terminalText(block.text);
      return [{ kind: "text", text, plain: text }];
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      const text = terminalText(block.thinking);
      return [{ kind: "thinking", text, plain: `[thinking] ${text}` }];
    }
    if (block.type === "toolCall" && typeof block.name === "string") {
      const name = terminalText(block.name);
      return [{ kind: "tool", label: `Tool · ${name} · arguments`, text: terminalText(JSON.stringify(block.arguments, null, 2) ?? ""), plain: `> ${name} ${json(block.arguments)}` }];
    }
    if (block.type === "image") return [{ kind: "image", text: "[image payload]", plain: "[image payload]" }];
    return [];
  });
}
function contentText(content: unknown): string {
  return contentBlocks(content).map((block) => block.plain).filter(Boolean).join("\n");
}
function messageText(message: unknown): string {
  if (!record(message)) return "";
  const body = [contentText(message.content), ...["details", "diagnostics", "errorMessage"].flatMap((field) => message[field] === undefined ? [] : [terminalText(typeof message[field] === "string" ? message[field] : JSON.stringify(message[field], null, 2) ?? "")])].filter(Boolean).join("\n");
  switch (message.role) {
    case "user": return `You\n${body}`;
    case "assistant": return `Assistant${message.stopReason === "error" ? " [generation error]" : message.stopReason === "aborted" ? " [aborted]" : ""}\n${body}`;
    case "toolResult": return `Tool ${typeof message.toolName === "string" ? terminalText(message.toolName) : ""}${message.isError ? " [error]" : " [done]"}\n${body}`;
    default: return "";
  }
}

/** Pure rendering of wire payloads only. No local cwd lookup, file read, or edit-preview calculation. */
export function transcriptText(view: RemoteView): string {
  const parts: string[] = [];
  for (const entry of view.conversation.entries) {
    if (!Array.isArray(entry.model)) continue;
    for (const message of entry.model) {
      const text = messageText(message);
      if (text) parts.push(text);
      if (record(entry.data) && entry.data.diagnostics !== undefined) parts.push(terminalText(JSON.stringify(entry.data.diagnostics, null, 2) ?? ""));
    }
  }
  const live = view.conversation.docs["pi.live"];
  if (record(live)) {
    if (record(live.generation)) {
      if (live.generation.message) parts.push(`Committed partial\n${messageText(live.generation.message)}`);
      else parts.push("Generating…");
      if (live.generation.retry) parts.push("Generation retry pending");
      if (live.generation.deferred) parts.push("Provider response pending");
    }
    if (Array.isArray(live.tools)) for (const slot of live.tools) {
      if (!record(slot) || typeof slot.name !== "string") continue;
      parts.push(`Tool ${terminalText(slot.name)} [${typeof slot.status === "string" ? terminalText(slot.status) : "pending"}]${typeof slot.output === "string" ? "\n" + terminalText(slot.output) : ""}${typeof slot.droppedBytes === "number" && slot.droppedBytes > 0 ? `\n[${slot.droppedBytes} output bytes dropped remotely]` : ""}`);
    }
    if (Array.isArray(live.compactions) && live.compactions.length) parts.push("Compacting context…");
  }
  return parts.join("\n\n") || "No messages yet.";
}

/** Pure, round-scoped pairing: an ID is meaningful only within its assistant occurrence. */
export function transcriptSections(view: RemoteView): TranscriptSection[] {
  const sections: TranscriptSection[] = [];
  type Execution = { section: TranscriptSection; callId: unknown; result?: Record<string, unknown>; entry?: unknown; taskId?: unknown };
  let round: Execution[] = [];
  const results = new Map<unknown, Execution[]>();
  const live = view.conversation.docs["pi.live"];
  const extras = (section: TranscriptSection, value: Record<string, unknown>) => {
    for (const field of ["details", "diagnostics", "errorMessage"] as const) if (value[field] !== undefined) {
      const text = typeof value[field] === "string" ? terminalText(value[field]) : terminalText(JSON.stringify(value[field], null, 2) ?? "");
      section.blocks.push({ kind: "tool", label: field === "details" ? "Committed details" : field === "diagnostics" ? "Diagnostics" : "Error", text, plain: text });
    }
  };
  const label = (execution: Execution, name: string, status: string, duration?: unknown) => {
    execution.section.label = `Tool ${terminalText(name)} [${status}]${typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? ` · ${duration}ms` : ""}`;
    execution.section.tone = ["error", "interrupted", "not-run"].includes(status) ? "error" : status === "done" ? "tool" : "working";
  };
  const tool = (key: string, name: string, args?: unknown): Execution => {
    const section: TranscriptSection = { key, label: "", tone: "working", markdown: false, execution: { primary: toolPrimary(name, args) }, blocks: [] };
    if (args !== undefined) {
      const text = terminalText(JSON.stringify(args, null, 2) ?? "");
      section.blocks.push({ kind: "tool", label: "Arguments", text, plain: text });
    }
    const execution = { section, callId: undefined };
    label(execution, name, "result unavailable");
    sections.push(section);
    return execution;
  };
  const message = (value: unknown, key: string, entryId?: unknown, taskId?: unknown, data?: unknown, partial = false) => {
    if (!record(value)) return;
    if (value.role === "toolResult") {
      // Never reach back across a later assistant round, even if the provider reuses a call ID.
      const matches = round.filter((item) => typeof value.toolCallId === "string" && item.callId === value.toolCallId && !item.result);
      const execution = matches.length === 1 ? matches[0]! : tool(key, typeof value.toolName === "string" ? value.toolName : "result");
      execution.callId = value.toolCallId;
      execution.result = value; execution.entry = entryId; execution.taskId = taskId;
      const sameEntry = results.get(entryId) ?? []; sameEntry.push(execution); results.set(entryId, sameEntry);
      execution.section.blocks.push(...contentBlocks(value.content));
      extras(execution.section, value);
      if (record(data)) extras(execution.section, data);
      const diagnostics = record(data) && Array.isArray(data.diagnostics) ? data.diagnostics : [];
      const codes = diagnostics.filter(record).map((item) => item.code);
      const status = codes.some((code) => ["interrupted", "aborted"].includes(String(code))) ? "interrupted"
        : codes.some((code) => ["tool_unavailable", "invalid_arguments", "blocked"].includes(String(code))) ? "not-run" : value.isError ? "error" : "done";
      label(execution, typeof value.toolName === "string" ? value.toolName : "result", status, value.durationMs);
      return;
    }
    if (value.role !== "assistant" && value.role !== "user") return;
    if (!partial) round = [];
    const failed = value.stopReason === "error";
    const status = failed ? "error" : value.stopReason === "aborted" ? "aborted" : partial ? "streaming · committed partial" : "";
    const blocks = contentBlocks(value.content).filter((block) => block.kind !== "tool");
    const section: TranscriptSection = { key, label: value.role === "user" ? "You" : `Assistant${status ? ` · ${status}` : ""}`, tone: failed ? "error" : value.role === "user" ? "user" : partial ? "working" : "assistant", markdown: value.role === "assistant", blocks };
    if (typeof value.errorMessage === "string") extras(section, { errorMessage: value.errorMessage });
    if (blocks.length || status) sections.push(section);
    if (value.role === "assistant" && Array.isArray(value.content)) value.content.forEach((block: unknown, index: number) => {
      if (!record(block) || block.type !== "toolCall" || typeof block.name !== "string") return;
      const execution = tool(`${key}:call:${index}`, block.name, block.arguments);
      execution.callId = block.id;
      if (value.stopReason === "aborted" || failed) label(execution, block.name, "not-run");
      if (!partial) round.push(execution);
    });
  };
  view.conversation.entries.forEach((entry, entryIndex) => {
    if (Array.isArray(entry.model)) entry.model.forEach((value, index) => message(value, `entry:${entry.id ?? entryIndex}:${index}`, entry.id, entry.byTaskId, entry.data));
  });
  if (record(live)) {
    const note = (key: string, label: string) => sections.push({ key, label, tone: "working", markdown: false, blocks: [] });
    if (Array.isArray(live.tools)) live.tools.forEach((slot, index) => {
      if (!record(slot) || typeof slot.name !== "string") return;
      // Explicit result entry is stronger than callId. Otherwise only the current round is eligible.
      const candidates = slot.entry !== undefined ? results.get(slot.entry) ?? [] : round;
      const matches = candidates.filter((item) => typeof slot.callId === "string" && item.callId === slot.callId && (slot.taskId === undefined || item.taskId === undefined || item.taskId === slot.taskId));
      const execution = matches.length === 1 ? matches[0]! : tool(`live:${String(slot.taskId ?? slot.entry ?? "current")}:${index}`, slot.name);
      if (execution.result) return; // The result replaces progress; never a duplicate live card.
      label(execution, slot.name, slot.status === "running" ? "running" : slot.status === "pending" ? "pending" : "interrupted");
      if (typeof slot.output === "string") {
        const text = terminalText(slot.output); execution.section.blocks.push({ kind: "text", text, plain: text });
      }
      if (typeof slot.droppedBytes === "number" && slot.droppedBytes > 0) {
        const text = `[${slot.droppedBytes} output bytes dropped remotely]`; execution.section.blocks.push({ kind: "text", text, plain: text });
      }
      extras(execution.section, slot);
    });
    if (record(live.generation)) {
      if (live.generation.message) message(live.generation.message, "generation", undefined, undefined, undefined, true);
      else note("generation", "Assistant · generating…");
      if (live.generation.retry) note("retry", "Generation retry pending");
      if (live.generation.deferred) note("deferred", "Provider response pending");
    }
    if (Array.isArray(live.compactions) && live.compactions.length) note("compaction", "Compacting context…");
  }
  return sections;
}

/** Display known tool intent without interpreting paths, shell syntax or local files. */
export function toolPrimary(name: string, args: unknown): string {
  if (record(args)) {
    if (name === "bash" && typeof args.command === "string") return `$ ${terminalText(args.command)}`;
    if (["read", "write", "edit"].includes(name) && typeof args.path === "string") return `${name} ${terminalText(args.path)}`;
  }
  return terminalText(name);
}

export function sessionWorkText(view: RemoteView): string {
  const tasks = Object.values(view.tasks.tasks);
  const cancelling = tasks.some((task) => record(task) && task.abortRequested);
  return tasks.length ? `${tasks.length} active tasks${cancelling ? " (cancelling)" : ""}` : "idle";
}

export function sessionText(view: RemoteView): string {
  return terminalText(`${view.model.provider}/${view.model.modelId} | ${view.session.cwd} | ${sessionWorkText(view)}`);
}
