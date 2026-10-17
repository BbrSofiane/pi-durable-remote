import type { ConversationId, ConversationView, ModelRef, SubmissionId, TaskGraph } from "@earendil-works/pi-durable";

export const PROTOCOL_VERSION = 1;
export const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;
export const MAX_SUBMIT_TEXT_BYTES = 32 * 1024;

/** Only published durable values cross the wire; no Harness or credentials. */
export type RemoteView = {
  session: { databasePath: string; cwd: string };
  model: ModelRef;
  conversation: ConversationView;
  tasks: TaskGraph;
};

export type Command =
  | { name: "submit"; conversationId: ConversationId; text: string; whenBusy: "steer" | "followUp" | "reject" }
  | { name: "abort"; conversationId: ConversationId };

export type ClientMessage =
  | { type: "hello"; protocolVersion: typeof PROTOCOL_VERSION; clientId: string }
  | { type: "resync"; protocolVersion: typeof PROTOCOL_VERSION }
  | { type: "command"; protocolVersion: typeof PROTOCOL_VERSION; id: string; command: Command };

export type ErrorCode =
  | "INVALID_MESSAGE" | "PROTOCOL_VERSION" | "HELLO_REQUIRED" | "WRONG_CONVERSATION"
  | "CONVERSATION_BUSY" | "COMMAND_FAILED" | "SERVER_BUSY" | "SERVER_CLOSING";

type ServerEnvelope = { protocolVersion: typeof PROTOCOL_VERSION; epoch: string };
export type ServerMessage = ServerEnvelope & (
  | { type: "snapshot" | "view"; revision: number; view: RemoteView }
  | { type: "reply"; id: string; ok: true; status: "admitted"; submissionId: SubmissionId }
  // Public Conversation.abort() resolves after cancellation drains, not at admission.
  | { type: "reply"; id: string; ok: true; status: "completed" }
  | { type: "reply"; id: string; ok: false; code: ErrorCode; error: string }
  | { type: "error"; code: ErrorCode; error: string }
);

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; code: "INVALID_MESSAGE" | "PROTOCOL_VERSION"; error: string; id?: string };

const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

/** Strict v1 input validation. A request ID is also the durable submission deduplication key. */
export function parseClientMessage(raw: string): ParseResult {
  if (byteLength(raw) > MAX_CLIENT_MESSAGE_BYTES) {
    return { ok: false, code: "INVALID_MESSAGE", error: "Message exceeds the payload limit" };
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch {
    return { ok: false, code: "INVALID_MESSAGE", error: "Expected JSON" };
  }
  const id = object(value) && value.type === "command" && identifier(value.id) ? value.id : undefined;
  const invalid = (): ParseResult => ({ ok: false, code: "INVALID_MESSAGE", error: "Invalid v1 message", ...(id ? { id } : {}) });
  if (!object(value)) return invalid();
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, code: "PROTOCOL_VERSION", error: "Expected protocol version 1", ...(id ? { id } : {}) };
  }
  switch (value.type) {
    case "hello":
      if (!keys(value, ["type", "protocolVersion", "clientId"]) || !identifier(value.clientId)) return invalid();
      break;
    case "resync":
      if (!keys(value, ["type", "protocolVersion"])) return invalid();
      break;
    case "command": {
      if (!keys(value, ["type", "protocolVersion", "id", "command"]) || !identifier(value.id) || !object(value.command)) return invalid();
      const command = value.command;
      if (!Number.isSafeInteger(command.conversationId) || (command.conversationId as number) < 0) return invalid();
      if (command.name === "submit") {
        if (!keys(command, ["name", "conversationId", "text", "whenBusy"]) ||
          typeof command.text !== "string" || command.text.trim().length === 0 || byteLength(command.text) > MAX_SUBMIT_TEXT_BYTES ||
          !["steer", "followUp", "reject"].includes(command.whenBusy as string)) return invalid();
      } else if (command.name !== "abort" || !keys(command, ["name", "conversationId"])) return invalid();
      break;
    }
    default: return invalid();
  }
  // All required members and allowed keys were checked above; brand numeric IDs at this boundary.
  return { ok: true, message: value as ClientMessage };
}
