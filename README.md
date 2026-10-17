# pi-durable-remote

A durable coding agent on **sof-sandbox.exe.xyz**, with a local terminal face. The Harness, model calls and read/write/edit/bash tools run as `exedev` on the VM; closing the client does not cancel work. Built only with pinned released npm APIs, not a sibling pi checkout or unpublished experimental modules.

## Local client

Requires Node >=22.19.0 (tested on 24.4.1), npm and working noninteractive OpenSSH authentication to the VM:

```sh
npm install --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run client -- --ssh-host sof-sandbox.exe.xyz --remote-port 7777
```

The client owns an ephemeral **127.0.0.1-only** SSH forward, with BatchMode, ConnectTimeout, host-key `accept-new`, ExitOnForwardFailure and keepalives. It does not reuse/kill existing tunnels. Exit closes only its own tunnel and restores the terminal. No provider credentials or VM workspace files are copied to the laptop.

**Enter** submits a follow-up; **Shift+Enter** inserts a newline; **Ctrl+A** aborts remote work (waits for cancellation to drain); **Ctrl+R** resyncs; **PageUp/PageDown** scroll; **Ctrl+Shift+F** searches the transcript; **Ctrl+O** expands/collapses all tools; **Ctrl+C** exits **without abort**. Transcript, committed partials/tool output, model/cwd and tasks come from remote snapshots. The native terminal presentation groups each tool call/progress/result into one bounded block, with readable literal commands, measured-row previews and full original content accessible via Ctrl+O. Small user/tool surfaces pair their own foreground/background; the main canvas and assistant body remain terminal-owned. Compact connection/model/remote-path metadata lives by the editor, not in a permanent top header. `NO_COLOR` removes presentation styling without removing status labels or spacing. Images remain placeholders. See [client details](packages/client/README.md) and [architecture](ARCHITECTURE.md).

Only submit/abort are agent commands. **/recover** and **/discard**, typed alone, are local TUI actions for the oldest unconfirmed input, not server commands. Other slash inputs submit literal text. There are **no** `/model`, `/thinking`, `/compact`, session-picker, subagent/extension, web/gateway or sandbox-management commands. Model and cwd are configured at server startup.

### Unconfirmed submissions

If an admission reply is lost, the recovery panel retains the original submission in memory. Inspect the fresh remote state, then type **/recover** to resend that exact original request ID and immutable payload (conversation ID, text and busy policy). Re-entering the text normally creates a new ID and may duplicate work. Recovery requires an open connection and a snapshot received after uncertainty for the **same persisted `pi.provider.sessionId`**. A new server epoch after reopening the same SQLite session is allowed; a missing or different session identity fails closed, even if the numeric conversation ID/path is unchanged. Reconnect never retries automatically, and aborts are never recovered.

**/discard** forgets only the oldest local receipt; it does not withdraw an admitted input or abort remote work. Repeated lost recovery replies keep the same receipt for another explicit attempt after a fresh snapshot. Multiple receipts remain visible and resolve oldest-first; at eight receipts, new submissions are refused without evicting earlier ones. Closing or restarting the client **loses all receipts**: there is no disk outbox or supported public SDK recovery API.

A recovered admission means **durably admitted**, not that the answer finished. Deduplication prevents a second admission under the retained ID; it does not promise exactly-once model calls, tool execution or external effects across crashes. Legitimate Harness recovery can resume the original work.

## Dedicated VM installation

Paths used by this deployment:

| Purpose | Path |
| --- | --- |
| Deployed source/dependencies | `/home/exedev/pi-durable-remote` |
| Persistent SQLite (outside source) | `/home/exedev/.local/share/pi-durable-remote/session.sqlite` |
| Isolated initial working directory | `/home/exedev/work/pi-durable-remote-smoke` |
| Dedicated user unit | `/home/exedev/.config/systemd/user/pi-durable-remote.service` |
| Existing Node/npm runtime (reused, not modified) | `/home/exedev/.local/share/mise/installs/node/24.4.1/bin` |
| Private endpoint | `ws://127.0.0.1:7777/` on the VM |
| Current model (administratively switched after the historical smoke) | provider `radius`, model ID `deepseek-v4.1-flash` |
| Existing VM auth/config | `~/.pi/agent/auth.json`, optional `models.json` |

