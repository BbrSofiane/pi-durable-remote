# Lessons from disler/durable-pi

## Decision

Use **durable-pi as a reference application, not a replacement for pi-durable-remote**. It confirms our core boundary: the remote machine owns the Harness, tools and SQLite; clients observe and steer committed state.

Borrow individual patterns through small, independently testable vertical slices. Keep our released-package dependencies, SSH transport, loopback-only endpoint and single-VM scope unless a concrete requirement justifies changing them.

**Recommended next slice:** explicit recovery of an ambiguously acknowledged submission using its original request ID and immutable payload. Safe repeatable deployment is the next operational priority. Neither is implemented by this research pass.

## Research baseline and evidence

- Reference: [disler/durable-pi](https://github.com/disler/durable-pi).
- Inspected commit: [`37165c619573dbaf425463038bbffecfe576beec`](https://github.com/disler/durable-pi/tree/37165c619573dbaf425463038bbffecfe576beec), dated October 11, 2026.
- Local baseline: this repository's implementation, documentation, installed declarations and tests; Earendil packages pinned to **1.1.0**.
- Upstream backend pins Earendil packages to **1.0.3**. Relevant public primitives exist locally, but runtime compatibility was not tested.
- Two fresh-context scouts completed. The external researcher timed out after saving a report; the parent read it and directly checked the key implementation claims.
- No upstream code or tests were executed. No dependencies were installed, project implementation was changed, VM operations were performed, or live model calls were made during research.

Distinguish source-backed implementation facts from adoption recommendations and upstream self-reported validation. Timing and cost figures from the proactive demo are not independent production benchmarks.

## What durable-pi adds

The project is an application layer around pi-durable, not a different durability engine. Its backend still opens a Harness over SQLite and resumes it. Above that, it provides:

- Device → session → agent addressing and session catalogs.
- REST commands and snapshot-first SSE streams.
- A shared SDK, client-side models and transcript projection for web and terminal clients.
- History, forks, agent configuration and durable jobs.
- Persisted human approvals and event-driven proactive examples.
- Deployment and device-management operations.

Its [SDK is not published to npm](https://github.com/disler/durable-pi/blob/37165c619573dbaf425463038bbffecfe576beec/apps/dpi-sdk/README.md#L1-L5). Adopting the application wholesale would therefore introduce a source-level dependency and substantially more operational surface than our current MVP needs.

## Transferable patterns

### 1. Deliberately recover ambiguous submissions

Their [send API](https://github.com/disler/durable-pi/blob/37165c619573dbaf425463038bbffecfe576beec/apps/dpi-sdk/src/client.ts#L217-L227) accepts a caller-supplied request ID.

Our server already passes wire command IDs to Harness admission, but [`RemoteClient.command()`](packages/client/src/remote.ts#L217-L234) creates a new UUID for every command. `CommandOutcomeUnknownError` retains the original ID and command, yet there is no supported retry workflow. Re-entering text in the UI creates a new ID and may duplicate work.

**Takeaway:** expose an explicit way to retry the original submission with its original immutable ID and payload. Do not automatically replay commands or silently resend under a new ID. Keep durable admission distinct from answer completion.

**Caution:** upstream's separate [HTTP create-route middleware](https://github.com/disler/durable-pi/blob/37165c619573dbaf425463038bbffecfe576beec/apps/dpi-backend/src/idempotency.ts#L4-L19) stores successful responses after creation. That alone does not establish atomic deduplication across concurrent requests or a crash between creation and response caching. This is a source-derived risk, not a reproduced failure. Do not copy an assumed exactly-once guarantee.

### 2. Separate transport from structured presentation

The upstream [AgentModel](https://github.com/disler/durable-pi/blob/37165c619573dbaf425463038bbffecfe576beec/apps/dpi-sdk/src/models.ts#L106-L175) combines committed entries, live generation and tool state into transcript items. Web and terminal renderers consume that shared model.

Our current snapshot formatter is sufficient for one TUI. If another renderer is added, centralize transcript interpretation rather than implementing it twice. A structured projection can initially consume whole snapshots; adopting SSE or incremental deltas is not a prerequisite.

**Adopt when:** a second renderer or richer transcript behavior creates a concrete need. Do not introduce an incremental reducer merely because upstream has one.

### 3. Persist human approval, not an in-memory promise

Their [approval task](https://github.com/disler/durable-pi/blob/37165c619573dbaf425463038bbffecfe576beec/apps/dpi-backend/src/jobs.ts#L375-L399) reads a committed decision document. The parent job creates that owned task and [checkpoints into a waiting state](https://github.com/disler/durable-pi/blob/37165c619573dbaf425463038bbffecfe576beec/apps/dpi-backend/src/jobs.ts#L622-L641).

**Takeaway:** when we introduce “prepare a change, then wait before publishing or deploying,” represent the pending approval and decision in durable state. A restart must not lose the question, create a second approval request, or repeat the consequential effect.

Learn this pattern without adopting the complete jobs UI or proactive demo. Before implementation, validate the small task/document seam against our pinned release with a deterministic restart test.

### 4. Make deployment safely repeatable

Their [deployment driver](https://github.com/disler/durable-pi/blob/37165c619573dbaf425463038bbffecfe576beec/apps/dpi-sdk/src/node/drivers.ts#L92-L106) treats application code as replaceable while agent data lives separately.

Our installers deliberately refuse existing deployments. That protects data but leaves upgrades as manual operator work.

**Takeaway:** add a narrowly scoped updater that preserves SQLite, auth and configuration; updates only allowlisted application code; restarts only our dedicated service; and verifies the same session afterward. Borrow code/data separation and the operational workflow, not the entire provisioning stack. Preserve our `--ignore-scripts` dependency-install policy and existing runtime management.

### 5. Let code own proactive triggers and permissions

Their [watcher](https://github.com/disler/durable-pi/blob/37165c619573dbaf425463038bbffecfe576beec/apps/proactive-dpi-demo/apps/proactive-dpi-be/src/watcher.ts#L150-L175) keeps thresholds and time windows in deterministic code while the model supplies a bounded classification.

**Takeaway:** events may trigger bounded investigation; consequential effects still require explicit policy or approval. We do not need Jev or an incident-management platform to apply that separation.

## What not to copy now

### Public bearer-token networking

Keep SSH and loopback for the current single-VM product. Upstream's [security caveats](https://github.com/disler/durable-pi/blob/37165c619573dbaf425463038bbffecfe576beec/README.md) explicitly acknowledge that a device token effectively grants shell authority, LAN HTTP can expose tokens in cleartext, and the hub holds every device token. Start directories are not a sandbox.

A device registry, public HTTP endpoint and web hub may be valid for a different product, but they are not necessary to improve this MVP.

### An AI guard as the security boundary

Their [Jev hook](https://github.com/disler/durable-pi/blob/37165c619573dbaf425463038bbffecfe576beec/apps/dpi-backend/src/addons.ts#L118-L134) only covers bash and explicitly permits execution if judging fails. It can be advisory protection, not isolation. It does not replace process permissions, sandboxing or explicit approval policy.

### The complete session/network platform

A persistent session catalog is useful when multi-session operation becomes a requirement. Today one explicit SQLite file and one controlling client remain simpler and match our accepted scope.

## Local migration constraints

- **Model/cwd invariants:** the [server](packages/server/src/index.ts#L117-L140) checks persisted cwd/model against startup configuration and uses the configured model in its view envelope. A model setter is not just another command: restart and configuration semantics must change coherently.
- **Strict protocol:** adding session/agent addressing or new command/frame types must account for v1 validation and its tests.
- **Snapshot semantics:** preserve fresh-snapshot readiness, epoch replacement, bounded buffering and no automatic command replay when adding presentation or transport features.
- **History:** current views expose the active transcript. Upstream's separate history API is a useful read-only pattern when reset/compaction or history navigation becomes user-facing.
- **Version gap:** exported primitives suggest the patterns are feasible, not that upstream code is drop-in compatible. The installed pi-durable 1.1.0 changelog contains breaking changes. Typecheck and test each adapted seam against our pinned package.
- **External effects:** durable admission and checkpoint recovery do not make shell commands or external APIs exactly-once. Unsafe interruption cannot undo an effect that already happened.

## Priority and recommended next move

The research lanes differed on priority: the local comparison favored a shared reducer; the practical-tradeoffs lane emphasized approvals and repeatable deployment; the external report favored ambiguous-submit recovery.

The parent recommendation is **explicit same-ID submission recovery first**, because it improves an existing failure path without adding a new product surface.

A bounded proving slice should:

1. Use the actual client against a deterministic Harness/server fixture.
2. Lose the admission reply after the input is durably admitted.
3. Restart/reconnect and obtain a fresh snapshot.
4. Deliberately retry the original immutable request ID and payload.
5. Assert the original submission is returned, with one admitted user input and no extra run caused by the retry.
6. Ensure the recovery action cannot silently change the original payload or allocate a new ID.

This tests admission deduplication, not exactly-once model calls or external effects during crash recovery. It should not require a new transport, device catalog, web UI, provider, or live paid test.

Next operational priority: safely repeatable deployment. Keep shared presentation models, durable approvals and richer session/history operations tied to demonstrated needs rather than adopting a broad feature roadmap.

## Confidence and remaining gaps

- **High confidence:** inspected architecture, version pins, stable message-ID API, reducer structure, persisted approval pattern and documented security boundaries.
- **Moderate confidence:** adoption cost and compatibility; these are engineering judgments informed by source inspection, not measured migrations.
- **Not established:** upstream runtime/test outcomes, concurrent create-route idempotency behavior, production performance, or drop-in compatibility with local 1.1.0.

No implementation is authorized or performed by this document. It records research conclusions and a proposed next vertical slice.

---

## Subsequent implementation follow-up: in-memory TUI submission recovery

The research baseline above is preserved as research, not retroactively relabeled implementation. Under separate user authorization, the recommended ambiguous-submission slice was implemented **for the existing TUI only, in memory only**, using the pinned released dependencies. No upstream SDK/code was imported, no public recovery API or new endpoint/transport/protocol was added, and no VM operation or paid/provider/auth call was needed.

- The internal client receipt store captures the original request ID, immutable cloned payload (conversation ID/text/`whenBusy`) and persisted public `pi.provider.sessionId` before the first send. Only ambiguous submissions are retained; abort is never replayed. The pinned Harness deduplicates request ID/type but does not compare text, so immutability is a client receipt-path guard, not a server-enforced promise.
- Exact local **/recover** resends the oldest retained receipt only after a fresh connected snapshot received after uncertainty for the same persisted identity. Reopening the same SQLite with a new server epoch is allowed; missing/different identity refuses even with the same numeric ID/path. No automatic retry runs. One in-flight attempt per receipt is enforced; refused, rejected and repeatedly uncertain attempts keep the receipt.
- Exact local **/discard** forgets only the oldest receipt, never aborts or withdraws remote work. Multiple receipts resolve oldest-first; eight-receipt capacity refuses new submissions without silent eviction. Unknown submissions are not restored into editor/history for accidental re-entry. Closing/restarting the client loses receipts; there is no disk outbox.
- Deterministic process tests drive actual `runRemoteTui`/released Editor and a bounded real CLI POSIX PTY, not a raw peer recovery action. They lose a reply after actual durable admission, keep the same client alive, restart the actual server on the same SQLite, receive a fresh same-identity snapshot, and use **/recover** to get the original submission. Repeated lost retry replies reuse the same ID/payload. Settled post-resume state proves one admitted input and no extra run caused by explicit dedup retries. Before-admission loss separately recovers into exactly one input. Actual-server snapshot faults prove missing/wrong UUID refusal despite unchanged numeric ID and public-view mutation. Terminal restoration, bounded capacity, no automatic replay and local discard are covered.
- The full local suite now contains 77 ordinary tests (including all original 38) and the unchanged 12 operational regressions. The recovery-state/TUI suites cover disconnected/pending/in-flight actions, payload mutation, multiple receipts, history/draft safety and exit semantics. Transport fault doubles do not replace the Harness, SQLite or controller.

A recovered acknowledgement is **durable admission, not answer completion**. These proofs do not promise exactly-once model invocations, tool execution or external effects across crashes: legitimate Harness recovery can resume the original work. The historical live smoke used `radius/gpt-5.4-mini`; the later administrative switch to `radius/deepseek-v4.1-flash` preserved conversation 1/history and is not a deployment performed by this slice.

**Still deferred:** safely repeatable deployment, durable local recovery storage, shared renderer/reducer, approvals and broader session/network/platform work. The existing first-install scripts remain collision-refusing; this follow-up does not authorize an updater or new deployment.
