import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { ClientMessage, ServerMessage } from "@sof/durable-remote-protocol";
import WebSocket from "ws";
import { startDurableServer } from "../src/index.ts";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    assert.ok(Date.now() < end, "Timed out waiting for test condition");
    await new Promise((done) => setTimeout(done, 10));
  }
}

export async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "durable-server-test-"));
  const databasePath = join(cwd, "session.sqlite");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const options = { cwd, databasePath, models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id }, port: 0 };
  const servers: Awaited<ReturnType<typeof startDurableServer>>[] = [];
  const beforeClose: (() => void)[] = [];
  t.after(async () => {
    for (const cleanup of beforeClose) cleanup();
    try { for (const server of servers.reverse()) await server.close(); }
    finally { await rm(cwd, { recursive: true, force: true }); }
  });
  const start = async () => { const server = await startDurableServer(options); servers.push(server); return server; };
  return { cwd, databasePath, faux, models, options, start, beforeClose };
}

export class Probe {
  readonly ws: WebSocket;
  readonly frames: ServerMessage[] = [];
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => this.frames.push(JSON.parse(raw.toString()) as ServerMessage));
    ws.on("error", () => {});
  }
  static async connect(url: string, t: TestContext): Promise<Probe> {
    const probe = new Probe(new WebSocket(url));
    t.after(() => probe.ws.terminate());
    await new Promise<void>((done, fail) => { probe.ws.once("open", done); probe.ws.once("error", fail); });
    return probe;
  }
  send(message: ClientMessage): void { this.ws.send(JSON.stringify(message)); }
  async wait(predicate: (frame: ServerMessage) => boolean, after = 0): Promise<ServerMessage> {
    await waitUntil(() => this.frames.slice(after).some(predicate));
    return this.frames.slice(after).find(predicate)!;
  }
  async hello() {
    const after = this.frames.length;
    this.send({ type: "hello", protocolVersion: 1, clientId: "test-terminal" });
    const frame = await this.wait((frame) => frame.type === "snapshot", after);
    assert.equal(frame.type, "snapshot");
    if (frame.type !== "snapshot") throw new Error("Expected snapshot");
    return frame;
  }
  async disconnect(): Promise<void> {
    const closed = new Promise<void>((done) => this.ws.once("close", () => done()));
    this.ws.close();
    await closed;
  }
}
