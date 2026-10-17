import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { startDurableServer } from "../../../server/src/index.ts";
import { SnapshotPeer } from "../../../server/src/peer.ts";

// Only this fixture changes transport behavior. Published Harness/storage/tool code is untouched.
const [cwd, databasePath, mode, port = "0"] = process.argv.slice(2);
if (!cwd || !databasePath) throw new Error("Explicit isolated fixture paths required");
const send = (value: object) => process.send?.(value);
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
const final = "integration-final: server bytes verified";
const expected = "durable server bytes ✓\n";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

if (mode === "held-turn") {
  faux.setResponses([
    async () => { send({ type: "model-held" }); await gate; return tool("write", { path: "result.txt", content: "initial bytes\n" }); },
    tool("edit", { path: "result.txt", oldText: "initial bytes", newText: "durable server bytes ✓" }),
    tool("read", { path: "result.txt" }),
    tool("bash", { command: `${quote(process.execPath)} -e ${quote('const f=require("node:fs");if(f.readFileSync("result.txt","utf8")!=="durable server bytes ✓\\n")process.exit(2);console.log("bash-server-verified")')}` }),
    fauxAssistantMessage(final),
  ]);
} else if (mode === "unsafe") {
  const script = new URL("./unsafe-tool.cjs", import.meta.url).pathname;
  faux.setResponses([tool("bash", { command: `exec ${quote(process.execPath)} ${quote(script)} ${quote(cwd)}` })]);
} else if (mode === "resume-tool") {
  faux.setResponses([
    async (context) => {
      const result = context.messages.find((message) => message.role === "toolResult");
      send({ type: "recovery-context", result });
      assert.ok(result?.role === "toolResult" && result.isError);
      assert.match(JSON.stringify(result), /interrupted/i);
      return tool("write", { path: "result.txt", content: expected });
    },
    fauxAssistantMessage(final),
  ]);
} else if (mode === "crash-before-reply") {
  // control() is reached only after conversation.submit() has returned its durable admission.
  // Persist test-only evidence synchronously, then die BEFORE queueing/sending that reply.
  const original = SnapshotPeer.prototype.control;
  SnapshotPeer.prototype.control = function (frame) {
    if (frame.type === "reply" && frame.ok && frame.status === "admitted") {
      writeFileSync(join(cwd, "crash-admission.json"), JSON.stringify(frame));
      process.kill(process.pid, "SIGKILL");
      return;
    }
    original.call(this, frame);
  };
  faux.setResponses([async () => new Promise<never>(() => {})]);
} else if (mode === "resume-input") {
  faux.setResponses([fauxAssistantMessage("integration-resumed-input")]);
} else throw new Error("Unknown fixture mode");

const server = await startDurableServer({ cwd, databasePath, models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id }, port: Number(port) });
send({ type: "ready", url: server.url, epoch: server.epoch, pid: process.pid });
let reported = false;
const progress = setInterval(() => {
  const view = server.currentView();
  if (!reported && Object.keys(view.tasks.tasks).length === 0 && view.conversation.entries.some((entry) => entry.model?.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "text" && block.text.startsWith("integration-"))))) {
    reported = true;
    send({ type: "finished", view, callCount: faux.state.callCount });
  }
}, 10);
process.on("message", (message) => {
  if (!message || typeof message !== "object" || !("type" in message)) return;
  if (message.type === "release") release();
  if (message.type === "inspect") send({ type: "inspection", view: server.currentView(), callCount: faux.state.callCount });
  if (message.type === "close") {
    clearInterval(progress);
    void server.close().then(() => { process.disconnect(); });
  }
});
