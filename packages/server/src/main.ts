import { parseArgs } from "node:util";
import { createConfiguredModels, ServerConfigurationError, startDurableServer } from "./index.ts";

const usage = `Usage: npm run server -- --cwd <directory> --storage <session.sqlite> --provider <provider> --model <model-id>
  --host 127.0.0.1|::1  --port 7777
  --auth-path <file>    --models-path <file>
  --list-models        List available chat model IDs using existing pi VM auth (no model calls)
One persistent session, one controlling client. Existing storage keeps its original cwd/model.
SSH tunnel: ssh -N -L 7777:127.0.0.1:7777 <vm>.exe.xyz
`;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    cwd: { type: "string" }, storage: { type: "string" }, provider: { type: "string" }, model: { type: "string" },
    host: { type: "string", default: "127.0.0.1" }, port: { type: "string", default: "7777" },
    "auth-path": { type: "string" }, "models-path": { type: "string" },
    "list-models": { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) { console.log(usage); return; }
  const authOptions = { authPath: values["auth-path"], modelsPath: values["models-path"] };
  if (values["list-models"]) {
    const models = await createConfiguredModels(authOptions);
    for (const model of await models.getAvailable()) console.log(`${model.provider}\t${model.id}`);
    return;
  }
  if (!values.cwd || !values.storage || !values.provider || !values.model) throw new ServerConfigurationError(usage);
  if (values.host !== "127.0.0.1" && values.host !== "::1") throw new ServerConfigurationError("Listen host must be 127.0.0.1 or ::1");
  if (!/^\d+$/.test(values.port)) throw new ServerConfigurationError("Invalid listen port");
  process.umask(0o077);
  const server = await startDurableServer({
    ...authOptions, cwd: values.cwd, databasePath: values.storage,
    model: { provider: values.provider, modelId: values.model }, host: values.host, port: Number(values.port),
    onFatal: (message) => { console.error(message); process.exitCode = 1; },
  });
  console.log(`durable-server listening ${server.url} (protocol v1)`);
  const stop = () => { void server.close().catch(() => { console.error("Server shutdown failed"); process.exitCode = 1; }); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

void main().catch((error: unknown) => {
  // Provider/auth errors may contain credential material; never print them or their raw causes.
  console.error(error instanceof ServerConfigurationError ? error.message : "Server failed to start (configuration, storage lease, auth, or listen endpoint)");
  process.exitCode = 1;
});
