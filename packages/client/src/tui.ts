import { Editor, matchesKey, ProcessTerminal, ScrollView, Text, truncateToWidth, TuiAltScreen, visibleWidth, VStack } from "@earendil-works/pi-tui";
import type { Terminal } from "@earendil-works/pi-tui";
import type { Command } from "@sof/durable-remote-protocol";
import { CommandOutcomeUnknownError, CommandRejectedError, RemoteClient } from "./remote.ts";
import type { RecoveryEligibility } from "./recovery.ts";
import { sessionWorkText, terminalText } from "./render.ts";
import { presentationTheme } from "./theme.ts";
import type { PresentationTheme } from "./theme.ts";
import { RemoteTranscript } from "./transcript.ts";

const maxPreviewLength = 64;
/**
 * Panel preview cap so the oldest receipt's preview, request ID and readiness each stay on their own single row
 * even at 36 columns (worst case: 1 + 21 + 1 + 3 + 9 = 35 columns), leaving the whole panel inside its row budget.
 */
const maxPanelPreviewColumns = 21;
/**
 * Rows the recovery panel may occupy: exactly one per `recoveryStatusText` line, each guaranteed to stay on a single
 * rendered row even at 36 columns. The layout pins the panel to these rows (`shrink: 0`), so height-constrained
 * viewports squeeze the transcript, notices and editor instead of clipping the target's readiness or preview.
 */
export const recoveryPanelMaxRows = 7;

/** One-line sanitized preview of the retained original intent; remote text is data, never terminal instructions. */
const intentPreview = (command: Command, maxColumns: number): string => {
  const flat = terminalText(command.name === "submit" ? command.text : JSON.stringify(command)).replace(/\n+/g, "⏎").trim();
  return terminalText(truncateToWidth(flat, maxColumns, "…"));
};

/**
 * Recovery readiness of the /recover target, derived from the store's authoritative eligibility checks — the same
 * guards recover() applies, so identity mismatch/absence and stale snapshots can never display as ready.
 */
const readinessWord = (eligibility: RecoveryEligibility): string => {
  switch (eligibility) {
    case "eligible": return "Ready";
    case "in-flight": return "Recovery in flight";
    case "awaiting-snapshot": return "Needs a fresh snapshot";
    case "disconnected": return "Needs a connected snapshot";
    case "missing-identity": return "Refused (no conversation identity)";
    case "different-identity": return "Refused (different conversation)";
    case "absent": return "Receipt gone";
  }
};

/**
 * Presentation mapping from the receipt store to the persistent recovery panel. Every line is short enough to stay
 * on one rendered row even at 36 columns, and the panel renders at most one row per line, so the whole panel fits
 * recoveryPanelMaxRows. Ordering keeps the most operator-critical facts first so deeper viewport clipping sacrifices
 * instruction rows before the oldest /recover target: the count with the retained total, the target's readiness from
 * the authoritative eligibility checks (including identity refusals), then its original input preview and request ID.
 * Rendered from the store on every update, so bounded notice churn can never erase it.
 */
export const recoveryStatusText = (client: Pick<RemoteClient, "recovery">): string => {
  const receipts = client.recovery.list();
  if (receipts.length === 0) return "";
  const target = receipts[0];
  return [
    `Unconfirmed: ${receipts.length}; /recover → oldest`,
    readinessWord(client.recovery.eligibility(target.requestId)),
    `"${intentPreview(target.command, maxPanelPreviewColumns)}" · ${target.requestId.slice(0, 8)}…`,
    "Recovery reuses the original ID;",
    "retyping may duplicate work",
    "/discard never aborts remote work;",
    "forgets the local receipt only",
  ].join("\n");
};

/** The released root layout, extracted so tests exercise the exact viewport budgeting the real TUI renders. */
export const tuiLayoutRoot = (
  header: Text,
  transcript: ScrollView,
  recoveries: Text,
  notices: Text,
  editor: Editor,
  help: Text,
): VStack =>
  new VStack([
    { component: transcript, basis: 0, grow: 1, minSize: 1 },
    // The recovery panel must never shrink below its rendered rows: its content is exactly recoveryPanelMaxRows
    // lines, each one rendered row even at 36 columns, and losing its tail would hide the /recover target's
    // readiness or original input preview (the row /discard would forget) in height-constrained viewports.
    { component: recoveries, basis: "auto", maxSize: recoveryPanelMaxRows, shrink: 0 },
    { component: notices, basis: "auto", maxSize: 4 },
    { component: editor, basis: "auto", maxSize: 10, minSize: 3 },
    { component: header, basis: "auto", maxSize: 2 },
    { component: help, basis: "auto", maxSize: 2 },
  ]);

export const tuiHelpText = "Enter: follow-up · ^C exit · ^O tools";

