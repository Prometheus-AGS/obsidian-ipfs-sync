import { CryptoError } from "../crypto";
import { ManifestFormatError } from "./encrypted-manifest";

/**
 * Is this the failure of a `manifest.enc` that is present but cannot be read: it does not authenticate, or it is
 * truncated or structurally invalid at the envelope level (what a cut-off write leaves)? Anything else is not a verdict
 * on the file and propagates: another vault, an unsupported format, a size cap, a platform failure.
 *
 * A `ManifestFormatError` is thrown only after the ciphertext authenticated: the file is authentic and holds fields
 * or values this build does not recognise (a newer device wrote it). That manifest is somebody's real state, so it is
 * never "unreadable" and is never replaced from a journal or a rebuild; it propagates as a refusal.
 */
export function isUnreadableManifest(error: unknown): boolean {
  if (error instanceof ManifestFormatError) return false;
  return error instanceof CryptoError && (error.code === "authentication-failed" || error.code === "malformed-input");
}
