# pi-durable-remote — implemented MVP

The durable coding agent's **Harness, model calls, filesystem and shell run on the VM**. A local terminal is its face. This document describes the current implementation, not unpublished pi experimental modules or a future roadmap.

## Published-only boundary

Exact npm pins: `@earendil-works/pi-tui` **1.2.0**, `@earendil-works/{pi-durable,pi-ai,pi-coding-agent,chord}` **1.1.0**, `ws` **8.18.3**, `proper-lockfile` **4.1.2**. Node >=22.19.0 is required; deployment uses existing Node **24.4.1**. Native `node:sqlite` and pi-durable remain experimental. No sibling checkout, file links, copied experimental runtime/TUI, `openDurable()` or `runDurableTui()` is used.

```text
Local terminal                                sof-sandbox.exe.xyz (exedev)
pi-tui + RemoteClient                         systemd --user: pi-durable-remote
  RemoteViewSource  <--- whole JSON views ---  127.0.0.1:7777 WebSocket
  RemoteController --- submit / abort ----->    Harness + SQLite outside source
             owned private SSH forward         ModelRuntime: existing VM pi auth
                                               CodingTools: read/write/edit/bash
                                               NodeExecutionEnv: explicit VM cwd
```

The client has no Harness, provider credentials or tool runner. It renders supplied committed entries, `pi.live` partial/tool output, model/cwd and tasks; it does not inspect a local repository or compute local edit previews. The project-owned fullscreen UI composes released pi-tui `Markdown`, `Text`, `Editor`, `ScrollView`, `VStack` and `TuiAltScreen`. A small pure section projection feeds both plain diagnostics and rich rendering; whole-snapshot/network behavior is unchanged. Remote terminal controls are stripped before trusted semantic styling or Markdown. Unchanged native components retain their parse/width caches. Terminal background/body foreground stay inherited; ANSI-palette accents and explicit labels distinguish roles, tools and state, with a no-styling `NO_COLOR` path. No URL opener or local-file autocomplete provider is installed. See [implemented presentation](packages/client/DESIGN.md).

## Packages and deployed paths

- `packages/protocol`: strict v1 wire types/input validation; published durable value types.
- `packages/server`: public `ModelRuntime.create()`, registry with CodingTools and a small coding prompt, `Harness.open()` with NodeExecutionEnv, public SQLite storage, one explicitly configured root conversation; startup always calls `harness.resume()`.
- `packages/client`: actual socket/hello/reconnect/controller, owned OpenSSH tunnel, renderer and pi-tui editor. Headless and TUI callers share the adapter. A bounded internal in-memory receipt store supports the TUI's explicit local recovery actions; it is not a new supported public SDK API.
- `packages/integration`: deterministic faux-provider process/recovery tests and real CLI POSIX PTY tests.
- `scripts`: first-install deployment, dependency install, dedicated user-service install and a read-only real SSH connection check.

On the VM: source `~/pi-durable-remote`; data `~/.local/share/pi-durable-remote/session.sqlite` (plus WAL/SHM and lease); isolated workspace `~/work/pi-durable-remote-smoke`; unit `~/.config/systemd/user/pi-durable-remote.service`. No application data is stored in deployed source. Existing pi apps/settings/auth are not overwritten. See [README](README.md) for exact operator commands.

## State and protocol

One persistent session and **one controlling client**, not a session registry or broadcast service. All HTTP requests return 404; WebSocket path is `/`. A second controlling socket receives 409. Browser Origins (including `null`) are rejected. The bind must be loopback (`127.0.0.1` or `::1`), never public. SSH is the access boundary; the hello client ID is not authentication. Processes with VM-user access can still control the endpoint; tools have that user's authority, not a per-conversation security sandbox.

Hello establishes protocol v1, then the client receives a whole `RemoteView`: explicit cwd/database, configured model, published `ConversationView` and `TaskGraph`. Resync and reconnect replace the whole state, never replay deltas. Each frame carries the server-lifetime `epoch`; transport-local `revision` orders views only within that epoch. A fresh epoch can replace a lower revision. Revision is **not** a durable commit sequence, and conversation/task mounts are not claimed to be one atomic combined transaction.

Only `submit` (text, explicit conversation ID, `steer|followUp|reject`) and `abort` are commands. Submit reply means **durable admission**, not answer completion. Abort reply means **cancellation drained**, matching the public API. Resync is a transport request. A disconnect never aborts or cancels remote work.

A submit's wire request ID is the Harness deduplication key across restarts. The same ID/type returns the original submission; the pinned Harness does **not** compare payload text. A new ID is a new input. The client never automatically retries commands. Lost/ambiguous submission replies retain the original ID and a deep-cloned/frozen payload (conversation ID, text and busy policy) in an internal in-memory receipt store. Immutability is enforced by this path, not assumed from server deduplication.

The TUI's exact argument-less **/recover** resends the oldest receipt only after a fresh connected snapshot received after uncertainty, matching the persisted public **`pi.provider.sessionId`** captured before observers can mutate views. Epoch, numeric conversation ID and database path alone are not session identity. A changed epoch on same-SQLite reopen is allowed; missing/different identity fails closed. One recovery attempt may be in flight per receipt; another recover or discard is refused until it settles. Successful admission removes only that receipt; refusal, rejection or another unknown outcome preserves it. No automatic replay or editor/history restoration of unknown inputs occurs. Ordinary re-entry generates a new ID and may duplicate work.

