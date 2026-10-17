import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { WebSocketServer, WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "@sof/durable-remote-protocol";

/** Transport-only fault modes: "pass" forwards everything; the others disturb admitted submit replies. */
export type FaultMode = "pass" | "drop-admitted-reply" | "drop-admitted-replies" | "fail-admitted-reply";
type RecordedCommand = { id: string; raw: string };

/**
 * A transport fault proxy for TUI tests: a real ws listener in front of the real server that records command frames
 * and can drop or fail the first admitted submit reply. It never implements client/controller logic.
 */
export async function faultProxy(t: TestContext, upstream: string, mode: FaultMode) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const sockets = new Set<WebSocket>();
  const commands: RecordedCommand[] = [];
  const holds = new Map<string, { resolveReceived: () => void; released: Promise<void>; raw?: string }>();
  let viewGate: { queued: string[] } | undefined;
  let faulted = false;
  let activeFront: WebSocket | undefined;
  server.on("connection", (front) => {
    activeFront = front;
    const back = new WebSocket(upstream);
    sockets.add(front); sockets.add(back);
    const queued: string[] = [];
    const toBack = (text: string) => { if (back.readyState === WebSocket.OPEN) back.send(text); else queued.push(text); };
    front.on("error", () => {}); back.on("error", () => {});
    front.on("message", (raw) => {
      const text = raw.toString();
      let parsed: ClientMessage | undefined;
      try { parsed = JSON.parse(text) as ClientMessage; } catch { parsed = undefined; }
      if (parsed?.type === "command") {
        commands.push({ id: parsed.id, raw: text });
        const hold = holds.get(parsed.id);
        if (hold) {
          holds.delete(parsed.id);
          hold.raw = text;
          hold.resolveReceived();
          void hold.released.then(() => toBack(hold.raw!));
          return;
        }
      }
      toBack(text);
    });
    back.on("open", () => { for (const text of queued) back.send(text); });
    back.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as ServerMessage;
      const drops = mode === "drop-admitted-replies" || (mode === "drop-admitted-reply" || mode === "fail-admitted-reply") && !faulted;
      const faults = drops && frame.type === "reply" && frame.ok && frame.status === "admitted";
      if (faults) {
        faulted = true;
        if (mode === "fail-admitted-reply") {
          front.send(JSON.stringify({ ...frame, ok: false, code: "COMMAND_FAILED", error: "Command failed; resync before retrying" }));
          return;
        }
        front.terminate(); back.terminate();
        return;
      }
      if (viewGate && (frame.type === "snapshot" || frame.type === "view")) { viewGate.queued.push(raw.toString()); return; }
      if (front.readyState === WebSocket.OPEN) front.send(raw.toString());
    });
    front.on("close", () => { sockets.delete(front); back.terminate(); });
    back.on("close", () => { sockets.delete(back); front.terminate(); });
  });
  t.after(async () => { for (const socket of sockets) socket.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `ws://127.0.0.1:${address.port}/`,
    commands,
    /** Queue every server snapshot/view from arm time until release; proves recovery waits for a real snapshot. */
    holdViews(): { release: () => void } {
      const queued: string[] = [];
      let open!: () => void;
      const released = new Promise<void>((done) => { open = done; });
      const gate = { queued };
      viewGate = gate;
      void released.then(() => {
        if (viewGate === gate) viewGate = undefined;
        for (const text of queued) if (activeFront?.readyState === WebSocket.OPEN) activeFront.send(text);
      });
      return { release: () => open() };
    },
    /** Hold one command frame (matched by request ID) at the proxy until released. */
    hold(requestId: string): { received: Promise<void>; release: () => void } {
      let resolveReceived!: () => void;
      let doRelease!: () => void;
      const received = new Promise<void>((done) => { resolveReceived = done; });
      const released = new Promise<void>((done) => { doRelease = done; });
      holds.set(requestId, { resolveReceived, released });
      return { received, release: doRelease };
    },
  };
}
