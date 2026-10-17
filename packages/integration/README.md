# Process recovery integration gate

These tests integrate the existing server and client contracts without adding a second runner or product API. They use published `fauxProvider`, real SQLite, real server Node processes and CodingTools; they never instantiate real model credentials or call a provider API. All cwd/database paths are private temporary fixtures. No VM is contacted.

```sh
npm run check
npm test
# Focused gate:
node --experimental-strip-types --test packages/integration/test/*.test.ts
```

The actual CLI PTY test uses the installed `python3` and Python's standard-library `pty` module on POSIX, without an npm/native terminal dependency. It launches `packages/client/src/main.ts` with an actual terminal in an empty client cwd, uses bracketed paste + Enter, waits for durable admission, presses Ctrl+C, checks restored termios/alternate-screen exit, then starts a second CLI to observe the completed remote tools/final answer. Capture is bounded to 128 KiB per instance and the driver has a 15-second deadline. This is real terminal/input/render/lifecycle evidence, not a human visual review or a full terminal emulator.

## Assertions

- A real client subprocess exits normally while the model is held. With no client processes left, the server finishes write/edit/read/bash and produces `result.txt` containing exactly `durable server bytes ✓\n`. The empty client cwd stays empty. Reconnecting the actual adapter receives the same whole final state and epoch, with one user input.
- A real unsafe CodingTools `bash` runs a uniquely owned fixture process and commits partial output. SIGKILL of the server leaves the external process alive (standalone PID death is not cgroup termination). The test kills only that exact recorded fixture PID before reopening the exact same SQLite file/cwd/model. Harness recovery supplies an `interrupted` error containing committed partial output; bash is **not** rerun, and one input remains. A subsequent write executes in the server cwd and completes the turn.
- A test-only `SnapshotPeer.control()` interception records an admitted reply and SIGKILLs its own server **before** sending it. The actual client reports unknown outcome with the retained request ID and command. After reopening SQLite and completing that input, a raw test protocol peer explicitly resends the same ID/payload; the reply has the original submission ID, the transcript still has one user input, and the faux model call count remains one.
- Actual CLI Ctrl+C exits successfully before model release, sends no abort, restores terminal settings and leaves work alive. A second PTY displays the finished bash output and final answer.

The explicit raw-peer resend is **server/protocol deduplication evidence only**: it is not a supported client retry workflow, not automatic replay, and adds no retry API. Ordinary adapter reconnect remains whole-state replacement without replay. Unsafe external side effects cannot be undone by SQLite, and independently surviving subprocesses are not reconciled by the app. Deployment should assess service cgroup termination separately; these tests prove standalone server-process behavior, not systemd/VM reboot behavior.

Owned fixture servers/clients, recorded tool PID and PTY client session are cleaned up; unrelated processes/files are never killed or removed. Stale SQLite leases are reclaimed through the existing bounded server lease policy, not removed by the test. Exact paths are canonicalized because macOS temporary directories can have `/var` and `/private/var` aliases.

## Deployment handoff (not performed here)

Remote runtime remains Node >=22.19 with dependencies pinned in the lockfile; install only with `npm install --ignore-scripts`. Use existing VM auth through the released ModelRuntime:

```sh
# On the VM; no model turn:
npm run server -- --list-models
# One explicit original configuration; loopback-only:
npm run server -- --cwd <absolute-vm-workspace> --storage <absolute-private-app-data>/session.sqlite --provider <provider> --model <model-id> --host 127.0.0.1 --port 7777
# On the local terminal:
npm run client -- --ssh-host sof-sandbox.exe.xyz --remote-port 7777
```

No deployment/service definition, real OpenSSH, existing VM authentication, VM reboot or paid model smoke is validated by this local integration gate. Those remain the authorized next slice. Pinned experimental durable/SQLite APIs, lease stale-time limitations, one-controller exclusion and whole-snapshot size ceilings remain unchanged.
