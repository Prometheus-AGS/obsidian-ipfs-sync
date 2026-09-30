import type { PullOutcome } from "./pull-runner";
import { isEventful, pullStatusText, STARTING_PULL_TEXT } from "./pull-notices";

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
}

/** How long the final pull notice stays: longer than a publish notice, because it can list conflict copies. */
export const RESULT_NOTICE_MS = 15_000;

export interface PullReporter {
  onProgress(text: string): void;
  finish(outcome: PullOutcome): void;
}

export interface PullPresenter {
  /**
   * Start showing a pull. A normal run creates one notice now and updates it in place through the phases until the
   * result replaces the text. A quiet run (catch-up on load) shows no notice unless it changed files, made a
   * conflict copy, was refused or failed.
   */
  begin(options: { readonly quiet: boolean }): PullReporter;
  /** A plain notice, for a request that never started (another operation was running). */
  notify(text: string): void;
}

function isQuietWorthy(outcome: PullOutcome): boolean {
  if (outcome.kind === "refused") return outcome.reason !== "busy";
  if (outcome.kind === "failed") return true;
  return isEventful(outcome.result);
}

export function createPullPresenter(ports: PresenterPorts): PullPresenter {
  const notify = (text: string): void => {
    ports.createNotice(text, RESULT_NOTICE_MS);
  };

  return {
    notify,
    begin: ({ quiet }) => {
      const progress = quiet ? undefined : ports.createNotice(STARTING_PULL_TEXT, 0);
      if (!quiet) ports.setStatus(STARTING_PULL_TEXT);
      return {
        onProgress: (text) => {
          progress?.setMessage(text);
          ports.setStatus(text);
        },
        finish: (outcome) => {
          const resultStatus = outcome.kind === "pulled" || outcome.kind === "incomplete" ? pullStatusText(outcome.result, ports.now()) : "";
          ports.setStatus(quiet && !isQuietWorthy(outcome) ? "" : resultStatus);
          if (progress !== undefined) {
            // The same notice carries the result, then goes away like any other.
            progress.setMessage(outcome.notice);
            ports.schedule(() => progress.hide(), RESULT_NOTICE_MS);
          } else if (isQuietWorthy(outcome)) {
            notify(outcome.notice);
          }
        },
      };
    },
  };
}
