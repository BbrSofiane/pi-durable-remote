import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { RemoteClient } from "../../client/src/index.ts";
import { waitUntil } from "../../server/test/helpers.ts";
export { waitUntil };

export class FixtureProcess {
  readonly child: ChildProcess;
  readonly messages: Record<string, unknown>[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr = "";
  stdout = "";
  stopped = false;
  constructor(command: string, args: string[], cwd: string, ipc = true) {
    this.child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc" as const] : [])], env: { ...process.env, TERM: "xterm-256color" } });
    this.child.stdout?.on("data", (data: Buffer) => { this.stdout = (this.stdout + data.toString()).slice(-128 * 1024); });
    this.child.stderr?.on("data", (data: Buffer) => { this.stderr = (this.stderr + data.toString()).slice(-16 * 1024); });
    this.child.on("message", (message) => { this.messages.push(message as Record<string, unknown>); });
    this.exited = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("exit", (code, signal) => { this.stopped = true; resolve({ code, signal }); });
    });
  }
  send(message: object): void { assert.ok(this.child.connected); this.child.send(message); }
  async message(type: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    await waitUntil(() => this.messages.some((message) => message.type === type) || this.stopped, timeoutMs);
    const message = this.messages.find((message) => message.type === type);
    assert.ok(message, `Missing ${type}; child exit: ${this.child.exitCode}/${this.child.signalCode}; ${this.stderr}`);
    return message;
  }
  async kill(): Promise<void> { if (!this.stopped) this.child.kill("SIGKILL"); await this.exited; }
  async close(): Promise<void> {
    if (this.stopped) return;
    this.send({ type: "close" });
    await waitUntil(() => this.stopped, 5000);
    assert.deepEqual(await this.exited, { code: 0, signal: null }, this.stderr);
  }
}

export async function integrationFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "durable-integration-test-")));
  const serverCwd = join(root, "server-workspace");
  const clientCwd = join(root, "empty-client");
  const databasePath = join(root, "data", "session.sqlite");
  await mkdir(serverCwd); await mkdir(clientCwd);
  const processes: FixtureProcess[] = [];
  const clients: RemoteClient[] = [];
  const toolOwnerPath = join(serverCwd, "unsafe-owner.json");
  let toolKilled = false;
  const killTool = async (): Promise<void> => {
    if (toolKilled) return;
    const text = await readFile(toolOwnerPath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
    if (!text) return;
    const owner = JSON.parse(text) as { pid: number; cwd: string };
    assert.equal(owner.cwd, serverCwd);
    assert.ok(Number.isInteger(owner.pid) && owner.pid > 1 && owner.pid !== process.pid);
    try { process.kill(owner.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    toolKilled = true;
  };
  t.after(async () => {
    for (const client of clients) client.close();
    for (const child of processes.reverse()) await child.kill();
    await killTool();
    await rm(root, { recursive: true, force: true });
  });
  const processAt = (command: string, args: string[], cwd = clientCwd, ipc = true) => {
    const child = new FixtureProcess(command, args, cwd, ipc); processes.push(child); return child;
  };
  const startServer = async (mode: string, port = 0) => {
    const child = processAt(process.execPath, ["--experimental-strip-types", new URL("./fixtures/server.ts", import.meta.url).pathname, serverCwd, databasePath, mode, String(port)], serverCwd);
    const ready = await child.message("ready");
    assert.equal(typeof ready.url, "string");
    return { child, url: ready.url as string, epoch: ready.epoch as string };
  };
  const faceAt = async (url: string) => {
    const client = new RemoteClient({ url, reconnectMinMs: 30, reconnectMaxMs: 100 });
    clients.push(client); client.start(); await client.ready(); return client;
  };
  const startClient = async (url: string) => {
    const child = processAt(process.execPath, ["--experimental-strip-types", new URL("./fixtures/client.ts", import.meta.url).pathname, url]);
    const ready = await child.message("ready");
    assert.equal(ready.cwd, clientCwd);
    assert.deepEqual(await readdir(clientCwd), [], "client has no repo/workspace");
    return child;
  };
  return { root, serverCwd, clientCwd, databasePath, startServer, startClient, faceAt, processAt, killTool, toolOwnerPath };
}
