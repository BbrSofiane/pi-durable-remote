import WebSocket from "ws";
import type { ServerMessage } from "@sof/durable-remote-protocol";

export const MAX_SERVER_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_CONTROL_FRAMES = 32;
const SLOW_PEER_TIMEOUT_MS = 10_000;

type ViewFrame = Extract<ServerMessage, { type: "snapshot" | "view" }>;

/** One in-flight send, a bounded control queue, and one coalesced latest whole view. */
export class SnapshotPeer {
  private controls: ServerMessage[] = [];
  private latest: ViewFrame | undefined;
  private sending = false;
  private timer: NodeJS.Timeout | undefined;
  private blockedSince: number | undefined;
  private disposed = false;

  private readonly socket: WebSocket;
  private readonly intervalMs: number;

  constructor(socket: WebSocket, intervalMs: number) {
    this.socket = socket;
    this.intervalMs = intervalMs;
    socket.on("close", () => this.dispose());
    socket.on("error", () => this.dispose());
  }

  control(frame: ServerMessage): void {
    if (this.disposed) return;
    if (this.controls.length >= MAX_CONTROL_FRAMES) { this.socket.terminate(); return; }
    this.controls.push(frame);
    this.flush();
  }

  view(frame: ViewFrame): void {
    if (this.disposed) return;
    // Resync/hello must still deliver a snapshot, even if an update supersedes its value.
    this.latest = { ...frame, type: this.latest?.type === "snapshot" ? "snapshot" : frame.type };
    if (frame.type === "snapshot") this.flush();
    else this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, this.intervalMs);
    this.timer.unref();
  }

  private flush(): void {
    if (this.disposed || this.socket.readyState !== WebSocket.OPEN) return;
    if (this.sending || this.socket.bufferedAmount > 0) {
      this.blockedSince ??= Date.now();
      if (Date.now() - this.blockedSince >= SLOW_PEER_TIMEOUT_MS) { this.socket.terminate(); return; }
      this.schedule();
      return;
    }
    this.blockedSince = undefined;
    const frame = this.controls.shift() ?? this.latest;
    if (!frame) return;
    if (frame === this.latest) this.latest = undefined;
    const payload = JSON.stringify(frame);
    if (Buffer.byteLength(payload) > MAX_SERVER_MESSAGE_BYTES) {
      // Never silently truncate a durable view; reconnect alone cannot fix this limit.
      this.socket.close(1009, "Server snapshot exceeds 16 MiB limit");
      this.dispose();
      return;
    }
    this.sending = true;
    this.blockedSince = Date.now();
    this.socket.send(payload, (error) => {
      this.sending = false;
      this.blockedSince = undefined;
      if (error) { this.socket.terminate(); this.dispose(); return; }
      if (this.controls.length > 0) this.flush();
      else if (this.latest) this.schedule();
    });
    // Monitor even a lone blocked snapshot with no subsequent updates.
    this.schedule();
  }

  private dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controls = [];
    this.latest = undefined;
  }
}
