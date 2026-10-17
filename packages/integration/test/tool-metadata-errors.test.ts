import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { waitUntil } from "./helpers.ts";

for (const code of ["EACCES", "EIO", "ENOENT"] as const) {
  test(`recovery tool metadata polling ${code === "ENOENT" ? "retries ENOENT" : `propagates ${code}`}`, { timeout: 25_000 }, async (t) => {
    const env: NodeJS.ProcessEnv = { ...process.env, INTEGRATION_TOOL_METADATA_ERROR: code };
    // The isolated runner must not inherit its parent's node:test worker marker.
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [
      "--experimental-strip-types", "--import", new URL("./fixtures/tool-metadata-io-fault.ts", import.meta.url).href,
      "--test", "--test-reporter=tap", "--test-name-pattern=SIGKILL mid-unsafe-bash",
      new URL("./recovery.test.ts", import.meta.url).pathname,
    ], { stdio: ["ignore", "pipe", "pipe"], env });
    let output = "";
    let stopped = false;
    const collect = (data: Buffer) => { output = (output + data.toString()).slice(-64 * 1024); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => { stopped = true; resolve({ code, signal }); });
    });
    t.after(async () => { if (!stopped) child.kill("SIGKILL"); await exited; });
    await waitUntil(() => stopped, 20_000);
    assert.match(output, new RegExp(`integration-injected-${code}`), output);
    assert.deepEqual(await exited, { code: code === "ENOENT" ? 0 : 1, signal: null }, output);
    if (code === "ENOENT") {
      assert.match(output, /# pass 1/, output);
      assert.match(output, /# fail 0/, output);
    } else {
      assert.match(output, new RegExp(`Synthetic tool metadata ${code}`), output);
      assert.match(output, new RegExp(`code: '${code}'`), output);
      assert.match(output, /# pass 0/, output);
      assert.match(output, /# fail 1/, output);
      assert.doesNotMatch(output, /Timed out|testTimeoutFailure/, "unexpected IO fails directly, not by exhausting polling");
    }
  });
}
