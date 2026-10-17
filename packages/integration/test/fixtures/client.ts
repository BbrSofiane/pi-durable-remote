import { RemoteClient, CommandOutcomeUnknownError } from "../../../client/src/index.ts";

// Absolute entrypoint; launched in an EMPTY directory, not in the server workspace/repo.
const client = new RemoteClient({ url: process.argv[2], reconnectMinMs: 30, reconnectMaxMs: 100 });
client.start();
await client.ready();
process.send?.({ type: "ready", cwd: process.cwd(), view: client.views.current() });
process.on("message", (message) => {
  if (!message || typeof message !== "object" || !("type" in message)) return;
  if (message.type === "submit" && "text" in message && typeof message.text === "string") {
    void client.controller.submit(message.text, "reject").then((reply) => process.send?.({ type: "admitted", reply })).catch((error: unknown) => {
      if (!(error instanceof CommandOutcomeUnknownError)) throw error;
      process.send?.({ type: "unknown", requestId: error.requestId, command: error.command });
    });
  }
  if (message.type === "close") { client.close(); process.disconnect(); }
});