/** Two native Text rows; keep both model and remote basename visible even in narrow terminals. */
export class RemoteFooter extends Text {
  private stateText = "";
  private model = "";
  private cwd = "";
  /** Semantic subordination for the metadata row, injected from the theme; identity under NO_COLOR. */
  metadataStyle: (text: string) => string = (text) => text;
  setSession(state: string, model: string, cwd: string): void {
    this.stateText = state; this.model = model; this.cwd = cwd;
  }
  override render(width: number): string[] {
    if (!this.model) return super.render(width);
    const modelWidth = Math.max(1, Math.floor((width - 3) / 2));
    const pathWidth = Math.max(1, width - modelWidth - 3);
    const basename = this.cwd.split("/").filter(Boolean).at(-1) ?? "/";
    const path = compactRemotePath(this.cwd);
    this.setText(`${this.stateText}\n${this.metadataStyle(`${truncateToWidth(this.model, modelWidth, "…")} · ${truncateToWidth(visibleWidth(path) > pathWidth ? basename : path, pathWidth, "…")}`)}`);
    return super.render(width);
  }
}

/** Remote path abbreviation is string-only: never probes the client's filesystem or git. */
export function compactRemotePath(path: string): string {
  const clean = terminalText(path).replace(/\/$/, "");
  const parts = clean.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : clean || "/";
}

/** Shared current-view chrome, also used by full-frame fixtures. Remote values are sanitized before styling. */
export function updateTuiChrome(client: RemoteClient, theme: PresentationTheme, header: Text, recoveries: Text, notices: Text): void {
  const stale = client.state !== "connected" && client.views.hasSnapshot();
  const state = `${client.state.toUpperCase()}${stale ? " · stale view" : ""}`;
  const stateStyle = client.state === "connected" ? theme.success : theme.warning;
  if (client.views.hasSnapshot()) {
    const view = client.views.current();
    const status = `${stateStyle(state)} · ${theme.muted(sessionWorkText(view))}`;
    if (header instanceof RemoteFooter) {
      header.metadataStyle = theme.muted;
      header.setSession(status, terminalText(view.model.modelId), terminalText(view.session.cwd));
    }
    else header.setText(`${status}\n${theme.muted(`${terminalText(view.model.modelId)} · ${compactRemotePath(view.session.cwd)}`)}`);
  } else header.setText(`${stateStyle(state)}\nWaiting for snapshot; no commands sent`);
  recoveries.setText(recoveryStatusText(client).split("\n").map((line, index) => index < 2 ? theme.warning(line) : line).join("\n"));
  notices.setText(client.notices.filter((notice) => notice !== "Connected; fresh whole snapshot received").slice(-3).map((notice) => `${theme.strong("Notice ·")} ${terminalText(notice)}`).join("\n"));
}

