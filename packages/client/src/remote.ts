import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { parseClientMessage, PROTOCOL_VERSION } from "@sof/durable-remote-protocol";
import type { ClientMessage, Command, ErrorCode, RemoteView, ServerMessage } from "@sof/durable-remote-protocol";
import type { OwnedSshTunnel } from "./tunnel.ts";
import { RecoveryState, defaultReceiptCapacity } from "./recovery.ts";
import { conversationIdentity, parseServerMessage } from "./wire.ts";

export type CommandReply = Extract<ServerMessage, { type: "reply"; ok: true }>;
export type ConnectionState = "connecting" | "connected" | "disconnected" | "closed";
export type RemoteClientOptions = ({ url: string; tunnel?: never } | { tunnel: OwnedSshTunnel; url?: never }) & {
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  snapshotTimeoutMs?: number;
  commandTimeoutMs?: number;
  /** Bound on in-memory ambiguous-submission receipts; submissions are refused before sending once it is reached. */
  receiptCapacity?: number;
};
export class NotConnectedError extends Error {
  constructor() { super("No fresh connection snapshot; command was not sent"); this.name = "NotConnectedError"; }
}
export class CommandRejectedError extends Error {
  readonly code: ErrorCode;
  readonly requestId: string;
  constructor(id: string, code: ErrorCode, message: string) {
    super(message); this.name = "CommandRejectedError"; this.code = code; this.requestId = id;
  }
}
/** The server may already have admitted/drained this command. Never automatically replay it. */
export class CommandOutcomeUnknownError extends Error {
  readonly requestId: string;
  readonly command: Command;
  constructor(id: string, command: Command) {
    super(`Outcome unknown for ${id}; reconnect/resync and inspect before taking further action`);
    this.name = "CommandOutcomeUnknownError"; this.requestId = id; this.command = command;
  }
}

