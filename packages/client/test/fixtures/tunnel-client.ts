import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import { OwnedSshTunnel, RemoteClient, transcriptText } from "../../src/index.ts";

const tunnel = await OwnedSshTunnel.open({ host: "test-vm.exe.xyz", remotePort: Number(process.argv[2]) });
const client = new RemoteClient({ tunnel, reconnectMinMs: 20, reconnectMaxMs: 50 });
let unrelated: WebSocketServer | undefined;
let survivor: ReturnType<typeof spawn> | undefined;
try {
  if (process.env.FAKE_SSH_MODE === "collision") {
    // This listener is NOT owned by the tunnel, and must never be mistaken for a successful forward.
    unrelated = new WebSocketServer({ host: "127.0.0.1", port: Number(new URL(tunnel.url).port) });
    await new Promise<void>((resolve) => unrelated!.once("listening", resolve));
    let connections = 0;
    unrelated.on("connection", (socket) => { connections++; socket.terminate(); });
    survivor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    survivor.on("error", () => {});
    client.start();
    await assert.rejects(client.ready(700), /Timed out/);
    client.close(); await tunnel.close();
    assert.equal(connections, 0);
    assert.ok(unrelated.address(), "tunnel cleanup preserved the pre-existing listener");
    assert.ok(survivor.pid); process.kill(survivor.pid, 0);
    process.stdout.write(JSON.stringify({ connections, unrelatedAlive: true, tunnelState: tunnel.state }) + "\n");
  } else {
    client.start(); await client.ready();
    const reply = await client.controller.submit("Via owned tunnel", "reject");
    const end = Date.now() + 5000;
    while (!transcriptText(client.views.current()).includes("tunnel-final") || Object.keys(client.views.current().tasks.tasks).length) {
      if (Date.now() > end) throw new Error("Tunnel final timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const events = readFileSync(process.env.FAKE_SSH_LOG!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const pid = events.find((event) => event.type === "spawn").pid;
    process.kill(pid, "SIGTERM"); // Fault only this test-owned fake SSH process.
    const disconnectedBy = Date.now() + 3000;
    while (client.state === "connected") {
      if (Date.now() > disconnectedBy) throw new Error("SSH fault did not disconnect");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await client.ready(5000);
    assert.match(transcriptText(client.views.current()), /tunnel-final/);
    client.close(); await tunnel.close();
    process.stdout.write(JSON.stringify({ admitted: reply.status === "admitted", tunnelState: tunnel.state, reconnected: true }) + "\n");
  }
} finally {
  client.close(); await tunnel.close();
  await new Promise<void>((resolve) => { if (!unrelated) resolve(); else unrelated.close(() => resolve()); });
  if (survivor) await new Promise<void>((resolve) => { survivor!.once("exit", () => resolve()); survivor!.kill("SIGTERM"); });
}