First install only, from this checkout:

```sh
bash scripts/deploy-checkout.sh
```

It inspects the VM before mutation, refuses existing source/data/workspace/unit or port collisions, checks user systemd/Linger and the existing runtime, ships an explicit source allowlist (no `.git`, node_modules, auth or local pi), then runs `npm install --ignore-scripts --no-audit --no-fund`, typecheck and CLI help on the VM. It does **not** overwrite or update an existing deployment. On a collision or partial failure, stop and inspect; do not delete existing paths to force a rerun. Runtime provisioning, if needed on another machine, requires a separate operator decision; this installation does not modify global mise configuration, system Node or other applications.

Both installers require a **successful** `ss` query before treating port 7777 as free. Missing `ss` or a failed socket query stops preflight before source transfer/dependency installation or model checks/data/workspace/unit creation; empty output from a failed command is not evidence of a free port.

List available authenticated chat-model IDs, with no model turn or raw auth output:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new sof-sandbox.exe.xyz \
  'cd ~/pi-durable-remote && PATH="$HOME/.local/share/mise/installs/node/24.4.1/bin:$PATH" npm run server -- --list-models'
```

After choosing an available provider/model, install and start the dedicated unit:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new sof-sandbox.exe.xyz \
  'bash ~/pi-durable-remote/scripts/install-user-service.sh "$HOME/.local/share/mise/installs/node/24.4.1/bin" radius gpt-5.4-mini'
```

The command above records the historical operator-approved smoke installation using `gpt-5.4-mini`, not the current model or an instruction to reinstall/update the existing VM. The VM was subsequently administratively switched to `radius/deepseek-v4.1-flash` while preserving conversation 1/history; this local recovery slice did not operate on it. The smoke model was a literal ID, not a drifting alias. For a new authorized installation choose literal IDs from the availability list. The installer checks availability through the actual public ModelRuntime bridge, never generation. It refuses data/workspace/unit/port collisions, creates private data and workspace directories, and enables `pi-durable-remote.service`. The service invokes Node directly with explicit cwd, persistent storage, provider/model and loopback bind; `Restart=always`, `RestartSec=6`, `UMask=0077`, `KillMode=control-group`, and a 30-second graceful stop bound. Linger is checked, never changed. The service is intentionally left running across SSH/client exits.

### Status and operations

SSH shells may need the existing user-bus environment explicitly:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new sof-sandbox.exe.xyz 'bash -s' <<'REMOTE'
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
systemctl --user is-enabled pi-durable-remote.service
systemctl --user is-active pi-durable-remote.service
systemctl --user show pi-durable-remote.service -p MainPID -p KillMode -p Restart -p FragmentPath
ss -H -ltn 'sport = :7777'
REMOTE

