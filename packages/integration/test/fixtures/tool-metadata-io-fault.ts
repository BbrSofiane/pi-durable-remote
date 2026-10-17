import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const code = process.env.INTEGRATION_TOOL_METADATA_ERROR;
if (!["EACCES", "EIO", "ENOENT"].includes(code ?? "")) throw new Error("Explicit test IO error code required");
let injected = false;
fs.readFile = new Proxy(fs.readFile, {
  async apply(target, thisArg, args) {
    const path = args[0] instanceof URL ? args[0].pathname : args[0];
    const result = await Reflect.apply(target, thisArg, args);
    if (!injected && typeof path === "string" && path.endsWith("/unsafe-owner.json")) {
      // Wait for a successful owner read so early test failure can clean its exact tool PID.
      // Startup ENOENT still passes through the real filesystem unchanged.
      injected = true;
      process.stderr.write(`integration-injected-${code}\n`);
      throw Object.assign(new Error(`Synthetic tool metadata ${code}`), { code });
    }
    return result;
  },
});
syncBuiltinESMExports();
