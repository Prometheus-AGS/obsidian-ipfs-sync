# Assessment: Smart Connections (brianpetro/obsidian-smart-connections) against IPFS Sync

Date: 2026-10-02. Read-only desk study. Nothing was installed or run.

Evidence tags: **[E]** read in source or issue text, with a location. **[I]** inference from evidence. **[?]** could not confirm.

Sources read (shallow clones in the session scratchpad, default branch HEAD on 2026-10-02):
- SC = obsidian-smart-connections `0a182cf`, plugin v4.7.2 (manifest.json:6-8 gives minAppVersion 1.8.7, isDesktopOnly false).
- ENV = obsidian-smart-env `d0c49f4` and JSB = jsbrains `5e93a61`. SC's package.json pins its dependencies as `file:../` siblings and one jsbrains commit (`ba80525`), so the SC repo alone holds only about 10 percent of the behaviour (src/main.js plus UI). The engine is in ENV and JSB. The HEADs I read may be newer than the code in the shipped 4.7.2 release. [?] which ENV/JSB commits 4.7.2 shipped.
- GitHub issues #1301, #1243, #1058, #1032 of the SC repo (read through `gh`).

---

## 1. Verdict, and the uncomfortable finding

**Verdict.** Smart Connections is the closest shipping thing to our planned "AI layer", and it tells us three things. (a) Local ONNX embeddings do run in an Obsidian mobile WebView, but only behind an explicit user tap, and at least one user report shows an iOS crash loop with it. (b) Its author advises against syncing the embedding store and tells third-party-sync users to exclude `.smart-env/`. Our plan says the opposite (embeddings ride the snapshot). (c) Our current exclusion list does not exclude `.smart-env/`, so a user who simply has Smart Connections installed would publish its whole index to the node. No change is needed to our core crypto, pull-budget or path-policy design. The changes needed are at the edges: exclusions, publish guards, docs, and the AI-layer plan.

**The uncomfortable finding: the hidden-directory hole plus the history cap.** Our scanner walks every directory the host lists, hidden or not, and skips only `DEFAULT_EXCLUSIONS` (src/sync/scan.ts:16-23; src/sync/exclusions.ts list: `.trash/ .ipfs-sync/ .ipfs-sync-fixture .DS_Store .obsidian/ node_modules/ .git/`). `.smart-env/` is not on it. Nothing in our DESIGN, specs or openspec mentions `.smart-env` or Smart Connections (grep over DESIGN.md, docs/, openspec/, README.md returned nothing). [E]

What follows, in order of how much it hurts:

1. SC rewrites that directory continuously. It appends to an `.ajson` shard and to a binary vector file after every re-import (13 s debounce after a note edit, ENV-side save debounce 750 ms during embedding). [E] A vault with SC running therefore never matches our idle fast path (path, size and mtime must all equal the recorded manifest, src/sync/idle-check.ts:30-40). [E for the rule, I for the consequence] Every auto-publish tick becomes a non-empty publish.
2. Every non-empty publish adds one pinned `manifests/<rootCID>.enc` of 4 to 14 MB (DESIGN §8.7 "History growth"), warns at 1,500 and refuses at 1,999, and `prune-history` does not exist yet. [E] With a 15-minute timer that is 96 publishes a day, so the 1,999 refusal arrives in about 21 days. At 14 MB each that is roughly 28 GB pinned on the node. [I: arithmetic on the cited numbers; the timer value is an example]. This turns an SC install into a publish outage that the user cannot self-repair until mvp-07b / prune ships.
3. Our blob is the whole file. A changed 50-150 MB vector file is re-encrypted and re-uploaded in full each tick. [E: DESIGN §8 "Blob" row; a modified file is a new blob] SC does append-in-place (`append_binary`, ENV src/modules/embeddings.js:1124-1126), which our format cannot exploit.
4. On the second device the pull would write A's shards and vector file over B's live SC state. SC loads vectors into memory at startup and only appends, so B's SC and A's files diverge silently. [I] SC's author names exactly this class of problem (see 2.4).

