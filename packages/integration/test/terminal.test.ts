import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import type { RemoteView, ServerMessage } from "@sof/durable-remote-protocol";
import { integrationFixture, waitUntil } from "./helpers.ts";
import { recoveryProxy } from "./fixtures/recovery-proxy.ts";

/** Optional raw PTY evidence; cumulative terminal writes, never used as current-frame previews. */
async function ptyArtifact(name: string, evidence: unknown): Promise<void> {
  const directory = process.env.PI_UI_FRAME_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `pty-${name}.json`), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
}

test("actual CLI PTY: editor admits input, Ctrl+C restores terminal without abort, reconnect shows completed remote tools", { timeout: 40_000 }, async (t) => {
  const f = await integrationFixture(t);
  const server = await f.startServer("held-turn");
  const smoke = async (mode: string) => {
    const driver = f.processAt("python3", [new URL("./fixtures/pty-driver.py", import.meta.url).pathname, process.execPath, new URL("../../client/src/main.ts", import.meta.url).pathname, server.url, mode], f.clientCwd, false);
    let completed = false;
    t.after(() => {
      if (completed) return;
      const first = driver.stdout.split("\n").find((line) => line.startsWith("{"));
      if (first) {
        const owner = JSON.parse(first) as { type: string; pid: number };
        assert.equal(owner.type, "pty-start");
        try { process.kill(owner.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    });
    await waitUntil(() => driver.stopped, 20_000);
    const lines = driver.stdout.trim().split("\n");
    const result = JSON.parse(lines.at(-1)!) as { code: number; sentInput: boolean; sentExit: boolean; sentExpand: boolean; restored: boolean; capture: string; error: string | null };
    assert.deepEqual(await driver.exited, { code: 0, signal: null }, `${driver.stderr}\n${JSON.stringify(result)}`);
    completed = true;
    assert.equal(result.error, null);
    assert.equal(result.code, 0);
    assert.equal(result.sentExit, true);
    assert.equal(result.restored, true, "real PTY termios restored after exit");
    assert.match(result.capture, /CONNECTED/);
    assert.match(result.capture, /Enter: follow-up/);
    assert.match(result.capture, /\x1b\[\?1049h/, "actual fullscreen alternate screen was entered");
    assert.match(result.capture, /\x1b\[\?1049l/, "actual fullscreen alternate screen was left");
    assert.equal(result.capture.includes(CURSOR_MARKER), false, "private pi-tui 1.2 cursor APC markers never reach the real terminal");
    assert.ok(result.capture.lastIndexOf("\x1b[?25h") > result.capture.lastIndexOf("\x1b[?25l"), "hardware cursor is visible on exit");
    t.diagnostic(`PTY ${mode}: exit=0, capture=${Buffer.byteLength(result.capture)} bytes, termios restored, cwd has no repo`);
    await ptyArtifact(mode, result);
    return result;
  };
  const first = await smoke("submit-exit");
  assert.equal(first.sentInput, true);
  assert.match(first.capture, /Input durably admitted/);
  await server.child.message("model-held");
  server.child.send({ type: "release" });
  const finished = await server.child.message("finished");
  const final = finished.view as RemoteView;
  assert.equal(final.conversation.entries.filter((entry) => entry.kind === "pi.user").length, 1);
  assert.equal(Object.keys(final.tasks.tasks).length, 0);
  assert.equal(finished.callCount, 5);
  assert.equal(await readFile(join(f.serverCwd, "result.txt"), "utf8"), "durable server bytes ✓\n");
  const next = await smoke("observe-final");
  assert.equal(next.sentInput, false);
  assert.equal(next.sentExpand, true, "actual CLI receives Ctrl+O before proving full tool accessibility");
  assert.match(next.capture, /Arguments/);
  assert.match(next.capture, /integration-final: server bytes verified/);
  assert.match(next.capture, /Tool bash \[done\]/);
  assert.match(next.capture, /bash-server-verified/);
  server.child.send({ type: "inspect" });
  const inspected = await server.child.message("inspection");
  assert.equal(inspected.callCount, finished.callCount, "observe/expand/exit adds no model invocation");
  assert.deepEqual(inspected.view, final, "expansion does not change committed data");
  assert.deepEqual(await readdir(f.clientCwd), [], "neither real TUI instance copied a repo or tool file into client cwd");
  await server.child.close();
});

test("actual CLI PTY recovery: live terminal retains unknown admission through server process restart and /recover restores original admission", { timeout: 40_000 }, async (t) => {
  const f = await integrationFixture(t);
  const first = await f.startServer("crash-before-reply");
  const proxy = await recoveryProxy(t, first.url);
  const driver = f.processAt("python3", [new URL("./fixtures/pty-driver.py", import.meta.url).pathname, process.execPath, new URL("../../client/src/main.ts", import.meta.url).pathname, proxy.url, "recover-restart"], f.clientCwd, false);
  let completed = false;
  t.after(() => {
    if (completed) return;
    const line = driver.stdout.split("\n").find((text) => text.startsWith("{"));
    if (!line) return;
    const owner = JSON.parse(line) as { type: string; pid: number };
    assert.equal(owner.type, "pty-start");
    try { process.kill(owner.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  });
  await waitUntil(() => first.child.stopped, 10_000);
  assert.deepEqual(await first.child.exited, { code: null, signal: "SIGKILL" });
  assert.equal(proxy.commands.length, 1);
  assert.equal(driver.stopped, false, "same CLI process remains alive after durable admission loses its reply");
  const admission = JSON.parse(await readFile(join(f.serverCwd, "crash-admission.json"), "utf8")) as Extract<ServerMessage, { type: "reply"; ok: true; status: "admitted" }>;
  const reopened = await f.startServer("resume-input", Number(new URL(first.url).port));
  const finished = await reopened.child.message("finished");
  await waitUntil(() => driver.stopped, 30_000);
  const result = JSON.parse(driver.stdout.trim().split("\n").at(-1)!) as { code: number; sentInput: boolean; sentRecover: boolean; sentExit: boolean; restored: boolean; capture: string; error: string | null };
  assert.deepEqual(await driver.exited, { code: 0, signal: null }, `${driver.stderr}\n${JSON.stringify(result)}`);
  completed = true;
  assert.equal(result.error, null);
  assert.equal(result.code, 0);
  assert.equal(result.sentInput, true);
  assert.equal(result.sentRecover, true, "actual Editor received explicit /recover after ready panel");
  assert.equal(result.sentExit, true);
  assert.equal(result.restored, true, "real PTY termios restored");
  assert.match(result.capture, /Unconfirmed: 1/);
  assert.match(result.capture, /Recovered input durably admitted/);
  assert.match(result.capture, /not an answer-completion/);
  assert.match(result.capture, /\x1b\[\?1049h/);
  assert.match(result.capture, /\x1b\[\?1049l/);
  assert.equal(result.capture.includes(CURSOR_MARKER), false, "cursor APC markers are resolved throughout process recovery");
  assert.ok(result.capture.lastIndexOf("\x1b[?25h") > result.capture.lastIndexOf("\x1b[?25l"), "hardware cursor is restored after recovery exit");
  assert.equal(proxy.commands.length, 2, "one original input plus one explicit recovery; no automatic replay or abort");
  assert.deepEqual(proxy.commands[1], proxy.commands[0]);
  assert.equal(proxy.commands[0]!.id, admission.id);
  assert.ok(proxy.replies.every((reply) => reply.ok && reply.status === "admitted" && reply.submissionId === admission.submissionId));
  reopened.child.send({ type: "inspect" });
  const inspected = await reopened.child.message("inspection");
  assert.equal(inspected.callCount, finished.callCount, "dedup retry adds no model invocation beyond legitimate resume");
  assert.deepEqual(inspected.view, finished.view);
  assert.equal((inspected.view as RemoteView).conversation.entries.filter((entry) => entry.kind === "pi.user").length, 1);
  assert.deepEqual(await readdir(f.clientCwd), []);
  t.diagnostic(`PTY recovery: same live CLI, same SQLite, two identical command frames, original submission ${admission.submissionId}, exit=0, termios and alternate screen restored`);
  await ptyArtifact("recover-restart", { ...result, commandFrames: proxy.commands, admission });
  await reopened.child.close();
});
