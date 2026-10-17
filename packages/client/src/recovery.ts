import type { Command } from "@sof/durable-remote-protocol";
import type { CommandReply } from "./remote.ts";

/** A retained receipt is "uncertain" until the operator acts; "recovering" marks one in-flight explicit attempt. */
export type RecoveryReceiptStatus = "uncertain" | "recovering";

/** Read-only view of one retained ambiguous submission for the TUI; the TUI never constructs these. */
export type RecoveryReceipt = {
  readonly requestId: string;
  readonly command: Command;
  readonly conversationIdentity: string;
  readonly status: RecoveryReceiptStatus;
  /** True once a server snapshot/view has arrived after the uncertain outcome; recovery waits until then. */
  readonly snapshotFresh: boolean;
};

/** Narrow transport surface the receipt store needs from the owning client. */
export type RecoveryHost = {
  /** True only with a fresh snapshot AND an open, usable transport; the store refuses recovery otherwise. */
  connected: () => boolean;
  identity: () => string | undefined;
  transmit: (requestId: string, command: Command) => Promise<CommandReply>;
};

/** Default bound on retained receipts; new submissions are refused before sending once it is reached. */
export const defaultReceiptCapacity = 8;

/**
 * Read-only result of the same guards `recover()` applies, in the same order; presentation must derive
 * recovery readiness from this, never from caller-mutable views. "absent" covers unknown/provisional IDs.
 */
export type RecoveryEligibility =
  | "eligible"
  | "in-flight"
  | "disconnected"
  | "awaiting-snapshot"
  | "missing-identity"
  | "different-identity"
  | "absent";

/** The refusal message `recover()` throws for each non-eligible outcome; shared so presentation and action cannot drift. */
export const recoveryRefusal = (eligibility: Exclude<RecoveryEligibility, "eligible">): string =>
  ({
    "absent": "No recoverable submission matches this receipt",
    "in-flight": "A recovery attempt is already in flight for this submission",
    "disconnected": "Recovery requires a fresh connected snapshot; currently disconnected",
    "awaiting-snapshot": "Recovery waits for a fresh snapshot after the uncertain outcome; none has arrived yet",
    "missing-identity": "The current snapshot has no persisted conversation identity; recovery is refused",
    "different-identity": "The current snapshot is a different conversation; recovery is refused",
  })[eligibility];

type ReceiptRecord = {
  readonly requestId: string;
  readonly command: Command;
  readonly conversationIdentity: string;
  /** A provisional record turns into a retained receipt only when its outcome is ambiguous. */
  provisional: boolean;
  status: RecoveryReceiptStatus;
  /** Set when the outcome became ambiguous; a server snapshot/view applied afterwards clears it. */
  needsFreshSnapshot: boolean;
  /** Monotonic token of the in-flight recovery attempt; only the owning attempt may clear its own in-flight mark. */
  attempt: number;
};

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
};

/** Clone and freeze the original submit intent once; later mutation of live command/error/view state cannot alter a resend. */
export const frozenCommand = (command: Command): Command => deepFreeze(structuredClone(command));

/**
 * In-memory receipt seam between ambiguous submissions and explicit operator recovery. Bounded capacity without silent
 * eviction; nothing here persists to disk, retries on its own, or sends anything except through the host's transmit.
 */
export class RecoveryState {
  private readonly records = new Map<string, ReceiptRecord>();
  private readonly host: RecoveryHost;
  readonly capacity: number;

  constructor(host: RecoveryHost, capacity: number) {
    this.host = host;
    this.capacity = capacity;
  }

  /** Reserve capacity and capture the immutable intent before the first send; throws instead of evicting. */
  provision(requestId: string, command: Command, conversationIdentity: string): void {
    if (this.records.size >= this.capacity) {
      throw new Error(`Recovery receipt capacity (${this.capacity}) reached; recover or discard receipts before submitting again`);
    }
    this.records.set(requestId, { requestId, command: frozenCommand(command), conversationIdentity, provisional: true, status: "uncertain", needsFreshSnapshot: false, attempt: 0 });
  }

  /** Outcome bookkeeping for one sent command: ambiguous outcomes retain the receipt, definite ones do not. */
  settled(requestId: string, outcome: "ok" | "ambiguous" | "rejected"): void {
    const record = this.records.get(requestId);
    if (!record) return;
    if (outcome === "ok") { this.records.delete(requestId); return; }
    if (outcome === "ambiguous") { record.provisional = false; record.status = "uncertain"; record.needsFreshSnapshot = true; return; }
    // A definite rejection of a recovery attempt honestly reports "not admitted" and leaves the choice to the operator.
    if (record.status === "recovering") record.status = "uncertain";
    else this.records.delete(requestId);
  }

  /** Receipts visible to the operator; mutating the result cannot change what a recovery resends. */
  list(): readonly RecoveryReceipt[] {
    const receipts: RecoveryReceipt[] = [];
    for (const record of this.records.values()) {
      if (record.provisional) continue;
      receipts.push(Object.freeze({
        requestId: record.requestId,
        command: record.command,
        conversationIdentity: record.conversationIdentity,
        status: record.status,
        snapshotFresh: !record.needsFreshSnapshot,
      }));
    }
    return receipts;
  }

  /** Called by the owning client when it applies a server snapshot/view; records may then be recovered again. */
  markFreshSnapshot(): void {
    for (const record of this.records.values()) record.needsFreshSnapshot = false;
  }

  /** Nonmutating eligibility of one receipt, mirroring `recover()`'s guards in order (authoritative host, not views). */
  eligibility(requestId: string): RecoveryEligibility {
    const record = this.records.get(requestId);
    if (!record || record.provisional) return "absent";
    if (record.status === "recovering") return "in-flight";
    if (!this.host.connected()) return "disconnected";
    if (record.needsFreshSnapshot) return "awaiting-snapshot";
    const identity = this.host.identity();
    if (identity === undefined) return "missing-identity";
    return identity === record.conversationIdentity ? "eligible" : "different-identity";
  }

  /**
   * Explicit operator recovery of one retained receipt: resend the exact original request ID and payload, only after a
   * fresh snapshot of the same persisted conversation identity. Never retries automatically.
   */
  async recover(requestId: string): Promise<CommandReply> {
    const record = this.records.get(requestId);
    if (!record || record.provisional) throw new Error(recoveryRefusal("absent"));
    const eligibility = this.eligibility(requestId);
    if (eligibility !== "eligible") throw new Error(recoveryRefusal(eligibility));
    const attempt = ++record.attempt;
    record.status = "recovering";
    try { return await this.host.transmit(record.requestId, record.command); }
    // Only the attempt that owns the receipt may clear the in-flight mark: a synchronous observer may already have
    // started the next attempt after a settled definite rejection, and that newer attempt must not be reset here.
    catch (error) { if (record.attempt === attempt && record.status === "recovering") record.status = "uncertain"; throw error; }
  }

  /** Local-only discard of one retained receipt; sends no abort, withdrawal or any other remote message. */
  discard(requestId: string): void {
    const record = this.records.get(requestId);
    if (!record || record.provisional) throw new Error("No recoverable submission matches this receipt");
    if (record.status === "recovering") throw new Error("Cannot discard while a recovery attempt is in flight");
    this.records.delete(requestId);
  }
}
