import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CLIENT_MESSAGE_BYTES, MAX_SUBMIT_TEXT_BYTES, parseClientMessage } from "../src/index.ts";

const submit = { type: "command", protocolVersion: 1, id: "request-1", command: { name: "submit", conversationId: 0, text: "hello", whenBusy: "reject" } };

test("protocol accepts only supported, explicitly targeted v1 commands", () => {
  for (const message of [submit, { type: "hello", protocolVersion: 1, clientId: "terminal-1" }, { type: "resync", protocolVersion: 1 }, { ...submit, command: { name: "abort", conversationId: 0 } }]) {
    assert.equal(parseClientMessage(JSON.stringify(message)).ok, true);
  }
  for (const command of [
    { ...submit.command, conversationId: "0" }, { ...submit.command, conversationId: -1 },
    { ...submit.command, conversationId: 1.5 }, { ...submit.command, conversationId: Number.MAX_SAFE_INTEGER + 1 },
    { ...submit.command, text: " " }, { ...submit.command, whenBusy: "other" },
    { name: "switchConversation", conversationId: 0 }, { ...submit.command, unexpected: true },
  ]) {
    const result = parseClientMessage(JSON.stringify({ ...submit, command }));
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.code, "INVALID_MESSAGE"); assert.equal(result.id, "request-1"); }
  }
});

test("protocol rejects bad JSON, unknown fields, versions, IDs and byte limits", () => {
  for (const raw of ["{", "null", "[]", JSON.stringify({ ...submit, extra: 1 }), JSON.stringify({ ...submit, id: "bad id" }), JSON.stringify({ ...submit, id: "x".repeat(129) })]) {
    assert.equal(parseClientMessage(raw).ok, false);
  }
  const version = parseClientMessage(JSON.stringify({ ...submit, protocolVersion: 2 }));
  assert.deepEqual(version, { ok: false, code: "PROTOCOL_VERSION", error: "Expected protocol version 1", id: "request-1" });
  assert.equal(parseClientMessage(JSON.stringify({ ...submit, command: { ...submit.command, text: "é".repeat(MAX_SUBMIT_TEXT_BYTES / 2) } })).ok, true);
  assert.equal(parseClientMessage(JSON.stringify({ ...submit, command: { ...submit.command, text: "é".repeat(MAX_SUBMIT_TEXT_BYTES / 2 + 1) } })).ok, false);
  assert.equal(parseClientMessage(" ".repeat(MAX_CLIENT_MESSAGE_BYTES + 1)).ok, false);
});