/** A project-owned UI composed from released pi-tui components, not experimental coding-agent source. */
export function runRemoteTui(client: RemoteClient, terminal: Terminal = new ProcessTerminal()): Promise<void> {
  const tui = new TuiAltScreen(terminal, true);
  const theme = presentationTheme();
  const transcript = new RemoteTranscript(theme);
  const header = new RemoteFooter("Durable remote", 0, 0);
  const notices = new Text("", 0, 0);
  // Recovery status is its own component rendered from the receipt store on every update, so bounded notice
  // churn can never erase or overwrite a visible unconfirmed submission.
  const recoveries = new Text("", 0, 0);
  const help = new Text(tuiHelpText, 0, 0);
  const editor = new Editor(tui, theme.editor);
  // The released Editor clears and trims before onSubmit. Capture the current expanded draft at its public
  // input boundary, including empty/whitespace drafts, rather than retaining a previous nonempty onChange value.
  let inputDraft = "";
  let draftRevision = 0;
  const handleEditorInput = editor.handleInput.bind(editor);
  editor.handleInput = (data) => {
    inputDraft = editor.getExpandedText();
    handleEditorInput(data);
  };
  editor.onChange = () => {
    draftRevision++;
    tui.requestRender();
  };
  tui.setLayoutRoot(tuiLayoutRoot(
    header,
    new ScrollView(transcript, { follow: "end", primary: true }),
    recoveries,
    notices,
    editor,
    help,
  ));
  tui.setFocus(editor);
  let submitting = false;
  let aborting = false;
  let exited = false;
  const update = () => {
    updateTuiChrome(client, theme, header, recoveries, notices);
    if (client.views.hasSnapshot()) transcript.update(client.views.current());
    // Local /recover and /discard must stay submittable in every connection state, so only an in-flight submission
    // disables the editor; the onSubmit guard refuses ordinary input while stale/disconnected and keeps the draft.
    editor.disableSubmit = submitting;
    tui.requestRender();
  };
  const unsubscribeView = client.views.subscribe(update);
  const unsubscribeStatus = client.subscribe(update);
  const report = (error: unknown) => client.notice(error instanceof Error ? error.message : "Client command failed");
  // Recovery/discard target the oldest retained receipt: RecoveryState.list() preserves insertion order, so the
  // selection is deterministic and never silently drops or overwrites another retained receipt.
  const recoverOldest = () => {
    const receipts = client.recovery.list();
    if (receipts.length === 0) { client.notice("/recover: no unconfirmed submission is retained"); update(); return; }
    const target = receipts[0];
    client.notice(`Recovering the oldest of ${receipts.length}: resending "${intentPreview(target.command, maxPreviewLength)}" with its original request ID`);
    const attempt = client.recovery.recover(target.requestId);
    update(); // recover() marked the receipt "recovering" synchronously; render the in-flight state now.
    void attempt.then((reply) => {
      client.notice(reply.status === "admitted" ? `Recovered input durably admitted (${reply.submissionId}); not an answer-completion acknowledgement` : "Recovered input completed");
    }).catch((error: unknown) => {
      if (error instanceof CommandOutcomeUnknownError) client.notice("Recovery outcome still unknown; the receipt is kept for another explicit /recover after a fresh snapshot");
      else if (error instanceof CommandRejectedError) client.notice(`Recovery resend was rejected, not admitted (${error.code}); the receipt is kept`);
      else client.notice(`Recovery refused: ${error instanceof Error ? error.message : "failed"}; the receipt is kept`);
    }).finally(() => { if (!exited) update(); });
  };
  const discardOldest = () => {
    const receipts = client.recovery.list();
    if (receipts.length === 0) { client.notice("/discard: no unconfirmed submission is retained"); update(); return; }
    const target = receipts[0];
    try {
      client.recovery.discard(target.requestId);
      client.notice(`Forgot the local receipt for "${intentPreview(target.command, maxPreviewLength)}"; the remote submission was not aborted`);
    } catch (error) {
      client.notice(`Discard refused: ${error instanceof Error ? error.message : "failed"}; the receipt is kept`);
    }
    update();
  };
  editor.onSubmit = (text) => {
    // Exact argument-less local commands: never forwarded, never editor history, never model input — even when
    // nothing is retained.
    if (text === "/recover") { recoverOldest(); return; }
    if (text === "/discard") { discardOldest(); return; }
    // Freeze this attempt's raw input and post-clear revision: even typing then clearing while a rejection is
    // pending is a newer draft, and must not resurrect this input. Unknown outcomes are never restored.
    const submittedDraft = inputDraft;
    const submittedRevision = draftRevision;
    const restoreDraft = () => {
      if (draftRevision !== submittedRevision || editor.getText() !== "") return;
      editor.setText(submittedDraft);
    };
    if (submitting || client.state !== "connected") {
      // Blocked before any send and never provisioned; keep the typed draft for ordinary re-entry.
      restoreDraft();
      return;
    }
    const retained = client.recovery.list().length;
    if (retained > 0) client.notice(`Submitting new input; ${retained} earlier submission(s) remain unconfirmed and retained (/recover resends the original; re-entry may duplicate work)`);
    submitting = true;
    update();
    void client.controller.submit(text).then((reply) => {
      editor.addToHistory(text);
      client.notice(reply.status === "admitted" ? `Input durably admitted (${reply.submissionId}); not an answer-completion acknowledgement` : "Command completed");
    }).catch((error: unknown) => {
      if (error instanceof CommandOutcomeUnknownError) {
        // Editor clears on submit. Do not restore unknown input where Enter could replay it; the receipt panel
        // and /recover or /discard own the outcome from here.
        client.notice(`Unconfirmed input (not replayed): ${text}`);
        client.notice("Use /recover to resend the original input with its original ID, or /discard to forget it locally");
      } else restoreDraft();
      report(error);
    }).finally(() => { submitting = false; if (!exited) update(); });
  };
  return new Promise<void>((resolve, reject) => {
    const finish = (failure?: unknown) => {
      if (exited) return;
      exited = true;
      unsubscribeView(); unsubscribeStatus();
      process.off("SIGINT", stop); process.off("SIGTERM", stop);
      client.close(); // Explicitly no remote abort.
      tui.stop();
      if (failure !== undefined) reject(failure); else resolve();
    };
    const stop = () => finish();
    tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) { stop(); return { consume: true }; }
      if (matchesKey(data, "ctrl+r")) { client.resync(); return { consume: true }; }
      if (matchesKey(data, "ctrl+o")) { transcript.toggleExpanded(); tui.requestRender(); return { consume: true }; }
      if (matchesKey(data, "ctrl+a")) {
        if (!aborting) {
          aborting = true;
          client.notice("Requesting abort (reply waits for cancellation to drain)");
          void client.controller.abort().then(() => client.notice("Abort completed")).catch(report).finally(() => { aborting = false; });
        }
        return { consume: true };
      }
    });
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    update();
    try { tui.start(); client.start(); }
    catch (error) { finish(error); }
  });
}
