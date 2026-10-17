import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";

export type TunnelState = "waiting" | "ready" | "closed";
export type SshTunnelOptions = { host?: string; remotePort?: number };

function portNumber(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Expected a port from 1 to 65535");
  return port;
}

/** No shell, agent interaction, public bind, shared SSH master, or pre-existing tunnel ownership. */
export function sshArguments(host: string, localPort: number, remotePort: number): string[] {
  if (!/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) throw new Error("Invalid SSH host");
  return ["-N", "-T", "-v", "-S", "none", "-o", "ControlMaster=no", "-o", "ControlPersist=no",
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
    "-L", `127.0.0.1:${portNumber(localPort)}:127.0.0.1:${portNumber(remotePort)}`, "--", host];
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("No loopback port")); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

export class OwnedSshTunnel {
  readonly url: string;
  private readonly args: string[];
  private readonly port: number;
  private child?: ChildProcess;
  private timer?: NodeJS.Timeout;
  private failures = 0;
  private stopped = false;
  private listeners = new Set<() => void>();
  state: TunnelState = "waiting";

  private constructor(host: string, port: number, remotePort: number) {
    this.port = port;
    this.args = sshArguments(host, port, remotePort);
    this.url = `ws://127.0.0.1:${port}/`;
  }
  static async open(options: SshTunnelOptions = {}): Promise<OwnedSshTunnel> {
    const host = options.host ?? "sof-sandbox.exe.xyz";
    const remotePort = options.remotePort ?? 7777;
    sshArguments(host, 1, remotePort);
    const tunnel = new OwnedSshTunnel(host, await unusedLoopbackPort(), remotePort);
    tunnel.launch();
    return tunnel;
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private update(state: TunnelState): void { this.state = state; for (const listener of this.listeners) listener(); }
  private launch(): void {
    if (this.stopped) return;
    const child = spawn("ssh", this.args, { stdio: ["ignore", "ignore", "pipe"] });
    this.child = child;
    let tail = "";
    let listenerSeen = false;
    let sessionSeen = false;
    // The listener log precedes bind(). With ExitOnForwardFailure, interactive entry confirms setup survived.
    // Never expose diagnostic/auth/config data, and never connect based on a port probe alone.
    child.stderr?.on("data", (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-8192);
      listenerSeen ||= tail.includes(`Local forwarding listening on 127.0.0.1 port ${this.port}.`);
      sessionSeen ||= tail.includes("Entering interactive session.");
      if (!this.stopped && child === this.child && this.state !== "ready" && listenerSeen && sessionSeen) {
        this.failures = 0;
        this.update("ready");
        tail = "";
      }
    });
    let startupKill: NodeJS.Timeout | undefined;
    const startup = setTimeout(() => {
      if (this.state !== "ready" && child === this.child) {
        child.kill("SIGTERM");
        startupKill = setTimeout(() => child.kill("SIGKILL"), 2000);
      }
    }, 15_000);
    child.on("error", () => { /* close owns retry; errors are surfaced as tunnel state, not raw stderr */ });
    child.once("close", () => {
      clearTimeout(startup);
      clearTimeout(startupKill);
      if (child !== this.child) return;
      this.child = undefined;
      if (this.stopped) return;
      this.update("waiting");
      const delay = Math.min(500 * 2 ** Math.min(this.failures++, 6), 10_000);
      this.timer = setTimeout(() => this.launch(), delay);
    });
  }
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.update("closed");
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      child.once("close", () => { clearTimeout(force); resolve(); });
      child.kill("SIGTERM");
    });
  }
}
