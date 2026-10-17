import { PROTOCOL_VERSION } from "@sof/durable-remote-protocol";
import type { RemoteView, ServerMessage } from "@sof/durable-remote-protocol";

export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const codes = new Set(["INVALID_MESSAGE", "PROTOCOL_VERSION", "HELLO_REQUIRED", "WRONG_CONVERSATION", "CONVERSATION_BUSY", "COMMAND_FAILED", "SERVER_BUSY", "SERVER_CLOSING"]);

/** Validate the wire envelope/mount before it becomes current state. Payload rendering remains defensive. */
export function parseServerMessage(raw: string): ServerMessage {
  const value: unknown = JSON.parse(raw);
  if (!record(value) || value.protocolVersion !== PROTOCOL_VERSION || typeof value.epoch !== "string" || !value.epoch) throw new Error("Invalid server envelope");
  switch (value.type) {
    case "snapshot": case "view": {
      const view = value.view;
      if (!natural(value.revision) || !record(view) || !record(view.session) || typeof view.session.cwd !== "string" || typeof view.session.databasePath !== "string" ||
        !record(view.model) || typeof view.model.provider !== "string" || typeof view.model.modelId !== "string" ||
        !record(view.conversation) || !record(view.conversation.conversation) || !natural(view.conversation.conversation.id) ||
        !Array.isArray(view.conversation.entries) || !view.conversation.entries.every(record) || !record(view.conversation.docs) ||
        !record(view.tasks) || !record(view.tasks.tasks)) throw new Error("Invalid server snapshot");
      break;
    }
    case "reply":
      if (typeof value.id !== "string" || typeof value.ok !== "boolean") throw new Error("Invalid command reply");
      if (value.ok) {
        if (!(value.status === "completed" || (value.status === "admitted" && natural(value.submissionId)))) throw new Error("Invalid command status");
      } else if (typeof value.code !== "string" || !codes.has(value.code) || typeof value.error !== "string") throw new Error("Invalid rejection");
      break;
    case "error":
      if (typeof value.code !== "string" || !codes.has(value.code) || typeof value.error !== "string") throw new Error("Invalid server error");
      break;
    default: throw new Error("Unknown server message");
  }
  return value as ServerMessage;
}

/**
 * Stable persisted conversation identity of the viewed conversation (`pi.provider.sessionId`), or undefined when the
 * existing payload carries none. Never derived from the epoch, numeric conversation ID or database path.
 */
export function conversationIdentity(view: RemoteView): string | undefined {
  const doc = view.conversation.docs["pi.provider"];
  if (!record(doc)) return undefined;
  const sessionId = doc.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}