# Actual client adapter + owned real SSH, snapshot/resync/reconnect, zero submits:
node --experimental-strip-types scripts/check-vm-connection.ts
# Read-only actual fullscreen CLI + real SSH under a bounded POSIX PTY:
python3 scripts/check-vm-terminal.py
```

These smoke-specific checks were written for the historical `radius/gpt-5.4-mini` configuration, not the later administrative model switch or a retargeted repository. Do not use their model assertion as a current health claim without a separately reviewed adaptation. They never submit input, abort work or print transcript/auth/SSH diagnostics.

On the VM with that environment set:

```sh
systemctl --user restart pi-durable-remote.service  # same cwd/model/database, new epoch
systemctl --user stop pi-durable-remote.service    # intentional interruption; can stop tools
systemctl --user start pi-durable-remote.service
# Private local diagnostic review only; do not paste raw provider/tool logs or credentials:
journalctl --user -u pi-durable-remote.service -n 30 --no-pager
```

HTTP `/health` is **not supported** (all HTTP is 404); health means a fresh valid WebSocket snapshot. A second controller gets 409, and browser Origins are rejected. Other local VM-user processes still have endpoint/tool authority. Nothing is exposed through exe.dev's public proxy; no VM sharing/gateway changes are made.

### Targeting a different repository

Prepare the repository **on the VM** yourself; the client does not sync local files. Stop the dedicated service first (consider running tools/effects). Edit **only** this application's unit's `--cwd` to that repository's absolute canonical directory and `--storage` to a **new** absolute SQLite file under the private application data directory, then `systemctl --user daemon-reload` and `start`. Keep loopback/port, runtime and cgroup settings intact. Do not reuse the smoke database with a different cwd/model: startup rejects that mismatch. Preserve the old database and its WAL/SHM together; do not delete a live lease. Reopen the original database only with its original cwd/model. This is a manual single-session retarget, not a multi-session picker or automatic repo installer.

Changing provider/model similarly requires a new database or restoring the original configuration; this MVP has no in-session model setter. The first-install scripts refuse updates; later source upgrades are a separate reviewed operational task. Back up only with the service stopped and tools drained, using SQLite-consistent procedures; do not copy just the main SQLite file while WAL is live.

## Semantics and limitations

- Disconnect/client exit: remote work continues; reconnect obtains a whole current snapshot, no replay. Old client state is marked stale until connected.
- Submit acknowledgement means **durably admitted**, not answered. Abort acknowledges **after drain**. Lost/ambiguous replies can mean an input was admitted; inspect fresh state before choosing local **/recover** or **/discard**. UI re-entry creates a new request ID and may duplicate work. The pinned Harness deduplicates request ID/type, **not payload text**: the internal receipt path enforces immutable original payloads. No automatic retry or durable local recovery store exists.
- Normal service restart reopens SQLite and calls `Harness.resume()`. Unsafe interrupted tools get an interruption result, not replay. External side effects cannot be undone. Standalone server SIGKILL can leave child tools alive; the dedicated service uses control-group shutdown to own its descendants, not external detached services. Live disconnect/reconnect and a settled-session service restart have been verified with one real model; reboot/power-loss and live descendant-kill behavior remain untested.
- Lease: one canonical database owner, one-second renewal, five-second stale threshold, up to about six seconds reclaim wait. Never remove a live lease or alias the database with hard links. Very long event-loop pauses remain an ownership risk.
- Whole snapshots: 16 MiB ceiling, 32 KiB UTF-8 submits; oversized state closes rather than truncates. No paging. Epoch/revision are transport ordering, not an atomic durable commit sequence.
- Released `pi-durable` 1.1.0 and Node SQLite are experimental. All external dependencies are exactly pinned and lockfile retained: pi-tui at 1.2.0 and the other four direct Earendil packages at 1.1.0, ws 8.18.3, proper-lockfile 4.1.2. No package lifecycle scripts are run. The expected SQLite ExperimentalWarning is harmless.
- Existing VM auth is read only through the published `ModelRuntime` bridge; invalid model configuration fails closed. No auth/settings are copied or overwritten by these scripts. Provider OAuth refresh during real calls is the published runtime's behavior. A listed model proves availability, not token validity or a successful API call. Catalog refresh is disabled; no user extensions or pi settings manager are loaded.

## Repository history and Entire

The initial commits curate the existing implementation into dependency-ordered architectural layers, authored at publication preparation time; they do not reconstruct its original development chronology. Historical validation below remains evidence from earlier work, not validation of every curated commit.

Entire's safe repository settings and generated Pi bridge are tracked. Local transcripts, checkpoints' working data, logs, credentials, databases, screenshots, dependencies and unrelated Pi configuration are excluded from the source tree. Git ignores do **not** exclude session data stored in Git refs: Entire's pre-push hook can upload those separately. This publication checkout uses the supported local `entire configure --local --skip-push-sessions` setting to retain capture while holding automatic session uploads pending a separate privacy review. That ignored local override is not inherited by a new clone; review its effective Entire settings and exact ref payload before pushing. Source mirroring is distinct from publishing session history.

## Validation

Ordinary tests use deterministic faux providers, real Harness/SQLite/WebSockets and isolated fixtures: all four tools, durable admission, disconnect completion, restart recovery, unsafe-tool non-replay, request-ID deduplication, lease/transport bounds, owned SSH cleanup/collision handling, actual CLI PTY input/restore, and fail-fast IO regressions. The local submission-recovery follow-up additionally proves actual `runRemoteTui`/Editor and CLI PTY **/recover** across server process death and same-SQLite reopen, original admission returned, identical ID/payload on repeated uncertain retries, no extra admission/run caused by retry, before-admission loss, bounded receipts/no eviction, wrong/missing persisted identity refusal, local discard and terminal restoration. It retains all original 38 ordinary and 12 operational regressions; that recovery follow-up reached 77 ordinary tests. The current released-TUI/presentation gate contains 97 ordinary tests and the same 12 operational tests. Requires POSIX `python3` with standard-library `pty` for terminal integration; no extra Python package. Run `npm run check && npm test` locally (and on the VM) plus `node --test scripts/test/*.test.mjs` for deployment-script regressions.

The local readability refresh uses exactly released pi-tui 1.2.0, with every other direct Earendil pin still 1.1.0. It adds cursor/APC compatibility and real-view presentation regressions without changing server, wire, model, authentication or recovery semantics. Native current-frame fixtures cover 36×20, 80×20 and 100×20, including long Unicode code, Markdown, running tools, committed streaming partials, errors and all seven recovery instructions at 36×20. [Presentation details and reproducible frame commands](packages/client/DESIGN.md) describe the implemented accents, plain diagnostics and preview limitations. These local faux-model tests make no VM operation or paid provider call; they are not a claim that the deployed VM has been upgraded.

Historical deployment checked on sof-sandbox: reused Node 24.4.1/npm 11.4.2, user systemd 255, Linger=yes, dedicated enabled/active service on 127.0.0.1:7777, private SQLite and explicit radius/gpt-5.4-mini configuration. All **38 ordinary tests plus twelve installer/archive regressions** pass locally and on the Linux VM. The installer regressions include empty-output socket-query failures (exit 42 and simulated command-unavailable exit 127) for both production preflight paths. Deployment and read-only health checks requested no model calls.

**Live end-to-end validation passed.** One authorized prompt to `radius/gpt-5.4-mini` completed `bash` (a controlled 15-second sleep), `write`, and `read` using existing VM auth. Direct remote filesystem reads verified the marker's exact 71 bytes before and after restart. Dropping the owned client/tunnel while bash was running left the service working; a fresh connection observed that same running task and its completion without resubmission. Restarting only the dedicated service after settlement preserved the same session and exact nine-entry transcript. The owned marker was then removed; the workspace is empty and the smoke conversation remains in SQLite.

The actual fullscreen CLI over real SSH also rendered all three completed tools and the final answer, accepted an unsent editor draft and Ctrl+R/Ctrl+C, exited 0, and restored termios/alternate screen. Independent parent repetition confirmed that UI activity added no input or model call. Each vertical slice passed independent source/evidence review, with fresh parent-run gates and no repeated paid prompt.

This in-memory TUI follow-up required no VM operation, new deployment, provider/auth call or paid prompt. Server wire/protocol and dependencies are unchanged. Safely repeatable deployment remains deferred; first-install scripts still refuse updates.

The single historical live prompt completed in 21.3 seconds and reported 3,583 tokens. It used a runtime deadline and brief-answer constraint, **not a hard token cap**. Only this configured real model was tested. No VM reboot, power-loss or live descendant-shutdown experiment was performed; deterministic tests cover mid-unsafe-tool crash recovery separately.