The second uncomfortable item concerns the AI layer itself: docs/006-embedded-stores.md ("embeddings ride the vault snapshot") and docs/005 ("embeddings for the current snapshot were synced down with the vault") assume the thing SC's author calls problematic, and assume ONNX embedding on a phone, which SC treats as opt-in and which crashes for some iOS users. See sections 2.4 and 5.

---

## 2. Findings by question

### 2.1 Mobile: embeddings and storage

- **Runtime.** Embeddings run in a Web Worker created from a Blob URL (`new Worker(url, {type:'module'})`, ENV src/adapters/embedding-model/transformers_v4_worker.js:265-267). The worker source is bundled as text (`'.worker.js': 'text'`, ENV build/build_plugin.js:228). [E]
- **ONNX runtime and WASM are not bundled.** The worker does `import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0')` at first load (ENV src/adapters/embedding-model/transformers_v4.worker.js:4, 92). SC's esbuild marks `@huggingface/transformers` and `@xenova/transformers` external (smart-connections/esbuild.js:19-20). `allowLocalModels=false`, `useBrowserCache=true` (worker.js:94-96). Models come from the Hugging Face hub (issue #1346 quotes a 404 on `huggingface.co/Xenova/multilingual-e5-small/resolve/main/onnx/model_q1f16.onnx`). So first use needs the network to jsDelivr and Hugging Face; later runs depend on the WebView Cache API. [E] Whether iOS evicts that cache is [?].
- **Backend choice.** It tries WebGPU if `navigator.gpu.requestAdapter()` succeeds, otherwise WASM (worker.js:62-80 region, `load()`). Batch size is 16 on WebGPU and 8 on CPU, capped at 16 (transformers_v4_worker.js:4-7, 170-189). Default model `TaylorAI/bge-micro-v2`, 384 dims, 512 tokens; the catalog also has 768-dim DenseOn (transformers_v4_worker.js:9-115). [E]
- **Model download size and on-device footprint.** [?] Not stated anywhere in the repos I read. The runtime is fetched from a CDN, so there is no size in the plugin bundle either. I did not look up Hugging Face file sizes.
- **Mobile is opt-in at load time.** On mobile `before_load()` returns false and shows a notice "Smart Environment loading deferred on mobile" with a "Load Smart Environment" button (ENV smart_env.js:195-205). The load starts only on that tap or from a settings tab or status view (`start_mobile_env_load`, smart_env.js:392-411). [E] Desktop loads at `onLayoutReady` (smart_env.js:139-149). `manifest.json` still says `isDesktopOnly: false`, and the README says "Works on mobile devices" and answers the FAQ "Does it work on mobile?" with "Yes". [E]
- **Mobile storage tuning.** The only `Platform.isMobile` data-layer switch I found: the maximum bytes per `.ajson` shard is 8 MiB on mobile and 64 MiB on desktop (ENV src/adapters/data/ajson_sharded_sources.js:13-16). [E] Other `isMobile` uses are UI only (status bar, story modal, view placement). [E]
- **Memory behaviour.** Vector files are loaded whole into `Float32Array` (embeddings.js `prepare_vector_file`/`load_vectors`, 813-872); appends go through a reserve-capacity step capped at 16 MiB headroom (embeddings.js:19, 875). The full set of source records is replayed into memory at load (ajson_sharded_sources.js `process_load_queue`, 213-267). [E] I found no memory ceiling or low-memory mode. [?]
- **Known mobile limitations (issues, all open).** #1301: on iPad and iPhone, after tapping Load, the app relaunches about 8 seconds later and shows the deferred notice again, in a loop. The author's only response in the thread is a guess (irregular imported notes, resource limits) and no fix. [E] #1032: the mobile toggle does not stay on. #794 and #829 are other mobile hang and "disable on mobile" requests. [E titles only] #1243: after installing on mobile, a user's plugins were deactivated on desktop and then on iOS (cause not established; only one user's report). [E report, [?] cause]

