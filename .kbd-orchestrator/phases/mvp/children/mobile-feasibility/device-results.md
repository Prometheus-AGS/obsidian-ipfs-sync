# Device results, mobile-feasibility (iPhone, iOS 27.2 beta, Obsidian 1.13.7 build 365)

Recorded 2026-10-02 from operator screenshots and reports. Not independently reproduced by an agent.

| Check | Build | Result | Evidence |
|---|---|---|---|
| BRAT install, plugin loads, settings tab renders | v0.2.0 | pass | screenshots 2-4 |
| Pull with empty pull name | v0.2.0 | expected refusal notice | screenshot 1 |
| First pull crash, then launch crash loop | v0.2.0 | iOS file-provider hang (0x8BADF00D scene-create watchdog, main thread in FPXPCAutomaticErrorProxy / URL(resolvingBookmarkData:)), cleared by phone restart. Original trigger unexplained. | App-2026-10-01-095409.ips, App-2026-10-01-095703.ips |
| Plaintext pull, 5 files, 24 KB | v0.2.0 | pass: "5 fetched, 0 unchanged, 0 conflicts, 0 failed" | screenshot 7 |
| Plaintext pull, 50 MB + 5 MB random files | v0.2.0 | pass (operator report; time and responsiveness not recorded) | operator message |
| Argon2id timing, 64 MiB t=3 p=1, 3 runs | 0.2.1-probe.1 (cebc71c + probe.diff) | 980 ms / 1143 ms / 1133 ms; longest event-loop gap 21 / 17 / 17 ms. Thresholds: under 3 s, gap under 100 ms. Pass. | screenshot 9 |
| Argon2id timing, 16 MiB t=3 p=1 (diagnostic) | same | 249 ms, gap 17 ms | screenshot 9 |

Mac baseline for the same function (Node 24.16.0): 990-1177 ms, gap 13-20 ms. The phone is within about 10% of the Mac.

Still unmeasured: encrypted publish and pull on a phone, background and suspend behaviour, memory above 50 MB, Android, the cause of the first crash, whether the full note file `ipfs-sync-argon-probe.md` agrees with the notices (only the notice text was seen).

Cleanup owed (needs operator approval): GitHub pre-release 0.2.1-probe.1; node keys obsidian-vault-phone-test-1 and obsidian-vault-phone-test-big with their MFS roots; iCloud vault probe-test.
