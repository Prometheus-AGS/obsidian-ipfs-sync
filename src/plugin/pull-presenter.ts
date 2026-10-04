import type { PullOutcome } from "./pull-runner";
import { encryptedPullStatusText, isEventfulReport, STARTING_PULL_TEXT } from "./pull-notices";

/** What the presenter needs of an Obsidian `Notice`. */
export interface NoticeHandle {
  setMessage(text: string): unknown;
  hide(): unknown;
}

export interface PresenterPorts {
  /** `durationMs` 0 keeps the notice until it is hidden. */
  createNotice(text: string, durationMs: number): NoticeHandle;
  setStatus(text: string): void;
  /** Run `callback` once after `delayMs`. */
  schedule(callback: () => void, delayMs: number): void;
  now(): Date;
  /** A notice with one button. Absent: the action is reachable only from the command palette. */
  offerAction?(text: string, label: string, run: () => void): void;
}

/** How long the final pull notice stays: longer than a publish notice, because it can list conflict copies. */
export const RESULT_NOTICE_MS = 15_000;

export const RESOLVE_FORK_LABEL = "Resolve fork";
export const RESOLVE_FORK_PROMPT = "IPFS Sync: this pull stopped at a fork. Nothing was written.";

export interface PullReporter {
  onProgress(text: string): void;
  finish(outcome: PullOutcome): void;
}

export interface PullPresenter {
  /**
   * Start showing a pull. A normal run creates one notice now and updates it in place through the phases until the
   * result replaces the text. A quiet run (catch-up on load) shows no notice unless it changed files, made a
   * conflict copy, was refused or failed. `resolveFork` starts the Resolve fork action from the button a fork notice offers.
   */
  begin(options: { readonly quiet: boolean; readonly resolveFork?: () => void }): PullReporter;
  /** A plain notice, for a request that never started (another operation was running). */
  notify(text: string): void;
}

/** A refusal a quiet run stays silent about: it will say it again at every start and the user can do nothing yet. */
const QUIET_REFUSALS: readonly string[] = ["busy", "locked"];
const QUIET_STOPS: readonly string[] = ["first-pull-not-confirmed", "busy", "lock-held", "lock-unreadable"];

function isQuietWorthy(outcome: PullOutcome): boolean {
  switch (outcome.kind) {
    case "refused":
      return !QUIET_REFUSALS.includes(outcome.reason);
    case "stopped":
      return !QUIET_STOPS.includes(outcome.reason);
    case "failed":
      return true;
    case "completed":
    case "unfinished":
      return isEventfulReport(outcome.report);
  }
}

function resultStatus(outcome: PullOutcome, at: Date): string {
  switch (outcome.kind) {
    case "completed":
    case "unfinished":
      return encryptedPullStatusText(outcome.report, at);
    default:
      return "";
  }
}

export function createPullPresenter(ports: PresenterPorts): PullPresenter {
  const notify = (text: string): void => {
    ports.createNotice(text, RESULT_NOTICE_MS);
  };

  return {
    notify,
    begin: ({ quiet, resolveFork }) => {
      const progress = quiet ? undefined : ports.createNotice(STARTING_PULL_TEXT, 0);
      if (!quiet) ports.setStatus(STARTING_PULL_TEXT);
      return {
        onProgress: (text) => {
          progress?.setMessage(text);
          ports.setStatus(text);
        },
        finish: (outcome) => {
          ports.setStatus(quiet && !isQuietWorthy(outcome) ? "" : resultStatus(outcome, ports.now()));
          if (progress !== undefined) {
            // The same notice carries the result, then goes away like any other.
            progress.setMessage(outcome.notice);
            ports.schedule(() => progress.hide(), RESULT_NOTICE_MS);
          } else if (isQuietWorthy(outcome)) {
            notify(outcome.notice);
          }
          if (outcome.kind === "stopped" && outcome.action === "resolve-fork" && resolveFork !== undefined) {
            ports.offerAction?.(RESOLVE_FORK_PROMPT, RESOLVE_FORK_LABEL, resolveFork);
          }
        },
      };
    },
  };
}
