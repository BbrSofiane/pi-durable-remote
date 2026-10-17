import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import type { ClientMessage, ServerMessage } from "@sof/durable-remote-protocol";

/** Transport faults only: all admissions, replies and snapshots originate in the actual server/Harness. */
export async function recoveryProxy(t: TestContext, upstream: string) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const sockets = new Set<WebSocket>();
  const commands: Extract<ClientMessage, { type: "command" }>[] = [];
  const replies: Extract<ServerMessage, { type: "reply" }>[] = [];
  let beforeAdmission = 0;
  let lostReplies = 0;
  let identityOverride: string | null | undefined;
  server.on("connection", (front) => {
    const back = new WebSocket(upstream);
    sockets.add(front); sockets.add(back);
    const queued: string[] = [];
    front.on("error", () => {}); back.on("error", () => {});
    front.on("message", (raw) => {
      const text = raw.toString();
      const frame = JSON.parse(text) as ClientMessage;
      if (frame.type === "command") {
        commands.push(frame);
        if (frame.command.name === "submit" && beforeAdmission > 0) {
          beforeAdmission--;
          front.terminate(); back.terminate(); // Never forwarded, so the Harness cannot admit it.
          return;
        }
      }
      if (back.readyState === WebSocket.OPEN) back.send(text);
      else queued.push(text);
    });
    back.on("open", () => { for (const text of queued) back.send(text); });
    back.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as ServerMessage;
      if (frame.type === "reply") {
        replies.push(frame);
        if (frame.ok && frame.status === "admitted" && lostReplies > 0) {
          lostReplies--;
          front.terminate(); back.terminate();
          return;
        }
      }
      // Exercise fail-closed identity guards without replacing the real server/controller or changing SQLite.
      if ((frame.type === "snapshot" || frame.type === "view") && identityOverride !== undefined) {
        const docs = frame.view.conversation.docs;
        if (identityOverride === null) Reflect.deleteProperty(docs, "pi.provider");
        else Reflect.set(docs, "pi.provider", { sessionId: identityOverride });
      }
      if (front.readyState === WebSocket.OPEN) front.send(JSON.stringify(frame));
    });
    front.on("close", () => { sockets.delete(front); back.terminate(); });
    back.on("close", () => { sockets.delete(back); front.terminate(); });
  });
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `ws://127.0.0.1:${address.port}/`, commands, replies,
    loseBeforeAdmission(count = 1): void { beforeAdmission = count; },
    loseAdmittedReplies(count = 1): void { lostReplies = count; },
    snapshotIdentity(value: string | null | undefined): void { identityOverride = value; },
  };
}
