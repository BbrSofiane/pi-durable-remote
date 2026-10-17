import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

test("createConfiguredModels rejects published runtime config errors before Harness startup without leaking diagnostics", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "durable-server-test-model-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Isolate home, pi state, and ambient authentication; no real credentials or network are usable.
  const { stdout } = await execute(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./fixtures/model-configuration.ts", import.meta.url)), directory], {
    env: { HOME: directory, PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1", OPENAI_API_KEY: "test-only-never-call" },
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  assert.equal(stdout.trim(), "configuration cases rejected: 3; valid/missing cases accepted: 2; network attempts: 0");
});
