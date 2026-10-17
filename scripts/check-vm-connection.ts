import assert from "node:assert/strict";
import { OwnedSshTunnel, RemoteClient } from "@sof/durable-remote-client";

// Read-only deployment health check through the same adapter and real SSH child as the TUI.
// Never submit/abort, print transcript/auth, or create a second model runtime locally.
const tunnel = await OwnedSshTunnel.open({ host: "sof-sandbox.exe.xyz", remotePort: 7777 });
const client = new RemoteClient({ tunnel });
try {
  client.start();
  const initial = await client.ready(25_000);
  assert.equal(initial.session.cwd, "/home/exedev/work/pi-durable-remote-smoke");
  assert.equal(initial.session.databasePath, "/home/exedev/.local/share/pi-durable-remote/session.sqlite");
  const epoch = client.epoch;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Resync snapshot timed out")); }, 5000);
    const unsubscribe = client.views.subscribe(() => { clearTimeout(timer); unsubscribe(); resolve(); });
    client.resync();
  });
  client.reconnectNow();
  assert.notEqual(client.state, "connected");
  const reconnected = await client.ready(15_000);
  assert.notEqual(reconnected, initial);
  assert.equal(client.epoch, epoch);
  assert.deepEqual(reconnected.session, initial.session);
  assert.equal(reconnected.conversation.conversation.id, initial.conversation.conversation.id);
  assert.deepEqual(reconnected.model, initial.model);
  console.log(JSON.stringify({
    health: "PASS", transport: "owned SSH loopback forward", resync: true, reconnect: true,
    session: reconnected.session, model: reconnected.model,
    entryCount: reconnected.conversation.entries.length,
    activeTasks: Object.keys(reconnected.tasks.tasks).length,
    modelCallsRequested: 0,
  }));
} catch {
  // Avoid emitting remote payloads, diagnostics or provider/auth causes even on assertion failure.
  console.error("VM connection check failed; inspect dedicated service status and connection configuration");
  process.exitCode = 1;
} finally {
  client.close();
  await tunnel.close();
}
