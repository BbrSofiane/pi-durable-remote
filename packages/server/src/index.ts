import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ConversationBusy, createRegistry, defineExtension, Harness, section } from "@earendil-works/pi-durable";
import type { ModelRef } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { lock } from "proper-lockfile";
import WebSocket, { WebSocketServer } from "ws";
import { MAX_CLIENT_MESSAGE_BYTES, parseClientMessage, PROTOCOL_VERSION } from "@sof/durable-remote-protocol";
import type { ClientMessage, ErrorCode, RemoteView, ServerMessage } from "@sof/durable-remote-protocol";
import { SnapshotPeer } from "./peer.ts";

export const SESSION_LOCK_STALE_MS = 5_000;
const MAX_PENDING_COMMANDS = 8;

export class ServerConfigurationError extends Error {}

export type ServerOptions = {
  cwd: string;
  databasePath: string;
  model: ModelRef;
  host?: "127.0.0.1" | "::1";
  port?: number;
  /** Injection is for deterministic tests; omission uses existing pi VM auth/config. */
  models?: Models;
  authPath?: string;
  modelsPath?: string | null;
  snapshotIntervalMs?: number;
  onFatal?: (message: string) => void;
};

/** Public coding-agent bridge, without extensions, user settings writes, or catalog network refresh. */
export async function createConfiguredModels(options: Pick<ServerOptions, "authPath" | "modelsPath"> = {}): Promise<ModelRuntime> {
  const models = await ModelRuntime.create({ authPath: options.authPath, modelsPath: options.modelsPath, allowModelNetwork: false });
  // The published runtime can resolve with built-in fallbacks despite invalid provider configuration.
  if (models.getError() !== undefined) {
    throw new ServerConfigurationError("Model configuration is invalid; check models.json and provider settings");
  }
  return models;
}

async function canonicalDatabasePath(path: string): Promise<string> {
  if (!path || path === ":memory:") throw new ServerConfigurationError("Select a persistent SQLite file with --storage");
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  try { return await realpath(absolute); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const existing = await lstat(absolute).catch((missing: NodeJS.ErrnoException) => {
      if (missing.code !== "ENOENT") throw missing;
      return undefined;
    });
    if (existing) throw new ServerConfigurationError("Storage path cannot be a dangling symlink");
    return join(await realpath(dirname(absolute)), basename(absolute));
  }
}

