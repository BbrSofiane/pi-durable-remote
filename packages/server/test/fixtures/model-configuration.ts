import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createConfiguredModels, ServerConfigurationError, startDurableServer } from "../../src/index.ts";

const directory = process.argv[2];
if (!directory) throw new Error("Isolated test directory required");
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error("Network forbidden in configuration regression test"); };
const authPath = join(directory, "auth.json");
await writeFile(authPath, "{}");
const cases = [
  { name: "malformed", config: "{ invalid JSON", errorPrefix: "Failed to parse models.json" },
  { name: "schema", config: JSON.stringify({ providers: "invalid" }), errorPrefix: "Invalid models.json schema" },
  { name: "composition", config: JSON.stringify({ providers: { openai: {} } }), errorPrefix: "Provider \"openai\"" },
];
for (const { name, config, errorPrefix } of cases) {
  const modelsPath = join(directory, `${name}.json`);
  const databasePath = join(directory, `${name}.sqlite`);
  await writeFile(modelsPath, config);
  const options = { authPath, modelsPath };
  // Verify the real published runtime retains the error and a built-in model despite resolving.
  const runtime = await ModelRuntime.create({ ...options, allowModelNetwork: false });
  assert.ok(runtime.getError()?.startsWith(errorPrefix));
  const model = runtime.getModels("openai")[0];
  assert.ok(model);
  const sanitized = (error: unknown) => {
    assert.ok(error instanceof ServerConfigurationError);
    assert.equal(error.message, "Model configuration is invalid; check models.json and provider settings");
    assert.equal(error.cause, undefined, "Raw configuration diagnostics must not leak through causes");
    return true;
  };
  await assert.rejects(createConfiguredModels(options), sanitized);
  let unexpected: Awaited<ReturnType<typeof startDurableServer>> | undefined;
  try {
    await assert.rejects(async () => {
      unexpected = await startDurableServer({ ...options, cwd: directory, databasePath, model: { provider: model.provider, modelId: model.id }, port: 0 });
    }, sanitized);
  } finally { await unexpected?.close(); }
  await assert.rejects(access(databasePath), { code: "ENOENT" }, "Rejected config must not open SQLite/Harness");
  await assert.rejects(access(`${databasePath}.lock`), { code: "ENOENT" }, "Rejected startup must release its lease");
}
// Missing config and an empty, valid config still work without provider/model network access.
const missing = await createConfiguredModels({ authPath, modelsPath: join(directory, "missing.json") });
assert.equal(missing.getError(), undefined);
const validPath = join(directory, "valid.json");
await writeFile(validPath, JSON.stringify({ providers: {} }));
const valid = await createConfiguredModels({ authPath, modelsPath: validPath });
assert.equal(valid.getError(), undefined);
assert.ok(valid.getModels("openai").length > 0);
assert.equal(networkAttempts, 0);
console.log("configuration cases rejected: 3; valid/missing cases accepted: 2; network attempts: 0");
