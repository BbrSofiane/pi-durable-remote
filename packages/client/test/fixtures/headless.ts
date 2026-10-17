import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { RemoteClient, transcriptText } from "../../src/index.ts";

// Load released modules first; thereafter the client may not perform ANY file IO.
let fileOperations = 0;
const forbidden = () => { fileOperations++; throw new Error("Local file IO is forbidden in the client"); };
for (const name of ["readFile", "readFileSync", "writeFile", "writeFileSync", "open", "openSync", "readdir", "readdirSync", "stat", "statSync", "lstat", "lstatSync", "access", "accessSync", "realpath", "realpathSync", "createReadStream", "createWriteStream"]) {
  (fs as unknown as Record<string, unknown>)[name] = forbidden;
}
for (const name of ["readFile", "writeFile", "open", "readdir", "stat", "lstat", "access", "realpath"]) (fsp as unknown as Record<string, unknown>)[name] = forbidden;
syncBuiltinESMExports();
const client = new RemoteClient({ url: process.argv[2], reconnectMinMs: 20 });
try {
  client.start();
  await client.ready();
  const reply = await client.controller.submit("Headless client tool check", "reject");
  const end = Date.now() + 5000;
  while (!transcriptText(client.views.current()).includes("headless-final") || Object.keys(client.views.current().tasks.tasks).length) {
    if (Date.now() > end) throw new Error("Headless final timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  process.stdout.write(JSON.stringify({ admitted: reply.status === "admitted", toolResult: transcriptText(client.views.current()).includes("headless-tool"), fileOperations }) + "\n");
} finally { client.close(); }
