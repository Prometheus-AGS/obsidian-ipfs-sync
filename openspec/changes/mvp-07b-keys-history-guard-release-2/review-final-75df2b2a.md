# Review record for tree 75df2b2a (item A)

What was reviewed. Tree T 75df2b2a2e6e5de82417f94cbcf6a8e840eb78440f64fc1fb772106658fefa7e (323 files) at commit fdc4ccfd9e209cd281b3d251129142caaa8bc499 on branch mvp-07b-guard-removal, build hash B ccfb61e31c7a1a9ab24895403e83ac1acb98d945d10245a4f6ea7e4af66dd2bb (matches dist/.guard-build.json). Coverage lists all 314 src/, cli/ and tools/ files of the tree listing, each marked read.

How. Every finding below was raised by an independent, code-reading, read-only security review of this branch: review rounds 1 to 9 (R1 first read at e82d84c, R2 two delta reads, R3 four partition reads at 18946bd, R4 two delta reads at 676bbf7, R5 to R9 at 0efa016, 5a73801, 903e3c1, 976a31a and a6a25c0) and delta reviews H, I, J and K (the desktop Node transport at 9276e34, c40f76f, f74cd96 and fdc4ccf). Ids are the round plus the reviewer's own label, for example R3P-M1 is the plugin partition's MEDIUM-1 in round 3. The round numbers follow review order, not the CHANGELOG fix-round numbers. Severities are the reviewers' own. Statuses come from the CHANGELOG (sections on the third to tenth rounds, the Not done lists and the accepted backlog), the dispatch and fix reports in the session transcript, and docs/operator/encrypted-vault.md. The compiled record was produced by the release-deployment-lead role from those sources; it is not a new review of the code.

Limits. None of the reviews executed code, and none was a cross-model judge run. The compiler of this record did not read the source; the review hand-backs, the CHANGELOG and the docs are the only evidence. Reviews of earlier changes (mvp-06, mvp-07a) are not included. Informational notes without a severity are not included. A finding raised by two reviewers appears under each reviewer's id. The HIGH redirect finding (requestUrl follows redirects) is split: the desktop half is fixed in 9276e34 (verified in Obsidian 1.14.4 for macOS), and the mobile half is R1-H2m, an accepted MEDIUM, because iOS follows a cross-origin redirect, strips Authorization, forwards a custom header, and the plugin cannot stop it. The uncomfortable part: 21 accepted findings carry the reason "status not recoverable from the CHANGELOG; operator to confirm", which means their disposition is not written down anywhere the compiler could read; the operator must confirm them. No review of the final tree HEAD fdc4ccf found a critical or high finding (delta reviews J and K), but those two reviews were scoped to the changed transport and plugin runner files, not the whole tree.

Totals. 202 findings: critical 0, high 6, medium 59, low 137. Fixed 102, accepted 100, open 0.

