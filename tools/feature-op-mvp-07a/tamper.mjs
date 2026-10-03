// Tamper switches: each kind acts once, on one in-memory copy or one armed fault, so exactly one check fails.

/** True the first time `kind` is asked for while it is the selected --tamper kind; false afterwards and for every other kind. */
export function tamperOnce(S, kind) {
  if (S.opts.tamper !== kind || S.tampered.has(kind)) return false;
  S.tampered.add(kind);
  return true;
}