### 2.2 Data layout on disk

- **Location.** `.smart-env/` in the vault root (JSB smart-environment/default.config.js:7; the directory is auto-detected by the presence of `smart_env.json`, smart_env.js:521-543). [E] Obsidian's vault index does not list dot-folders, so SC reaches it through the raw adapter (`obsidian_adapter.append/appendBinary`, ENV src/adapters/smart-fs/obsidian.js:~55-65). [E]
- **Files.** `smart_env.json` (settings); `smart_sources.ajson` plus `smart_sources_N.ajson` shards, append-only, last valid record per key wins, replayed in numeric shard order (ajson_sharded_sources.js:22-64); a binary vector file per model fingerprint named `mf_<hash>` (no extension), raw Float32 rows, one row per source or block (embeddings.js:348-364, 1098-1160); `.tmp` files (`<path>.tmp`, embeddings.js `write_vectors_file`), and `.optimize.tmp` / `.backup` files during the user-triggered "optimize/compact" (ajson_sharded_sources.js:549, 609, 666-691). A legacy per-note layout under `multi/` is migrated on load (lines 30-32, 229-232) and is built on `ajson_multi_file.js` in JSB smart-collections. [E] Secrets are in Obsidian `secretStorage`, not in the vault (ENV src/adapters/smart-secrets/obsidian.js). [E]
- **Sizes.** Vector row = dims x 4 bytes: 1,536 B at 384 dims, 3,072 B at 768. [E for the formula, dims from the model catalog] A 10k-source vault is about 15 MB for sources alone, which matches our docs/006 estimate. [E] Block-level vectors are written by the same module (`this.env.smart_blocks?.embeddings`), so rows can be several times the source count. The block count per note is [?]; at 10 blocks per note the file is about 150 MB [I, illustrative]. Shard cap is 8 MiB mobile and 64 MiB desktop, so a large vault has many shard files [E for the cap, I for the count].
- **Update frequency.** A modify, create, rename or delete event on a vault file (and `editor-change`) queues a re-import; the queue runs after a 13 s wait by default (`re_import_wait_time`, JSB smart-sources/smart_sources.js:222-226; events at ENV src/adapters/smart-fs/obsidian.js:335-370). Saves are debounced 750 ms (JSB smart-collections/collection.js:26, 588-591), and embedding checkpoints flush every 1,000 items (embeddings.js:18). [E] So while a person types, the files change about every 13 to 20 seconds. [I]
- **Sync-conflict handling.** (a) SC waits for Obsidian Sync: after load it sleeps 3 s and then polls `internalPlugins.plugins.sync.instance` until it is not syncing (ENV smart_env.js:595-615). [E] (b) README FAQ "Syncthing and third party sync": "add the `.smart-env/` directory to its ignore patterns to avoid conflicts" (README.md:383). [E] (c) It adds `.smart-env` to `.gitignore` for new users when a `.gitignore` exists (src/main.js:86, 224-231). [E] (d) Issue #1058: the author says "I recommend against syncing the embedding files … a lot of data (often gigabytes, depending on vault size and embedding model) that's updated frequently", and that the real problem is handling "when data [is] synced, which may be after the Smart Environment was loaded". He also says Obsidian Sync does not sync dot-folders (user's statement, author did not dispute it). [E] (e) Per-file append-only ajson plus a numeric shard order and last-record-wins is a merge-friendly log, but it is within one device's file set; I found no cross-device merge. [E for the log, [?] for any merge logic]
- **Which of our mechanisms this touches.**
  - Exclusion list and the "`.obsidian/` no longer syncs" decision (07a 1.3): the decision is right but incomplete; hidden tool directories other than `.obsidian/` are not covered.
  - Manifest limits: 100,000 entries and 8 MiB of path bytes (DESIGN §8). A vault that still holds SC's legacy `multi/` directory is one file per note [I], so it can add as many entries as there are notes. Normal SC layouts add tens of files. [I]
  - Path policy: `.smart-env/...` passes every rule I read (no dot-segment rule applies to a name that merely starts with a dot; `mf_<hash>` has no reserved or platform-unsafe shape). [E for the rules read in path-policy.ts:1-70, I for the conclusion]
  - mtime shortcut: (size, mtime) equal means no hash (DESIGN §8.7 "Delta detection"). An appended file changes size, so it is hashed in full, which is 64 MiB of SHA-256 per shard on desktop and a vector file of tens of MB on a phone. [I: cost not measured]
  - Conflict copies: our name format is `<stem> (ipfs conflict DATE).<ext>` (src/sync/conflict-name.ts:23-32). SC's loader only accepts `smart_sources.ajson` and `smart_sources_<N>.ajson` (ajson_sharded_sources.js:54-64), so a conflict copy would be ignored by SC and sit as junk. [E for both, I for the net effect] A conflict copy of the extensionless `mf_<hash>` file would be named `mf_<hash> (ipfs conflict …)`, which SC would also ignore. [I]

