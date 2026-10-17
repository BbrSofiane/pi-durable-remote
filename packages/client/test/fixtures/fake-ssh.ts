import { createServer, connect } from "node:net";
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const forward = args[args.indexOf("-L") + 1].split(":");
const localPort = Number(forward[1]);
const remotePort = Number(forward[3]);
const log = (event: object) => appendFileSync(process.env.FAKE_SSH_LOG!, JSON.stringify(event) + "\n");
log({ type: "spawn", pid: process.pid, args });
const sockets = new Set<ReturnType<typeof connect>>();
const server = createServer((front) => {
  const back = connect(remotePort, "127.0.0.1");
  sockets.add(front); sockets.add(back);
  front.pipe(back); back.pipe(front);
  front.on("error", () => {}); back.on("error", () => {});
  front.on("close", () => { sockets.delete(front); back.destroy(); });
  back.on("close", () => { sockets.delete(back); front.destroy(); });
});
server.on("error", () => { log({ type: "forward-failed" }); process.exitCode = 1; });
if (process.env.FAKE_SSH_MODE === "collision") await new Promise((resolve) => setTimeout(resolve, 150));
// OpenSSH logs listener intent BEFORE bind, including on failure.
process.stderr.write(`debug1: Local forwarding listening on 127.0.0.1 port ${localPort}.\r\n`);
server.listen(localPort, "127.0.0.1", () => {
  process.stderr.write("debug1: Entering interactive session.\r\n");
});
process.on("SIGTERM", () => {
  log({ type: "term", pid: process.pid });
  for (const socket of sockets) socket.destroy();
  server.close(() => { process.exitCode = 0; });
});
