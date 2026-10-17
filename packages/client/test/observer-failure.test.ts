import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fixture } from "../../server/test/helpers.ts";

for (const kind of ["view", "status"]) {
  test(`RemoteClient ${kind} observer faults propagate rather than triggering malformed-frame recovery`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    const server = await f.start();
    await assert.rejects(promisify(execFile)(process.execPath, ["--experimental-strip-types", "packages/client/test/fixtures/observer-failure.ts", server.url, kind], { timeout: 5000, maxBuffer: 32 * 1024 }), (error: unknown) => {
      const child = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
      assert.equal(child.code, 1, "default fatal observer behavior must exit the isolated child");
      assert.notEqual(child.killed, true, "child must fail from the observer, not the test timeout");
      assert.deepEqual(JSON.parse(child.stdout!), { originalError: true, state: "connected", invalidFrameNotices: 0 });
      assert.match(child.stderr!, /local-observer-regression-sentinel/);
      return true;
    });
    assert.equal(f.faux.state.callCount, 0, "no model turn was required");
  });
}