### 2.3 Plugin architecture lessons

- **Startup.** SC's `onload()` is synchronous: it schedules `initialize` on `onLayoutReady`, creates the env, registers a settings tab and views, and returns (src/main.js:55-61). The env itself loads in `onLayoutReady` (ENV smart_env.js:139-149) and, on mobile, only after a tap. A further `setTimeout(3000)` and the Obsidian Sync wait precede loading the collections (smart_env.js:595-598). [E] Our `onload` is async and awaits `openSettingsStore` and `this.refreshSession()` before returning (src/plugin/index.ts:55, 73), but the only session work found is a local key-slot existence probe (`vaultExists`, session-keys.ts:214-216) [E for the call, [?] that `hasLocalKeySlots` makes no network request; I did not read it]. Our catch-up already uses `onLayoutReady` and defaults to off (index.ts:127-130, settings-model.ts:116). [E]
- **Off the main thread.** Embedding runs in a worker with a message adapter; `terminate()` plus Blob URL revoke on unload (transformers_v4_worker.js:288-306); queue sort-by-length and batch windows of 64 (lines 191-199). Our heavy work is Argon2id on the main thread with a 10 ms yield (DESIGN §8 Argon2id row), which was measured at about 1 s on an iPhone. Not a problem today, but it is the same pattern SC chose a worker for.
- **iOS launch watchdog.** SC avoids all heavy init at launch on mobile; the one user-visible cost at launch is a notice. The crash reports (#1301) show that even deferring does not protect after the user taps. Our iPhone log (0x8BADF00D scene-create, file-provider hang, cleared by restart, trigger unexplained: device-results.md:9) was a file-provider hang on an iCloud vault, which is a different mechanism. A plugin that writes thousands of small files into an iCloud-backed vault at launch would be a plausible trigger [I]; SC's `multi/` legacy layout and our own pull both do that. Not tested.
- **Settings and updates.** Versioned settings migrations at load (`run_migrations()` in before_load, migrate_* in src/main.js:89-93); a release-notes view on version change (main.js:151-); items carry a `version` per component (smart_env.config.js). [E] We already have settings-migration.ts.
- **Release and distribution.** Releases go through a GitHub Actions `workflow_dispatch` that takes the exact SHAs of the two dependency repos, optional `--draft`, and asks for artifact attestations (.github/workflows/release.yml:1-40). `prerelease: false` in ENV build/release_runner.js:197. [E] I found no BRAT beta channel or pre-release tags in these files. [?] whether the author uses BRAT betas; not evidenced. The idea worth copying is the release workflow's pinning of dependency SHAs and attestations, which fits our "verify against official sources" rule. Our `tools/release` hard-codes 0.2.0 (reflection.md) and that remains the real gap.
- **Unattended background sync on iOS.** SC offers no pattern. It has no background work: it embeds only while the app is in the foreground and exposes a pause control. [E for no background API; I for "so nothing to copy"]. The closest transferable pattern is "check that another syncer is idle before touching shared files" (the Obsidian Sync wait), which we already have as `publish.lock` and the in-process lock. [E]

### 2.4 Interaction risks if SC runs in the same vault

Limits for reference (src/sync/pull-budget.ts:11-27): SEGMENT_MEMORY_BUDGET 128 MiB, WHOLE_BODY_LIMIT 32 MiB, PULL_CONFIRM_ABOVE_DEFAULT 512 MiB, plugin minimum segment exponent 20, concurrency up to 6. Manifest: 100,000 entries, 64 MiB envelope. Full re-upload above 256 MiB needs a flag.

| Our mechanism | What SC does | Effect | Basis |
|---|---|---|---|
| Publish scan (scan.ts) | `.smart-env/` is not excluded | Index published with the vault; each tick re-uploads changed shards and the vector file in full | E (both), I (effect) |
| Idle fast path | files change every ~13 s of editing | Never idle while SC is active, so every timer tick is a real publish | E rule, I consequence |
| History cap 1,500 / 1,999 | see above | Cap reached in weeks; publish refused; no prune command | E numbers, I projection |
| Full re-upload guard (256 MiB) | a vault with a 150+ MB index | First publish of a SC vault is large; a changed vector file re-uploads whole | I (size unmeasured) |
| 32 MiB single-request write; plugin per-segment write | vector file above 32 MiB | Chunked per segment, fine | E for the rule |
| WHOLE_BODY_LIMIT on pull | vector file above 32 MiB, gateway ignoring Range | File becomes `unfetched`; a half-pulled index set | E rule, I interaction |
| PULL_CONFIRM_ABOVE 512 MiB | index of several hundred MB | First pull on a second device trips the confirmation purely because of the index | I |
| SEGMENT_MEMORY_BUDGET 128 MiB | SC keeps all vectors in a `Float32Array` plus a loaded ONNX model on the same phone | Combined pressure on one WebView process; the 128 MiB was sized with Argon2id and our pull only | I, not measured. #1301 is evidence SC alone can kill the app on iOS |
| Drift guard / conflict copies | B's SC has local `.smart-env`; A's version arrives | Remote wins, B's file kept as conflict copy that SC ignores; B's SC state is now A's, in memory still B's | E for naming, I for state mismatch |
| Delete strays | SC deletes/renames its own `.backup`, `.tmp`, shard files | A published `.tmp` or `.optimize.tmp` mid-operation; a pull that deletes strays removes files SC expects (only if we ever delete; "never delete local files in 1.1" in DESIGN §4.3 still holds) | E for SC temp names, I for risk |
| Pulled-file events | our pull writes notes through the adapter; SC listens to `vault` create/modify and re-embeds each one after 13 s | Not corruption: a pull of N notes triggers N re-imports and embeddings on a phone right after the pull | E listeners, I load |
| Our `.ipfs-sync/` and `.ipfs-sync/tmp/*.part` plaintext | SC ignores dot-folders as sources: `add_ignore_pattern('**/.*/**')` (JSB smart-fs/smart_fs.js:157-158) | No indexing of our temp plaintext or state | E |
| Fold collisions / path policy | SC names are ASCII, case-stable | None expected | I |
| Atomic temp rename | SC uses `.tmp` then replace for whole-file writes (embeddings.js:1157-1161) | If we snapshot between the write and the replace, we publish the old file and a stray `.tmp` | E pattern, I timing |

The most consequential item is a consistency risk, not a performance one. The ajson record for a source refers to a row in the vector file by index (`file`, `file_i` refs, embeddings.js:~520-600). Publishing the two files at different instants (our scan is not atomic across files) can give a pair that does not match; the loader validates shape (`Invalid vector file shape`, line 582) but I did not find a cross-file consistency check. [E for the refs, I for the risk]. This is a strong reason to exclude the directory rather than try to sync it.

### 2.5 Facts we should keep that SC confirms

- Doing nothing at launch except registering, then working in `onLayoutReady`, is the standard pattern (SC does this; so do we for catch-up).
- A hidden directory is a first-class sync hazard; the author documents it in the README FAQ.
- WASM/ONNX in a WebView works for most users but needs a network fetch for runtime and models on first use, and it can crash iOS for some.

---

## 3. Recommended changes (ranked), each tied to a task or section

Nothing below is code. "Decision" means a spec or design edit by the owning role.

**R1. Add `.smart-env/` to the default exclusion list in the same release that drops `.obsidian/`.** Tie: mvp-07a task 1.3 (the `.obsidian/` exclusion and `excludesHash` change) and the exclusion text in src/sync/exclusions.ts's doc and DESIGN §4/§8. Reason: it costs no additional `excludesHash` warning round if done together (old manifests warn once anyway, DESIGN/6.2 text), whereas doing it later forces a second warning on every device. The pull side already treats an excluded path in an old manifest as `expected` and skips it (path-policy.ts header). Evidence: 2.2, 2.4. Owner: ipfs-engineer (list), documentation-specialist (6.2 text). Priority: highest; it is a few lines and it closes the history-cap and consistency risks.

**R2. Document the Smart Connections case in the 6.2 documentation task.** Tie: 07a task 6.2 ("must state" list) and docs/operator/encrypted-vault.md. State: SC (and any plugin that keeps a large index in a hidden directory) keeps its index per device; `.smart-env/` is excluded by default; a user who removes the exclusion takes on the history growth and consistency risk; with SC the user should expect SC to re-index pulled notes on the device. Owner: documentation-specialist.

**R3. Add a publish-time advisory for large hidden directories not on the exclusion list.** Tie: 07a task area for `adviseUnrestorablePaths` / publish-plan advisories (publish-plan.ts), or 07b. A warning (never a refusal) when a top-level dot-directory holds more than a stated number of files or bytes, naming it and offering to add it to the extra exclusions. This catches `.space`, `.makemd`, `.smart-connections` (an older SC folder name; only inferred from the SC repo's own .gitignore) and anything else. Thresholds are a decision for product-manager; I have no data to propose numbers. Owner: product-manager (spec), ipfs-engineer.

**R4. Reconsider the auto-publish cadence versus history growth before 07b closes.** Tie: 07b (history, prune) and DESIGN §8.7 "History growth". Even with R1, any busy plugin or a typist creates a non-empty publish every tick. Decision needed: either `prune-history` ships in 07b ahead of Release 2, or auto-publish coalesces (publish only when changes are quiet for N minutes), or the refusal text gets an interim recovery. SC's 13 s quiet period before re-import is an existing, shipping example of a quiet-period rule (smart_sources.js:222-226). Owner: product-manager / ipfs-engineer.

**R5. Rewrite the AI-layer assumption "embeddings ride the snapshot" before the data-engineer builds on it.** Tie: docs/005 lines ~99-101 and open question 4, docs/006 "Non-negotiable design rule" and "Build/update pipeline" step 1, DESIGN §7. SC's author reports that syncing mutable embedding files is the hard part. Our own design differs in an important way: an immutable per-snapshot index keyed by content hash, not an in-place append log, and that avoids "data synced after the environment loaded" only if the loader treats the index as a cache it can ignore or rebuild. Decision needed: state explicitly that the index is optional and a device may rebuild instead; state the size budget (rows x dims x 4 bytes; 10k notes x 10 blocks x 384 dims is about 150 MB, which crosses WHOLE_BODY_LIMIT and is a third of PULL_CONFIRM_ABOVE) and that blocks are not embedded by default on mobile. Owner: data-engineer with product-manager.

**R6. Make local embedding on a phone explicitly opt-in and user-initiated in the AI-layer plan, and plan an iOS-crash gate.** Tie: docs/005 "Disconnected operation" scenario, mvp-08 PGlite plan (WASM memory in the same WebView), DESIGN §7, and the 07b operator run (7.1/7.2). Evidence: SC defers load on mobile (smart_env.js:195-205) and shows a crash loop in #1301. Our mobile-feasibility run measured Argon2id only (reflection.md); no ONNX or PGlite run exists on a phone. Add to the AI-layer acceptance: a device run that loads PGlite plus the model together on an iPhone with a vault of realistic size, measuring peak memory, before the airplane-mode scenario is promised. Owner: data-engineer, bdd-engineer.

**R7. Treat first-use network fetch as part of the "disconnected" claim.** Tie: docs/005 acceptance scenario. SC fetches the ONNX runtime from jsDelivr and models from Hugging Face on first load and then relies on the browser cache (2.1). "Airplane mode, phone only" is true only after a successful online first run and only while the WebView cache persists; docs/006 already says iOS can evict IndexedDB, and the Cache API is the same class of storage [I]. Decide whether to bundle model and runtime into the vault or plugin (size and WASM-in-bundle questions) or to state the first-run requirement. Also relevant to the CSP and "no remote code" posture in our rules: SC imports executable code from a CDN, which we should not copy. Owner: data-engineer, security-reviewer.

**R8. Guard against a pull that rewrites files another plugin has open.** Tie: 07a task 5.3 (plugin pull runner) and the pull presenter. SC re-embeds every pulled note 13 s later (2.4). On a phone that is a burst of CPU right after a pull. Not a correctness issue, so docs only (fold into R2), but note it for the 07b operator run: observe a pull with SC installed. Owner: documentation-specialist, bdd-engineer.

**R9. Make the iCloud launch hang a tracked risk for any plugin that writes many small files.** Tie: reflection.md "Uncomfortable findings" (first crash unexplained) and 07b 7.1. SC's legacy `multi/` layout and our own `.part` temp files both create many small files in an iCloud-backed vault. No evidence ties SC to the hang. Record as an untested hypothesis only. Owner: workflow-lead.

**R10. Copy the "release by pinned SHAs with attestations" practice into the CI task.** Tie: mvp-10 (Release 3) and the release-deployment-lead's CI work. SC's release workflow takes dependency SHAs as inputs and attests assets (.github/workflows/release.yml). Our `tools/release` hard-coded 0.2.0 is already a known gap (reflection.md). Owner: release-deployment-lead. Low priority.

### Things that need NO change, and why

- **Argon2id parameters and the HTTPS/requestUrl transport.** SC does not use either; nothing in it contradicts our measured ~1 s and the 50 MB plaintext pull. (Not a validation of memory above 50 MB, which remains unmeasured.)
- **SEGMENT_MEMORY_BUDGET 128 MiB, WHOLE_BODY_LIMIT 32 MiB, PULL_CONFIRM_ABOVE 512 MiB.** These are sized for notes and attachments. SC data is the only thing in this study that stresses them, and R1 removes it from the default path. Retuning them for an index we exclude would be speculative.
- **Path policy, fold collisions, symlink guard.** SC's names pass; no rule needs to change.
- **`.ipfs-sync/` exclusion and the `tmp/*.part` plaintext.** SC's source scanner skips all dot-folders (smart_fs.js:157-158), so it will not index our plaintext temp files or state. The existing exclusion is correct.
- **Catch-up on load default off; `onLayoutReady` scheduling.** Matches SC's startup discipline. Keep.
- **Foreground-only sync, no background-fetch claim.** SC does no background work on iOS either; there is nothing to adopt, and our "All foreground" triggers (DESIGN §4.3) stay accurate.
- **Pulling remote-wins with a conflict copy and never deleting local files.** Safe against SC: conflict copies of SC files are ignored by its loader (2.2). The risk is solved by exclusion, not by changing the conflict policy.

---

## 4. What I did not verify

- Model and runtime download sizes; WebView cache eviction behaviour; real vector-file and block counts for a typical vault.
- Whether the SC 4.7.2 release matches the ENV and JSB HEADs I read.
- Whether a BRAT beta channel exists for SC.
- Root cause of #1301 and #1243; I report them as user reports only.
- Anything about Android (SC or ours).
- Any behaviour at runtime. No SC code was executed, and none of our tests were run for this assessment.
