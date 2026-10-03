import type { SyncEventBus } from "../core/events";
import type { KuboClient } from "../kubo";
import { encryptedPhaseText, UNLOCKING_PULL_TEXT, type EncryptedPhase } from "./pull-notices";

/**
 * What a running decrypting pull shows. The engine reports no phases of its own, so the phase follows the node request
 * the pull is making: a name lookup, a listing, the key-slot file, the manifest, then blobs. The count is files written
 * (`file.changed` events). Key derivation reports a fraction, which goes to the dialog's indicator and sets the
 * "keep the app in the foreground" text.
 */

export interface PullProgress {
  /** The client with its reads observed. Behaviour is unchanged. */
  observe<C extends Pick<KuboClient, "nameResolve" | "ipfsLs" | "gatewayStream">>(client: C): C;
  /** The key derivation's progress callback. */
  readonly onKdf: (fraction: number) => void;
  /** Stop listening for file events. */
  stop(): void;
}

export interface PullProgressDeps {
  readonly bus: Pick<SyncEventBus, "on">;
  readonly show: (text: string) => void;
  /** The dialog's indicator; absent for a run without a dialog. */
  readonly kdfFraction?: (fraction: number) => void;
  /** Called once when the first blob is requested: the unlock is over by then. */
  readonly onFetchStart?: () => void;
}

export function createPullProgress(deps: PullProgressDeps): PullProgress {
  let written = 0;
  let phase: EncryptedPhase = "resolving";
  let fetching = false;
  const show = (): void => deps.show(encryptedPhaseText(phase, written));
  const enter = (next: EncryptedPhase): void => {
    phase = next;
    show();
  };
  const stopFiles = deps.bus.on("file.changed", () => {
    written += 1;
    if (phase === "fetching") show();
  });

  return {
    observe: (client) => {
      // Within one pass the key-slot file is read first and the manifest second, both by the CID of their listing entry (no path).
      let wholeFileReads = 0;
      return {
        ...client,
        nameResolve: (...args: Parameters<typeof client.nameResolve>) => {
          enter("resolving");
          return client.nameResolve(...args);
        },
        ipfsLs: (...args: Parameters<typeof client.ipfsLs>) => {
          enter("listing");
          return client.ipfsLs(...args);
        },
        gatewayStream: (...args: Parameters<typeof client.gatewayStream>) => {
          const [, path] = args;
          if (path !== undefined && path !== "") {
            if (!fetching) {
              fetching = true;
              deps.onFetchStart?.();
            }
            enter("fetching");
          } else {
            wholeFileReads += 1;
            enter(wholeFileReads === 1 ? "key-slots" : "manifest");
          }
          return client.gatewayStream(...args);
        },
      };
    },
    onKdf: (fraction) => {
      deps.show(UNLOCKING_PULL_TEXT);
      deps.kdfFraction?.(fraction);
    },
    stop: stopFiles,
  };
}
