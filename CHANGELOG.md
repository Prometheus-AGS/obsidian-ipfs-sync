# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries describe what exists in the code;
anything not yet built is under "Known limitations" or not mentioned.

## [Unreleased] - no default IPFS node (branch `mvp-07b-guard-removal`, not a release)

**If you relied on the built-in node, you must now configure one.** Releases up to 0.2.0 sent every request to the
maintainer's own node unless you changed it. This branch removes that default. A fresh install, or a script that never
set a URL, no longer reaches any node: it stops and tells you what to set. This entry describes commit `f1e5236`. The
maintainer's node is still open to anyone; this change does not fix that, it stops new installs from sending encrypted
blobs and their metadata (sizes, timing, how many files) to it without being asked.

### Changed

- **No built-in RPC or gateway URL.** `defaultLayer()` in `src/core/config/defaults.ts` supplies neither. Set both, by
  flag (`--rpc-url`, `--gateway-url`), environment (`IPFS_SYNC_RPC_URL`, `IPFS_SYNC_GATEWAY_URL`) or config file
  (`rpc.url`, `gateway.url`). With either missing, a command exits 2 with a configuration error (`no-rpc-url`,
  `no-gateway-url`) and sends no request. Both are required because every pull, publish read-back, status and key command
  reads through the gateway; the gateway URL is not derived from the RPC URL. A port setting alone counts as unset.
- **The plugin starts with empty URLs.** The settings tab shows "Node: Not configured". Publish, pull, status, the key
  actions, the vault opener and the auto-publish timer refuse with "Set your IPFS node in settings" and send no request.
- **The operator tools name the shared node themselves** (`tools/feature-op-client.ts` and the `feature-op-mvp-*`
  toolboxes), and `IPFS_SYNC_RPC_URL` and `IPFS_SYNC_GATEWAY_URL` still override it.
- **Four review fixes, from an independent code-reading review, and the changes that followed their delta review.**
  - **The gateway gets the RPC credential only on the RPC origin.** The gateway inherits the global auth when its origin
    equals the RPC origin; on any other origin it gets auth kind `none` unless gateway auth is set explicitly
    (`IPFS_SYNC_GATEWAY_AUTH_*` for the CLI, the Gateway authentication control for the plugin; see Added)
    (`src/core/config/build-config.ts`).
  - **Redirects are refused, never followed.** A 301, 302, 303, 307 or 308 answer fails with a fixed message that does not
    echo `Location` and tells the operator to check the URL's scheme and path. The Node stream transport never follows
    one. Obsidian's `requestUrl` follows redirects itself with no
    option to stop it, so on mobile a followed redirect is neither prevented nor detected. (This entry first said "and on
    desktop non-ranged requests"; the ninth round below moved all desktop requests to Node and corrected it.)
    (`src/kubo/http.ts`, `tests/unit/kubo-redirect.test.ts`).
  - **The retired host is cleared at load, for every readable format.** See the retired-host entry below.
  - **The first-pull confirmation states the replacement count.** When at least N existing local files differ from the
    vault, the confirmation says "at least N" files will be replaced and a dated copy of each is kept. It is not shown
    when N is 0. It is a lower-bound preview; the stage plans again (`src/sync/encrypted-pull.ts`,
    `cli/pull-encrypted-command.ts`, `src/plugin/first-pull-dialog-model.ts`).

- **Settings loading, display and the settings tab, from the next review round.**
  - Stored data with no version marker takes the previous-plugin path only if it is empty, or has a key of that plugin
    and none of the current form's. Anything else is unreadable and left untouched, so a current-form file that lost its
    `version` key no longer has `ownedKeys`, `gatewayAuth`, the device store and the sequence floor overwritten with
    defaults (`isLegacyForm` in `src/plugin/settings-migration.ts`).
  - A previous-plugin `rpcUrl` with a user name or password is stored empty, with a notice. The legacy `authToken` beside
    such an address is dropped too, as it is for the retired host; the user enters credentials again.
  - Status shows an address as scheme, host, port and path, or "invalid address", never userinfo, query or fragment
    (`displayAddress` in `src/core/config/endpoint.ts`, `src/plugin/sync-status.ts`). URL redaction covers everything
    between `//` and the last `@`. An invalid auth header name is no longer echoed.
  - The 401 or 403 gateway hint appears only when the gateway has no credential because its origin differs from the RPC's
    while the RPC has one (`credentialWithheld`). An explicit None, or a node without a credential, gets the plain message.
  - A JWT whose `exp` is a finite number beyond the date range gives a fixed warning and does not throw
    (`authWarnings` in `src/core/config/jwt.ts`).
  - Switching the node or gateway authentication picker away from a kind clears that kind's typed secret fields; Bearer to
    Basic and back needs the token typed again (`src/plugin/settings-view-model.ts`).
  - `manifest.json` `authorUrl` is now the GitHub repository.
- **Switching nodes is documented (README, DESIGN section 8.6).** After the retired host is cleared, only the URLs and the
  two credentials reset. Owned keys, pull name, last publish and pull, device store, publication key and MFS root
  persist, and the vault state under `.ipfs-sync/` is named by a hash of the MFS root, so a new empty node meets the old
  key-slot copy and a publish is refused with `lost-slots` until the user runs Abandon. Clear the pull name too. Status
  shows the old publish's root CID and time until the next publish (`src/plugin/sync-status.ts`). Abandon is the way out
  and moves files aside rather than deleting them; it also teaches users to click past refusals.
- **Third independent review round: pull, CLI and plugin settings.** The review read the code and executed nothing.
  Unit tests with fakes were added for the fixes (`tests/unit/cli-review-round3.test.ts`,
  `config-review-round3.test.ts`, `node-root-cid-bound.test.ts`, `plugin-settings-review3.test.ts`,
  `plugin-unreadable-backup.test.ts`). None ran inside Obsidian or on a phone.
  - **A folder with no state for the vault asks before a pull replaces files.** The first-pull confirmation is now also
    required when the device holds a sequence floor for the vault but the directory has no state for it, and at least one
    local file differs from the node's copy. It states the destination path (the CLI passes it), "at least N existing
    files will be replaced" and that a dated copy of each is kept, with a fixed statement (`NO_STATE_PULL_STATEMENT`).
    An empty or identical directory is not asked. `--accept-first-pull` skipped it (superseded in the fourth round
    below: `--accept-replace` now does); a run that cannot ask stops with
    `first-pull-not-confirmed` and writes nothing (`src/sync/encrypted-pull.ts`, `cli/pull-encrypted-command.ts`,
    `src/plugin/first-pull-dialog-model.ts`). Before this, only a pull with no record at all asked. **Every recovery
    path (Abandon, deleting `.ipfs-sync/`, pulling into a new folder) leaves a folder with no baseline, and the baseline
    is what protects you from the node.**
  - **Root CIDs from the node are bounded to 128 characters.** A longer one is refused with fixed text that does not echo
    it, where it enters (`src/sync/target-resolution.ts`, `src/sync/commit-node.ts`, `src/kubo/ipns.ts`). The local
    record would have written it and then refused to read it back.
  - **CLI.** `--auth-password`, `--auth-token` and `--auth-header-value` are refused (exit 2); use `IPFS_SYNC_AUTH_*`.
    An implicitly loaded `./ipfs-sync.config.json` that sets `rpc.url` or `gateway.url` is refused while a credential is
    configured by environment or flags, unless `--config` is passed or the URL is set by flag or environment. A symlinked
    `.ipfs-sync` is refused by publish, init, keys, prune-history, `pull --list-versions` and abandon, and the state
    folder is created 0700. `status` escapes node-supplied text, and `escapeNodeText` now also escapes zero-width and
    invisible characters. Without a terminal the CLI offers no prompt, so `keys change-passphrase`, `keys increase-cost`
    and `prune-history` without their explicit flag exit 2 before sending anything. `--show-request` redacts the
    credential header names of both endpoints. A passphrase file inside the vault is refused. A credential configured
    for a non-loopback `http:` endpoint produces a warning. Unparsable URLs print "invalid address"
    (`cli/args.ts`, `cli/load-config.ts`, `cli/state-folder-link.ts`, `cli/io.ts`, `cli/run.ts`,
    `cli/passphrase-file.ts`, `cli/request-trace.ts`, `cli/status-command.ts`, `src/core/config/build-config.ts`,
    `src/core/config/endpoint.ts`, `src/kubo/errors.ts`).
  - **Plugin settings.** Changing the node URL origin blanks the stored node credential; changing the gateway origin
    drops the gateway credential (an explicit None is kept); a plain line under each field says so. Editing a URL, port
    or credential no longer triggers a key check (press Check again; the check on opening the tab remains). An unreadable
    `data.json` is copied to `data.json.unreadable-<UTC timestamp>` (plain text, same secrets) before the first save
    replaces it, and the save is refused if the copy fails. The auto-publish interval is capped at 35,000 minutes. Cancel
    is focused after Check key slots and on the first-pull dialog. Escape during Abandon or Clear stale lock reports the
    real result. The legacy token is dropped when its URL is not carried over. The settings tab is emptied on close
    (`src/plugin/settings-fields.ts`, `settings-view-model.ts`, `settings-tab.ts`, `settings-store.ts`,
    `unreadable-backup.ts`, `settings-migration.ts`, `settings-model.ts`, `settings-to-config.ts`, `index.ts`, and the
    dialogs).
- **Fourth independent review round: the rule, not the example (commit `c86445c`).** The third round fixed what the
  reviewer pointed at. Each fix passed the reviewer's string and missed the next one that a slightly wider check would
  have caught. This round replaces several narrow checks with shared ones. Tests were written first and failed before the
  source change, except A-L1 and A-L2, where the review reports say otherwise. Touched and importing test files pass one at a
  time and typecheck is clean in both configs. The full suite, the heavy CLI-spawning files and the guard tests have not
  run on this commit. Nothing ran in Obsidian.
  - **`--accept-replace` is new, and `--accept-first-pull` no longer answers the replace question.** A pull into a folder
    with no state for a vault this device already knows, where files that differ from the node's copy would be replaced,
    needs `--accept-replace` when it cannot ask. `--accept-first-pull` answers only the true first pull. **A script or cron
    job that passes `--accept-first-pull` to cover the stateless case stops (`first-pull-not-confirmed`, exit 1, nothing
    written) until it passes `--accept-replace`.** The message names the flag (`cli/args.ts`, `cli/run.ts`,
    `cli/pull-encrypted-command.ts`, `src/sync/encrypted-pull.ts`, `cli/help-text.ts`).
  - **A confirmation is offered only when standard input and standard output are both terminals** (superseded in the fifth
    round below: standard error must be one too) (`canAsk` in `cli/io.ts`). Before, standard input alone decided, so with output piped the consequence text went where the person
    answering could not see it. With either end redirected the contract is "no terminal": the explicit flag, or exit 2 before
    any request for `keys change-passphrase`, `keys increase-cost`, `keys discard`, `prune-history` and `abandon` (a pull
    that needs a yes exits 1). A question that is asked and declined exits 1.
  - **One CID validator for reads and writes** (`isCidToken` and `assertPersistableCid`, `src/sync/local-record.ts`). A
    root path the node supplies must be `/ipfs/<cid>` with a CID of 10 to 128 alphanumeric characters, and is refused
    otherwise with fixed text (`rootOfPath` in `src/sync/commit-node.ts`: `/ipns/...`, a path below the root, a bare token and
    whitespace are all refused). `filesStat` CIDs go through the same function. The publish journal, the maintenance
    journal and the root state refuse to persist a value they would refuse to read, before the first write. Gateway CIDs
    and IPNS names are bounded at 128 (`src/kubo/gateway.ts`, `src/sync/target-resolution.ts`).
  - **`displayAddress` and the protocol error.** Anything that is not `http:` or `https:` with a host prints "invalid
    address", including text that parses as another scheme (`user:secret@host:5001`). The "must use http or https" error
    no longer names the parsed scheme, because the scheme could be part of the secret (`src/core/config/endpoint.ts`).
  - **CLI output and files.** `fs.write` takes the per-path directory mode: folders for pulled notes keep the platform
    default (before, every directory it created was 0700), and only the `.ipfs-sync` state folder is 0700, matched
    case-insensitively (`cli/node-host-bridge.ts`). Output stripping (`cli/io.ts`) shares one code-point table with
    `escapeNodeText` (`isUnsafeCodePoint`, `src/kubo/errors.ts`). The plain-http credential warning exempts only
    `localhost`, `127.x.x.x` and `[::1]`; `*.localhost` is no longer exempt (`src/core/config/build-config.ts`). The
    explicit-port conflict check sees the URL as the parser does: tabs, line breaks, backslashes, extra slashes and
    surrounding control characters (`parserView`, `src/core/config/endpoint.ts`).
  - **Help text** now covers the resume rule for a pending rewrap or prune journal (re-running takes what to finish from the
    journal and ignores the rest of the command line, including `--cost`, `--passphrase-file` and `--keep`), the refusal of
    an implicitly loaded config file, `--accept-replace`, and the exit codes (`cli/help-text.ts`).
  - **Plugin.** Closing Abandon or Clear stale lock while it runs no longer hides a failure: a notice reports it, dialog
    handles are tracked per dialog, and a thrown error in Abandon is shown as fixed text. Any change of origin blanks that
    block's draft credential and returns its picker to the stored kind. The publish interval is a whole number of minutes:
    a stored fraction, negative or non-finite value loads as 0 (off) and the credentials are kept. The unreadable
    `data.json` copy is read back before the save, and the pending flag clears only after the save succeeds. One sentence
    about redirect risk sits under the credential fields (Authentication section); with only a gateway credential it is not
    beside the gateway fields. A missing space in the unreadable-file notice was added (`src/plugin/*`).
- **Fifth review round: abandon names what it drops, the terminal rule, fixed text (commit `5a73801`).** Abandon moved the
  pending key-management (maintenance) journal without naming it. Tests were written first
  and failed before the source change. Touched and importing test files pass one at a time and typecheck is clean in both
  configs. The full suite has not run on this commit. Nothing ran in Obsidian.
  - **Abandon previews and moves four local files, and says what that costs.** The key-slot copy, the state, the publish
    journal and the key-management journal (`cli/abandon-command.ts`, `src/plugin/encryption-copy.ts`, `cli/help-text.ts`).
    A pending rewrap or prune is dropped from this device. Its write to the node is not withdrawn: a rewritten key-slot
    file may stay in the shared tree, and other devices that then publish to that root will see changed key slots.
    **Abandon can drop the one record the tool needs to clean up after itself, and the dialog and the CLI preview now say
    so.** This entry first said `ipfs-sync keys discard` withdraws the write. **That was wrong, and the sixth round
    corrected it** (see below): discard withdraws a key-slot file only for a rewrap that has not yet published. The plugin
    has no discard action, so that step is on the command line. Abandon stays allowed: it is the escape hatch. The CLI's
    "nothing to move" message names the key-management journal; the plugin's `NOTHING_TO_ABANDON` line does not (see Not
    done).
  - **A confirmation is offered only when standard input, standard output AND standard error are terminals** (`canAsk`,
    `cli/io.ts`). The question is written to standard error, so a run with it redirected could not show the question.
    Such a run is a run that cannot ask: the explicit flag, or exit 2 before any request.
  - **A stored `publishIntervalMinutes` of `null` loads as 0 (off) with the file kept.** `JSON.stringify` writes NaN and
    infinity as `null`. Every other non-number type still makes the file unreadable (`src/plugin/settings-parse.ts`).
  - **Fixed text where text was claimed to be fixed.** The unresolved-name pull error no longer echoes the node's answer
    or the name (`src/sync/target-resolution.ts`). The lock file's host is cut to 64 characters (marked when cut) and
    escaped before it reaches a dialog or a CLI line (`describeLock`, `src/sync/publish-lock.ts`; the stale-lock dialog
    escapes the description again). The plugin abandon failure path returns one of three fixed lines (invalid MFS root,
    local files not all moved, unexpected error) and never reads the error's message (`src/plugin/abandon-flow.ts`).
  - **`--accept-first-pull` also covers the replace consequence on a true first pull into a non-empty directory** (files
    that differ are replaced, dated copies kept). `--accept-replace` is the stateless one. Help text says so
    (`cli/help-text.ts`).
