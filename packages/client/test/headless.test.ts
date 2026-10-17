import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fixture } from "../../server/test/helpers.ts";

test("exported headless RemoteClient submits/observes actual server with local file IO forbidden", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "echo headless-tool" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("headless-final"),
  ]);
  const server = await f.start();
  const result = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "packages/client/test/fixtures/headless.ts", server.url], { timeout: 8000, maxBuffer: 32 * 1024 });
  assert.deepEqual(JSON.parse(result.stdout), { admitted: true, toolResult: true, fileOperations: 0 });
  assert.equal(f.faux.state.callCount, 2);
});
