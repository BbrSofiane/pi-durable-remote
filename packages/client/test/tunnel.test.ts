import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { sshArguments } from "../src/tunnel.ts";
import { fixture } from "../../server/test/helpers.ts";

test("SSH arguments pin loopback forwarding, noninteractive auth, own non-shared process and safe host", () => {
  const args = sshArguments("exedev@sof-sandbox.exe.xyz", 45678, 7777);
  assert.deepEqual(args, ["-N", "-T", "-v", "-S", "none", "-o", "ControlMaster=no", "-o", "ControlPersist=no", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-L", "127.0.0.1:45678:127.0.0.1:7777", "--", "exedev@sof-sandbox.exe.xyz"]);
  for (const host of ["-oProxyCommand=evil", "host; touch marker", "", "user@host/path"]) assert.throws(() => sshArguments(host, 1, 7777), /Invalid SSH host/);
  for (const port of [0, -1, 65536, NaN, 1.1]) assert.throws(() => sshArguments("host", port, 7777));
});

for (const mode of ["forward", "collision"]) {
  test(`owned SSH ${mode}: real adapter through isolated fake executable, safe cleanup`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    f.faux.setResponses([fauxAssistantMessage("tunnel-final")]);
    const server = await f.start();
    const dir = await mkdtemp(join(tmpdir(), "durable-client-ssh-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const log = join(dir, "ssh.jsonl");
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    await writeFile(join(dir, "ssh"), `#!/bin/sh\nexec ${quote(process.execPath)} --experimental-strip-types ${quote(resolve("packages/client/test/fixtures/fake-ssh.ts"))} "$@"\n`, { mode: 0o700 });
    const output = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "packages/client/test/fixtures/tunnel-client.ts", String(server.port)], {
      timeout: 8000, maxBuffer: 32 * 1024,
      env: { ...process.env, PATH: dir + delimiter + process.env.PATH, FAKE_SSH_LOG: log, FAKE_SSH_MODE: mode },
    });
    const result = JSON.parse(output.stdout);
    assert.equal(result.tunnelState, "closed");
    const events = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === "spawn"));
    for (const event of events.filter((event) => event.type === "spawn")) assert.throws(() => process.kill(event.pid, 0), /ESRCH/);
    if (mode === "forward") {
      assert.equal(result.admitted, true); assert.equal(result.reconnected, true); assert.equal(f.faux.state.callCount, 1);
      assert.equal(events.filter((event) => event.type === "spawn").length, 2);
      assert.ok(events.some((event) => event.type === "term"));
    } else {
      assert.equal(result.connections, 0); assert.equal(result.unrelatedAlive, true);
      assert.equal(f.faux.state.callCount, 0);
      assert.ok(events.some((event) => event.type === "forward-failed"));
    }
  });
}
