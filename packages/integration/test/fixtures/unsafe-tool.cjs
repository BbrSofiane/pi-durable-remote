const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const cwd = process.argv[2];
assert.equal(process.cwd(), cwd);
// exec replaces bash with this one uniquely identified, test-owned process.
fs.appendFileSync(path.join(cwd, "unsafe-executions.txt"), "executed\n");
fs.writeFileSync(path.join(cwd, "unsafe-owner.json"), JSON.stringify({ pid: process.pid, cwd }));
console.log("unsafe-committed-partial");
// This external effect may outlive the server PID. Tests kill only the recorded owner.
const poll = setInterval(() => {
  if (fs.existsSync(path.join(cwd, "unsafe-release"))) {
    fs.appendFileSync(path.join(cwd, "unsafe-executions.txt"), "completed\n");
    clearInterval(poll);
    clearTimeout(limit);
  }
}, 20);
const limit = setTimeout(() => process.exit(3), 45_000);