**/discard** removes only the oldest local receipt, never remote work. The store reserves capacity before the first send, defaults to eight receipts and refuses new submissions instead of silently evicting. Aborts are not retained or replayed. Closing/restarting the client loses its receipts; there is no durable client retry store, generic replay manager, new endpoint/protocol or public caller-supplied-ID API. The local actions are not server commands or model inputs.

Bounds: incoming 64 KiB, submit UTF-8 32 KiB, outgoing whole view 16 MiB, eight pending commands, 32 control replies per peer, one in-flight frame and one newest-view slot. Slow sends close after ten seconds. Oversized snapshots close explicitly, not truncate; reconnect alone cannot fix their size. Hello deadline is five seconds; heartbeat retires an unresponsive controller in about 30 seconds.

## Ownership and recovery

The canonical SQLite path is protected before Harness open by a proper-lockfile lease, updated each second and stale after five seconds. Startup retries ownership for at most about six seconds. Cwd/model must match persisted root configuration; incompatible reopen and retained model-runtime configuration errors fail closed. Do not alias SQLite with hard links, remove a live lease, or use noncooperating writers. Long event-loop stalls beyond the stale interval remain a lease risk.

| Event | Current behavior |
| --- | --- |
| Local exit, sleep, network loss | VM keeps working; fresh snapshot on reconnect, no command replay. |
| Graceful service restart | Server closes mounts/Harness and releases lease; startup resumes durable work, new epoch. |
| Server SIGKILL | Stale lease is reclaimed; public Harness recovery marks interrupted unsafe tools rather than replaying them. |
| External tool effect before crash | Not undone. Standalone server PID death can leave tool subprocesses alive. Dedicated systemd `KillMode=control-group` owns descendant shutdown. |
| VM reboot | Enabled user service + existing Linger=yes start it again; persistent SQLite is reopened. No reboot/power-loss test has been performed. |
| Unknown submission outcome | Resync/reconnect and inspect, then explicitly /recover the same immutable ID/payload against the same persisted identity or /discard locally; no automatic retry. Abort is never replayed. |

Systemd restarts only the dedicated application, uses private file permissions and bounded shutdown before killing its remaining cgroup. This does not reconcile external effects, detached services or processes escaping the cgroup. It is not an exactly-once side-effect guarantee or permission isolation.

## Authentication and current exclusions

Public coding-agent `ModelRuntime` reads the VM's existing `~/.pi/agent/auth.json` and optional `models.json`; catalog network refresh is disabled. `--list-models` reports available IDs without generation or raw credential data. Availability does not prove unexpired credentials or provider success. Real calls can trigger the published runtime's credential-refresh behavior. The client never copies auth to the laptop. User settings/extensions are not loaded; no gateway integration is configured.

Not implemented: multi-session/picker, multiple controllers, compact/model/thinking commands, subagent/extension ecosystem, Chord operation transport, web/public proxy, exe LLM gateway, repository provisioning, per-conversation VM/sandbox, transcript paging. Model/cwd selection is explicit server startup configuration, not local UI state.

Following published API discovery, the original five implementation slices passed independent review: server, client, process recovery, VM deployment, and live validation. That historical baseline contained 38 ordinary tests using faux providers and 12 deployment regressions. Real SSH snapshot/reconnect and actual CLI PTY input/render/restore checks passed.

The subsequent local in-memory TUI recovery gates reached 77 ordinary tests and the unchanged 12 operational regressions. The released pi-tui 1.2.0/readability refresh retains those tests and adds three cursor compatibility and three real-view presentation cases, for a historical 83-test ordinary baseline plus the same 12 operational regressions. Subsequent tool-block and palette/contrast regressions bring the current suite to 97 ordinary tests, still with the same 12 operational regressions. Actual live `runRemoteTui`/Editor and bounded CLI PTY tests lose a reply after durable admission, kill the server process, reopen the same SQLite, and explicitly recover with the same original ID/payload. They observe the original submission returned, one admitted input and no additional run **caused by retry**, measured against settled post-resume state. Separate before-admission transport loss admits exactly one input on explicit recovery. Repeated lost retry replies preserve the receipt; missing/wrong UUID snapshots with the same numeric ID fail closed, even after public-view mutation. Component tests additionally cover pending/disconnected/in-flight guards, receipt capacity, editor/history behavior, exit and local discard. All fault doubles affect transport only; admission/storage/model behavior uses the actual Harness and faux provider. These tests do not establish exactly-once generation or external effects across crash recovery.

One authorized live prompt to `radius/gpt-5.4-mini` completed bash/write/read on the VM, with exact remote-file byte verification. Disconnecting the client/tunnel during the running tool did not stop work; reconnect observed the same turn. A dedicated service restart after settlement preserved the same session and exact transcript. The marker was cleaned up. The VM was later administratively switched to `radius/deepseek-v4.1-flash`, preserving conversation 1/history. This TUI recovery follow-up did not operate on the VM, redeploy, change dependencies/protocol/server behavior or make provider/auth calls. Safely repeatable deployment remains deferred. There was no repeated paid prompt or hard token cap. Reboot/power-loss and live descendant shutdown remain untested; deterministic tests cover mid-unsafe-tool crash recovery. See the root README for operational details and validation limits.