- **Sixth round: abandon says only what the code does, and is never blocked (commit `903e3c1`).** Abandon is the escape
  hatch, so its text and behaviour were tightened. Tests were written first and failed before the source change, except
  the CLI abandon cases, which were written after the code. Touched and importing test files pass one at a time and
  typecheck is clean in both configs. The full suite has not run on this commit. Nothing ran in Obsidian.
  - **Correction: `keys discard` does not withdraw a prune, or a rewrap that has published.** The fifth round, the README,
    DESIGN section 8.6, the runbook and this file said discard withdraws the pending node write. The code
    (`withdrawMaintenanceWrite`, `src/sync/republish-root.ts`; `discardStatements`, `src/sync/key-management-text.ts`)
    withdraws a key-slot file only for a rewrap that has not yet published. For a prune, or a rewrap that has published,
    it forgets the record and takes nothing back: removed history files stay removed and a published key-slot file
    stays. **Abandon can drop the one record the tool needs to clean up after itself, and the earlier docs told you
    otherwise.** Run discard before abandon if you want an unpublished rewrap withdrawn. The CLI consequence text, the
    help text and the plugin copy say this now, and the plugin copy names all four files (`cli/abandon-command.ts`,
    `cli/help-text.ts`, `src/plugin/encryption-copy.ts`).
  - **A failing or unusable device store no longer blocks abandon.** Any error reading the sequence floor is reported with
    fixed text ("not read") and the four files still move. When the vault id is no longer on the device the floor line
    says "not looked up (the vault id is no longer on this device)" (`floorKept`, `src/sync/vault-keys.ts`).
  - **A rename that fails after the first file moved is a partial move.** The result carries counts only ("N of M files
    were moved. Run abandon again to move the rest." The seventh round added "into a new backup folder"). The plugin locks the session and refreshes status; the CLI exits 1
    without operating-system text. A rerun moves the rest (`AbandonPartialMoveError`).
  - **The plugin abandon takes the on-disk `publish.lock`** like publish, pull and the key actions. A held lock gives the
    busy result and moves nothing (`src/plugin/abandon-flow.ts`). The seventh round below narrows this: a lock file that
    cannot be used no longer blocks abandon.
  - **Smaller.** Nothing to move with no terminal and no flag exits 2. The lock host in dialogs and CLI lines is cut to
    a bounded prefix (64 characters shown), escaped and shown in double quotes, so it cannot forge the sentence after it;
    the record keeps at most 255 characters of the host, and a lock file over 64 KiB is rejected as unreadable
    (`src/sync/publish-lock.ts`). The exit-2 sentence in the help text lists `pull --resolve-fork`, which has no
    confirming flag and always exits 2 without a terminal.
  - **Every fix since the first review came from a review that read code and executed nothing.** This round is no
    different. The next review will probably find more.
- **Seventh round: abandon survives a broken lock and a failing release (commit `976a31a`).** Abandon is the escape
  hatch, so a broken lock must not block it and a failing release must not hide what it did. Tests were written first
  and failed before the source change, except that some CLI cases passed vacuously until the lock-file seam existed. The
  eight touched and importing test files pass (292 tests) and typecheck is clean in both configs. The full suite has not
  run on this commit. Nothing ran in Obsidian.
  - **Abandon now runs without its safety lock when the lock file is broken, and it says so.** A live lock held by
    another process still gives the busy result and moves nothing. A lock file that is unreadable (junk, or over 64 KiB)
    or unsupported (the file system refuses hard links) no longer blocks abandon (the eighth round reads the lock once
    more first and refuses when it is live). The move runs with no lock and one fixed
    line is shown: "the publish lock could not be used, so abandon ran without it; make sure no publish is running". The
    CLI prints it as a `note` line before the move. The plugin appends it to the success note (and, since the eighth round, to a partial-move result). If a publish is running
    while you abandon on a broken lock, nothing stops the two from touching the same files (`acquireAbandonLock`,
    `src/sync/publish-lock.ts`; `ABANDON_WITHOUT_LOCK_LINE`, `src/sync/vault-keys.ts`). The "publish from a file system
    that supports hard links" advice no longer reaches the abandon path.
  - **A failing lock release can no longer replace the abandon outcome.** Both the CLI and the plugin release through
    `releaseQuietly`, which swallows the error, so a throw cannot turn a successful move into a failure or replace a
    partial-move error. The plugin settles its session from the move result. `release()` now marks itself done only
    after the remove succeeded, so a second call retries; the heartbeat still stops once. A stale lock file left behind
    ages out or is cleared by `--break-lock`.
  - **Text.** The partial-move line now reads "N of M files were moved. Run abandon again to move the rest into a new
    backup folder." A rerun names its own backup folder, so the first files stay in the first folder and the rest go in
    the new one; look in both under `.ipfs-sync/`. The help text says abandon needs neither the RPC URL nor the gateway
    URL (`partialMoveLine`, `cli/help-text.ts`).
- **Eighth round: a live lock is never mistaken for a broken one; settle and heartbeat edges (commit `808b555`).** The
  seventh round decided "broken" from one failed system call, so a live holder on a volume without hard links could be
  taken for a broken lock and abandon would run beside it. Tests were written first and 13 new ones failed before the
  source change. The touched and importing lock files pass and typecheck is clean in both configs. The full suite has not
  run on this commit. Nothing ran in Obsidian.
  - **Abandon reads the lock once more before it goes on without it.** After `lock-unreadable` or `lock-unsupported`, a
    record that decodes and is not stale gives `lock-held` ("busy") and nothing moves. Only a lock that is still
    unreadable, absent or stale lets abandon run without the lock, with the one fixed line. A read error on the existing
    lock path (a directory at `publish.lock`, a file with no read permission) counts as unreadable for abandon only
    (`liveHolder`, `acquireAbandonLock`, `src/sync/publish-lock.ts`). This corrects the seventh round, which let any
    unreadable or unsupported result go through.
  - **A takeover put-back that fails with `lock-unsupported` refuses as lock-held.** When a live lock was moved aside and
    the file system cannot create it again, the moved file stays under its `.taken` name (`takeOver`).
  - **The plugin settles its session inside a guard.** If locking the session throws, the result keeps the move outcome
    and adds "reload the plugin". The without-lock note now also reaches a partial-move result
    (`MoveOutcome`, `src/plugin/abandon-flow.ts`). The seventh round said it did not.
  - **A late heartbeat cannot recreate the lock after release.** A stopped flag and an awaited in-flight beat
    (`settled`) keep it from writing after the remove. The CLI's lock file honors the new `isStopped` argument
    (`cli/publish-lock-file.ts`). The plugin's adapter lock file ignores it and relies on release awaiting the beat, so a
    write that hangs could hold release.
  - **The CLI prints "nothing to abandon" style text and exits 1 when the move found no files** (`NOTHING_TO_MOVE`,
    `cli/abandon-command.ts`): the message is the one used for none found at the start, and ends "nothing was moved".
  - **Every fix since the first review came from a review that read code and executed nothing.** Each fix round created
    the next MEDIUM finding one level further out. The lock is best effort, and abandon fails open on a broken one. **Rounds stop here by decision, not because the
    reviews ran out of findings.** The next review will probably find more, and the items under "Not done" are what is
    already known.
- **Ninth round / desktop transport: desktop sends every request through Node and refuses redirects (commit `9276e34`;
  probe tool changes in `6ac4698`, `e7c0ccb`, `e385918`).** The redirect behaviour of `requestUrl` was untested through
  the first eight rounds. It was probed on a real desktop and on an iPhone, and the desktop result changed the code.
  - **Desktop: every request, any method and body type, goes through Node's `http` and `https`**
    (`src/plugin/node-transport.ts`, chosen by `pluginTransport` in `src/plugin/request-url-transport.ts`; all plugin call
    sites use it). Node returns a 3xx instead of following it, and `requestEndpoint` refuses it with the fixed message.
    The request, its method and its credential go to the configured URL only. Response bodies stream, so the size caps
    apply before a body is buffered. The old ranged-read-only transport (`range-streaming-transport.ts`) is replaced by
    this file. Mobile has no Node and keeps `requestUrl`, which cannot refuse a redirect.
  - **Cost on desktop.** Node's TLS uses its own CA list: a private CA needs `NODE_EXTRA_CA_CERTS`, and the TLS failure
    message says so (`TLS_FAILURE_MESSAGE`). Node ignores the system proxy and the Chromium trust store, so a node reached
    through a system proxy, or through a private CA that Node does not trust, fails on desktop.
  - **Probed on a real desktop** (Obsidian installer 1.8.4, app 1.14.4, Electron 33.3.2, macOS), by the operator and by the
    lead using computer control. With the old `requestUrl` path a node's cross-origin 307 to `127.0.0.1` was followed and
    the POST replayed (method kept, no `Origin` header). With the new build the probe said "redirect NOT followed; the
    redirect target was not reached", and the request carried the configured `X-Api-Key` to its own URL only and none of
    Chromium's `sec-fetch` headers.
  - **Probed on an iPhone** (CFNetwork, `requestUrl`). A cross-origin redirect was followed and the POST replayed with an
    empty body (`key/list` carries none). `Authorization` was stripped on the cross-origin hop. A custom header
    (`X-Api-Key`) was forwarded. **iOS forwards a custom-header credential across origins and the plugin cannot stop it;**
    use Bearer or Basic on a phone, and a node that does not redirect.
  - **Finding history.** A reviewer rated the `requestUrl` redirect HIGH and two others MEDIUM (third round, below). The
    desktop probe confirmed the loopback case, which is the HIGH criterion, and the desktop transport closes it. On mobile
    it stays a documented MEDIUM.
  - **`tools/probe-redirect-forwarding.mjs`.** `node tools/probe-redirect-forwarding.mjs --host <LAN address>` (or
    `--loopback` for a desktop run) serves a redirecting "node" on port 5101 and a target on 5102. It prints one `VERDICT`
    line per request and the header names it received with a short hash of each credential value, never the value.
  - **How the desktop result was obtained.** It came only after the operator had spent about an hour on earlier probe
    attempts that failed for reasons on the lead's side: incomplete instructions, and a user-agent the first probe printed
    truncated.
  - Tests: `tests/unit/node-transport.test.ts` (new), `tests/unit/hostile-gateway-bounds.test.ts`. They run outside
    Obsidian; the probes above are the only runs on real devices.
- **Tenth round / the desktop transport fails closed (commits `7a9ce77` and `c40f76f`; they fix the ninth round, `9276e34`).**
  An independent read of the ninth round's transport found two defects in it. Both are fixed; the tests were written
  first and failed before the code. Sixteen touched files passed one at a time and typecheck was clean on `7a9ce77`; the
  full suite had not run on that commit. Nothing has run in Obsidian with this build.
  - **A malformed response no longer hangs the run.** A node answering with a status outside 200-599 (Node's parser
    accepts any three digits) or with headers that `Headers` or `Response` refuse made the handler throw inside an event
    callback. The promise never settled, the sockets stayed open, and with no timeout by design the publish or pull never
    reached its `finally`, so the sync lock stayed held until the plugin reloaded. The handler now accepts 200-599 only,
    builds the headers and the `Response` inside a `try`, and on failure destroys both sockets and rejects with the fixed
    message "the node answered with a response this plugin cannot read". Nothing the node sent is echoed. 101 and 103 are
    no longer treated as bodyless (`src/plugin/node-transport.ts`).
  - **No silent fallback to `requestUrl` on desktop.** When `globalThis.require` was missing or threw on a desktop app,
    the transport used to fall back to `requestUrl`, which follows redirects, and undid the ninth round without a sign.
    It now refuses every request with the fixed message "the desktop network layer is unavailable, so the plugin will not
    send requests through the redirect-following fallback; reload the plugin or report this". `requestUrl` is used only
    when the app is not a desktop app, that is on mobile (`pluginTransport`, `src/plugin/request-url-transport.ts`). Entry
    tests that relied on the silent fallback now run as mobile.
  - **Custom auth header names.** The name cannot be Host, Transfer-Encoding, Connection, Content-Length, Upgrade, Expect,
    TE, Keep-Alive, Proxy-Connection or Trailer. Node honours those; `fetch` ignored them (`src/core/config/auth.ts`).
  - **The CORS hint** now ends "desktop uses Node's http and is not subject to CORS, mobile uses requestUrl"
    (`src/kubo/errors.ts`). Three code comments that said desktop uses `requestUrl` were corrected.
  - **Three gate failures fixed in the tests; no source change (`c40f76f`).** The phone-timing pty test no longer hangs
    when `dist/.guard-build.json` is current (the state right after `--build`): `spawnSync` blocked the event loop, so the
    test timeout could not fire. The Release 1 tarball golden no longer compares gzip bytes, because the zlib in the Node
    build changes them: Homebrew Node 26.8.2 ships zlib 1.2.12 and writes 193 bytes, Node 22 and 24 write 195. It compares
    the gzip header and the decompressed tar bytes and adds a within-run reproducibility test. The lock-during-unlock test
    no longer races `vaultExists()`: it waits for the passphrase dialog request instead of sleeping 5 ms.
  - **Round-10 follow-up: abort, shared header list, host bridge, TLS split (commit `f74cd96`).**
    - **An aborted request can no longer hang the desktop transport.** A signal already aborted rejects before a request is
      made. An abort before the response destroys the request and rejects. An abort after the response errors the body
      stream with the abort reason. The promise settles once and the abort listener is removed on every exit. Only a string
      error `code` is read (`DOMException.code` is the legacy number 20) (`src/plugin/node-transport.ts`).
    - **The ten connection-framing header names live in one module**, `src/core/config/connection-headers.ts`, used by the
      auth validation (`buildAuth`) and the transport. The custom auth header also cannot be Content-Type or Range
      (`CREDENTIAL_FORBIDDEN_HEADERS`); the transport does not refuse those two. The earlier entry naming
      `CONNECTION_HEADERS` in `src/core/config/auth.ts` is out of date.
    - **The host bridge has no permissive default.** `net.fetch` without an injected transport throws "network access is not
      available in this host" before sending anything. The body is typed as bytes and passed through; a `Blob` body is a
      `TypeError` from the Node transport (`src/plugin/obsidian-host-bridge.ts`).
    - **TLS failures have two fixed messages.** A certificate verification failure keeps `TLS_FAILURE_MESSAGE` and names
      `NODE_EXTRA_CA_CERTS`. `EPROTO`, `ERR_SSL_*` and `ERR_TLS_*` get `TLS_CONNECT_FAILURE_MESSAGE` ("the connection could
      not be established as TLS: check the address and scheme"), with no CA advice. This replaces the single
      message that sent a `WRONG_VERSION_NUMBER` failure to the wrong remedy. `NODE_EXTRA_CA_CERTS` must be set in the
      environment Obsidian is launched with; a macOS GUI launch does not inherit shell variables.
    - **The CORS hint wording changed** to "this request used the browser fetch, which is subject to CORS; the node must
      allow the app origin", and it appears only for a "Failed to fetch" `TypeError` (`src/kubo/errors.ts`). The wording
      quoted in the previous bullet is superseded.
    - **Verified in real Obsidian** 1.14.4 desktop on macOS (computer control, local probe, round-10 build `main.js` sha256
      prefix `5b906b2f`): a 308 from the node was not followed, the target was never reached, and the request carried
      `x-api-key` only and no Chromium headers. This is the only run of the current transport in Obsidian. Abort handling
      and the TLS split have run in unit tests only. iOS and other mobile still follow redirects.
  - **The uncomfortable part.** The redirect guarantee exists only where Node's `http` is reachable. On mobile it does
    not exist, and this round did not change that.
  - **Release tarballs depend on the Node build.** A Release 1 CLI tarball built with a different Node build has a
    different sha256 than the golden; build release tarballs on the same Node build every time. Node 24 produced the
    goldens. The release tool also assembles `ipfs-sync-cli-0.3.0.tgz` for Release 2 (`tools/release/assemble.mjs`, and the
    file list in `tests/unit/release-mvp-07.test.ts`), so the same rule applies to it; nobody has compared a Release 2
    tarball across Node builds. The checker's clean-export build ran on Node 26.8.2 here: nvm's 24.21.0 failed with an
    esbuild platform-package error inside the clean export. That failure was not investigated.

### Added

- **`abandon` works with no node configured** (CLI and plugin). It only moves local state aside and prints the sequence
  floor, so it is the way out when a node is gone.
- **Gateway authentication in the plugin settings.** A control under the gateway port with Same as node (the default),
  None, Basic, Bearer and Custom header. Same as node follows the shared builder's origin rule (the node credential goes to
  the gateway only when scheme, host and port equal the RPC's, otherwise none). An explicit block wins, and None sends no
  credential even on a matching origin. The block goes to the gateway only. The settings version stays 3; data saved
  without it loads as Same as node. The secret is stored in plain text in `data.json` beside the node credential, and
  that file is excluded from publish. The tab shows a line when the node credential is withheld from a gateway on a
  different address. A gateway 401 or 403 on a request with no credential now says where to set one
  (`src/plugin/settings-model.ts`, `settings-to-config.ts`, `settings-fields.ts`, `settings-tab-copy.ts`,
  `src/kubo/errors.ts`; `tests/unit/plugin-gateway-auth.test.ts`, `tests/unit/kubo-gateway-auth-hint.test.ts`). This
  removes the failure the first review fix caused for a plugin user whose gateway sits on another origin.
- **The retired built-in host is cleared at load.** Stored data naming it in either URL, in the previous plugin's format,
  the previous version or the current version, and including the trailing-dot form, gets empty RPC and gateway URLs
  ("Not configured"). The auth tied to it is dropped: a legacy `authToken`, the node auth and the gateway auth. The user
  sees a one-time notice to set their own node and enter credentials again, and the cleared data is written back
  (`loadSettings`, `migrateLegacy`, `clearRetiredNode` in `src/plugin/settings-migration.ts`). A host typed by hand in a
  session still shows the settings-tab warning until the next load clears it. This replaces the earlier behaviour that
  kept a legacy `authToken` and kept current-format data as saved. **An upgrader who really used that node must now
  enter it and its credentials again.** The host string lives only in `src/core/config/retired-default-hosts.ts`, for
  that comparison; `tests/unit/no-default-node.test.ts` fails if it appears elsewhere under `src/` or `cli/`.
- **A blocking constraint, `no-default-node`,** in `.kbd-orchestrator/constraints.md`, with a grep that fails on a
  built-in URL under `src/` or `cli/`.

### Not done

- The maintainer's node is not hardened. Anyone who types its address into the settings is back where 0.2.0 put them.
- The guard evidence for this tree is stale and must be regenerated (stated in the commit). Nothing here has been run
  inside Obsidian or on a phone. The Gateway authentication control was never rendered. No mock of it exists in
  `docs/design/`, because the Open Design MCP did not connect, and `styles.css` does not exist.
- **LOW findings of the delta review, not fixed.** The first-pull preview hashes files twice (the review's wording; the
  second hash is the stage's own). The count can drift while the dialog is open. The origin rule shares one credential across all paths of one
  host.
- **What the fourth review round deliberately left.** Each item is known and unfixed.
  - Operands after `--` are echoed when they are reported.
  - A secret embedded in a URL path (as opposed to userinfo, query or fragment) is shown by `displayAddress`.
  - An implicitly loaded config file still applies its other fields (`mfsRoot`, `publicationKey`, `ownedKeys`, ports).
    Only `rpc.url` and `gateway.url` are judged.
  - Bare tokens from `name/resolve` are refused. A node that answers with a bare CID instead of `/ipfs/<cid>` now fails
    publish and pull. No such node was tried.
  - The shared pull test rigs (`tests/helpers/encrypted-pull-rig.ts`, `pull-stage-rig.ts`) default `acceptFirstPull` to
    true and leave `acceptReplace` off, so a stateless-pull test must pass `acceptReplace` itself. Two integration tests
    had to be changed for that.
  - `styles.css` does not exist, so the redirect sentence under the credential fields has a class and no style rule. It
    has never been rendered in Obsidian.
  - A-L: the cron job pattern is fixed only for the stateless case. A cron job that passes `--accept-first-pull` for
    a first pull is unchanged; one that relied on it for a folder with no state stops until `--accept-replace` is added.
  - **Every fix since the first review was found by a code-reading review that executed nothing, and the next round will
    probably find more.** The pattern is stable: a fix covers the string the reviewer named, the next reviewer finds the
    next string the narrower check passes. This round moved from per-string checks to shared validators to break that, but
    no search for remaining local patterns was run, and the full test suite has not run on this commit.
- **What the last delta review left as accepted backlog.** These came from a code-reading review that executed nothing.
  None is fixed on this branch. Each is known.
  - The abandon preview is listed before the lock is taken, so it can differ from the final count if a publish changes
    the files in between.
  - The CLI floor read creates the per-user device-store directory as a side effect (`ensureDirectory`,
    `cli/device-store-node.ts`).
  - `floorKept` reads the whole state file with no size cap while the lock is held.
  - Lock facts left by the eighth round, all from reading code, none run: `release()` removes the file after reading the
    token and does not re-check it at the remove. Release has no timeout. A crashed CLI publisher blocks the plugin
    abandon for up to 15 minutes, because the plugin treats a CLI holder as live (`isProcessAlive: () => true`,
    `src/plugin/adapter-lock-file.ts`), so "abandon is always allowed" holds fully only for the CLI. A live CLI holder
    with an empty host name looks like junk (`decodeLock` rejects an empty host), so abandon goes past it. The help text
    does not describe the lock policy.
  - The publish refusal `lockUnsupported` still advises "publish from a vault on a file system that supports hard
    links" outside the abandon path. The other callers were not reviewed for whether that advice fits.
  - The plugin abandon takes `publish.lock` without the changed-hands re-check that the key-action lock
    (`key-action-lock`) does.
  - The CLI's behaviour at readline end-of-input (a closed input stream at the abandon prompt) is unverified.
  - The unexpected-error text points to a developer console that does not receive the error.
  - A node-supplied key ID reaches `ownedKeys` and an IPNS name with no shape check. The vault key still authenticates
    the manifest.
  - The invisible-character table is narrower than `escapeForDisplay` (the `Default_Ignorable` and `Cf` ranges).
  - Check-then-use windows remain in the Node host bridge. Using one needs local write access.
  - The CID rule is six copies of one regex, not one definition. The next copy that drifts will be found by a reviewer,
    not by a test.
  - On the maintenance path the root CID shape is validated after the first node write. A malformed root can leave a
    half-applied shared tree. Rerunning the command recovers; `keys discard` recovers only an unpublished rewrap.
  - The unreadable-file backup is compared as decoded text, not raw bytes.
  - The redirect sentence sits in the Authentication section, not beside the gateway fields.
  - The `NOTHING_TO_ABANDON` wording does not name the key-management journal. The CLI message does.
- **What the last read of the transport left as accepted backlog (tenth round).** These came from a code-reading review.
  Nothing was executed. None is fixed on this branch.
  - `files/write` responses and `fetchGatewayBytes` read the body with no cap. This predates the transport change.
  - The TLS error classification is incomplete. Some certificate verification codes pass Node's text through. An
    `ERR_SSL_*` code such as `WRONG_VERSION_NUMBER` is reported as a verification failure and points to
    `NODE_EXTRA_CA_CERTS`, which is the wrong remedy for it (`isTlsFailure`).
  - The host bridge's `net.fetch` still defaults to the WebView `fetch` and bypasses `requestEndpoint`. No caller uses it
    today.
  - A truncated body that ends in `close` or `aborted` without `error` might leave a response stream hanging. This is
    unverified.
  - A 1xx interim response that never gets a final answer hangs, because the desktop transport has no timeout by design.
  - **Accepted after the round-10 follow-up, not fixed.**
    - The Node transport has no request timeout and no idle deadline: a node that accepts the connection and goes silent
      leaves the call pending. By design; no caller passes a signal.
    - `net.fetch` in the host bridge buffers the whole response with no byte cap.
    - A body stream that closes with neither `end` nor `error` is not explicitly errored.
    - `NODE_TLS_REJECT_UNAUTHORIZED=0` in Obsidian's environment would disable certificate verification, because the
      transport sets no `rejectUnauthorized`.
    - Some Node error texts outside the two TLS classes (`ERR_OSSL_*`, invalid protocol) pass through, escaped.
    - `escapeNodeText` does not cover U+2061 to U+2064, U+180E, U+034F and U+FFF9 to U+FFFB.
    - The `isTlsFailure` item above is partly closed: `ERR_SSL_*` no longer points to `NODE_EXTRA_CA_CERTS`.
- **Dead code left in place.** `warnAboutRetiredDefault` in `src/plugin/index.ts` and the `retiredDefaultNoticeShown`
  field remain. Load now clears the retired host, so the one-time notice they gate cannot fire from stored data.
- **Redirect probe coverage (the item "`requestUrl` redirect behaviour is untested" is replaced by this list).**
  - Probed: one macOS desktop (Obsidian installer 1.8.4, app 1.14.4, Electron 33.3.2) and one iPhone (CFNetwork,
    `requestUrl`). Results are in the ninth round above.
  - Not probed: Android; body-carrying calls on mobile (the multipart upload); an https-to-http downgrade; Windows and
    Linux desktops.
  - Open on mobile: iOS forwards a custom-header credential (`X-Api-Key`) to another origin and the plugin cannot stop it.
    The gateway must not redirect, and Bearer or Basic is the safer choice on a phone.
- **LOW findings L4 and L5, not fixed.** L4 is the dead retired-notice code listed above. L5: re-pointing a URL keeps its
  credential, so a credential written for one host goes to the next one typed.
- M4 below (plain `http` accepted with credentials) is superseded in part: a non-loopback `http:` endpoint with a
  credential now produces a warning (see Changed), and is still accepted. The plain-text credential in `data.json` stands.
- The credential in `data.json` is plain text, as is the node credential. Anyone who can read the vault folder on that
  device can read both.
- **Open findings from an independent code-reading review.** The reviewer read the code and executed nothing. The labels
  are the review's own, not released facts. None is fixed on this branch.
  - M2: the CLI does not know a renamed Obsidian configuration folder, so it can sync a folder the plugin would exclude.
  - M4: plain `http` is accepted for an endpoint that carries credentials. A warning is printed for a non-loopback host
    since the third review round; it is not refused.
  - M5: the plugin transport buffers whole response bodies without a bound, and some CLI reads do too.
  - M6: the Obsidian adapter cannot see symbolic links, and its rename is not atomic.
  - M7: `change-passphrase` and rewrap do not revoke an old passphrase, and there is no key rotation command. A leaked
    old passphrase opens the vault forever, for every copy of the vault data that anyone kept.
  - M8: the device-local rollback floor is easy to reset, which removes the rollback protection on that device.
- **Findings left open from the third review round.** It was an independent code-reading review that executed nothing.
  The ratings are the reviewers' own. None is fixed on this branch.
  - `requestUrl` follows redirects and may forward headers, on mobile and on desktop non-ranged requests. One reviewer
    rated it HIGH, another MEDIUM. Untested; to be probed on the phone. (Superseded by the ninth round: probed; closed on
    desktop, a documented MEDIUM on mobile.)
  - The plugin transports have no request timeout.
  - The mobile transport buffers whole bodies (memory).
  - "Not found" is taken from unauthenticated node text.
  - Credentials are stored in plain text in `data.json`, and other plugins can read them through the plugin object (the
    session and the store are runtime properties).
  - `net.fetch` in the host bridge is unscoped. It is dormant: nothing calls it today.
  - The unlocked session has no idle timeout.
  - The mass-removal guard ignores removals caused by exclusions.
  - A stale-lock takeover compares the token only.
  - The sequence floor evicts the oldest of 64 vaults silently.
  - Plaintext paths and sha256 sit in the vault's `.ipfs-sync` state folder, and cloud sync tools may copy them.
  - The node sees exact sizes and per-file edit timing.
  - A key holder can write arbitrary relative paths (`.zshrc`, `.vscode/tasks.json`) into a destination you chose.
  - `publish` has no secrets deny-list. Publishing a home directory would upload `.ssh`.
  - **The release gate is an attestation chain, not a proof.** Its records are written by the party being checked.
    Unread files do not fail it. The checker file is not pinned outside itself. Test helpers and the runner config are
    not hashed. The reader children in the operator run execute unhashed helpers with node credentials in their
    environment.
  - The repository lives inside the operator's vault folder (`.ipfs-sync`). A CLI run against the vault root would write
    into the git working tree.
  - The earlier M2 and M4 to M8 items above still apply.

## [Unreleased] - guard removal: real notes are accepted (branch `mvp-07b-guard-removal`, not a release)

**This is a branch, not a release.** Release v0.3.0 is not cut: `manifest.json` and `package.json` read 0.3.0
(commit `ef50b1c`), and there is no tag, no GitHub release and no release record. `main` still holds the fixture-only
guard. This entry is task 6.3 of change `mvp-07b-keys-history-guard-release-2`; it describes the removal commit
`38db5f8` and the documentation that goes with it. It sits above the 07b material below.

**What you should expect.** The tool now accepts a real vault and encrypts it. Nothing has been run inside Obsidian or on
a phone. No independent review of this tree has been recorded. The Release 2 evidence (the review record, the operator
run in Obsidian desktop against the shared node, the phone timing) is pending until the iteration-9 release steps
(tasks 6.4 to 7.3). The whole test suite had not been run on this branch when this entry was written; the phase gate
(task 6.4) runs it once. Read "Real notes: what you accept" in `README.md` before you publish anything you cannot lose
or cannot expose.

### Removed

- **The fixture-only guard.** `src/sync/publish-guard.ts` and `src/sync/pull-guard.ts` are permissive and keep every
  export name and signature. `init`, `publish`, the `keys` commands, `prune-history` and the plugin's Publish no longer
  need a `.ipfs-sync-fixture` marker. A pull is allowed into any directory (the usual conflict policy applies) and
  writes no marker, so a pulled copy can be published from. The marker parsing stays exported for its callers; nothing
  that gates an operation reads the result.
- **The fixture-only copy.** The publish and pull refusal notices no longer say fixture-only. The plugin settings
  callout now says every publish is encrypted with your vault passphrase and that without it the published data cannot
  be read. The CLI help says "Any vault can be published." and "Any directory can be pulled into."
- `tests/unit/fixture-marker.test.ts` is deleted on this branch only; the pre-removal suite stays on `main`.

### Added

- `tests/unit/guard-permissive.test.ts` (16 tests): publish without a marker, pull into a non-empty directory, no marker
  written by pull, and the refusal that stays.

### Changed

- The tests that asserted the old refusals are adapted: 20 test files, 2 integration and 18 unit (the list is in
  `git show 38db5f8 --stat`).
- `README.md`, `DESIGN.md` section 8.9 and the operator runbook describe real-notes operation and its risks instead of
  fixture-only operation. Where they still say fixture, it is history (release 0.2.0 and the earlier trees) or the
  generator of the synthetic test vault (`pnpm fixture:generate`), which still writes its marker; the marker has no meaning.

### Unchanged, and still refused

- A symbolic-link state folder (`state-folder-guard.ts`, the first step of the pull engine), a destination that exists and
  is not a directory, a mass removal, a missing passphrase, the path policy, the locks, the sequence floor and a
  plaintext root.
- `.ipfs-sync-fixture` stays on the default exclusion list, so a leftover marker is never published. `excludesHash` is
  unchanged.

### Security and limits

- Encrypted does not mean invisible: paths are encrypted, and the node operator still sees the number of files, their
  exact sizes, when you publish, and that the vault exists. Published ciphertext is permanent and public: old roots stay
  pinned and the public `keyslots.json` allows offline guessing of the passphrase.
- Losing the passphrase loses the vault. There is no recovery. The plaintext is on every device that holds the vault, and
  `.ipfs-sync/` holds paths and temporary plaintext.
- A timer never asks the cost question, so it stays out of a High-cost vault until you unlock by hand. The plugin's
  `requestUrl` buffers whole bodies; mobile behaviour with a real vault is unmeasured.
- The limits recorded in the 07b entry below stay, in particular: the sequence floor does not stop a node from showing an
  old copy to a device that has no recorded state, and rewrap does not revoke the old passphrase or any old copy of the key
  slot. The mass-removal guard does not catch the removal of 49 percent of the entries.

## [Unreleased] - key management, history pruning, mass-removal guard, plaintext removal (history: written while the tree was fixture-only, after the pull below)

*History.* When this section was written the tree was fixture-only; the guard is removed on branch
`mvp-07b-guard-removal` (entry above). The statements below that say fixture-only, or that the guard-removal branch was
not built, describe that earlier state. This section is change `mvp-07b-keys-history-guard-release-2`, the
code tasks only (`tasks.md` 1.x to 4.5, 4.8 and the added 2.3 and 2.4). It is covered by automated tests with fake nodes.
It has not been run inside Obsidian, on a phone, or by the operator against the shared node, and it has not been
independently reviewed. At that point not built: the operator-run script `tools/feature-op-mvp-07.mjs` (4.6, 4.7a, 4.7b;
it exists now), the guard-removal branch (6.2; it exists now), coalescing of auto-publishes (not built; the operator chose
the CLI command plus a plugin prune action in 1.8) and the check of the TTL a remote resolver sees after the restore form
(4.9; the shared-node test of the explicit options is recorded, see Changed). The plugin prune action (2.5) is built and
covered by fake-DOM and wiring tests only. Nothing here is tagged or released, and no release can pass the checker today.

### Added

- **`ipfs-sync keys change-passphrase`, `keys increase-cost`.** Replace the key slot by one that wraps the same vault key
  (a new generated passphrase, or the same passphrase at a higher cost; `--cost standard|high`). The new `keyslots.json`
  holds only the new slot. Nothing is re-encrypted; `manifest.enc` and the sequence do not change. Four derivations, a
  test unlock of the published file, then the local copy. A lower cost needs a confirmation that shows both costs.
  Rewrap does not revoke the old passphrase or any old copy of the key slot; the command says so before it asks.
- **`keys accept-slots`, `keys discard`.** Accept another device's changed slots from one root after the manifest of that
  root authenticates under the unlocked key (`--root-cid` with `--allow-rollback` for a restore across a rewrap), and drop
  a stuck key-management operation.
- **Maintenance journal** `maintenance.<h>.json` for rewrap and prune, separate from the publish journal. Publish and pull
  refuse while one exists and name `keys discard` and `keys accept-slots`. A rewrap that loses the name race puts back
  the old key-slot file; after a rewrap or prune the next publish with no change reports nothing changed.
- **`ipfs-sync prune-history <vault> --keep <n> [--dry-run | --yes-prune]`.** Removes the oldest history files from the
  node's working tree, keeps at least the newest 20, checks the newest 20 and the node's sequence first, republishes under
  the same sequence. The 1,500 and 1,999 messages name it.
- **Mass-removal guard.** `publish` stops when the removals that count equal every remaining entry or exceed half of at
  least two (exactly half proceeds). Exclusion-driven removals are listed apart and not counted; carried entries count as
  kept. `--allow-mass-removal`, a CLI yes, or a plugin dialog on a manual publish confirm; the timer refuses.
- **Plugin:** Encryption-section rows for change passphrase, increase cost, accept key slots and the slot's cost; dialogs
  for each, for the mass-removal confirmation and for a key slot above the default cost (manual pull, Resolve fork,
  Restore, manual publish at the unlock and the key actions ask; the timer and catch-up pull do not); and the command
  "Measure key derivation time" (one Argon2id derivation at the default cost on random input, with the longest event-loop
  gap and the first 16 characters of the `main.js` hash).
- **Desktop Range streaming.** On desktop a GET with a `Range` header goes through Node `http` and `https` (found with
  `globalThis.require`) and is cancelled after the header bytes. Mobile still buffers whole bodies. (Superseded in the
  ninth round: on desktop every request goes through Node, not ranged reads alone.)
- **Guard evidence tooling:** `tools/check-guard-preconditions.mjs` (tree hash, clean-export build, review record,
  operator-run record, phone timing, dist and checklist tests), `tools/record-phone-timing.mjs`, `tools/release-mvp-07.mjs`
  and per-release descriptors in `tools/release/`. Fixture policy is centralised in `src/sync/fixture-constants.ts`,
  `publish-guard.ts`, `pull-guard.ts` and `state-folder-guard.ts` with no behaviour change.

### Removed

- **The plaintext reader.** `--allow-plaintext-v1` and `--manifest-file` are unknown options; the v1 manifest, pull, plan,
  fetch, record, target, screen and latch modules are deleted. A root with `manifest.json` and no key slots is refused
  ("plaintext publications are no longer supported by this version"). `abandon` records no latch and prints the sequence
  floor. `encrypted-seen.json` is no longer written or read. This supersedes the 07a line that kept the plaintext reader
  behind a flag.

### Changed

- A vault emptied on a device that has a state no longer publishes an empty manifest: the mass-removal guard stops it.
  The empty-vault error remains for a first publish.
- `abandon` also moves a pending `maintenance.<h>.json`.
- Restore step for the IPNS pointer after a shared-node run: the printed form and the runbook are now
  `ipfs name publish --key=<key> --ttl 5m <pointer>` (the lifetime stays at kubo's 24h default). On 2026-10-04 kubo v0.42.0
  on the shared node accepted `--ttl 5m --lifetime 24h` on a throwaway key and the pointer resolved. The TTL a remote
  resolver sees was not checked.

### Security and limits

- Silent per-file corruption of unchanged files by someone who can write to the node is not detected by the publisher.
- Removing 49 percent of the entries is silent.
- Concurrent publishes are narrowed, not prevented.
- The sequence floor does not stop a node from showing an old copy to a device that has no recorded state.
- Rewrap does not revoke the old passphrase or any old copy of the key slot.
- The review record, the operator-run record and the phone-timing record are attestations, not proofs.
- A change to any scoped file after the review record or after the operator run changes the tree hash, and both must be redone.
- Two wrong code texts found while writing these notes are fixed: the cost statement and `keys increase-cost` help now say
  that the CLI without a terminal and the plugin's timer and catch-up pull refuse a cost above the default while manual
  plugin actions ask in a dialog, and the maintenance-pending message now says the ways out are command-line commands.
  What remains true: the plugin has no `keys discard` and does not finish an interrupted operation (Accept changed key
  slots also clears a pending operation). The history-growth decision (task 1.8) is taken: the CLI command and a plugin
  prune action both exist; coalescing is not built.
- **Plugin prune action (task 2.5).** A "Prune history..." row in the Encryption section, hidden until a vault exists. The
  dialog asks for a keep count (the floor of 20 is shown; a smaller number is raised) and the current passphrase, then
  does a dry run under one key derivation and shows counts only (removed, kept, total) with the engine's own statements.
  The review step focuses Cancel; files are removed only on an explicit press of the remove control, never on Cancel,
  Escape or closing the window. It takes the same lock pair as the other key actions, and the 2.4 cost confirmation
  applies. The auto-publish timer and the catch-up pull never prune. There is no resume in the plugin: an interrupted
  prune is finished with `ipfs-sync prune-history`, and the plugin has no discard action. The 1,500 warning and the 1,999
  refusal now name the command and the Encryption-section action. Tested with a fake DOM and stubs; not run in Obsidian
  or on a phone, and not tried with a screen reader.
- **History growth under auto-publish (task 1.8).** A timer at 15 minutes on a vault that changes on every tick writes 96
  history files a day: the warning at about 15.6 days, the refusal at about 20.8 days. The timer default is off. Auto-publish
  does not coalesce; the recovery is pruning, from the CLI or the plugin.
- On a High-cost vault the auto-publish timer stays refused until a manual unlock; a wrong-passphrase pull asks the cost
  question again on every attempt; the desktop streaming lookup is unconfirmed inside Obsidian. (The ninth round's desktop
  probe ran the Node transport in Obsidian 1.8.4 on macOS; other desktops are untested.)

## [Unreleased] - encrypted pull and second-device publish (fixture-only, after the encrypted publish below)

*History: when this was written the tree was fixture-only; the guard is removed on branch `mvp-07b-guard-removal`
(entry at the top).* This section is change `mvp-07-encrypted-pull-second-device`, task
group `07a`: the read side of the encrypted vault. It is covered by automated tests with fake nodes. It has not been run
inside Obsidian, on a phone, or by the operator against the shared node, and it has not been independently reviewed. The
`publish` and `init` guard (`.ipfs-sync-fixture` must hold `fixture`) was unchanged then; `mvp-07b` removes it. Nothing
here is tagged or released. The v0.2.0 pre-release is still the plaintext build and does not contain any of this.

### Added

- **`ipfs-sync pull` reads an encrypted vault.** It takes the vault passphrase (same sources as `publish`) and
  `publish.lock`, reads only (`name/resolve`, `key/list`, listings, gateway reads), authenticates `manifest.enc` before
  it requests any file, plans each path on plaintext sha256 (this device, the baseline, the node), fetches from the
  immutable tree the authenticated manifest names (never the mutable `current/`), decrypts into `.ipfs-sync/tmp/`,
  renames a file into place only when its size and sha256 equal the manifest entry, and writes the state file last.
  Flags: `--name`, `--root-cid`, `--manifest`, `--allow-rollback`, `--resolve-fork`, `--expect-min-sequence`,
  `--expect-vault-id`, `--accept-first-pull`, `--max-bytes` (default 536870912, 512 MiB), `--accept-large` and
  `--list-versions` (the newest 20 history entries by name, with date and device for files of at most 8 MiB). The output
  lists `integrity-failed`, `unfetched` and skipped paths apart. Exit 0: everything written and verified, or skipped as
  expected. Exit 1: a file failed or was not fetched, a path was skipped as unsafe, or the pull stopped at a check.
  Exit 2: a refused invocation or destination.
- **The record and the sequence floor.** This device records the highest manifest sequence it accepted, in
  `state.<h>.json` (now format 3: adds `manifestIdentity`, `previousIdentity`, `highestSequence`, `highestIdentity`,
  `complete`, `unmaterialized`, `devicesSeen` and `restoredFrom`; format 2, which no released build wrote, is upgraded on
  read) and in `sequence-floor.json` outside the vault (CLI: a per-user directory; plugin: the `deviceStore` section of
  the plugin data). A node that serves a lower sequence is refused. The floor survives `abandon`, deleting `.ipfs-sync/`
  and a changed MFS root. It keeps at most 64 vaults.
- **First pull** shows the sequence, date and device the vault key holder chose and asks (or needs
  `--accept-first-pull`). A declined first pull writes no file, marker, state, floor or key-slot copy; the lock may leave
  an empty `.ipfs-sync/` folder.
- **Restore** (`--allow-rollback` with `--root-cid` or `--manifest`; plugin: "Restore an older version") adds and replaces
  files, never deletes, keeps local edits as dated conflict copies and does not lower the recorded sequence; the next
  publish makes the result a new version.
- **Fork resolution** (`--resolve-fork`, needs a terminal; plugin: "Resolve fork") merges against the common ancestor in
  the node's history. With no ancestor, every file that differs from the node's becomes a conflict copy.
- **Second-device publish.** A second device pulls, adopts the owned key (`ownedKeys` in the config file, or
  `--owned-key <id>` for one run; plugin: "Adopt a key by ID") and publishes at the next sequence. The publisher reads the
  publication name before its first write and again before `name/publish` and refuses when it moved ("another device may
  have published"). The drift guard removes stray blobs only when no other device was ever seen.
- **History names carry the sequence:** `manifests/<16-digit sequence>-<rootCID>.enc`. Names written by a `mvp-06`
  development build (`<rootCID>.enc`) still read and sort first.
- **Path policy for pulled manifests:** paths a pull must not write are skipped before any request, as `expected` (the
  configuration folder, the exclusion list) or `unsafe` (a shape no honest publisher produces, or a name another platform
  can write: Windows forms, reserved names, 8.3 shapes, case-fold collisions). The policy is host-independent: a name such
  as `CON.md` is refused by pull on every host including Linux, is carried unchanged in that device's publishes, and
  makes the pull exit 1. The publisher warns about such names and never refuses.
- **Plugin:** Pull for encrypted vaults (first-pull, restore, fork and large-pull dialogs; the catch-up pull never opens
  a dialog), the commands "Restore an older version" and "Resolve fork", a "Pull record" row in the Encryption section,
  and the setting "Ask before pulling more than (MB)" (`pullConfirmAboveMb`, 64 to 8192, default 512). The plugin sweeps
  `.ipfs-sync/tmp/` on load only while it holds `publish.lock`.
- The publish engine awaits a fresh lock-token check (`beforeFirstWrite`) right before its first request that can change
  the node, in the CLI and the plugin.

### Changed

- **`.obsidian/` no longer syncs.** The default exclusion list now holds the whole `.obsidian/` folder in place of the
  narrower entries, and `.smart-env/`. The default list's `excludesHash` is now
  `ebd10cbd1cd9776229910af44cc1455550e840ba6aad25e8ba9434b0df32da0f` (before this change:
  `062286b651a2f5a832e1b8913d4e4fcd7dcfd39c081d5eb0bf5f5310962ddc9d`). A pull of a manifest with another hash prints one
  warning and verifies every local file by content. Entries of an old manifest under `.obsidian/` are skipped as expected
  (exit 0) and leave the manifest at the next publish.
- **`.smart-env/` (Smart Connections embeddings) is excluded by default.** Reason, limited to what a desk study read in
  that plugin's source and issues (nothing was installed or run): the plugin queues a re-import 13 seconds after a note
  edit and appends to files in that folder; its README tells third-party sync users to ignore it; its author advised
  against syncing the embedding files. On our side, the idle check (path, size and modification time must all equal the
  record) cannot apply while those files change, and each non-empty publish adds one history file toward the warning at
  1,500 and the refusal at 1,999.
- **`publish --repair` in the "node is ahead" case** is refused ("Run pull first, then publish again.") when a floor
  exists for the vault, when the local state decodes, and for a device with no state and no floor. It remains only for a
  state file that exists, does not decode, and has no floor, behind its confirmation. The "ahead" and fork refusals of
  `publish` now name `pull` and `pull --resolve-fork`; the new-device refusal names `pull`.
- A directory that `pull` populated carries `pulled-fixture`; to publish from it, write `fixture` into
  `.ipfs-sync-fixture` by hand (your statement that it holds no real notes; nothing verifies it).
- `pull` routes by the root: key slots or an encrypted manifest mean the decrypting reader. The plaintext (version 1)
  reader stays behind `--allow-plaintext-v1`, and the encrypted-only flags are refused on a plaintext root.
- The token check moved from `src/plugin/lock-token-check.ts` to `src/sync/lock-token-check.ts` and is shared by the CLI
  and the plugin.

### Security

- A pull detects a replayed older genuine manifest only on a device that already accepted a newer one. A first pull has no
  baseline and trusts what the node serves; a freeze (withheld updates) is not detected. Deleting the per-user directory
  (CLI), the plugin data or reinstalling the plugin removes the floor.
- Someone who holds the vault key can publish a manifest with a very high sequence; every device that pulls it records it
  and then refuses honest, lower manifests. Recovery: delete the floor file and the affected `state.<h>.json` files and
  pull again as a first pull (the floor file holds every vault's floor).
- `--root-cid` and `--manifest` name what the gateway serves; the client does not verify the returned bytes against the
  CID, so authenticity rests on the vault key.
- `.ipfs-sync/tmp/` holds verified plaintext until a file is renamed or swept. A file whose size and modification time equal
  the recorded values is not hashed, so a pull can replace an in-place edit that kept both without a conflict copy.
- On the operator's node an unresolvable name always answers `could not resolve name`, identically for a never-published
  name and for `dht-timeout` of 1 ms, 1 s and 10 s. The publisher's name re-check can therefore detect a move only when
  the name resolves; a routing failure on a vault that already has a published name reads as `not-found` and the publish
  proceeds. It is not a compare-and-swap, and a write race on the shared MFS tree is not detected.

### Known limitations

- Fixture vaults only; nothing here ran inside Obsidian, on a phone, or by the operator against the shared node
  (`mvp-07b`). The plugin dialogs for pull were never opened in Obsidian.
- Large-file pull in the plugin is not advertised as working until the `mvp-07b` operator run records the outcome. The
  CLI streams; the plugin holds up to a 128 MiB budget (a design budget, not a measurement), its transport buffers whole
  responses, and a gateway that ignores Range makes files above 32 MiB `unfetched`.
- Plugin `rename` onto an existing file removes the target first, so it is not atomic.
- A key slot above the default Argon2id cost has no confirmation dialog in the plugin (superseded by the 07b cost dialog above, for manual actions only).
- Paths this device could not restore stay as the node has them in the baseline; the next publish carries them unchanged
  and publishes nothing from this device for them.
- Measured on an iPhone (iOS 27.2 beta, Obsidian 1.13.7 build 365; operator screenshots and reports of 2026-10-02, not
  reproduced by an agent): the release 0.2.0 plaintext pull worked for 5 files (24 KB) and for a 50 MB and a 5 MB random
  file; Argon2id at 64 MiB, t = 3, p = 1 took 980, 1143 and 1133 ms with a longest event-loop gap of 21, 17 and 17 ms in a
  probe build (`0.2.1-probe.1`). The first pull crashed the app once (unexplained); the relaunch loop was an iOS
  file-provider hang cleared by restarting the phone. The encrypted pull has not run on a phone; Android is untested.
  Phone test installs go through BRAT from a GitHub pre-release with its own tag, fixture-only until the guard is removed.

## [Unreleased] - encrypted publish (fixture-only, after 0.2.0)

*History: when this was written the tree was fixture-only; the guard is removed on branch `mvp-07b-guard-removal`
(entry at the top).* Publishing was then encrypted, but the encryption was not independently reviewed to the standard
real notes need and had never been run inside Obsidian (still true). `publish` and `init` accepted only a vault whose
`.ipfs-sync-fixture` file held the text `fixture`. That marker was an accident guard, not a control: anyone who could
create the file could override the refusal. This section describes change
`mvp-06-encrypted-vault-publish` as it stood when it was written; where the section above differs (pull of an encrypted
vault, state format 3, history names with a sequence prefix, the exclusion list, `--repair` in the ahead case), the section
above is current. Nothing here is tagged or released.

### Added

- Client-side encryption of every publish, in the CLI and the plugin. File contents (AES-256-GCM, 8 MiB segments,
  a fresh key per file version), file names (HMAC-SHA256 node names in two-character prefix folders) and the manifest
  (`manifest.enc`, plus one encrypted history copy per publish under `manifests/`) are encrypted on the device. A
  random 256-bit vault key is wrapped by an Argon2id key (64 MiB, 3 iterations, 1 lane by default; floors 19,456 KiB and
  2 iterations; ceilings 131,072 KiB and 4) and stored in the public `keyslots.json` with a key commitment that is
  checked before decryption. The byte formats are in `DESIGN.md` section 8.
- `ipfs-sync abandon <vault> [--yes-abandon] [--mfs-root <path>]` and the plugin command "Abandon this vault" (also a
  button in the settings tab's Encryption section). They move this device's key-slot copy, sync state and journal for
  the MFS root into `.ipfs-sync/abandoned-<h>-<ms>/`. They never contact the node and delete nothing. They record the
  `encrypted-seen.json` latch before moving anything, so abandoning does not re-open the plaintext reader for that
  destination. The CLI takes the cross-process publish lock while it moves files; the plugin took only its in-process
  lock then (it takes the publish lock too since the sixth review round). The CLI asks you
  to type `abandon` on a terminal and does nothing without one unless `--yes-abandon` is given. Refusal messages that
  name the abandon action now quote the command (`src/sync/abandon-hint.ts`).
- `ipfs-sync init <vault> [--passphrase-file <path>]`: the only way to create a vault. It generates the passphrase (23
  random symbols and 2 check symbols, shown in five groups of five). Interactively it shows the passphrase once and
  requires it to be typed again; with `--passphrase-file` it writes a new 0600 file, exclusively, and prints only the
  path. It ignores a passphrase in the environment and refuses a root that has any entry.
- Passphrase sources for `publish`: `IPFS_SYNC_PASSPHRASE_FILE` (0600, owned by you, not a symbolic link),
  `IPFS_SYNC_PASSPHRASE`, or a prompt that does not echo. Setting both variables is an error; there is no
  `--passphrase` flag; a `passphrase` key in a configuration file is rejected. The text is checked for the generated
  form before any request.
- Per-root local state in `<vault>/.ipfs-sync/` (`state.<h>.json`, `journal.<h>.json`, `keyslots.<h>.json`), a
  cross-process `publish.lock` with a 60-second heartbeat, and a copy of `keyslots.json` per MFS root that makes a wrong
  passphrase fail locally (`publish` still sends two read-only requests, `files/stat` and `key/list`, before it unlocks) and lets the tool refuse a substituted slot file before any derivation.
- Interrupted publishes: a journal is written before `manifest.enc`; the next run finishes, adopts or discards it.
  `publish --repair` continues past a behind, ahead, torn-manifest or unreadable-record refusal under stated
  conditions; `--recover-slots` unlocks slots a device knows nothing about after showing their cost;
  `--break-lock` removes the publish lock after a confirmation; `--allow-full-reupload` permits a non-interactive
  re-upload above 256 MiB.
- Plugin: "Clear stale publish lock" (command, and a "Publish lock" section in the settings tab). It is enabled only
  when the lock's last heartbeat is at least 15 minutes old. Clearing holds the plugin's sync lock for its whole
  duration (operation kind `clear-stale-lock`), so it refuses as busy while a publish, pull or abandon runs; it re-reads
  the age and token, moves the file aside, checks the moved bytes and puts the file back if it is not the lock that was
  seen. It does not stop a CLI publish on the same folder. A crash between the move-aside and the discard can leave a
  `.taken` file (a few bytes) in `.ipfs-sync/` that is never cleaned up automatically. A lock file that cannot be parsed
  is not clearable from the plugin; use `ipfs-sync publish --break-lock` on a computer.
- Read-back before publishing: the snapshot is read through its immutable path and checked before `pin/add` and
  `name/publish`, which use exactly the verified root CID.
- A history check before any write: a warning at 1,500 files in `manifests/` and a refusal at 1,999.
- A keyless idle path: an unchanged vault with a record, no journal and a matching root CID returns before unlocking, so
  the plugin's timer does not derive the key on every tick.
- Plugin: setup dialog (generated passphrase, re-entry, no-recovery acknowledgement), unlock dialog with a
  local probable-typo check, an in-memory session, an Encryption section in the settings tab (state and a Lock button),
  and an unlocking indicator that asks you to keep the app in the foreground. The timer never opens a dialog.
- Pull (as of `mvp-06`; the section above supersedes this refusal): detected an encrypted root and stopped with "pulling
  encrypted vaults is not supported yet"; latches that fact in
  `.ipfs-sync/` so a later plaintext manifest for the same destination is refused as a possible downgrade. An
  `abandoned-<h>-<ms>` backup folder also counts as latch evidence: in the CLI, and in the plugin since a correction made
  after review 5c (the plugin's folder key-value store now lists matching folders); the plugin part is covered by
  fake-adapter tests only and has not run in Obsidian.
- Feature-operation script (`tools/feature-op-mvp-06.mjs`, `tools/feature-op-mvp-06/`): records the IPNS pointer of
  `obsidian-vault-sync` before the first change, prints and records the sha256 of `dist/cli/ipfs-sync.mjs` and whether it
  changed during the run, and refuses `--allow-stale-build` on the shared-node path. The lead reported a local stub run
  (121 of 121 checks) and tamper runs; I did not run them. It then ran twice against the shared node on 2026-09-30
  (task 6.2 and the delivery-cadence feature checkpoint; both exit 0, 121 of 121 checks; encrypted layout; publish #2 "1 written, 0 removed" at sequence 2; three kill points
  resumed; refusals sent no mutating request; the hostile-object variants ran against a local stub only; all 42
  mutating requests stayed under `/obsidian-vault-sync/mvp06-demo/<runid>` and the own key; Argon2id 844, 1096 and
  859 ms wall with a largest event-loop gap of 39 ms on the development machine). Consequences: the two runs left two run
  folders (`muo58t8n-ed2e9a64` and `muo6r3gr-8907bcc4`) and their pins on the node, and repointed the IPNS key
  `obsidian-vault-sync`: from the mvp-05 plaintext demo root `/ipfs/bafybeihh4slp53ygsfk454pm4tqjbccd5tu6s6egu37gai2mvfnbw6aa7e` to the first run's root
  `/ipfs/bafybeiec4bfadcs3iaowvg4yiwh66ivnrn3sym4r6h4x4xtw262un5jxwu`, and then to the second run's root
  `/ipfs/bafybeifu652yt23rpx4d4wgzd4rvyehf6xob6m53dzy6rntni2osl6oz3u` (current). Other keys are unchanged. Delivered behaviour differs from the task wording in two places: `--repair` on an older genuine manifest
  (behind) succeeds without a prompt (only ahead and rebuild ask), and the wrong-passphrase refusal sends two
  read-only requests, not none.
- Marker values: `fixture` (you, or `pnpm fixture:generate`) and `pulled-fixture` (written by pull).

### Changed

- **Publish is encrypted only.** Plaintext manifest v1 publishing is removed from the CLI and the plugin. `publish`
  needs the vault passphrase and refuses without one, before any request.
- **New MFS layout:** `current/<xx>/<52-character name>`, `manifests/<rootCID>.enc`, `manifest.enc`, `keyslots.json`. A
  root that holds a plaintext publication from an earlier release is refused; use a new MFS root. The old plaintext
  stays public and pinned.
- **Markers.** `publish` and `init` accept only `fixture`. A marker written by pull now reads `pulled-fixture` and
  `publish` refuses it. A pulled marker written by release 0.2.0 (`fixture copy created by ipfs-sync pull`, empty, or
  `marker`) is refused by `pull` with a message that says the marker predates this version and must be re-marked deliberately.
  `publish` uses that wording only for the pulled-copy text; an empty marker or `marker` gets its generic refusal. It must be re-marked deliberately by writing `fixture` (or, for pull, `pulled-fixture`) into
  `.ipfs-sync-fixture`. The fixture generator writes `fixture`.
- **Pull reads plaintext roots only with `--allow-plaintext-v1`**, never for a destination that has seen an encrypted
  vault, and refuses every manifest path under `.obsidian/` (previously only `.obsidian/plugins/`). The plugin has no
  setting for the flag, so its Pull cannot read a plaintext root.
- The pull demo of release 0.2.0 (publish a fixture vault, pull it into a second vault) no longer works with this tree.
- Local state format 1 (`state.json`, the pull record) is not used by publish; per-root files of format 2 replace it.
- **Release note, CLI host bridge.** Vault writes through `cli/node-host-bridge.ts` now create directories with mode
  0700 and files with mode 0600, via a temporary file. A crash can leave `.<name>.<pid>.<uuid>.tmp` inside a vault
  directory; delete such a file by hand if you find one.
- The plugin's `publish.lock` is created by a check and then a rename (two steps). `createExclusive`
  (`src/plugin/adapter-lock-file.ts`) reads the file back after the rename and compares the bytes, and removes its own
  file if the read-back throws; the token check (then `src/plugin/lock-token-check.ts`, now `src/sync/lock-token-check.ts`) checks the token a second time right after acquisition
  and before the publish starts. There is no check immediately before each write to the node, so a CLI publish and a
  plugin publish can overlap for up to one heartbeat interval (about 60 s) on a platform where rename overwrites. The
  plugin still depends on rename semantics for that window; what `adapter.rename` does in Obsidian is unconfirmed.

### Removed

- Plaintext manifest v1 publishing, in the CLI and in the plugin's Publish command.

### Security

- Anyone with the root CID can fetch the public key slot and guess the passphrase offline, permanently. Passphrases are
  generated (115 random bits plus a 10-bit check) for that reason. A leaked passphrase plus any old slot copy opens every
  state ever published: old roots stay pinned and this project never unpins. Changing the passphrase (not yet
  implemented) would not revoke either.
- The passphrase check catches a mistyped body symbol with probability about 99.9% and a mistyped check symbol always.
  About 1 in 1,024 arbitrary 25-symbol strings passes by chance. Generation-only is a typo guard, not proof that the
  user did not choose the text.
- There is no recovery for a lost passphrase.
- The environment variable, terminal scrollback of the interactive `init` display, and `script` and `tmux` logs can
  expose the passphrase; environment variables are inherited by child processes. The passphrase-file check cannot be made
  on Windows, and Node has no `openat`, so a swap of the file's parent directory between check and open can still misplace
  the file.
- The publisher pins whatever is in `current/` at snapshot time unless its read-back catches it, and does not re-verify
  blobs it did not write in a run.
- `.ipfs-sync/` (state, journal) is plaintext at rest and must be excluded from third-party sync and backups; deleting it
  resets the local state, including the encrypted-seen latch, and leaves the device unable to publish to roots it
  published to before. `abandon` does not reset the latch.

### Known limitations

- Fixture vaults only. Encryption is implemented but not independently reviewed to a standard that permits real notes
  and has never been run inside Obsidian. Reviews 0.1, 0.2, 2, 2b, 3, 3b, 4-1, 5, 5b (delta check of the split
  feature-operation script) and 5c are done; each was a static read by one model, and the cross-model judge was not run.
  Review 5 re-read the review 4-1 fixes (C-01 to C-08) statically. Review 5c re-read the review-5 fixes R5-01 to R5-08
  the same way, with nothing executed. The corrections made for its findings (C5-01, C5-03, C5-04, C5-05) have not been
  re-read by a reviewer, and C5-02 is open (below). There is no in-app run and no run with a real vault; Argon2id was
  timed on an iPhone in a probe build after this entry was written (see the section above). The feature-operation script ran twice against the shared node (see "Added"); kubo `files/write`
  overwrite semantics beyond what it exercised, and whether kubo reads `arg` from a POST body, remain unverified.
- Terminal restore of the passphrase prompt is shown only in tests with injected streams (Ctrl-C, Ctrl-D, a 257th byte,
  end of input, a failure to enter raw mode). Restore on `SIGTERM`, `SIGHUP` and `SIGTSTP` is unverified.
- Deferred to `mvp-07b`: W-14, W-15, W-16 and `prune-history` are preconditions for removing the fixture guard. The
  release tooling does not yet call `checkDistBundles` (N2-13); that blocks Release 2.
- Changing the passphrase, adding key slots, and `ipfs-sync prune-history` do not exist yet (pulling an encrypted vault
  does now; see the section above). At 1,999 history files publishing to that root stops; the way on is a new MFS root
  and a new vault.
- The plugin cannot repair or recover slots; use the CLI. It can clear a publish lock that is at least 15 minutes stale,
  but not one it cannot parse. `--break-lock` deletes a live lock if run while a plugin publish is running. The setup,
  unlock, abandon and clear-stale-lock dialogs have never been run inside Obsidian. After an abandon, a second Publish
  can open a second unlock dialog over the first; this is cosmetic and accepted.
- Open (C5-02): the plugin's lock token is not re-checked immediately before each node write; only the heartbeat
  (every 60 s) notices a replaced lock file. See "Changed" above.
- The pull notice for a vault with other files now says "no files outside .obsidian/ and .ipfs-sync/"; it previously
  named only `.obsidian/`.
- Obsidian's `requestUrl` buffers whole response bodies, so the size caps give no memory protection inside the plugin.
- A restore that preserves file modification times and sizes is missed by the delta and idle paths.
- Rollback and freeze by an open-write node are not detected.
- Two devices publishing to one root are not supported.

## [0.2.0] - 2026-09-30 (fixture-only pre-release, plaintext)

**Release 1 is fixture-only. It must not be used on real notes.** It has no encryption. It syncs
synthetic fixture vaults only (a vault marked by a `.ipfs-sync-fixture` file), refuses any other vault,
and everything it publishes to your kubo node is readable by anyone who obtains the CID.

Tagged `v0.2.0` and published as a GitHub pre-release. The in-Obsidian demonstration that defines the release (a pull
with a real conflict in Obsidian desktop on macOS) is not recorded in this repository.

### Added

Increment mvp-01, configuration, auth, shared client, CLI:
- `ipfs-sync status`: node identity, MFS listing, gateway fetch, write probe and key state.
- Separate RPC (write) and gateway (read) endpoints, each with URL and optional port. Auth schemes: none,
  basic, bearer (static token or JWT), custom header. Flags override `IPFS_SYNC_*` environment variables,
  which override the config file; the config file rejects secrets.
- Node-safety checks: MFS root confined to `/obsidian-vault-sync`, publication key name pattern
  (`^obsidian-vault(-[a-z0-9-]+)?$`), and the fixture-vault guard.
- One shared kubo client (`src/kubo`) used by the plugin and the CLI. It works around the node's quirks:
  arguments in the query string, `files/write` as multipart with field `data`, `name/resolve` with
  `nocache=true`.

Increment mvp-02, manifest and delta publish:
- Manifest v1 with per-file sha256 and an `excludesHash`; change detection by size/mtime pre-filter, then sha256.
- `ipfs-sync publish <vault>`: sends only changed files to `<mfsRoot>/current/`, verifies each write,
  pins the MFS root, stores `manifest.json` and `manifests/<cid>.json`, and publishes the root CID to the IPNS key.
- Project-owned IPNS key `obsidian-vault-sync`, created only when absent and recorded under `ownedKeys`.
  A foreign key is refused unless its ID is passed with `--owned-key`.
- One shared exclusion list. Defaults: `.trash/`, `.ipfs-sync/`, `.ipfs-sync-fixture`, `.DS_Store`,
  `.obsidian/workspace.json`, `.obsidian/workspace-mobile.json`, `.obsidian/workspace.json.bak`,
  `.obsidian/graph.json`, `.obsidian/cache`, `.obsidian/plugins/` (whole folder, so plugin code and
  plugin data stay on the device), `.obsidian/plugins/ipfs-sync/data.json`, `node_modules/`, `.git/`.
- Synthetic fixture vault generator: `pnpm fixture:generate <dir> [--seed <n>]`.

Increment mvp-03, delta pull and conflict policy:
- `ipfs-sync pull <vault>`: resolves the IPNS name, reads the manifest through the gateway, and fetches only
  missing or changed files. Each file is hashed against the manifest and renamed into place only on a match.
  Options `--name`, `--manifest <cid>` (restore an earlier snapshot) and `--manifest-file <path>`.
- Conflict policy: remote becomes canonical; a local file that differs from both the last synced state and the
  remote is kept as `name (ipfs conflict YYYY-MM-DD).ext`. Pull never deletes local files; remote deletions are reported only.
- Pull path policy: manifest paths that are absolute, contain `..` or empty segments, backslashes or control
  characters, lie inside `.ipfs-sync/` or `.obsidian/plugins/`, or match the exclusion list are refused and
  counted as failed. The CLI also refuses to write through a symbolic link.
- CLI destination guard: pull writes only into an absent, empty or marked directory.

Increment mvp-04, plugin publish and settings:
- **IPFS Sync: Publish vault** command, ribbon icon and status notice, on the same publish engine as the CLI.
  Publish requires the fixture marker.
- Settings tab: RPC and gateway URL and port, publication key, MFS root, auth scheme with per-scheme fields,
  exclusion list editor, owned-key display and adopt-by-ID with a confirmation dialog, optional auto-publish interval.
- Settings migration from the old flat settings; the old default key name `obsidian-vault` maps to `obsidian-vault-sync`,
  and an existing foreign key is never adopted implicitly.
- Node requests go through Obsidian's `requestUrl`, because the node's CORS rules block the WebView's `fetch`. (Since the
  ninth round this holds on mobile only; desktop uses Node's `http` and `https`.)

Increment mvp-05, plugin pull and conflict:
- **IPFS Sync: Pull vault** command and a Pull ribbon icon, with progress in a notice and the status bar and a
  summary of fetched, unchanged, conflict, failed and remote-deletion counts. It names up to three conflict copies and says
  "incomplete" when any file failed. Pull is read-only against the node.
- Same pull engine as the CLI: same verification, atomic writes, conflict copies and path policy.
- Pull target: the **pull name** setting (an IPNS key ID; `/ipns/` prefix accepted), else the ID of the owned
  publication key, else the pull stops and tells you to set a pull name.
- Destination guard for the plugin: Pull writes only into a vault that has the fixture marker or no files outside
  `.obsidian/` and `.ipfs-sync/` (the marker is then created). Any other vault is refused before any request.
- Every open editor is saved before files are compared, so an edit that exists only in the editor is treated as a local edit.
- Publish and Pull do not run at the same time in one vault.
- **Catch up on load** setting (per device, off by default): one pull after the workspace layout is ready.
- **Read cap** setting: default 64 MB per file, 8 to 1024. A file above the cap fails by name; other files continue.
- Settings show the last pull and last publish (counts, CIDs, timestamps only).
- Settings model moved to version 3, migrating from version 2 without changing existing values.

### Changed

- Build tooling is pnpm (`pnpm build`, `pnpm dev`, `pnpm test`, `pnpm typecheck`); `package-lock.json` is gone. Node 24.15 or later.
- `pnpm build` writes the plugin to `dist/plugin/` and the CLI to `dist/cli/ipfs-sync.mjs`; it does not write into a vault.
  `pnpm dev` writes into a vault only when `OBSIDIAN_PLUGIN_DIR` is set.
- Default publication key is `obsidian-vault-sync`, default MFS root `/obsidian-vault-sync/default`.
- The plugin's own `data.json` (which holds credentials) was added to the default exclusions, which changes the `excludesHash`.
- The `kubo-rpc-client` dependency was replaced by a small fetch-based caller behind the same client interface.
- Minimum Obsidian version is 1.12.3.
- The project is MIT licensed (copyright KnowMe AI, LLC).

### Removed

- `scripts/publish.sh`, `scripts/pull.sh` and `scripts/excludes.txt`. Use `ipfs-sync publish` and `ipfs-sync pull`.
- The plugin's old whole-archive pull and its `ipfsRequest()` helper.

### Known limitations

- No encryption. Fixture vaults only; other vaults are refused. Everything published is readable by anyone with the CID.
- The plugin cannot detect symbolic links: Obsidian's file adapter has no `lstat`. Do not place symlinks in a synced vault.
- Per-file read cap (64 MB by default, 8 to 1024 MB configurable); files are read whole, so large files cost memory.
- Remote deletions are not applied on pull; they are reported and the local file stays.
- Plugin writes replace an existing file by removing it and then renaming a temporary file, which is not atomic.
  A crash in that window could leave the file missing until the next pull. Untested.
- Mobile is not verified. Windows and Linux are not verified. The demonstration target is Obsidian desktop on macOS, and it has not been recorded yet.
- An authenticated (auth-protected) kubo endpoint has not been exercised with the plugin.
- Requires Obsidian 1.12.3 or later.
- Snapshot sync only: no multi-writer merge, no history browser, no AI layer.

## [0.1.0]

Version in `manifest.json` before this work. Not documented in detail here.
