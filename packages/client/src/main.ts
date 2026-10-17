import { parseArgs } from "node:util";
import { RemoteClient } from "./remote.ts";
import { OwnedSshTunnel } from "./tunnel.ts";
import { runRemoteTui } from "./tui.ts";

const help = `Usage: npm run client -- [--ssh-host sof-sandbox.exe.xyz] [--remote-port 7777]
       npm run client -- --url ws://127.0.0.1:7777/

Default: own a noninteractive SSH loopback tunnel to sof-sandbox.exe.xyz.
--url connects directly (e.g. a local test server or a caller-owned SSH tunnel).
Requires an interactive terminal. Exit with Ctrl+C; remote work is NOT aborted.
Model/cwd selection belongs to server startup; the current v1 server has no model/thinking controls.
`;

let tunnel: OwnedSshTunnel | undefined;
try {
  const { values } = parseArgs({ options: {
    help: { type: "boolean", short: "h" },
    url: { type: "string" },
    "ssh-host": { type: "string" },
    "remote-port": { type: "string" },
  }, allowPositionals: false });
  if (values.help) process.stdout.write(help);
  else {
    if (values.url && (values["ssh-host"] || values["remote-port"])) throw new Error("Use --url or SSH options, not both");
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("An interactive terminal is required; use the exported RemoteClient API for headless operation");
    if (!values.url) tunnel = await OwnedSshTunnel.open({ host: values["ssh-host"], remotePort: values["remote-port"] === undefined ? undefined : Number(values["remote-port"]) });
    const client = tunnel ? new RemoteClient({ tunnel }) : new RemoteClient({ url: values.url! });
    await runRemoteTui(client);
  }
} catch (error) {
  // Do not print raw SSH diagnostics, provider config, or potentially credential-bearing URLs.
  process.stderr.write(error instanceof Error && ["An interactive terminal is required; use the exported RemoteClient API for headless operation", "Use --url or SSH options, not both", "Invalid SSH host", "Expected a port from 1 to 65535", "Expected a loopback ws:// URL with path / and no credentials"].includes(error.message)
    ? `${error.message}\n` : "Client startup failed; check --help, runtime, SSH and command options\n");
  process.exitCode = 1;
} finally {
  await tunnel?.close();
}