<!-- guard-review:v1 -->
{
  "reviewer": "security-reviewer",
  "verdict": "approved",
  "reviewedCommit": "fdc4ccfd9e209cd281b3d251129142caaa8bc499",
  "treeSha256": "75df2b2a2e6e5de82417f94cbcf6a8e840eb78440f64fc1fb772106658fefa7e",
  "treeFileCount": 323,
  "buildSha256": "ccfb61e31c7a1a9ab24895403e83ac1acb98d945d10245a4f6ea7e4af66dd2bb",
  "checkerSha256": "9307bc627249a9a5f8dcda98f1da1353357cad20a595be93f0e68b1de7cb005e",
  "checklistTests": {
    "tests/unit/removal-guard.test.ts": "5c66ec51ba4c2ae172d2bc3b973b2c7eea65b5a5babb60f85d49b29ae3bf3f07",
    "tests/unit/publish-mass-removal.test.ts": "12542757cde5754754ffd2d77d9ab7f9433143124d963fd7c2e3a4a8c84b0bfe",
    "tests/unit/cli-publish-mass-removal.test.ts": "254cd5cb72f8dd395217fb203f1a8a7b4270923e52cb05a409f191aa10388838",
    "tests/unit/prune-history.test.ts": "2484a3fce509e9d6caa5ab620fd76fc1d4aac1da784200a019b4cddd647fdaad",
    "tests/unit/prune-history-plan.test.ts": "cb43aad34634abffc29682f55c2880c3b0fb1c0c90f793255679168d1675a1d1",
    "tests/unit/cli-prune-history.test.ts": "a8673f8b992a67cfb6158485b73e05f122bafaefd432aec8a5091982f37d3ca0",
    "tests/unit/encrypted-transfer.test.ts": "027d7a3a759e5b3ea07443598b04b44e00dabb72e204ac314c9eae035e0d4433",
    "tests/unit/history-names.test.ts": "add169a19d7891eed5a8f105df00566cc77a2afe8a8fe33d46627d91d926c356",
    "tests/unit/guard-permissive.test.ts": "8e2687abd3fc895c4ec61edda4b38f069a9663ebb0c5cbfc8da32c93dcca9eca",
    "tests/unit/plaintext-removal.test.ts": "f88b2cfa3ea23a085a5e5f29c068f92033c1e7cf0bcbe98acd6acb10d3ff4a37",
    "tests/unit/crypto-key-slots-rewrap.test.ts": "610af610c52db7db9d7731eba858fe752cce39e0a81880d19adbfe24c1613486",
    "tests/unit/key-management.test.ts": "00b486ac5e404d73a0ba465f7c86109c44b67c9cc60c20cff5f3a814f3e7fb93",
    "tests/unit/key-accept.test.ts": "e86abe9d891cb53a737865aab60d2a2a12105f050443516a2d16dcb1bc89a53b",
    "tests/unit/slot-acceptance.test.ts": "01143d2d6a210cb50f0881e090e03c66ded168d8e375e7cba0c35748cb18279f",
    "tests/unit/cli-keys-accept.test.ts": "5793a6e1657e53720ee6a833a04d704b203297c65f9f81327fa635d3b0caad89",
    "tests/unit/maintenance-journal.test.ts": "821d37a62da6b387121648141535c4ba1003dfea189a76c5a4e6d4293204ed2d",
    "tests/unit/maintenance-node.test.ts": "09526de4d2e803e8974003c98017b12cbf13a6394e3387392a7f84072bb49f3b"
  },
  "coverage": [
    {
      "path": "cli/abandon-command.ts",
      "read": true
    },
    {
      "path": "cli/args.ts",
      "read": true
    },
    {
      "path": "cli/device-store-node.ts",
      "read": true
    },
    {
      "path": "cli/help-text.ts",
      "read": true
    },
    {
      "path": "cli/init-command.ts",
      "read": true
    },
    {
      "path": "cli/io.ts",
      "read": true
    },
    {
      "path": "cli/keys-accept.ts",
      "read": true
    },
    {
      "path": "cli/keys-command.ts",
      "read": true
    },
    {
      "path": "cli/keys-discard.ts",
      "read": true
    },
    {
      "path": "cli/keys-rewrap.ts",
      "read": true
    },
    {
      "path": "cli/keys-session.ts",
      "read": true
    },
    {
      "path": "cli/load-config.ts",
      "read": true
    },
    {
      "path": "cli/main.ts",
      "read": true
    },
    {
      "path": "cli/node-host-bridge.ts",
      "read": true
    },
    {
      "path": "cli/owned-keys-store.ts",
      "read": true
    },
    {
      "path": "cli/passphrase-errors.ts",
      "read": true
    },
    {
      "path": "cli/passphrase-file.ts",
      "read": true
    },
    {
      "path": "cli/passphrase-input.ts",
      "read": true
    },
    {
      "path": "cli/passphrase-prompt.ts",
      "read": true
    },
    {
      "path": "cli/passphrase-show.ts",
      "read": true
    },
    {
      "path": "cli/prune-command.ts",
      "read": true
    },
    {
      "path": "cli/publish-command.ts",
      "read": true
    },
    {
      "path": "cli/publish-lock-file.ts",
      "read": true
    },
    {
      "path": "cli/pull-command.ts",
      "read": true
    },
    {
      "path": "cli/pull-context.ts",
      "read": true
    },
    {
      "path": "cli/pull-encrypted-command.ts",
      "read": true
    },
    {
      "path": "cli/pull-versions.ts",
      "read": true
    },
    {
      "path": "cli/realpath-guard.ts",
      "read": true
    },
    {
      "path": "cli/request-trace.ts",
      "read": true
    },
    {
      "path": "cli/run.ts",
      "read": true
    },
    {
      "path": "cli/state-folder-link.ts",
      "read": true
    },
    {
      "path": "cli/status-command.ts",
      "read": true
    },
    {
      "path": "src/core/config/auth.ts",
      "read": true
    },
    {
      "path": "src/core/config/build-config.ts",
      "read": true
    },
    {
      "path": "src/core/config/connection-headers.ts",
      "read": true
    },
    {
      "path": "src/core/config/defaults.ts",
      "read": true
    },
    {
      "path": "src/core/config/endpoint.ts",
      "read": true
    },
    {
      "path": "src/core/config/errors.ts",
      "read": true
    },
    {
      "path": "src/core/config/index.ts",
      "read": true
    },
    {
      "path": "src/core/config/jwt.ts",
      "read": true
    },
    {
      "path": "src/core/config/layers.ts",
      "read": true
    },
    {
      "path": "src/core/config/node-safety.ts",
      "read": true
    },
    {
      "path": "src/core/config/retired-default-hosts.ts",
      "read": true
    },
    {
      "path": "src/core/config/types.ts",
      "read": true
    },
    {
      "path": "src/core/events/event-bus.ts",
      "read": true
    },
    {
      "path": "src/core/events/event-types.ts",
      "read": true
    },
    {
      "path": "src/core/events/index.ts",
      "read": true
    },
    {
      "path": "src/core/host-bridge/host-bridge.ts",
      "read": true
    },
    {
      "path": "src/core/host-bridge/index.ts",
      "read": true
    },
    {
      "path": "src/crypto/aes-gcm.ts",
      "read": true
    },
    {
      "path": "src/crypto/argon2.ts",
      "read": true
    },
    {
      "path": "src/crypto/blob-names.ts",
      "read": true
    },
    {
      "path": "src/crypto/blob.ts",
      "read": true
    },
    {
      "path": "src/crypto/bytes.ts",
      "read": true
    },
    {
      "path": "src/crypto/codec.ts",
      "read": true
    },
    {
      "path": "src/crypto/errors.ts",
      "read": true
    },
    {
      "path": "src/crypto/hkdf.ts",
      "read": true
    },
    {
      "path": "src/crypto/hmac.ts",
      "read": true
    },
    {
      "path": "src/crypto/index.ts",
      "read": true
    },
    {
      "path": "src/crypto/key-derivation.ts",
      "read": true
    },
    {
      "path": "src/crypto/key-slot-format.ts",
      "read": true
    },
    {
      "path": "src/crypto/key-slots.ts",
      "read": true
    },
    {
      "path": "src/crypto/manifest-envelope.ts",
      "read": true
    },
    {
      "path": "src/crypto/passphrase.ts",
      "read": true
    },
    {
      "path": "src/crypto/random.ts",
      "read": true
    },
    {
      "path": "src/crypto/self-test.ts",
      "read": true
    },
    {
      "path": "src/crypto/strict-json.ts",
      "read": true
    },
    {
      "path": "src/crypto/testing/argon2id-raw.ts",
      "read": true
    },
    {
      "path": "src/crypto/testing/generated-passphrase.ts",
      "read": true
    },
    {
      "path": "src/crypto/testing/unwrap-vck.ts",
      "read": true
    },
    {
      "path": "src/crypto/webcrypto.ts",
      "read": true
    },
    {
      "path": "src/kubo/auth-headers.ts",
      "read": true
    },
    {
      "path": "src/kubo/client.ts",
      "read": true
    },
    {
      "path": "src/kubo/errors.ts",
      "read": true
    },
    {
      "path": "src/kubo/gateway.ts",
      "read": true
    },
    {
      "path": "src/kubo/http.ts",
      "read": true
    },
    {
      "path": "src/kubo/index.ts",
      "read": true
    },
    {
      "path": "src/kubo/ipns.ts",
      "read": true
    },
    {
      "path": "src/kubo/mfs-write.ts",
      "read": true
    },
    {
      "path": "src/kubo/multipart.ts",
      "read": true
    },
    {
      "path": "src/kubo/node-calls.ts",
      "read": true
    },
    {
      "path": "src/kubo/rpc-call.ts",
      "read": true
    },
    {
      "path": "src/kubo/rpc-fields.ts",
      "read": true
    },
    {
      "path": "src/kubo/types.ts",
      "read": true
    },
    {
      "path": "src/main.ts",
      "read": true
    },
    {
      "path": "src/plugin/abandon-dialog-model.ts",
      "read": true
    },
    {
      "path": "src/plugin/abandon-flow.ts",
      "read": true
    },
    {
      "path": "src/plugin/abandon-vault-dialog.ts",
      "read": true
    },
    {
      "path": "src/plugin/accept-slots-dialog-model.ts",
      "read": true
    },
    {
      "path": "src/plugin/accept-slots-dialog.ts",
      "read": true
    },
    {
      "path": "src/plugin/adapter-lock-file.ts",
      "read": true
    },
    {
      "path": "src/plugin/adopt-key-dialog.ts",
      "read": true
    },
    {
      "path": "src/plugin/base64.ts",
      "read": true
    },
    {
      "path": "src/plugin/catch-up.ts",
      "read": true
    },
    {
      "path": "src/plugin/change-passphrase-dialog-model.ts",
      "read": true
    },
    {
      "path": "src/plugin/change-passphrase-dialog.ts",
      "read": true
    },
    {
      "path": "src/plugin/clear-stale-lock-dialog.ts",
      "read": true
    },
    {
      "path": "src/plugin/cost-confirm-dialog-model.ts",
      "read": true
    },
    {
      "path": "src/plugin/cost-confirm-dialog.ts",
      "read": true
    },
    {
      "path": "src/plugin/device-store-plugin.ts",
      "read": true
    },
    {
      "path": "src/plugin/editor-flush.ts",
      "read": true
    },
    {
      "path": "src/plugin/encryption-copy.ts",
      "read": true
    },
    {
      "path": "src/plugin/encryption-dialog-controls.ts",
      "read": true
    },
    {
      "path": "src/plugin/encryption-settings-model.ts",
      "read": true
    },
    {
      "path": "src/plugin/encryption-settings.ts",
      "read": true
    },
    {
      "path": "src/plugin/first-pull-dialog-model.ts",
      "read": true
    },
    {
      "path": "src/plugin/first-pull-dialog.ts",
      "read": true
    },
    {
      "path": "src/plugin/fork-dialog-model.ts",
      "read": true
    },
    {
      "path": "src/plugin/fork-dialog.ts",
      "read": true
    },
    {
      "path": "src/plugin/increase-cost-dialog-model.ts",
      "read": true
    },
    {
      "path": "src/plugin/increase-cost-dialog.ts",
      "read": true
    },
    {
      "path": "src/plugin/index.ts",
      "read": true
    },
    {
      "path": "src/plugin/key-action-failure.ts",
      "read": true
    },
    {
      "path": "src/plugin/key-action-lock.ts",
      "read": true
    },
    {
      "path": "src/plugin/key-actions.ts",
      "read": true
    },
    {
      "path": "src/plugin/key-adoption.ts",
      "read": true
    },
    {
      "path": "src/plugin/key-dialog-controls.ts",
      "read": true
    },
    {
      "path": "src/plugin/key-dialog-shared.ts",
      "read": true
    },
    {
      "path": "src/plugin/key-dialogs.ts",
      "read": true
    },
    {
      "path": "src/plugin/key-ports.ts",
      "read": true
    },
    {
      "path": "src/plugin/key-secret-entry.ts",
      "read": true
    },
    {
      "path": "src/plugin/large-pull-dialog-model.ts",
      "read": true
    },
    {
      "path": "src/plugin/large-pull-dialog.ts",
      "read": true
    },
    {
      "path": "src/plugin/mass-removal-dialog-model.ts",
      "read": true
    },
    {
      "path": "src/plugin/mass-removal-dialog.ts",
      "read": true
    },
    {
      "path": "src/plugin/measure-derivation.ts",
      "read": true
    },
    {
      "path": "src/plugin/measure-notice.ts",
      "read": true
    },
    {
      "path": "src/plugin/node-status.ts",
      "read": true
    },
    {
      "path": "src/plugin/node-transport.ts",
      "read": true
    },
    {
      "path": "src/plugin/obsidian-fs.ts",
      "read": true
    },
    {
      "path": "src/plugin/obsidian-host-bridge.ts",
      "read": true
    },
    {
      "path": "src/plugin/obsidian-kv.ts",
      "read": true
    },
    {
      "path": "src/plugin/plugin-seams.ts",
      "read": true
    },
    {
      "path": "src/plugin/prune-history-dialog-model.ts",
      "read": true
    },
    {
      "path": "src/plugin/prune-history-dialog.ts",
      "read": true
    },
    {
      "path": "src/plugin/publish-notices.ts",
      "read": true
    },
    {
      "path": "src/plugin/publish-runner.ts",
      "read": true
    },
    {
      "path": "src/plugin/pull-confirm-dialog.ts",
      "read": true
    },
    {
      "path": "src/plugin/pull-confirm-model.ts",
      "read": true
    },
    {
      "path": "src/plugin/pull-dialog-copy.ts",
      "read": true
    },
    {
      "path": "src/plugin/pull-dialogs.ts",
      "read": true
    },
    {
      "path": "src/plugin/pull-keys.ts",
      "read": true
    },
    {
      "path": "src/plugin/pull-notices.ts",
      "read": true
    },
    {
      "path": "src/plugin/pull-presenter.ts",
      "read": true
    },
    {
      "path": "src/plugin/pull-progress.ts",
      "read": true
    },
    {
      "path": "src/plugin/pull-report.ts",
      "read": true
    },
    {
      "path": "src/plugin/pull-restore.ts",
      "read": true
    },
    {
      "path": "src/plugin/pull-runner.ts",
      "read": true
    },
    {
      "path": "src/plugin/pull-sweep.ts",
      "read": true
    },
    {
      "path": "src/plugin/pull-target.ts",
      "read": true
    },
    {
      "path": "src/plugin/read-cap.ts",
      "read": true
    },
    {
      "path": "src/plugin/request-url-transport.ts",
      "read": true
    },
    {
      "path": "src/plugin/restore-dialog-model.ts",
      "read": true
    },
    {
      "path": "src/plugin/restore-dialog.ts",
      "read": true
    },
    {
      "path": "src/plugin/session-dialogs.ts",
      "read": true
    },
    {
      "path": "src/plugin/session-keys.ts",
      "read": true
    },
    {
      "path": "src/plugin/session-status.ts",
      "read": true
    },
    {
      "path": "src/plugin/settings-activity.ts",
      "read": true
    },
    {
      "path": "src/plugin/settings-fields.ts",
      "read": true
    },
    {
      "path": "src/plugin/settings-migration.ts",
      "read": true
    },
    {
      "path": "src/plugin/settings-model.ts",
      "read": true
    },
    {
      "path": "src/plugin/settings-parse.ts",
      "read": true
    },
    {
      "path": "src/plugin/settings-store.ts",
      "read": true
    },
    {
      "path": "src/plugin/settings-tab-controls.ts",
      "read": true
    },
    {
      "path": "src/plugin/settings-tab-copy.ts",
      "read": true
    },
    {
      "path": "src/plugin/settings-tab-exclusions.ts",
      "read": true
    },
    {
      "path": "src/plugin/settings-tab-keys.ts",
      "read": true
    },
    {
      "path": "src/plugin/settings-tab-lock.ts",
      "read": true
    },
    {
      "path": "src/plugin/settings-tab-pull.ts",
      "read": true
    },
    {
      "path": "src/plugin/settings-tab.ts",
      "read": true
    },
    {
      "path": "src/plugin/settings-to-config.ts",
      "read": true
    },
    {
      "path": "src/plugin/settings-view-model.ts",
      "read": true
    },
    {
      "path": "src/plugin/setup-dialog-model.ts",
      "read": true
    },
    {
      "path": "src/plugin/setup-dialog.ts",
      "read": true
    },
    {
      "path": "src/plugin/stale-lock-copy.ts",
      "read": true
    },
    {
      "path": "src/plugin/stale-lock-flow.ts",
      "read": true
    },
    {
      "path": "src/plugin/stale-lock.ts",
      "read": true
    },
    {
      "path": "src/plugin/summary-store.ts",
      "read": true
    },
    {
      "path": "src/plugin/sync-lock.ts",
      "read": true
    },
    {
      "path": "src/plugin/sync-status.ts",
      "read": true
    },
    {
      "path": "src/plugin/unlock-dialog-model.ts",
      "read": true
    },
    {
      "path": "src/plugin/unlock-dialog.ts",
      "read": true
    },
    {
      "path": "src/plugin/unreadable-backup.ts",
      "read": true
    },
    {
      "path": "src/plugin/vault-opener.ts",
      "read": true
    },
    {
      "path": "src/sync/abandon-hint.ts",
      "read": true
    },
    {
      "path": "src/sync/blob-fetch.ts",
      "read": true
    },
    {
      "path": "src/sync/blob-source.ts",
      "read": true
    },
    {
      "path": "src/sync/chunked-write.ts",
      "read": true
    },
    {
      "path": "src/sync/commit-node.ts",
      "read": true
    },
    {
      "path": "src/sync/commit-ports.ts",
      "read": true
    },
    {
      "path": "src/sync/conflict-name.ts",
      "read": true
    },
    {
      "path": "src/sync/device-store.ts",
      "read": true
    },
    {
      "path": "src/sync/diff.ts",
      "read": true
    },
    {
      "path": "src/sync/drift.ts",
      "read": true
    },
    {
      "path": "src/sync/encrypted-manifest.ts",
      "read": true
    },
    {
      "path": "src/sync/encrypted-pull-events.ts",
      "read": true
    },
    {
      "path": "src/sync/encrypted-pull-fetch.ts",
      "read": true
    },
    {
      "path": "src/sync/encrypted-pull-plan.ts",
      "read": true
    },
    {
      "path": "src/sync/encrypted-pull-stage.ts",
      "read": true
    },
    {
      "path": "src/sync/encrypted-pull.ts",
      "read": true
    },
    {
      "path": "src/sync/encrypted-transfer.ts",
      "read": true
    },
    {
      "path": "src/sync/exclusions.ts",
      "read": true
    },
    {
      "path": "src/sync/fixture-constants.ts",
      "read": true
    },
    {
      "path": "src/sync/fork-resolution.ts",
      "read": true
    },
    {
      "path": "src/sync/guarded-kv.ts",
      "read": true
    },
    {
      "path": "src/sync/hash.ts",
      "read": true
    },
    {
      "path": "src/sync/history-check.ts",
      "read": true
    },
    {
      "path": "src/sync/history-gate.ts",
      "read": true
    },
    {
      "path": "src/sync/history-names.ts",
      "read": true
    },
    {
      "path": "src/sync/host-errors.ts",
      "read": true
    },
    {
      "path": "src/sync/idle-check.ts",
      "read": true
    },
    {
      "path": "src/sync/journal.ts",
      "read": true
    },
    {
      "path": "src/sync/key-management-text.ts",
      "read": true
    },
    {
      "path": "src/sync/key-management.ts",
      "read": true
    },
    {
      "path": "src/sync/local-manifest.ts",
      "read": true
    },
    {
      "path": "src/sync/local-record.ts",
      "read": true
    },
    {
      "path": "src/sync/lock-token-check.ts",
      "read": true
    },
    {
      "path": "src/sync/maintenance-journal.ts",
      "read": true
    },
    {
      "path": "src/sync/maintenance-node.ts",
      "read": true
    },
    {
      "path": "src/sync/manifest-auth.ts",
      "read": true
    },
    {
      "path": "src/sync/manifest-identity.ts",
      "read": true
    },
    {
      "path": "src/sync/manifest-paths.ts",
      "read": true
    },
    {
      "path": "src/sync/name-recheck.ts",
      "read": true
    },
    {
      "path": "src/sync/node-reader.ts",
      "read": true
    },
    {
      "path": "src/sync/path-fold-table.ts",
      "read": true
    },
    {
      "path": "src/sync/path-fold.ts",
      "read": true
    },
    {
      "path": "src/sync/path-limits.ts",
      "read": true
    },
    {
      "path": "src/sync/path-policy.ts",
      "read": true
    },
    {
      "path": "src/sync/pool.ts",
      "read": true
    },
    {
      "path": "src/sync/prune-history-text.ts",
      "read": true
    },
    {
      "path": "src/sync/prune-history.ts",
      "read": true
    },
    {
      "path": "src/sync/publish-commit.ts",
      "read": true
    },
    {
      "path": "src/sync/publish-errors.ts",
      "read": true
    },
    {
      "path": "src/sync/publish-guard.ts",
      "read": true
    },
    {
      "path": "src/sync/publish-key.ts",
      "read": true
    },
    {
      "path": "src/sync/publish-lock.ts",
      "read": true
    },
    {
      "path": "src/sync/publish-manifest.ts",
      "read": true
    },
    {
      "path": "src/sync/publish-plan.ts",
      "read": true
    },
    {
      "path": "src/sync/publish-refusals.ts",
      "read": true
    },
    {
      "path": "src/sync/publish-resume.ts",
      "read": true
    },
    {
      "path": "src/sync/publish-sequence.ts",
      "read": true
    },
    {
      "path": "src/sync/publish-session.ts",
      "read": true
    },
    {
      "path": "src/sync/publish-types.ts",
      "read": true
    },
    {
      "path": "src/sync/publish.ts",
      "read": true
    },
    {
      "path": "src/sync/pull-budget.ts",
      "read": true
    },
    {
      "path": "src/sync/pull-conflict.ts",
      "read": true
    },
    {
      "path": "src/sync/pull-errors.ts",
      "read": true
    },
    {
      "path": "src/sync/pull-guard.ts",
      "read": true
    },
    {
      "path": "src/sync/pull-sequence.ts",
      "read": true
    },
    {
      "path": "src/sync/pull-unlock.ts",
      "read": true
    },
    {
      "path": "src/sync/read-back.ts",
      "read": true
    },
    {
      "path": "src/sync/removal-guard.ts",
      "read": true
    },
    {
      "path": "src/sync/repair.ts",
      "read": true
    },
    {
      "path": "src/sync/republish-root.ts",
      "read": true
    },
    {
      "path": "src/sync/root-files.ts",
      "read": true
    },
    {
      "path": "src/sync/root-state.ts",
      "read": true
    },
    {
      "path": "src/sync/same-bytes.ts",
      "read": true
    },
    {
      "path": "src/sync/scan.ts",
      "read": true
    },
    {
      "path": "src/sync/sequence-floor.ts",
      "read": true
    },
    {
      "path": "src/sync/sequence-rules.ts",
      "read": true
    },
    {
      "path": "src/sync/slot-acceptance.ts",
      "read": true
    },
    {
      "path": "src/sync/stable-json.ts",
      "read": true
    },
    {
      "path": "src/sync/state-folder-guard.ts",
      "read": true
    },
    {
      "path": "src/sync/symlink-guard.ts",
      "read": true
    },
    {
      "path": "src/sync/target-resolution.ts",
      "read": true
    },
    {
      "path": "src/sync/temp-files.ts",
      "read": true
    },
    {
      "path": "src/sync/three-way.ts",
      "read": true
    },
    {
      "path": "src/sync/up-to-date-check.ts",
      "read": true
    },
    {
      "path": "src/sync/vault-keys.ts",
      "read": true
    },
    {
      "path": "tools/check-guard-preconditions.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/arguments.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/cli-runner.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/cli-scenarios.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/constants.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/harness-phases.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/hostile-phase.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/hostile-tools.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/install.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/machine-checks.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/machine-session.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/machine-steps.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/node-reader.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/node-view.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/observed-phase.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/phases.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/policy.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/record.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/recorder.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/run.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/scenario-kit.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/script-only-phase.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07/terminal-prompt.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07a/children.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07a/constants.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07a/policy.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07a/proxy.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07a/report.mjs",
      "read": true
    },
    {
      "path": "tools/feature-op-mvp-07a/workspace.mjs",
      "read": true
    },
    {
      "path": "tools/hook-isolation.mjs",
      "read": true
    },
    {
      "path": "tools/record-phone-timing.mjs",
      "read": true
    },
    {
      "path": "tools/release-mvp-07.mjs",
      "read": true
    },
    {
      "path": "tools/release/assemble.mjs",
      "read": true
    },
    {
      "path": "tools/release/bump.mjs",
      "read": true
    },
    {
      "path": "tools/release/constants.mjs",
      "read": true
    },
    {
      "path": "tools/release/descriptors.mjs",
      "read": true
    },
    {
      "path": "tools/release/facts.mjs",
      "read": true
    },
    {
      "path": "tools/release/notes.mjs",
      "read": true
    },
    {
      "path": "tools/release/plan.mjs",
      "read": true
    },
    {
      "path": "tools/release/record.mjs",
      "read": true
    },
    {
      "path": "tools/release/release1.mjs",
      "read": true
    },
    {
      "path": "tools/release/release2.mjs",
      "read": true
    },
    {
      "path": "tools/release/steps.mjs",
      "read": true
    },
    {
      "path": "tools/release/tar.mjs",
      "read": true
    }
  ],
  "counts": {
    "critical": 0,
    "high": 6,
    "medium": 59,
    "low": 137
  },
  "findings": [
    {
      "id": "R1-H1",
      "severity": "high",
      "status": "fixed",
      "summary": "The plugin sent the one node credential to the gateway host as well as the RPC host.",
      "fixedInCommit": "1e65784cc73494a8462dcc1b4149614500efb898"
    },
    {
      "id": "R1-H2",
      "severity": "high",
      "status": "fixed",
      "summary": "requestUrl follows redirects, so a credential or POST body could follow a redirect to a host the user never configured; desktop now sends every request through Node's http, which refuses redirects (verified in Obsidian 1.14.4).",
      "fixedInCommit": "9276e34a70ae3822aa05f7a5bd1133167c7eb849"
    },
    {
      "id": "R1-H2m",
      "severity": "medium",
      "status": "accepted",
      "summary": "Mobile residual of R1-H2: requestUrl still follows redirects on mobile and the plugin can neither prevent nor detect it.",
      "acceptedBecause": "iOS cannot stop redirects (probed on an iPhone: a cross-origin redirect is followed, Authorization is stripped, a custom header is forwarded), so the plugin cannot prevent it; the docs say to prefer Bearer or Basic on a phone and a node that does not redirect."
    },
    {
      "id": "R1-M1",
      "severity": "medium",
      "status": "fixed",
      "summary": "The first-pull confirmation did not say how many existing local files the pull would replace.",
      "fixedInCommit": "1e65784cc73494a8462dcc1b4149614500efb898"
    },
    {
      "id": "R1-M2",
      "severity": "medium",
      "status": "accepted",
      "summary": "The CLI does not know a renamed Obsidian configuration folder on publish or pull.",
      "acceptedBecause": "CHANGELOG: M2, the CLI does not know a renamed Obsidian configuration folder, so it can sync a folder the plugin would exclude; open, not fixed on this branch."
    },
    {
      "id": "R1-M3",
      "severity": "medium",
      "status": "fixed",
      "summary": "A legacy or 0.2.0 settings migration silently kept the maintainer's open node and its credential.",
      "fixedInCommit": "e0f2cbfd6e8a8f75f45524b4339b9a81e7e202e4"
    },
    {
      "id": "R1-M4",
      "severity": "medium",
      "status": "fixed",
      "summary": "Plain http was accepted for credentials with no warning; a warning now appears for a non-loopback http endpoint (still accepted).",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R1-M5",
      "severity": "medium",
      "status": "accepted",
      "summary": "Response bodies are buffered whole on the plugin transport and some CLI reads are unbounded.",
      "acceptedBecause": "CHANGELOG: M5, the mobile transport buffers whole response bodies and some CLI reads are unbounded; mobile cannot cap before buffering."
    },
    {
      "id": "R1-M6",
      "severity": "medium",
      "status": "accepted",
      "summary": "The plugin pull on the Obsidian adapter cannot see symlinks and renames non-atomically.",
      "acceptedBecause": "CHANGELOG: M6, the Obsidian adapter cannot see symbolic links and its rename is not atomic; open, not fixed."
    },
    {
      "id": "R1-M7",
      "severity": "medium",
      "status": "accepted",
      "summary": "Rewrap and change-passphrase do not revoke an old passphrase or old key-slot copies.",
      "acceptedBecause": "CHANGELOG: M7, change-passphrase and rewrap do not revoke an old passphrase and there is no key rotation command; documented limit."
    },
    {
      "id": "R1-M8",
      "severity": "medium",
      "status": "accepted",
      "summary": "The device-local rollback floor can be reset by restoring or deleting the file.",
      "acceptedBecause": "CHANGELOG: M8, the device-local rollback floor is easy to reset; documented limit."
    },
    {
      "id": "R1-L1",
      "severity": "low",
      "status": "fixed",
      "summary": "The state-folder symlink guard ran only on pull; publish, init, keys, prune-history, pull --list-versions and abandon now refuse a symlinked .ipfs-sync.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R1-L2",
      "severity": "low",
      "status": "accepted",
      "summary": "The mass-removal guard does not count exclusion-driven removals.",
      "acceptedBecause": "CHANGELOG: the mass-removal guard ignores removals caused by exclusions; listed as known."
    },
    {
      "id": "R1-L3",
      "severity": "low",
      "status": "accepted",
      "summary": "There is no fetch timeout, so a stalled node holds the locks.",
      "acceptedBecause": "CHANGELOG: the plugin transports have no request timeout; accepted by design."
    },
    {
      "id": "R1-L4",
      "severity": "low",
      "status": "fixed",
      "summary": "--auth-password, --auth-token and --auth-header-value put secrets in argv; they are refused with exit 2.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R1-L5",
      "severity": "low",
      "status": "fixed",
      "summary": "CLI abandon did not list the key-management (maintenance) journal.",
      "fixedInCommit": "5a73801f08b251d1feb5c731f436b502bc45de15"
    },
    {
      "id": "R1-L6",
      "severity": "low",
      "status": "accepted",
      "summary": "status writes a probe file to the node and a failed cleanup blocks the next publish.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R1-L7",
      "severity": "low",
      "status": "accepted",
      "summary": "Operator tools default to the retired host and use a fixed shared temp path.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R1-L8",
      "severity": "low",
      "status": "accepted",
      "summary": "Dead guard exports keep security-sounding names after the guard removal.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R1-L9",
      "severity": "low",
      "status": "accepted",
      "summary": "The node can see file count, exact sizes, timing and history length.",
      "acceptedBecause": "CHANGELOG: the node sees exact sizes and per-file edit timing; by design."
    },
    {
      "id": "R2A-H1",
      "severity": "high",
      "status": "fixed",
      "summary": "The redirect refusal did not cover the plugin's primary transport requestUrl (desktop closed by the Node transport; mobile residual is R1-H2m).",
      "fixedInCommit": "9276e34a70ae3822aa05f7a5bd1133167c7eb849"
    },
    {
      "id": "R2A-H2",
      "severity": "high",
      "status": "fixed",
      "summary": "After the origin rule the plugin could not authenticate a gateway on another origin; the plugin gained a Gateway authentication control.",
      "fixedInCommit": "e0f2cbfd6e8a8f75f45524b4339b9a81e7e202e4"
    },
    {
      "id": "R2A-M1",
      "severity": "medium",
      "status": "fixed",
      "summary": "A trailing-dot host bypassed retired-host detection.",
      "fixedInCommit": "e0f2cbfd6e8a8f75f45524b4339b9a81e7e202e4"
    },
    {
      "id": "R2A-M2",
      "severity": "medium",
      "status": "fixed",
      "summary": "The legacy auth token survived a retired-host migration.",
      "fixedInCommit": "e0f2cbfd6e8a8f75f45524b4339b9a81e7e202e4"
    },
    {
      "id": "R2A-M3",
      "severity": "medium",
      "status": "fixed",
      "summary": "Version-marked 0.2.0 data naming the retired host was not cleared.",
      "fixedInCommit": "e0f2cbfd6e8a8f75f45524b4339b9a81e7e202e4"
    },
    {
      "id": "R2A-M4",
      "severity": "medium",
      "status": "fixed",
      "summary": "The redirect refusal message gave the operator nothing to act on.",
      "fixedInCommit": "e0f2cbfd6e8a8f75f45524b4339b9a81e7e202e4"
    },
    {
      "id": "R2A-L1",
      "severity": "low",
      "status": "accepted",
      "summary": "The first-pull preview hashes existing files and the stage hashes them again.",
      "acceptedBecause": "CHANGELOG: the first-pull preview hashes files twice (LOW findings of the delta review, not fixed)."
    },
    {
      "id": "R2A-L2",
      "severity": "low",
      "status": "fixed",
      "summary": "The preview count can drift while the dialog is open; the copy now says at least N.",
      "fixedInCommit": "e0f2cbfd6e8a8f75f45524b4339b9a81e7e202e4"
    },
    {
      "id": "R2A-L3",
      "severity": "low",
      "status": "accepted",
      "summary": "The origin comparison is origin-only, so paths of one host share a credential.",
      "acceptedBecause": "CHANGELOG: the origin rule shares one credential across all paths of one host (not fixed)."
    },
    {
      "id": "R2A-L4",
      "severity": "low",
      "status": "fixed",
      "summary": "net.fetch bypassed the redirect refusal; documented in e0f2cbf and given no permissive default in f74cd96.",
      "fixedInCommit": "e0f2cbfd6e8a8f75f45524b4339b9a81e7e202e4"
    },
    {
      "id": "R2B-M1",
      "severity": "medium",
      "status": "fixed",
      "summary": "The Status notice printed a raw stored URL that could carry credentials.",
      "fixedInCommit": "09a51c8b7d5b9b500e963d9cecaab142efa7d282"
    },
    {
      "id": "R2B-M2",
      "severity": "medium",
      "status": "accepted",
      "summary": "A redirect can carry the gateway credential (a custom header is the most exposed) to another host on mobile; desktop closed in 9276e34.",
      "acceptedBecause": "iOS cannot stop redirects (probed on an iPhone: a cross-origin redirect is followed, Authorization is stripped, a custom header is forwarded), so the plugin cannot prevent it; the docs say to prefer Bearer or Basic on a phone and a node that does not redirect."
    },
    {
      "id": "R2B-M3",
      "severity": "medium",
      "status": "fixed",
      "summary": "A settings object without a version key took the legacy path and overwrote the file with defaults.",
      "fixedInCommit": "09a51c8b7d5b9b500e963d9cecaab142efa7d282"
    },
    {
      "id": "R2B-L1",
      "severity": "low",
      "status": "fixed",
      "summary": "The gateway 401/403 hint was shown when no credential had been withheld.",
      "fixedInCommit": "09a51c8b7d5b9b500e963d9cecaab142efa7d282"
    },
    {
      "id": "R2B-L2",
      "severity": "low",
      "status": "fixed",
      "summary": "A JWT with an out-of-range exp threw a RangeError.",
      "fixedInCommit": "09a51c8b7d5b9b500e963d9cecaab142efa7d282"
    },
    {
      "id": "R2B-L3",
      "severity": "low",
      "status": "fixed",
      "summary": "ConfigError echoed a pasted header name and URL passwords containing slash, question mark or hash.",
      "fixedInCommit": "09a51c8b7d5b9b500e963d9cecaab142efa7d282"
    },
    {
      "id": "R2B-L4",
      "severity": "low",
      "status": "accepted",
      "summary": "The retired-host notice code is dead after load-time clearing.",
      "acceptedBecause": "CHANGELOG: dead retired-notice code (warnAboutRetiredDefault) left in place; LOW L4 not fixed."
    },
    {
      "id": "R2B-L5",
      "severity": "low",
      "status": "fixed",
      "summary": "Re-pointing an endpoint URL kept the stored credential for the new host.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R2B-L6",
      "severity": "low",
      "status": "fixed",
      "summary": "Typed secrets survived switching an auth picker and could be re-saved silently.",
      "fixedInCommit": "09a51c8b7d5b9b500e963d9cecaab142efa7d282"
    },
    {
      "id": "R2B-L7",
      "severity": "low",
      "status": "accepted",
      "summary": "settings-parse uses 'gatewayAuth' in stored, which walks the prototype chain; Object.hasOwn suggested.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R3K-M1",
      "severity": "medium",
      "status": "accepted",
      "summary": "Redirect refusal and credential scoping are not enforced on the plugin transport requestUrl.",
      "acceptedBecause": "iOS cannot stop redirects (probed on an iPhone: a cross-origin redirect is followed, Authorization is stripped, a custom header is forwarded), so the plugin cannot prevent it; the docs say to prefer Bearer or Basic on a phone and a node that does not redirect."
    },
    {
      "id": "R3K-M2",
      "severity": "medium",
      "status": "accepted",
      "summary": "Response-size caps are checked after the whole body is buffered on the plugin transport.",
      "acceptedBecause": "CHANGELOG: the mobile transport buffers whole bodies before the size caps apply (memory)."
    },
    {
      "id": "R3K-M3",
      "severity": "medium",
      "status": "accepted",
      "summary": "Absence and not-found are decided from unauthenticated node text.",
      "acceptedBecause": "CHANGELOG: \"Not found\" is taken from unauthenticated node text."
    },
    {
      "id": "R3K-L1",
      "severity": "low",
      "status": "accepted",
      "summary": "Unbounded body reads from node-controlled responses.",
      "acceptedBecause": "CHANGELOG: tenth-round backlog, files/write responses and fetchGatewayBytes are read with no cap."
    },
    {
      "id": "R3K-L2",
      "severity": "low",
      "status": "fixed",
      "summary": "Credentials could be sent over cleartext http to a non-loopback host with no warning.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3K-L3",
      "severity": "low",
      "status": "fixed",
      "summary": "displayAddress and redactUserinfo disagreed with the URL parser.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3K-L4",
      "severity": "low",
      "status": "fixed",
      "summary": "The invalid-URL error echoed the raw URL with only userinfo removed.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3K-L5",
      "severity": "low",
      "status": "accepted",
      "summary": "ByteReader keeps one array element per tiny chunk (memory amplification).",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R3K-L6",
      "severity": "low",
      "status": "accepted",
      "summary": "Test-only crypto hooks are exported from production modules; only an external lint stops their use.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R3K-L7",
      "severity": "low",
      "status": "fixed",
      "summary": "escapeNodeText missed zero-width, soft-hyphen, BOM and tag-block characters.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3P-H1",
      "severity": "high",
      "status": "fixed",
      "summary": "requestUrl follows redirects, so the 'a redirect is never followed' invariant did not hold on the plugin's primary transport.",
      "fixedInCommit": "9276e34a70ae3822aa05f7a5bd1133167c7eb849"
    },
    {
      "id": "R3P-M1",
      "severity": "medium",
      "status": "fixed",
      "summary": "Editing the RPC URL ran a key check that sent the stored credential to the newly typed host.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3P-M2",
      "severity": "medium",
      "status": "fixed",
      "summary": "After Check key slots, focus moved to Accept instead of Cancel.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3P-M3",
      "severity": "medium",
      "status": "fixed",
      "summary": "An unreadable data.json was overwritten by defaults on the first save with no backup.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3P-M4",
      "severity": "medium",
      "status": "accepted",
      "summary": "No request timeout or cancellation on any plugin transport, so an untrusted node can wedge sync.",
      "acceptedBecause": "CHANGELOG: the plugin transports have no request timeout; accepted by design."
    },
    {
      "id": "R3P-M5",
      "severity": "medium",
      "status": "fixed",
      "summary": "The auto-publish interval had no upper bound and setInterval overflows above about 35,791 minutes.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3P-M6",
      "severity": "medium",
      "status": "accepted",
      "summary": "A hostile gateway or node can exhaust a phone's memory through unbounded buffering.",
      "acceptedBecause": "CHANGELOG: the mobile transport buffers whole bodies (memory)."
    },
    {
      "id": "R3P-L1",
      "severity": "low",
      "status": "fixed",
      "summary": "The first-pull dialog focused the acknowledgement checkbox, not Cancel.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3P-L2",
      "severity": "low",
      "status": "fixed",
      "summary": "Closing Abandon or Clear stale lock while it ran reported cancelled.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3P-L3",
      "severity": "low",
      "status": "accepted",
      "summary": "Host bridge net.fetch is unscoped.",
      "acceptedBecause": "CHANGELOG: net.fetch in the host bridge is unscoped; dormant, nothing calls it."
    },
    {
      "id": "R3P-L4",
      "severity": "low",
      "status": "accepted",
      "summary": "The key session and the settings store are runtime properties of the plugin instance.",
      "acceptedBecause": "CHANGELOG: credentials in data.json are plain text and other plugins can read them through the plugin object (the session and the store are runtime properties)."
    },
    {
      "id": "R3P-L5",
      "severity": "low",
      "status": "accepted",
      "summary": "Stale-lock clear race.",
      "acceptedBecause": "CHANGELOG: a stale-lock takeover compares the token only."
    },
    {
      "id": "R3P-L6",
      "severity": "low",
      "status": "fixed",
      "summary": "Legacy migration kept a token when there was no URL.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3P-L7",
      "severity": "low",
      "status": "fixed",
      "summary": "Secrets remained in detached settings DOM after the tab closed.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3P-L8",
      "severity": "low",
      "status": "accepted",
      "summary": "lstat cannot see symlinks on the Obsidian adapter.",
      "acceptedBecause": "CHANGELOG: M6, the Obsidian adapter cannot see symbolic links (lstat is stat)."
    },
    {
      "id": "R3P-L9",
      "severity": "low",
      "status": "accepted",
      "summary": "The editor flush happens once, before the passphrase prompt.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R3P-L10",
      "severity": "low",
      "status": "accepted",
      "summary": "The unlocked session has no idle timeout.",
      "acceptedBecause": "CHANGELOG: the unlocked session has no idle timeout."
    },
    {
      "id": "R3S-M1",
      "severity": "medium",
      "status": "fixed",
      "summary": "The first-pull confirmation keyed on no record of the vault, so a populated stateless directory got no confirmation when the device held a floor.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3S-M2",
      "severity": "medium",
      "status": "fixed",
      "summary": "A node-supplied root CID had no 128-character bound on the pull path and could make this build write a state or journal file it later refuses to read.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3S-L1",
      "severity": "low",
      "status": "accepted",
      "summary": "The mass-removal guard is blind to exclusion-driven removals.",
      "acceptedBecause": "CHANGELOG: the mass-removal guard ignores removals caused by exclusions."
    },
    {
      "id": "R3S-L2",
      "severity": "low",
      "status": "accepted",
      "summary": "Stale-lock takeover cannot tell a freshly heartbeated live lock from the stale one it read.",
      "acceptedBecause": "CHANGELOG: a stale-lock takeover compares the token only."
    },
    {
      "id": "R3S-L3",
      "severity": "low",
      "status": "accepted",
      "summary": "Sequence-floor retention and merge edge cases.",
      "acceptedBecause": "CHANGELOG: the sequence floor evicts the oldest of 64 vaults silently."
    },
    {
      "id": "R3S-L4",
      "severity": "low",
      "status": "accepted",
      "summary": "Plaintext metadata at rest in the vault's .ipfs-sync folder.",
      "acceptedBecause": "CHANGELOG: plaintext paths and sha256 sit in the vault's .ipfs-sync state folder, and cloud sync tools may copy them."
    },
    {
      "id": "R3S-L5",
      "severity": "low",
      "status": "accepted",
      "summary": "Node-visible metadata.",
      "acceptedBecause": "CHANGELOG: the node sees exact sizes and per-file edit timing."
    },
    {
      "id": "R3S-L6",
      "severity": "low",
      "status": "accepted",
      "summary": "A single unpublishable local path blocks the whole publish without naming it.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R3S-L7",
      "severity": "low",
      "status": "accepted",
      "summary": "Resume discards a journal as never written on a node-reported older or absent manifest.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R3S-L8",
      "severity": "low",
      "status": "accepted",
      "summary": "Path policy protects only the state folder, VCS folders and the config folder, and the destination guard is gone.",
      "acceptedBecause": "CHANGELOG: a key holder can write arbitrary relative paths (.zshrc, .vscode/tasks.json) into a destination you chose, and publish has no secrets deny-list."
    },
    {
      "id": "R3S-L9",
      "severity": "low",
      "status": "accepted",
      "summary": "Commit-time TOCTOU in the replace path can overwrite an edit saved in the window.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R3S-L10",
      "severity": "low",
      "status": "accepted",
      "summary": "markerWritten is reported true although writeFixtureMarker is a no-op.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R3S-L11",
      "severity": "low",
      "status": "accepted",
      "summary": "The generic repair path needs no confirmation beyond its flag.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R3C-M1",
      "severity": "medium",
      "status": "fixed",
      "summary": "Credentials were accepted as command-line flags.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3C-M2",
      "severity": "medium",
      "status": "fixed",
      "summary": "The node credential followed whatever URL an implicitly loaded cwd config named.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3C-M3",
      "severity": "medium",
      "status": "fixed",
      "summary": "The state-folder symlink guard existed only for pull.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3C-M4",
      "severity": "medium",
      "status": "fixed",
      "summary": "status printed node-supplied strings to stdout without control-character escaping.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3C-M5",
      "severity": "medium",
      "status": "accepted",
      "summary": "The release gate is an attestation chain and parts of it do not bind what they claim.",
      "acceptedBecause": "CHANGELOG: the release gate is an attestation chain, not a proof; its records are written by the party being checked and unread files do not fail it."
    },
    {
      "id": "R3C-M6",
      "severity": "medium",
      "status": "accepted",
      "summary": "Code that runs inside the evidence-producing operator run is outside the tree hash T.",
      "acceptedBecause": "CHANGELOG: the reader children in the operator run execute unhashed helpers with node credentials in their environment."
    },
    {
      "id": "R3C-M7",
      "severity": "medium",
      "status": "accepted",
      "summary": "Item E binds 17 test files by hash but not the helpers or runner config, and all test against an in-memory fake node.",
      "acceptedBecause": "CHANGELOG: test helpers and the runner config are not hashed."
    },
    {
      "id": "R3C-L1",
      "severity": "low",
      "status": "fixed",
      "summary": "--show-request chose the credential header list by URL prefix.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3C-L2",
      "severity": "low",
      "status": "fixed",
      "summary": "Production io always defined confirm and prompt, so the no-terminal branches never ran.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3C-L3",
      "severity": "low",
      "status": "fixed",
      "summary": ".ipfs-sync was created with the umask default by the lock file.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3C-L4",
      "severity": "low",
      "status": "fixed",
      "summary": "A passphrase file inside the vault was not refused.",
      "fixedInCommit": "5aa10aa3a9f033ff425f54d51552e9f405a3a541"
    },
    {
      "id": "R3C-L5",
      "severity": "low",
      "status": "accepted",
      "summary": "The per-user state directory, and with it the trust anchor, is selected by environment variables.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R3C-L6",
      "severity": "low",
      "status": "accepted",
      "summary": "Item D is a sentinel grep plus an allowlist probe.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R3C-L7",
      "severity": "low",
      "status": "accepted",
      "summary": "Operator-harness path hygiene: fixed shared temp names.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R3C-L8",
      "severity": "low",
      "status": "accepted",
      "summary": "Harness confinement is by key name, and the key name is the product default.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R3C-L9",
      "severity": "low",
      "status": "accepted",
      "summary": "The confinement proxy accepts any local caller and flags plaintext without blocking it.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R3C-L10",
      "severity": "low",
      "status": "accepted",
      "summary": "The signed phone statement has no freshness bound.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R3C-L11",
      "severity": "low",
      "status": "accepted",
      "summary": "The build is made from reviewedCommit and nothing asserts it agrees with HEAD.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R3C-L12",
      "severity": "low",
      "status": "accepted",
      "summary": "Release 1 runRecord edits manifest.json and builds with the inherited full environment.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R3C-L13",
      "severity": "low",
      "status": "accepted",
      "summary": "Environmental hazard: the repository sits at the CLI state-folder name inside the operator's vault.",
      "acceptedBecause": "CHANGELOG: the repository lives inside the operator's vault folder (.ipfs-sync); a CLI run against the vault root would write into the git working tree."
    },
    {
      "id": "R4A-M1",
      "severity": "medium",
      "status": "fixed",
      "summary": "The root-CID bound checked length only, not shape, so a node value could still wedge the journal.",
      "fixedInCommit": "c86445c43e70bc2940b0b14a55d72a8e65cf88ff"
    },
    {
      "id": "R4A-M2",
      "severity": "medium",
      "status": "fixed",
      "summary": "displayAddress echoed a secret when the text parsed as a non-http URL.",
      "fixedInCommit": "c86445c43e70bc2940b0b14a55d72a8e65cf88ff"
    },
    {
      "id": "R4A-L1",
      "severity": "low",
      "status": "fixed",
      "summary": "Confirmation details went to stdout, the prompt to stderr, and only stdin was checked for a terminal.",
      "fixedInCommit": "c86445c43e70bc2940b0b14a55d72a8e65cf88ff"
    },
    {
      "id": "R4A-L2",
      "severity": "low",
      "status": "fixed",
      "summary": "--accept-first-pull also answered the new stateless replace question; --accept-replace now answers it.",
      "fixedInCommit": "c86445c43e70bc2940b0b14a55d72a8e65cf88ff"
    },
    {
      "id": "R4A-L3",
      "severity": "low",
      "status": "fixed",
      "summary": "A pending-journal resume runs with no terminal and no confirming flag; the help text now says so.",
      "fixedInCommit": "c86445c43e70bc2940b0b14a55d72a8e65cf88ff"
    },
    {
      "id": "R4A-L4",
      "severity": "low",
      "status": "fixed",
      "summary": "Directory mode applied to every write, and the state-folder guard matched on exact case.",
      "fixedInCommit": "c86445c43e70bc2940b0b14a55d72a8e65cf88ff"
    },
    {
      "id": "R4A-L5",
      "severity": "low",
      "status": "fixed",
      "summary": "The invisible-character filter in io.ts was narrower than escapeNodeText.",
      "fixedInCommit": "c86445c43e70bc2940b0b14a55d72a8e65cf88ff"
    },
    {
      "id": "R4A-L6",
      "severity": "low",
      "status": "fixed",
      "summary": "The kubo client's gateway and name checks accepted CIDs of unbounded length.",
      "fixedInCommit": "c86445c43e70bc2940b0b14a55d72a8e65cf88ff"
    },
    {
      "id": "R4A-L7",
      "severity": "low",
      "status": "fixed",
      "summary": "The plain-http warning exempted every *.localhost host.",
      "fixedInCommit": "c86445c43e70bc2940b0b14a55d72a8e65cf88ff"
    },
    {
      "id": "R4A-L8",
      "severity": "low",
      "status": "fixed",
      "summary": "The explicit-port check ran on the untrimmed URL while the parser trims.",
      "fixedInCommit": "c86445c43e70bc2940b0b14a55d72a8e65cf88ff"
    },
    {
      "id": "R4A-L9",
      "severity": "low",
      "status": "accepted",
      "summary": "A credential flag after -- is not refused and its value is echoed.",
      "acceptedBecause": "CHANGELOG: fourth-round backlog, operands after -- are echoed when they are reported."
    },
    {
      "id": "R4A-L10",
      "severity": "low",
      "status": "accepted",
      "summary": "Path-embedded secrets in endpoint URLs are shown everywhere.",
      "acceptedBecause": "CHANGELOG: a secret embedded in a URL path is shown by displayAddress."
    },
    {
      "id": "R4A-L11",
      "severity": "low",
      "status": "fixed",
      "summary": "Help-text documentation drift.",
      "fixedInCommit": "c86445c43e70bc2940b0b14a55d72a8e65cf88ff"
    },
    {
      "id": "R4A-L12",
      "severity": "low",
      "status": "accepted",
      "summary": "The implicit config file still steers other fields.",
      "acceptedBecause": "CHANGELOG: an implicitly loaded config file still applies its other fields."
    },
    {
      "id": "R4B-M1",
      "severity": "medium",
      "status": "fixed",
      "summary": "A failure after the user closed Abandon or Clear stale lock while it ran was silent.",
      "fixedInCommit": "c86445c43e70bc2940b0b14a55d72a8e65cf88ff"
    },
    {
      "id": "R4B-M2",
      "severity": "medium",
      "status": "accepted",
      "summary": "Redirect through requestUrl rated MEDIUM; the settings tab gained one sentence about it in c86445c.",
      "acceptedBecause": "iOS cannot stop redirects (probed on an iPhone: a cross-origin redirect is followed, Authorization is stripped, a custom header is forwarded), so the plugin cannot prevent it; the docs say to prefer Bearer or Basic on a phone and a node that does not redirect."
    },
    {
      "id": "R4B-L3",
      "severity": "low",
      "status": "fixed",
      "summary": "A half-typed credential survived an address change.",
      "fixedInCommit": "c86445c43e70bc2940b0b14a55d72a8e65cf88ff"
    },
    {
      "id": "R4B-L4",
      "severity": "low",
      "status": "fixed",
      "summary": "The interval cap was not enforced on stored fractional values.",
      "fixedInCommit": "c86445c43e70bc2940b0b14a55d72a8e65cf88ff"
    },
    {
      "id": "R4B-L5",
      "severity": "low",
      "status": "accepted",
      "summary": "The 'unattended never creates a first copy' guarantee rests on the locked-session refusal, not on the first-pull gate.",
      "acceptedBecause": "status not recoverable from the CHANGELOG; operator to confirm"
    },
    {
      "id": "R4B-L6",
      "severity": "low",
      "status": "fixed",
      "summary": "A second dialog open could drop the first dialog's handle.",
      "fixedInCommit": "c86445c43e70bc2940b0b14a55d72a8e65cf88ff"
    },
    {
      "id": "R4B-L7",
      "severity": "low",
      "status": "fixed",
      "summary": "The unreadable-file backup was not re-verified and the pending flag cleared before the save succeeded.",
      "fixedInCommit": "c86445c43e70bc2940b0b14a55d72a8e65cf88ff"
    },
    {
      "id": "R4B-L8",
      "severity": "low",
      "status": "fixed",
      "summary": "A missing space in the unreadable-data notice.",
      "fixedInCommit": "c86445c43e70bc2940b0b14a55d72a8e65cf88ff"
    },
    {
      "id": "R5-M1",
      "severity": "medium",
      "status": "fixed",
      "summary": "Abandon moved a pending key-management journal that neither the preview nor the consequence text named.",
      "fixedInCommit": "5a73801f08b251d1feb5c731f436b502bc45de15"
    },
    {
      "id": "R5-L1",
      "severity": "low",
      "status": "fixed",
      "summary": "Plugin abandon took only the in-process lock, not the on-disk publish.lock.",
      "fixedInCommit": "903e3c115081b3c4e21f2730b6832c7783ffddee"
    },
    {
      "id": "R5-L2",
      "severity": "low",
      "status": "accepted",
      "summary": "A node-supplied key ID reaches persistent state and an IPNS name with no shape check.",
      "acceptedBecause": "CHANGELOG: a node-supplied key ID reaches ownedKeys and an IPNS name with no shape check; the vault key still authenticates the manifest."
    },
    {
      "id": "R5-L3",
      "severity": "low",
      "status": "fixed",
      "summary": "The terminal rule checked stdin and stdout, but every question is written to stderr.",
      "fixedInCommit": "5a73801f08b251d1feb5c731f436b502bc45de15"
    },
    {
      "id": "R5-L4",
      "severity": "low",
      "status": "fixed",
      "summary": "The first-pull flag answers the replace consequence on a true first pull; the help text now says so.",
      "fixedInCommit": "5a73801f08b251d1feb5c731f436b502bc45de15"
    },
    {
      "id": "R5-L5",
      "severity": "low",
      "status": "fixed",
      "summary": "A stored publishIntervalMinutes of null made the whole settings file unreadable.",
      "fixedInCommit": "5a73801f08b251d1feb5c731f436b502bc45de15"
    },
    {
      "id": "R5-L6",
      "severity": "low",
      "status": "fixed",
      "summary": "Text claimed as fixed carried node-chosen or file-chosen text.",
      "fixedInCommit": "5a73801f08b251d1feb5c731f436b502bc45de15"
    },
    {
      "id": "R5-L7",
      "severity": "low",
      "status": "accepted",
      "summary": "The unsafe-code-point table is narrower than the claim next to it.",
      "acceptedBecause": "CHANGELOG: the invisible-character table is narrower than escapeForDisplay (Default_Ignorable and Cf ranges)."
    },
    {
      "id": "R5-L8",
      "severity": "low",
      "status": "accepted",
      "summary": "Check-then-use windows in the Node host bridge.",
      "acceptedBecause": "CHANGELOG: check-then-use windows remain in the Node host bridge; using one needs local write access."
    },
    {
      "id": "R5-L9",
      "severity": "low",
      "status": "accepted",
      "summary": "The one CID validator is six copies of one regex.",
      "acceptedBecause": "CHANGELOG: the CID rule is six copies of one regex, not one definition."
    },
    {
      "id": "R5-L10",
      "severity": "low",
      "status": "accepted",
      "summary": "rootCid() shape is validated after the first node write.",
      "acceptedBecause": "CHANGELOG: on the maintenance path the root CID shape is validated after the first node write; rerunning the command recovers."
    },
    {
      "id": "R5-L11",
      "severity": "low",
      "status": "accepted",
      "summary": "The unreadable-settings copy is verified against decoded text, not the file's bytes.",
      "acceptedBecause": "CHANGELOG: the unreadable-file backup is compared as decoded text, not raw bytes."
    },
    {
      "id": "R5-L12",
      "severity": "low",
      "status": "accepted",
      "summary": "One redirect sentence is not tied to the gateway credential fields.",
      "acceptedBecause": "CHANGELOG: the redirect sentence sits in the Authentication section, not beside the gateway fields."
    },
    {
      "id": "R6-M1",
      "severity": "medium",
      "status": "fixed",
      "summary": "Plugin abandon never took the cross-process publish.lock.",
      "fixedInCommit": "903e3c115081b3c4e21f2730b6832c7783ffddee"
    },
    {
      "id": "R6-M2",
      "severity": "medium",
      "status": "fixed",
      "summary": "The text claimed keys discard withdraws a pending write, which holds only for an unpublished rewrap.",
      "fixedInCommit": "903e3c115081b3c4e21f2730b6832c7783ffddee"
    },
    {
      "id": "R6-M3",
      "severity": "medium",
      "status": "fixed",
      "summary": "An unusable device store blocked abandon, the escape hatch.",
      "fixedInCommit": "903e3c115081b3c4e21f2730b6832c7783ffddee"
    },
    {
      "id": "R6-M4",
      "severity": "medium",
      "status": "fixed",
      "summary": "A mid-sequence move failure was not stated and the plugin failure mapping was inverted.",
      "fixedInCommit": "903e3c115081b3c4e21f2730b6832c7783ffddee"
    },
    {
      "id": "R6-L1",
      "severity": "low",
      "status": "fixed",
      "summary": "The reported floor could be false when the vault id was no longer on the device.",
      "fixedInCommit": "903e3c115081b3c4e21f2730b6832c7783ffddee"
    },
    {
      "id": "R6-L2",
      "severity": "low",
      "status": "fixed",
      "summary": "The plugin abandon text omitted the publish journal.",
      "fixedInCommit": "903e3c115081b3c4e21f2730b6832c7783ffddee"
    },
    {
      "id": "R6-L3",
      "severity": "low",
      "status": "accepted",
      "summary": "The UNEXPECTED text points to a console that never receives the error.",
      "acceptedBecause": "CHANGELOG: the unexpected-error text points to a developer console that does not receive the error."
    },
    {
      "id": "R6-L4",
      "severity": "low",
      "status": "fixed",
      "summary": "CLI abandon with no terminal and no flag exited 1 instead of 2 when nothing was found.",
      "fixedInCommit": "903e3c115081b3c4e21f2730b6832c7783ffddee"
    },
    {
      "id": "R6-L5",
      "severity": "low",
      "status": "fixed",
      "summary": "The lock host name was spoofable inside the sentence and read unbounded.",
      "fixedInCommit": "903e3c115081b3c4e21f2730b6832c7783ffddee"
    },
    {
      "id": "R6-L6",
      "severity": "low",
      "status": "fixed",
      "summary": "The help text's exit-2 sentence omitted pull --resolve-fork.",
      "fixedInCommit": "903e3c115081b3c4e21f2730b6832c7783ffddee"
    },
    {
      "id": "R6-L7",
      "severity": "low",
      "status": "accepted",
      "summary": "readline EOF behaviour at the abandon prompt is unverified.",
      "acceptedBecause": "CHANGELOG: the CLI's behaviour at readline end-of-input (a closed input stream at the abandon prompt) is unverified."
    },
    {
      "id": "R7-M1",
      "severity": "medium",
      "status": "fixed",
      "summary": "A failing release() after the move hid the real result and left the plugin session unlocked.",
      "fixedInCommit": "976a31a981efea0bd03feaeceb96a0b27872a64e"
    },
    {
      "id": "R7-M2",
      "severity": "medium",
      "status": "fixed",
      "summary": "Abandon was blocked by unreadable or unsupported lock files and the messages gave wrong advice.",
      "fixedInCommit": "976a31a981efea0bd03feaeceb96a0b27872a64e"
    },
    {
      "id": "R7-L1",
      "severity": "low",
      "status": "fixed",
      "summary": "A partial move splits the backup across two folders and the text never said so.",
      "fixedInCommit": "976a31a981efea0bd03feaeceb96a0b27872a64e"
    },
    {
      "id": "R7-L2",
      "severity": "low",
      "status": "fixed",
      "summary": "The help text overstated that every command needs the RPC and gateway URLs.",
      "fixedInCommit": "976a31a981efea0bd03feaeceb96a0b27872a64e"
    },
    {
      "id": "R7-L3",
      "severity": "low",
      "status": "accepted",
      "summary": "The abandon preview lists files before the lock is taken.",
      "acceptedBecause": "CHANGELOG: the abandon preview is listed before the lock is taken, so it can differ from the final count."
    },
    {
      "id": "R7-L4",
      "severity": "low",
      "status": "accepted",
      "summary": "The CLI device-store read has side effects.",
      "acceptedBecause": "CHANGELOG: the CLI floor read creates the per-user device-store directory as a side effect."
    },
    {
      "id": "R7-L5",
      "severity": "low",
      "status": "accepted",
      "summary": "Unbounded work and blocking opens while the lock is held.",
      "acceptedBecause": "CHANGELOG: floorKept reads the whole state file with no size cap while the lock is held."
    },
    {
      "id": "R8-M1",
      "severity": "medium",
      "status": "fixed",
      "summary": "A live foreign lock could be misclassified as unsupported, so abandon moved files under a live publisher.",
      "fixedInCommit": "808b555187a3aae6bf036713b5072e86aa31f829"
    },
    {
      "id": "R8-M2",
      "severity": "medium",
      "status": "fixed",
      "summary": "A successful move could be reported as a failure when the session calls throw.",
      "fixedInCommit": "808b555187a3aae6bf036713b5072e86aa31f829"
    },
    {
      "id": "R8-L1",
      "severity": "low",
      "status": "fixed",
      "summary": "An in-flight heartbeat could recreate the lock after release.",
      "fixedInCommit": "808b555187a3aae6bf036713b5072e86aa31f829"
    },
    {
      "id": "R8-L2",
      "severity": "low",
      "status": "accepted",
      "summary": "release() removes without re-checking the token.",
      "acceptedBecause": "CHANGELOG: release() removes the file after reading the token and does not re-check it at the remove."
    },
    {
      "id": "R8-L3",
      "severity": "low",
      "status": "fixed",
      "summary": "A lock path that cannot be read was neither unreadable nor passed through.",
      "fixedInCommit": "808b555187a3aae6bf036713b5072e86aa31f829"
    },
    {
      "id": "R8-L4",
      "severity": "low",
      "status": "accepted",
      "summary": "A live holder can be made to look junk.",
      "acceptedBecause": "CHANGELOG: a live CLI holder with an empty host name looks like junk (decodeLock rejects an empty host), so abandon goes past it."
    },
    {
      "id": "R8-L5",
      "severity": "low",
      "status": "accepted",
      "summary": "Release can hang the outcome.",
      "acceptedBecause": "CHANGELOG: release has no timeout."
    },
    {
      "id": "R8-L6",
      "severity": "low",
      "status": "accepted",
      "summary": "A dead holder on the same machine blocks plugin abandon.",
      "acceptedBecause": "CHANGELOG: a crashed CLI publisher blocks the plugin abandon for up to 15 minutes because the plugin treats a CLI holder as live."
    },
    {
      "id": "R8-L7",
      "severity": "low",
      "status": "fixed",
      "summary": "The abandon outcome could report zero files as success.",
      "fixedInCommit": "808b555187a3aae6bf036713b5072e86aa31f829"
    },
    {
      "id": "R8-L8",
      "severity": "low",
      "status": "fixed",
      "summary": "The partial-move path dropped the without-lock note.",
      "fixedInCommit": "808b555187a3aae6bf036713b5072e86aa31f829"
    },
    {
      "id": "R9-M1",
      "severity": "medium",
      "status": "accepted",
      "summary": "A transient read error on a live holder's lock makes abandon run without the lock.",
      "acceptedBecause": "Recorded as accepted backlog by the lead after the last read of the abandon and lock code (no further fix round); abandon's no-lock branch is a best-effort fail-open by design (CHANGELOG, eighth round)."
    },
    {
      "id": "R9-M2",
      "severity": "medium",
      "status": "accepted",
      "summary": "The re-read is not an atomic check and the fixed text does not say so.",
      "acceptedBecause": "Recorded as accepted backlog by the lead after the last read of the abandon and lock code (no further fix round); abandon's no-lock branch is a best-effort fail-open by design (CHANGELOG, eighth round)."
    },
    {
      "id": "R9-M3",
      "severity": "medium",
      "status": "accepted",
      "summary": "takeOver's put-back can orphan the live lock so the live holder loses it.",
      "acceptedBecause": "Recorded as accepted backlog by the lead after the last read of the abandon and lock code (no further fix round); abandon's no-lock branch is a best-effort fail-open by design (CHANGELOG, eighth round)."
    },
    {
      "id": "R9-L1",
      "severity": "low",
      "status": "accepted",
      "summary": "A dangling symlink at the lock path traps abandon as busy.",
      "acceptedBecause": "Recorded as accepted backlog by the lead after the last read of the abandon and lock code (no further fix round); abandon's no-lock branch is a best-effort fail-open by design (CHANGELOG, eighth round)."
    },
    {
      "id": "R9-L2",
      "severity": "low",
      "status": "accepted",
      "summary": "release() waits with no bound on a hung network file system.",
      "acceptedBecause": "Recorded as accepted backlog by the lead after the last read of the abandon and lock code (no further fix round); abandon's no-lock branch is a best-effort fail-open by design (CHANGELOG, eighth round)."
    },
    {
      "id": "R9-L3",
      "severity": "low",
      "status": "accepted",
      "summary": "Two concurrent release() calls both run the read and remove steps.",
      "acceptedBecause": "Recorded as accepted backlog by the lead after the last read of the abandon and lock code (no further fix round); abandon's no-lock branch is a best-effort fail-open by design (CHANGELOG, eighth round)."
    },
    {
      "id": "R9-L4",
      "severity": "low",
      "status": "accepted",
      "summary": "A .taken file is never swept.",
      "acceptedBecause": "Recorded as accepted backlog by the lead after the last read of the abandon and lock code (no further fix round); abandon's no-lock branch is a best-effort fail-open by design (CHANGELOG, eighth round)."
    },
    {
      "id": "R9-L5",
      "severity": "low",
      "status": "accepted",
      "summary": "The lock-held text advises publish --break-lock when abandon surfaces it.",
      "acceptedBecause": "Recorded as accepted backlog by the lead after the last read of the abandon and lock code (no further fix round); abandon's no-lock branch is a best-effort fail-open by design (CHANGELOG, eighth round)."
    },
    {
      "id": "H-M1",
      "severity": "medium",
      "status": "fixed",
      "summary": "A malformed node response made the response handler throw, hanging the run and holding the sync lock.",
      "fixedInCommit": "7a9ce77c65d152bcf06f37056ac9af5a2ea694ec"
    },
    {
      "id": "H-M2",
      "severity": "medium",
      "status": "fixed",
      "summary": "On desktop the transport silently fell back to requestUrl, which follows redirects.",
      "fixedInCommit": "7a9ce77c65d152bcf06f37056ac9af5a2ea694ec"
    },
    {
      "id": "H-M3",
      "severity": "medium",
      "status": "accepted",
      "summary": "Two readers buffer the whole body with no cap.",
      "acceptedBecause": "CHANGELOG: tenth-round backlog, files/write responses and fetchGatewayBytes read the body with no cap; this predates the transport change."
    },
    {
      "id": "H-L1",
      "severity": "low",
      "status": "fixed",
      "summary": "A custom auth header could be named Host, Transfer-Encoding, Connection, Content-Length, Upgrade, Expect or TE.",
      "fixedInCommit": "7a9ce77c65d152bcf06f37056ac9af5a2ea694ec"
    },
    {
      "id": "H-L2",
      "severity": "low",
      "status": "accepted",
      "summary": "TLS error classification is incomplete and over-broad.",
      "acceptedBecause": "CHANGELOG: the TLS classification is partly closed in f74cd96 (ERR_SSL_* no longer points to NODE_EXTRA_CA_CERTS); other certificate codes pass Node's text through, escaped."
    },
    {
      "id": "H-L3",
      "severity": "low",
      "status": "fixed",
      "summary": "The host bridge kept a latent bypass of the Node transport through a fetch default.",
      "fixedInCommit": "f74cd9664a5d955ae4d6cba73a61591fb9cf4648"
    },
    {
      "id": "H-L4",
      "severity": "low",
      "status": "fixed",
      "summary": "Stale or untrue comments and hints, including the CORS hint saying the plugin uses requestUrl.",
      "fixedInCommit": "7a9ce77c65d152bcf06f37056ac9af5a2ea694ec"
    },
    {
      "id": "I-H1",
      "severity": "high",
      "status": "fixed",
      "summary": "Aborting a Node-transport request threw inside the error listener and could leave the promise pending forever.",
      "fixedInCommit": "f74cd9664a5d955ae4d6cba73a61591fb9cf4648"
    },
    {
      "id": "I-M1",
      "severity": "medium",
      "status": "accepted",
      "summary": "No timeout; a stalled node holds the shared lock indefinitely.",
      "acceptedBecause": "CHANGELOG: the Node transport has no request timeout and no idle deadline; by design, no caller passes a signal."
    },
    {
      "id": "I-M2",
      "severity": "medium",
      "status": "fixed",
      "summary": "Connection-framing headers were blocked only for the auth header name, not in the transport.",
      "fixedInCommit": "f74cd9664a5d955ae4d6cba73a61591fb9cf4648"
    },
    {
      "id": "I-M3",
      "severity": "medium",
      "status": "fixed",
      "summary": "Hosts built without a transport defaulted to WebView fetch, which bypasses the desktop guarantee.",
      "fixedInCommit": "f74cd9664a5d955ae4d6cba73a61591fb9cf4648"
    },
    {
      "id": "I-L1",
      "severity": "low",
      "status": "fixed",
      "summary": "The abort listener leaked on the success path.",
      "fixedInCommit": "f74cd9664a5d955ae4d6cba73a61591fb9cf4648"
    },
    {
      "id": "I-L2",
      "severity": "low",
      "status": "fixed",
      "summary": "The CORS hint was misleading.",
      "fixedInCommit": "f74cd9664a5d955ae4d6cba73a61591fb9cf4648"
    },
    {
      "id": "I-L3",
      "severity": "low",
      "status": "fixed",
      "summary": "Stale comments contradicted the new transport design.",
      "fixedInCommit": "f74cd9664a5d955ae4d6cba73a61591fb9cf4648"
    },
    {
      "id": "I-L4",
      "severity": "low",
      "status": "fixed",
      "summary": "ERR_SSL_* was reported as a certificate failure and pointed at NODE_EXTRA_CA_CERTS.",
      "fixedInCommit": "f74cd9664a5d955ae4d6cba73a61591fb9cf4648"
    },
    {
      "id": "I-L5",
      "severity": "low",
      "status": "fixed",
      "summary": "net.fetch with a Blob body always failed on both transports.",
      "fixedInCommit": "f74cd9664a5d955ae4d6cba73a61591fb9cf4648"
    },
    {
      "id": "I-L6",
      "severity": "low",
      "status": "fixed",
      "summary": "A custom auth header named Content-Type or Range collided with the real request header.",
      "fixedInCommit": "f74cd9664a5d955ae4d6cba73a61591fb9cf4648"
    },
    {
      "id": "J-M1",
      "severity": "medium",
      "status": "accepted",
      "summary": "A silent node still leaves the promise pending forever.",
      "acceptedBecause": "CHANGELOG: the Node transport has no request timeout and no idle deadline: a node that accepts the connection and goes silent leaves the call pending; by design, no caller passes a signal."
    },
    {
      "id": "J-M2",
      "severity": "medium",
      "status": "accepted",
      "summary": "Host bridge net.fetch buffers the whole response with no cap.",
      "acceptedBecause": "CHANGELOG: net.fetch in the host bridge buffers the whole response with no byte cap; no caller uses it and it throws when no transport is injected."
    },
    {
      "id": "J-L1",
      "severity": "low",
      "status": "accepted",
      "summary": "A body that closes without end or error never settles the stream.",
      "acceptedBecause": "CHANGELOG: a body stream that closes with neither end nor error is not explicitly errored."
    },
    {
      "id": "J-L2",
      "severity": "low",
      "status": "accepted",
      "summary": "A process-level TLS verification override would apply to credentialed requests.",
      "acceptedBecause": "CHANGELOG: NODE_TLS_REJECT_UNAUTHORIZED=0 in Obsidian's environment would disable certificate verification because the transport sets no rejectUnauthorized."
    },
    {
      "id": "J-L3",
      "severity": "low",
      "status": "accepted",
      "summary": "The TLS remedy omits that the variable must be set before Obsidian starts.",
      "acceptedBecause": "The remedy text is accurate; the launch-environment point (NODE_EXTRA_CA_CERTS must be set where Obsidian is launched) went into the CHANGELOG and docs, not the message."
    },
    {
      "id": "J-L4",
      "severity": "low",
      "status": "accepted",
      "summary": "Some errors still carry Node's own text.",
      "acceptedBecause": "CHANGELOG: some Node error texts outside the two TLS classes (ERR_OSSL_*, invalid protocol) pass through, escaped."
    },
    {
      "id": "J-L5",
      "severity": "low",
      "status": "accepted",
      "summary": "The CORS-hint comment says Failed to fetch comes only from WebView fetch, which is Chromium-specific.",
      "acceptedBecause": "Comment wording only, harmless on desktop in the reviewer's own words; accepted by the lead and not changed."
    },
    {
      "id": "J-L6",
      "severity": "low",
      "status": "accepted",
      "summary": "escapeNodeText leaves some invisible characters unescaped.",
      "acceptedBecause": "CHANGELOG: escapeNodeText does not cover U+2061 to U+2064, U+180E, U+034F and U+FFF9 to U+FFFB."
    },
    {
      "id": "K-M1",
      "severity": "medium",
      "status": "accepted",
      "summary": "The files/write reply is read uncapped (src/kubo/rpc-call.ts:105).",
      "acceptedBecause": "Accepted at HEAD fdc4ccf, not fixed on this branch: the files/write reply is read uncapped (CHANGELOG tenth-round backlog, predates the transport change)."
    },
    {
      "id": "K-L1",
      "severity": "low",
      "status": "accepted",
      "summary": "gatewayFetch is uncapped and typed into the pull client.",
      "acceptedBecause": "Accepted at HEAD fdc4ccf: fetchGatewayBytes is uncapped but no caller uses it (CHANGELOG tenth-round backlog)."
    },
    {
      "id": "K-L2",
      "severity": "low",
      "status": "accepted",
      "summary": "The on-load stale-temp sweep is skipped whenever catch-up is enabled.",
      "acceptedBecause": "Accepted at HEAD fdc4ccf, not fixed on this branch: the reviewer rated it LOW at confidence 65 and the pull engine may sweep on its own."
    },
    {
      "id": "K-L3",
      "severity": "low",
      "status": "accepted",
      "summary": "Plugin unload cannot cancel an in-flight run.",
      "acceptedBecause": "Accepted at HEAD fdc4ccf, not fixed on this branch: the reviewer rated it LOW at confidence 45 and it needs a hung request plus a plugin disable."
    },
    {
      "id": "K-L4",
      "severity": "low",
      "status": "accepted",
      "summary": "A throw from the Resolve fork confirmation is unhandled.",
      "acceptedBecause": "Accepted at HEAD fdc4ccf, not fixed on this branch: the reviewer rated it LOW at confidence 35 and no lock is held when it throws."
    },
    {
      "id": "K-L5",
      "severity": "low",
      "status": "accepted",
      "summary": "Notices print error.message unescaped and a path-token URL shows in full.",
      "acceptedBecause": "Accepted at HEAD fdc4ccf, not fixed on this branch: display only; a secret in a URL path would show in notices (CHANGELOG already lists path-embedded secrets)."
    }
  ]
}
<!-- /guard-review -->