export async function startDurableServer(options: ServerOptions) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 7777;
  const intervalMs = options.snapshotIntervalMs ?? 25;
  if (!["127.0.0.1", "::1"].includes(host)) throw new ServerConfigurationError("Listen host must be 127.0.0.1 or ::1");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ServerConfigurationError("Invalid listen port");
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 1000) throw new ServerConfigurationError("Invalid snapshot interval");
  const cwd = await realpath(options.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new ServerConfigurationError("Working directory must be a directory");
  const databasePath = await canonicalDatabasePath(options.databasePath);
  let compromised: Error | undefined;
  let fatalClose: (() => void) | undefined;
  const release = await lock(databasePath, {
    realpath: false,
    stale: SESSION_LOCK_STALE_MS,
    update: 1000,
    retries: { retries: 6, factor: 1, minTimeout: 1000, maxTimeout: 1000, randomize: false },
    onCompromised(error) {
      compromised = error;
      fatalClose?.();
    },
  });
  let released = false;
  const releaseLease = async () => {
    if (!released && !compromised) { released = true; await release(); }
  };
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const models = options.models ?? await createConfiguredModels(options);
    if (!models.getModel(options.model.provider, options.model.modelId)) {
      throw new ServerConfigurationError("Selected chat model is not configured; use --list-models");
    }
    if (!options.models) {
      const available = await models.getAvailable(options.model.provider);
      if (!available.some((model) => model.id === options.model.modelId)) {
        throw new ServerConfigurationError("Selected model has no usable VM authentication");
      }
    }
    // Built once per server start from validated, canonical values; stable across requests for prompt caching.
    const runtimeContext = [
      "Runtime context for this session:",
      `- You run on the server host: every tool executes on the machine running this session, not on the connecting client.`,
      `- Configured model: ${options.model.provider}/${options.model.modelId}. This is fixed at server startup.`,
      `- Workspace: ${cwd}. You read and edit files there.`,
      `- Durable conversation store: ${databasePath} (SQLite). This is a distinct role from the workspace: it holds persisted conversation history and survives restarts. The two paths are independent; either placement (inside or outside the workspace) is supported.`,
      `- An empty workspace does not mean there is no persisted conversation history; history lives in the SQLite store, not in workspace files.`,
      `- The server manages the store and its live companions ${databasePath}-wal, ${databasePath}-shm and ${databasePath}.lock (write-ahead log, shared memory and session lease). Do not modify or delete these files while the session is running.`,
      `- Diagnostics: For the documented dedicated user-service deployment: journalctl --user -u pi-durable-remote.service -n 30 --no-pager. When running standalone, diagnostics are the stdout/stderr of the launching process. Do not share logs unredacted; they can contain private details.`,
    ].join("\n");
    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(defineExtension({
      name: "remote-coding",
      sections: [
        section("preamble", () => "You are a concise coding assistant. Use read, write, edit, and bash to inspect and change the workspace. Verify changes when practical and report results honestly.", { tag: false }),
        section("runtime", () => runtimeContext),
        section("cwd", (input) => input.env?.cwd),
      ],
    }));
    const storage = await openNodeSqliteStorage(databasePath);
    cleanup = () => storage.close(BACKGROUND_CONTEXT);
    const harness = await Harness.open(storage, {
      models, registry,
      env: ({ cwd: targetCwd }) => new NodeExecutionEnv({ cwd: targetCwd ?? cwd }),
    }, BACKGROUND_CONTEXT);
    cleanup = () => harness.close(BACKGROUND_CONTEXT);
    const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: options.model, cwd } });
    const agent = await conversation.agent(BACKGROUND_CONTEXT);
    if (agent.cwd !== cwd || agent.model?.provider !== options.model.provider || agent.model.modelId !== options.model.modelId) {
      throw new ServerConfigurationError("Storage belongs to a different cwd/model; reopen with its original configuration");
    }
    const conversationState = await conversation.viewState(BACKGROUND_CONTEXT);
    const taskState = await harness.taskGraph(BACKGROUND_CONTEXT);
    cleanup = async () => { conversationState.dispose(); taskState.dispose(); await harness.close(BACKGROUND_CONTEXT); };
    const http = createServer((_request, response) => { response.writeHead(404); response.end(); });
    const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES, perMessageDeflate: false });
    const epoch = randomUUID();
    let revision = 0;
    let closing = false;
    let controller: WebSocket | undefined;
    let peer: SnapshotPeer | undefined;
    let hello = false;
    let pendingCommands = 0;
    let commandLine: Promise<void> = Promise.resolve();
    const envelope = { protocolVersion: PROTOCOL_VERSION, epoch } as const;
    const currentView = (): RemoteView => ({
      session: { databasePath, cwd }, model: options.model,
      conversation: conversationState.value, tasks: taskState.value,
    });
    const frame = (type: "snapshot" | "view"): Extract<ServerMessage, { type: "snapshot" | "view" }> => ({ ...envelope, type, revision, view: currentView() });
    const publish = () => { revision++; if (hello) peer?.view(frame("view")); };
    const unsubscribeConversation = conversationState.subscribe(publish);
    const unsubscribeTasks = taskState.subscribe(publish);
    const reject = (target: SnapshotPeer, id: string | undefined, code: ErrorCode, error: string) => {
      target.control(id ? { ...envelope, type: "reply", id, ok: false, code, error } : { ...envelope, type: "error", code, error });
    };
    const handleCommand = async (message: Extract<ClientMessage, { type: "command" }>, target: SnapshotPeer) => {
      try {
        if (closing) { reject(target, message.id, "SERVER_CLOSING", "Server is closing"); return; }
        if (message.command.conversationId !== conversation.id) {
          reject(target, message.id, "WRONG_CONVERSATION", "Command does not target this session's conversation"); return;
        }
        if (message.command.name === "submit") {
          const submission = await conversation.submit({
            type: "input", content: message.command.text, whenBusy: message.command.whenBusy, requestId: message.id,
          }, BACKGROUND_CONTEXT);
          target.control({ ...envelope, type: "reply", id: message.id, ok: true, status: "admitted", submissionId: submission.id });
        } else {
          await conversation.abort(BACKGROUND_CONTEXT);
          target.control({ ...envelope, type: "reply", id: message.id, ok: true, status: "completed" });
        }
      } catch (error) {
        if (error instanceof ConversationBusy) reject(target, message.id, "CONVERSATION_BUSY", "Conversation is busy; input was not admitted");
        else reject(target, message.id, "COMMAND_FAILED", "Command failed; resync to inspect durable state before retrying");
      }
    };
    http.on("upgrade", (request, socket, head) => {
      // Loopback alone does not protect against drive-by browser WebSockets.
      const status = request.headers.origin !== undefined ? 403 : closing ? 503 : controller ? 409 : request.url !== "/" ? 404 : undefined;
      if (status) { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
      sockets.handleUpgrade(request, socket, head, (ws) => {
        controller = ws;
        const target = new SnapshotPeer(ws, intervalMs);
        peer = target;
        hello = false;
        const helloTimeout = setTimeout(() => ws.terminate(), 5000);
        helloTimeout.unref();
        let alive = true;
        const heartbeat = setInterval(() => {
          if (!alive) { ws.terminate(); return; }
          alive = false;
          ws.ping();
        }, 15_000);
        heartbeat.unref();
        ws.on("pong", () => { alive = true; });
        ws.on("error", () => {}); // Transport errors never cancel Harness work.
        ws.on("close", () => {
          clearTimeout(helloTimeout);
          clearInterval(heartbeat);
          if (controller === ws) { controller = undefined; peer = undefined; hello = false; }
        });
        ws.on("message", (data, binary) => {
          if (binary) { reject(target, undefined, "INVALID_MESSAGE", "Expected a text JSON frame"); return; }
          const parsed = parseClientMessage(data.toString());
          if (!parsed.ok) { reject(target, parsed.id, parsed.code, parsed.error); return; }
          const message = parsed.message;
          if (message.type === "hello") {
            hello = true;
            clearTimeout(helloTimeout);
            target.view(frame("snapshot"));
            return;
          }
          if (!hello) { reject(target, message.type === "command" ? message.id : undefined, "HELLO_REQUIRED", "Send hello before commands or resync"); return; }
          if (message.type === "resync") { target.view(frame("snapshot")); return; }
          if (pendingCommands >= MAX_PENDING_COMMANDS) { reject(target, message.id, "SERVER_BUSY", "Command queue is full; request was not admitted"); return; }
          pendingCommands++;
          commandLine = commandLine.then(() => handleCommand(message, target)).finally(() => { pendingCommands--; });
        });
      });
    });
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => closePromise ??= (async () => {
      closing = true;
      controller?.terminate();
      unsubscribeConversation(); unsubscribeTasks();
      conversationState.dispose(); taskState.dispose();
      await new Promise<void>((done) => http.close(() => done()));
      await new Promise<void>((done) => sockets.close(() => done()));
      try {
        await harness.close(BACKGROUND_CONTEXT);
        await commandLine;
      } finally { await releaseLease(); }
    })();
    fatalClose = () => {
      closing = true;
      options.onFatal?.("Session lease compromised; shutting down");
      void close().catch(() => options.onFatal?.("Shutdown after compromised lease failed"));
    };
    if (compromised) throw new ServerConfigurationError("Session lease compromised during startup");
    cleanup = close;
    await new Promise<void>((done, fail) => {
      http.once("error", fail);
      http.listen(port, host, () => { http.off("error", fail); done(); });
    });
    if (compromised) throw new ServerConfigurationError("Session lease compromised during startup");
    harness.resume();
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Missing listen address");
    return { epoch, port: address.port, host, url: `ws://${host === "::1" ? "[::1]" : host}:${address.port}/`, currentView, close };
  } catch (error) {
    try { await cleanup?.(); } finally {
      // A compromised lease is already relinquished by proper-lockfile; never remove a successor's lock.
      await releaseLease();
    }
    throw error;
  }
}