type Pending = { command: Command; resolve: (reply: CommandReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** Whole-value source; startup current() deliberately fails until a snapshot has arrived. */
export class RemoteViewSource {
  private value?: RemoteView;
  private listeners = new Set<() => void>();
  current(): RemoteView { if (!this.value) throw new NotConnectedError(); return this.value; }
  hasSnapshot(): boolean { return this.value !== undefined; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  replace(view: RemoteView): void { this.value = view; for (const listener of this.listeners) listener(); }
}

export class RemoteController {
  private client: RemoteClient;
  constructor(client: RemoteClient) { this.client = client; }
  submit(text: string, whenBusy: Extract<Command, { name: "submit" }>["whenBusy"] = "followUp"): Promise<CommandReply> {
    if (this.client.state !== "connected") return Promise.reject(new NotConnectedError());
    return this.client.command({ name: "submit", conversationId: this.client.views.current().conversation.conversation.id, text, whenBusy });
  }
  abort(): Promise<CommandReply> {
    if (this.client.state !== "connected") return Promise.reject(new NotConnectedError());
    return this.client.command({ name: "abort", conversationId: this.client.views.current().conversation.conversation.id });
  }
}

/** Headless and terminal paths share this exact socket, admission and reconnect implementation. */
export class RemoteClient {
  readonly views = new RemoteViewSource();
  readonly controller = new RemoteController(this);
  /** In-memory receipts of ambiguous submissions; the TUI reads and acts through this seam only. */
  readonly recovery: RecoveryState;
  state: ConnectionState = "disconnected";
  epoch?: string;
  revision = -1;
  readonly notices: string[] = [];
  private readonly options: RemoteClientOptions;
  private readonly url: string;
  private readonly clientId = randomUUID();
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private snapshotTimer?: NodeJS.Timeout;
  private failures = 0;
  private started = false;
  private stopped = false;
  private pending = new Map<string, Pending>();
  // Authoritative wire identity, captured from accepted server frames before any observer sees the view. The publicly
  // exposed view is caller-mutable, so recovery identity checks never read from it.
  private persistedIdentity?: string;
  private listeners = new Set<() => void>();
  private waiters = new Set<() => void>();
  private stopTunnelSubscription?: () => void;

  constructor(options: RemoteClientOptions) {
    this.options = options;
    this.url = options.tunnel?.url ?? options.url!;
    this.recovery = new RecoveryState({
      // Recovery resends need the same fresh, OPEN transport that command() requires: between socket termination and
      // its close handler the connection state alone would let a resend register without being transmittable.
      connected: () => this.state === "connected" && this.socket?.readyState === WebSocket.OPEN,
      identity: () => this.currentIdentity(),
      transmit: (requestId, command) => this.transmit(requestId, command),
    }, options.receiptCapacity ?? defaultReceiptCapacity);
    const url = new URL(this.url);
    if (url.protocol !== "ws:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Expected a loopback ws:// URL with path / and no credentials");
    }
    for (const value of [options.reconnectMinMs, options.reconnectMaxMs, options.snapshotTimeoutMs, options.commandTimeoutMs, options.receiptCapacity]) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error("Timeouts and receipt capacity must be positive finite numbers");
    }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(): void { for (const listener of this.listeners) listener(); for (const waiter of this.waiters) waiter(); }
  notice(text: string): void { this.notices.push(text); if (this.notices.length > 20) this.notices.shift(); this.notify(); }
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.stopTunnelSubscription = this.options.tunnel?.subscribe(() => {
      if (this.options.tunnel?.state !== "ready") {
        this.notice("SSH tunnel unavailable; waiting for an owned forward");
        this.reconnectNow();
      }
    });
    this.connect();
  }
  /** Wait for a fresh snapshot, not merely TCP/WS open. Does not start an eager rejecting promise. */
  ready(timeoutMs = 15_000): Promise<RemoteView> {
    if (this.state === "connected") return Promise.resolve(this.views.current());
    if (this.stopped) return Promise.reject(new NotConnectedError());
    return new Promise((resolve, reject) => {
      const finish = () => {
        if (this.state === "connected") { cleanup(); resolve(this.views.current()); }
        else if (this.stopped) { cleanup(); reject(new NotConnectedError()); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for a fresh server snapshot")); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(finish); };
      this.waiters.add(finish);
    });
  }
  private connect(): void {
    if (this.stopped) return;
    if (this.options.tunnel && this.options.tunnel.state !== "ready") { this.scheduleReconnect(); return; }
    this.state = "connecting";
    this.notify();
    const ws = new WebSocket(this.url, { maxPayload: 16 * 1024 * 1024, handshakeTimeout: this.options.snapshotTimeoutMs ?? 5000, followRedirects: false });
    this.socket = ws;
    let fresh = false;
    this.snapshotTimer = setTimeout(() => {
      if (ws === this.socket && !fresh) { this.notice("Server snapshot timed out; reconnecting"); ws.terminate(); }
    }, this.options.snapshotTimeoutMs ?? 5000);
    ws.on("open", () => { if (ws === this.socket) this.send({ type: "hello", protocolVersion: PROTOCOL_VERSION, clientId: this.clientId }); });
    ws.on("message", (raw, binary) => {
      if (ws !== this.socket || this.stopped || ws.readyState !== WebSocket.OPEN) return;
      let message: ServerMessage;
      // Recover only from wire/ordering/status validation, never from application observers.
      try {
        if (binary) throw new Error("Binary server message");
        message = parseServerMessage(raw.toString());
        if (message.type === "snapshot" || message.type === "view") {
          if (!fresh && message.type !== "snapshot") throw new Error("Expected startup snapshot");
          if (fresh && message.epoch !== this.epoch && message.type !== "snapshot") throw new Error("Expected new-epoch snapshot");
          if (message.epoch === this.epoch && message.revision < this.revision) {
            if (!fresh) throw new Error("Stale startup snapshot");
            return;
          }
        } else if (message.type === "reply") {
          if (!fresh || message.epoch !== this.epoch) throw new Error("Reply outside current epoch");
          const pending = this.pending.get(message.id);
          if (pending && message.ok && ((pending.command.name === "submit" && message.status !== "admitted") || (pending.command.name === "abort" && message.status !== "completed"))) throw new Error("Unexpected command reply status");
        }
      } catch {
        ws.terminate();
        this.notice("Invalid/incompatible server frame; reconnecting without replay");
        return;
      }
      if (message.type === "snapshot" || message.type === "view") {
        const joining = !fresh;
        const previousEpoch = this.epoch;
        const changed = previousEpoch !== undefined && previousEpoch !== message.epoch;
        if (changed) this.unknownPending();
        this.epoch = message.epoch;
        this.revision = message.revision;
        this.state = "connected";
        fresh = true;
        this.failures = 0;
        clearTimeout(this.snapshotTimer);
        this.persistedIdentity = conversationIdentity(message.view);
        this.views.replace(message.view);
        this.recovery.markFreshSnapshot();
        if (changed) this.notice("Server restarted (new epoch); replaced state from its snapshot");
        else if (joining) this.notice("Connected; fresh whole snapshot received");
        else this.notify();
      } else if (message.type === "reply") {
        this.reply(message);
      } else if (message.type === "error") {
        this.notice(`Server notice: ${message.code} — ${message.error}`);
        if (!fresh || message.code === "PROTOCOL_VERSION" || message.code === "SERVER_CLOSING") ws.terminate();
      }
    });
    ws.on("error", () => { if (ws === this.socket && !this.stopped) this.notice("WebSocket transport error; reconnecting"); });
    ws.on("close", () => {
      if (ws !== this.socket) return;
      clearTimeout(this.snapshotTimer);
      this.socket = undefined;
      if (this.stopped) return;
      this.state = "disconnected";
      this.unknownPending();
      this.notice("Disconnected; server work continues. Waiting for a fresh snapshot");
      this.scheduleReconnect();
    });
  }
  private scheduleReconnect(): void {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const delay = Math.min((this.options.reconnectMinMs ?? 250) * 2 ** Math.min(this.failures++, 6), this.options.reconnectMaxMs ?? 10_000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
  /** Discard a transport only; it neither replays commands nor aborts remote work. */
  reconnectNow(): void {
    if (this.stopped) return;
    if (this.socket) {
      this.state = "disconnected";
      this.socket.terminate();
      this.notify();
    } else { clearTimeout(this.reconnectTimer); this.connect(); }
  }
  resync(): void {
    if (this.state !== "connected") { this.notice("Resync waits for reconnection"); return; }
    this.send({ type: "resync", protocolVersion: PROTOCOL_VERSION });
  }
  private send(message: ClientMessage): void {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(message), (error) => { if (error && ws === this.socket) ws.terminate(); }); }
    catch { ws.terminate(); }
  }
  command(command: Command): Promise<CommandReply> {
    if (this.state !== "connected" || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new NotConnectedError());
    const id = randomUUID();
    const message: ClientMessage = { type: "command", protocolVersion: PROTOCOL_VERSION, id, command };
    const validation = parseClientMessage(JSON.stringify(message));
    if (!validation.ok) return Promise.reject(new Error(validation.error + "; command was not sent"));
    if (command.name === "submit") {
      // Capture the original intent before the first send; without a persisted identity, recovery stays disabled.
      const identity = this.currentIdentity();
      if (identity === undefined) this.notice("No persisted conversation identity in this snapshot; an ambiguous outcome of this submission cannot be recovered");
      else {
        try { this.recovery.provision(id, command, identity); }
        catch (error) { return Promise.reject(error); } // Capacity reached: refused before any send, nothing evicted.
      }
    }
    try { return this.transmit(id, command); }
    catch (error) { this.recovery.settled(id, "rejected"); return Promise.reject(error); }
  }

  /** Send one exact request ID and command; shared by ordinary commands and explicit recovery resends. */
  private transmit(requestId: string, command: Command): Promise<CommandReply> {
    if (this.pending.size >= 8) throw new Error("Too many pending client commands; command was not sent");
    const message: ClientMessage = { type: "command", protocolVersion: PROTOCOL_VERSION, id: requestId, command };
    const validation = parseClientMessage(JSON.stringify(message));
    if (!validation.ok) throw new Error(validation.error + "; command was not sent");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.markUnknown(requestId);
        this.notice("Command reply timed out; outcome unknown. Resync before any manual retry");
        this.resync();
      }, this.options.commandTimeoutMs ?? 60_000);
      this.pending.set(requestId, { command, resolve, reject, timer });
      this.send(message);
    });
  }

  private currentIdentity(): string | undefined {
    return this.persistedIdentity;
  }
  private reply(reply: Extract<ServerMessage, { type: "reply" }>): void {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(reply.id);
    if (reply.ok) { this.recovery.settled(reply.id, "ok"); pending.resolve(reply); }
    else if (reply.code === "COMMAND_FAILED") {
      this.recovery.settled(reply.id, "ambiguous");
      pending.reject(new CommandOutcomeUnknownError(reply.id, pending.command));
      this.notice("Command failed with ambiguous outcome; resyncing without replay");
      this.resync();
    } else {
      this.recovery.settled(reply.id, "rejected");
      pending.reject(new CommandRejectedError(reply.id, reply.code, reply.error));
      this.notice(`Command rejected: ${reply.code} — ${reply.error}`);
    }
  }
  private markUnknown(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    this.recovery.settled(id, "ambiguous");
    pending.reject(new CommandOutcomeUnknownError(id, pending.command));
    this.notice(`Outcome unknown: ${id}. No automatic replay; inspect the fresh snapshot`);
  }
  private unknownPending(): void { for (const id of [...this.pending.keys()]) this.markUnknown(id); }
  /** Close only client resources; intentionally sends no abort command. */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.snapshotTimer);
    this.stopTunnelSubscription?.();
    this.state = "closed";
    this.unknownPending();
    this.socket?.terminate();
    this.notify();
  }
}
