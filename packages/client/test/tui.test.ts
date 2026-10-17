import assert from "node:assert/strict";
import test from "node:test";
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { RemoteClient, runRemoteTui, terminalText, transcriptText } from "../src/index.ts";
import { deferred, fixture, waitUntil } from "../../server/test/helpers.ts";

class TestTerminal implements Terminal {
  output = "";
  columns = 36;
  rows = 20;
  kittyProtocolActive = false;
  input?: (data: string) => void;
  stopped = false;
  start(input: (data: string) => void): void { this.input = input; }
  stop(): void { this.stopped = true; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(_status: ProgramStatus): void {}
}

test("pi-tui editor submits to real adapter, shows connection state, and Ctrl+C exits without abort", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.beforeClose.push(() => release.resolve());
  let aborted = false;
  f.faux.setResponses([async (_context, options) => {
    options?.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
    entered.resolve(); await release.promise; return fauxAssistantMessage("ui-final");
  }]);
  const server = await f.start();
  const client = new RemoteClient({ url: server.url, reconnectMinMs: 20 });
  const terminal = new TestTerminal();
  const ui = runRemoteTui(client, terminal);
  t.after(async () => { terminal.input?.("\x03"); await ui; client.close(); });
  await client.ready();
  await waitUntil(() => terminalText(terminal.output).includes("CONNECTED"));
  for (const character of "UI message 世界") terminal.input!(character);
  terminal.input!("\r");
  await entered.promise;
  await waitUntil(() => client.notices.some((notice) => notice.includes("durably admitted")));
  client.reconnectNow();
  await waitUntil(() => terminalText(terminal.output).includes("DISCONNECTED"));
  await client.ready();
  terminal.input!("\x12"); // Ctrl+R uses adapter resync.
  terminal.input!("\x03");
  await ui;
  assert.equal(client.state, "closed");
  assert.equal(terminal.stopped, true);
  assert.equal(aborted, false);
  assert.ok(Object.keys(server.currentView().tasks.tasks).length);
  assert.match(transcriptText(server.currentView()), /UI message 世界/);
  release.resolve();
  await waitUntil(() => transcriptText(server.currentView()).includes("ui-final"));
});

test("remote payload text is rendered without terminal control sequences or local previews", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("hello\x1b]52;c;credential-looking-data\x07世界\x1b[2J\r\x00end")]);
  const server = await f.start();
  const client = new RemoteClient({ url: server.url }); t.after(() => client.close());
  client.start(); await client.ready(); await client.controller.submit("safe display");
  await waitUntil(() => Object.keys(client.views.current().tasks.tasks).length === 0 && client.views.current().conversation.entries.some((entry) => entry.kind === "pi.assistant"));
  const output = transcriptText(client.views.current());
  assert.match(output, /hello世界end/);
  assert.doesNotMatch(output, /\x1b|\x07|\r|\x00|credential-looking-data/);
  assert.equal(terminalText("a\t b\u009bb"), "a     bb");
});
