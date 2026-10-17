import { RemoteClient } from "../../src/index.ts";

const client = new RemoteClient({ url: process.argv[2], reconnectMinMs: 20 });
client.start();
await client.ready();
const failure = new Error("local-observer-regression-sentinel");
// Monitor only: the default fatal behavior must still terminate this isolated process.
process.once("uncaughtExceptionMonitor", (error) => {
  process.stdout.write(JSON.stringify({
    originalError: error === failure,
    state: client.state,
    invalidFrameNotices: client.notices.filter((notice) => notice.includes("Invalid/incompatible server frame")).length,
  }) + "\n");
});
const observe = () => { throw failure; };
if (process.argv[3] === "view") client.views.subscribe(observe);
else client.subscribe(observe);
client.resync();
await new Promise((resolve) => setTimeout(resolve, 500));
throw new Error("Local observer failure was swallowed");
