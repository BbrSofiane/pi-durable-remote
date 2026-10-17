# Durable server — first slice

This project-owned adapter uses only released `@earendil-works/*` 1.1.0 APIs. It does not load coding-agent experimental modules, local pi source, user extensions, or the architecture document's future features.

## Local commands

Requires Node >=22.19.0 (validated on 24.4.1). Install from the repository root:

```sh
npm install --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run server -- --help
```

On the VM, choose a provider/model using its existing pi auth/config:

```sh
npm run server -- --list-models
npm run server -- --cwd /absolute/workspace --storage /absolute/app-data/session.sqlite --provider <provider> --model <model-id>
```

`--auth-path` and `--models-path` override the released `ModelRuntime` defaults (`~/.pi/agent/auth.json` and `models.json`). No auth values are emitted. Catalog network refresh is disabled; listing models makes no model generation calls. Published runtime configuration/composition errors are rejected with a sanitized message before SQLite/Harness startup rather than accepting built-in fallback configuration. The server never writes pi settings or installs extensions. Provider credential refresh, if required by an actual model call, remains the published runtime's behavior. There have been **no deployment or real-provider tests** in this slice.

Only `127.0.0.1` and `::1` binds are allowed; default `127.0.0.1:7777`. `--port 0` is useful for tests. Browser `Origin` headers are rejected, including a `null` Origin; only the `/` WebSocket path is served. All HTTP requests return 404. SSH is the authentication boundary, not the hello client ID. The tools have the VM user's authority; loopback is not isolation from other processes running as that user.

## Session lifetime and lease

`--storage` is mandatory and cannot be `:memory:`. The root conversation's original cwd/model must match on reopen; startup refuses a mismatch rather than silently modifying an existing session. The SQLite path and working directory are canonicalized. Existing file and parent symlink aliases resolve to the same lease; dangling storage symlinks are rejected. Do not use hard links to alias SQLite files (SQLite WAL and the path lease are not hard-link safe).

`proper-lockfile@4.1.2` acquires `<canonical-database>.lock` **before storage/Harness open**, renews every second, and considers it stale after 5 seconds. Acquisition retries once per second for at most 6 seconds. After SIGKILL, startup can therefore wait roughly 5–6 seconds before reclaiming a stale lease. A live/unknown lease fails closed; never manually delete a live lease. Compromise closes the endpoint/Harness and signals a fatal error. Successful shutdown releases the lease after Harness shutdown; uncompleted durable tasks remain available to `harness.resume()` on reopen. Severe event-loop pauses beyond the stale interval are an inherent lease risk.

The Harness, tools, and model calls are never cancelled because a client disconnects. Startup always calls `harness.resume()`. SIGINT/SIGTERM close the server gracefully. One controlling socket is allowed; an additional connection receives HTTP 409. Send hello within five seconds. A transport ping/pong heartbeat retires a nonresponsive controlling connection within approximately 30 seconds, enabling reconnect.

## Protocol handoff for the client slice

Import from `@sof/durable-remote-protocol`:

- Values: `PROTOCOL_VERSION`, `MAX_CLIENT_MESSAGE_BYTES`, `MAX_SUBMIT_TEXT_BYTES`, `parseClientMessage`.
- Types: `ClientMessage`, `Command`, `ServerMessage`, `RemoteView`, `ErrorCode`, `ParseResult`.
- `RemoteView.conversation` is the published `ConversationView`; entries' messages live in `entry.model`, not invented `entry.data` messages. `RemoteView.tasks` is the published `TaskGraph`; `pi.live`, `pi.inbox`, `pi.agent`, and other documents are passed through intact. Durable IDs are branded **numbers**, including the reserved root conversation ID (do not hardcode it).

Send text JSON frames, with `protocolVersion: 1` on **every** client message:

```json
{"type":"hello","protocolVersion":1,"clientId":"terminal-unique-id"}
{"type":"resync","protocolVersion":1}
{"type":"command","protocolVersion":1,"id":"unique-request-id","command":{"name":"submit","conversationId":0,"text":"Inspect the workspace","whenBusy":"reject"}}
{"type":"command","protocolVersion":1,"id":"unique-abort-id","command":{"name":"abort","conversationId":0}}
```

The IDs above are examples; use the conversation ID from the snapshot. Identifiers are 1–128 ASCII characters from `[A-Za-z0-9._:-]`. Unknown fields, commands, invalid targets, empty text, versions, binary frames, and oversized inputs are rejected. `whenBusy` is explicitly `steer`, `followUp`, or `reject`.

Every server message carries `protocolVersion: 1` and a fresh server-lifetime `epoch`:

- `snapshot` on hello/resync; `view` on updates. Both contain `revision` and the **whole** `RemoteView`. Replace state, do not append entries. A new epoch means discard the previous lifetime's revision/state. Within an epoch ignore older revisions; snapshots can reuse the current revision. Revision is a transport-local notification counter, not a durable commit sequence. Conversation/task mounts are authentic published values, not a claimed atomic combined storage transaction.
- Submit success: `{"type":"reply","id":"…","ok":true,"status":"admitted","submissionId":123,…}`. This means **durable admission only**, not a successful answer. Observe entries/documents/tasks for progress and outcome.
- Abort success: `{"type":"reply","id":"…","ok":true,"status":"completed",…}`. Approved API exception: public `Conversation.abort()` resolves only after cancellation drains. Views keep progressing while this reply is pending; disconnect does not cancel it.
- Correlated error: `reply`, `ok: false`, `id`, `code`, `error`. Uncorrelatable invalid input/pre-hello errors use `type: "error"`, `code`, `error`. Command exceptions are sanitized, not returned as raw provider/auth errors. On ambiguous command failure, resync before retrying.

For submits the wire `id` is passed **unchanged as the Harness requestId**. Generate a fresh ID for each distinct input; retain it and the exact same payload for a retry after a lost admission reply or restart. Never reuse an ID for a different input: the published Harness returns the original submission for that ID. There is no client-local replay of completed work, no server-side answer wait, and no separate client/server idempotency cache.

Transport bounds: incoming messages 64 KiB, submit text 32 KiB UTF-8, outgoing frames 16 MiB, pending commands 8 globally, control-frame backlog 32 per socket. There is one in-flight send and one coalesced latest view; intermediate views may be skipped. Resync requests retain snapshot semantics even when superseded by newer values. A slow socket is terminated after 10 seconds of blocked sends. Outgoing oversize closes with 1009 rather than truncating a durable snapshot; reconnect alone cannot solve an oversized session. There is no transcript paging or session picker.

## Deterministic evidence

`npm test` uses faux providers only. Actual Harness/SQLite/WebSocket integration exercises read/write/edit/bash in a temporary cwd, admission before response completion, busy/invalid/target rejection, disconnect/reconnect, resync, persisted request-ID deduplication and fresh restart epochs. A private child process is SIGKILLed during a pending faux model response; a new server reclaims only the stale lease and resumes the admitted input. No shell/tool child is launched in that kill fixture. Additional tests cover canonical lease collision on another port, normal lease release, compromised lease shutdown, and bounded/coalesced sends. All fixtures/processes are owned by these tests and removed afterward.
