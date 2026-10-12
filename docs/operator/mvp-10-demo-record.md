# mvp-10 demo record — real-vault round trip and Release 3 (v0.4.0)

This is the single record for `openspec/changes/mvp-10-real-vault-publish-and-release`.
Sections 1–6 are filled during the operator-run demo (the run-sheets
`mvp-10-secret-scan.md` and `mvp-10-demo-run.md` carry the procedures); sections 7–9 are
filled by the team at tasks 5.2/5.3/6.1/6.2. Task 6.2 checks every section is present.

Absolute rules (from the run-sheets): no file contents, no key material, no matched secret
text in this record — names only, abbreviated (first 20 chars of the vault-relative path +
`…` + length). Scan reports live under `/tmp/` and are deleted after adjudication.

## 0. Pre-demo node baseline (read-only, captured by lead 2026-10-06)

`ipfs files ls /obsidian-vault-sync` (kubectl context `know-me`, namespace `ipfs`, pod
`ipfs-0`, container `ipfs`) — 13 roots:

```
mvp02-demo mvp03-demo mvp04-demo mvp05-demo mvp06-demo mvp06-probe mvp07a-demo
mvp07b-demo mvp08-demo phone-test-1 phone-test-big publish-real-20260929 real-obsidian
```

`ipfs files ls -l /obsidian-vault-sync/real-obsidian`:

```
keyslots.json  bafkreifaiwkj3ubsr5xay64psolyksrxqxeklryp7ahvfhznnxe3kvx7y4  594
```

The demo root holds only the aborted-run `keyslots.json` — the adopt-path precondition of
task 2.3 (no `manifest.enc`, no other entries). The gate build the operator installs at 3.1:
`dist/plugin/main.js` sha256 `fd46e1050230383e865a4062a7024614ee9d9542c73dc2aa690de3500590423a`
(verified unchanged this date; no source file newer than the build).

## 1. Operator gate 2.1 — secret scan

Agent-run under design decision D-E (operator authorization 2026-10-11,
`.kbd-orchestrator/phases/mvp/execution.md`); the operator adjudicated.

- Name-scan list provenance: reconstructed 2026-10-06, pattern
  `password|secret|credential|cert|gpg` on publishable `.md` basenames, count 36
  (2026-10-05 scan recorded the count only; list not persisted).
- Content scan tool: gitleaks (`gitleaks dir --redact`), run by the agent
- Tool version: 8.30.1
- Scan date: 2026-10-11
- Publishable set at scan time: 4,825 files / 1,001,531,092 bytes
- Scanner coverage caveat: gitleaks scanned 671.95 MB of the ~954 MiB publishable set;
  binary-detected files (PDFs and similar) are skipped by the scanner.
- Content findings in the publishable set: 686 findings across 134 files
  (440 of them — 64% — in two files: `Keys and Stuff.md…` (len 17) and
  `skytok/Supabase.md…` (len 19))
- OpenAI-key-shaped finding remaining in publishable set: none live — 8 files carry
  `openai-api-key` findings and the operator revoked all old OpenAI keys on
  2026-10-11 (§2), so no live OpenAI credential remains.
- Overall verdict: **GO** — the leaked key is revoked; every other finding is knowingly
  retained and published encrypted (`kept`, D-E) or is a name-only false positive.
- Adjudication method, stated plainly: the operator reviewed the full printed finding
  list (153 rows, session of 2026-10-11), adjudicated `Keys and Stuff.md…` individually
  ("real keys, and that is why we encrypt that file before pushing to IPFS"), and gave a
  bulk `kept` verdict for the remainder, directing completion. Per-file liveness was
  not individually verified beyond the OpenAI revocation; the bulk verdict and its basis
  are recorded here rather than presented as 153 individual reviews.
- Operator worksheet with full paths: `/tmp/mvp10-adjudication.md` (local, deleted after
  adjudication per the run-sheet rules).

### Content findings adjudication (134 files)

| # | file (abbreviated) | findings | detector rules | verdict | note |
|---|--------------------|----------|----------------|---------|------|
| 1 | ai/Base prompt.md… (len 17) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 2 | ai/code/Bot Improvem… (len 35) | 4 | curl-auth-header | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 3 | anthropic/API Key.md… (len 20) | 2 | anthropic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 4 | aws/Access Keys.md… (len 18) | 2 | generic-api-key,aws-access-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 5 | Brius/agents/Brius B… (len 56) | 3 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 6 | Brius/Data/brius-mas… (len 41) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 7 | Brius/Data/connectio… (len 32) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 8 | Brius/Data/queries/b… (len 40) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 9 | Brius/samples/patien… (len 31) | 1 | jwt | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 10 | Brius/samples/Patien… (len 41) | 1 | jwt | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 11 | Brius/SYSTEM_PROMPT.… (len 22) | 3 | jwt,generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 12 | cal.com/Password.md… (len 19) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 13 | cloudflare/WebRTC AP… (len 24) | 5 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 14 | compass_coach/avatar… (len 31) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 15 | compass_coach/liveki… (len 38) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 16 | dify/Calling Dify Ch… (len 26) | 1 | curl-auth-header | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 17 | dify/Calling Dify Wo… (len 30) | 1 | curl-auth-header | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 18 | doordash/DoorDash AP… (len 29) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 19 | foodonthestove/Strip… (len 29) | 1 | stripe-access-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 20 | github/Actions Acces… (len 30) | 2 | github-pat,github-fine-grained-pat | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 21 | github/IDE Access To… (len 26) | 1 | github-pat | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 22 | google/Gemini Api Ke… (len 24) | 3 | gcp-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 23 | grafana/CompassCoach… (len 23) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 24 | heygen/Avatar API To… (len 26) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 25 | IDX/Github Token.md… (len 19) | 1 | github-fine-grained-pat | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 26 | Keys and Stuff.md… (len 17) | 253 | private-key,slack-app-token,sentry-user-token,anthropic-api-key,gcp-api-key,sentry-access-token,cohere-api-token,github-fine-grained-pat,huggingface-access-token,digitalocean-pat,azure-ad-client-secret,generic-api-key,npm-access-token,openai-api-key,aws-access-token,perplexity-api-key,jwt,github-pat | kept | operator, 2026-10-11: "real keys, and that is why we encrypt that file before pushing to IPFS" |
| 27 | kokab/bible/bible st… (len 32) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 28 | langfuse/Keys.md… (len 16) | 4 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 29 | langsmith/API Key.md… (len 20) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 30 | linode/Keys.md… (len 14) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 31 | livepeer/LivePeer.md… (len 20) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 32 | next.js/markdown_doc… (len 69) | 1 | linkedin-client-secret | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 33 | paperbase/Supabase.m… (len 21) | 2 | jwt | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 34 | pinata/Credentials f… (len 31) | 6 | generic-api-key,jwt | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 35 | plaid/Client ID.md… (len 18) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 36 | prometheus-proxy/Ima… (len 33) | 1 | curl-auth-header | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 37 | prometheus/ai/I-Con … (len 45) | 1 | curl-auth-header | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 38 | prometheus/cca-biolo… (len 44) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 39 | qdrant/ApiKey.md… (len 16) | 2 | curl-auth-header,generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 40 | reveles/Key Master.m… (len 21) | 4 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 41 | skytok/Runway.md… (len 16) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 42 | skytok/Supabase.md… (len 18) | 187 | perplexity-api-key,jwt,github-pat,private-key,slack-app-token,sentry-user-token,anthropic-api-key,gcp-api-key,sentry-access-token,cohere-api-token,github-fine-grained-pat,huggingface-access-token,digitalocean-pat,azure-ad-client-secret,generic-api-key,openai-api-key,aws-access-token | rotated | no live credential remains after the 2026-10-11 OpenAI key revocation (§2) |
| 43 | supabase/docs/Local … (len 37) | 1 | curl-auth-header | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 44 | supabase/docs/Vault.… (len 22) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 45 | tribe 2/1Password.md… (len 20) | 2 | generic-api-key,1password-secret-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 46 | tribe 2/Amazon/Tribe… (len 31) | 2 | generic-api-key,aws-access-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 47 | tribe 2/Anthropic/Cl… (len 35) | 5 | anthropic-api-key,generic-api-key,aws-access-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 48 | tribe 2/Azure/Open A… (len 32) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 49 | tribe 2/Azure/Open A… (len 29) | 3 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 50 | tribe 2/budibase/val… (len 31) | 3 | generic-api-key,aws-access-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 51 | tribe 2/chatgpt/RIME… (len 30) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 52 | tribe 2/Chatwoot Dia… (len 28) | 1 | gcp-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 53 | tribe 2/claude/API K… (len 25) | 3 | anthropic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 54 | tribe 2/code interpr… (len 40) | 6 | generic-api-key,aws-access-token,jwt | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 55 | tribe 2/code interpr… (len 63) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 56 | tribe 2/code interpr… (len 53) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 57 | tribe 2/code interpr… (len 57) | 2 | generic-api-key,aws-access-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 58 | tribe 2/code interpr… (len 60) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 59 | tribe 2/code interpr… (len 62) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 60 | tribe 2/code interpr… (len 60) | 1 | mailgun-signing-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 61 | tribe 2/code interpr… (len 61) | 4 | twilio-api-key,generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 62 | tribe 2/code interpr… (len 48) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 63 | tribe 2/code interpr… (len 48) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 64 | tribe 2/code interpr… (len 57) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 65 | tribe 2/Coinbase API… (len 29) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 66 | tribe 2/comerica/Cre… (len 31) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 67 | tribe 2/digital ocea… (len 34) | 3 | digitalocean-pat,generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 68 | tribe 2/Docker Login… (len 29) | 3 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 69 | tribe 2/Docusign.md… (len 19) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 70 | tribe 2/ethoscare/Lo… (len 27) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 71 | tribe 2/ethoscare/pr… (len 26) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 72 | tribe 2/ethoscare/Se… (len 29) | 1 | sendgrid-api-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 73 | tribe 2/ethoscare/Su… (len 29) | 4 | generic-api-key,jwt | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 74 | tribe 2/ethoscare/Te… (len 36) | 4 | hashicorp-tf-api-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 75 | tribe 2/ethoscare/Te… (len 47) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 76 | tribe 2/git/Git Toke… (len 25) | 1 | github-pat | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 77 | tribe 2/GitHub Acces… (len 30) | 1 | github-pat | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 78 | tribe 2/Google Cloud… (len 38) | 1 | gcp-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 79 | tribe 2/Google Cloud… (len 44) | 1 | gcp-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 80 | tribe 2/Google Gemin… (len 47) | 1 | gcp-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 81 | tribe 2/Greenscape/G… (len 34) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 82 | tribe 2/Greenscape/R… (len 26) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 83 | tribe 2/hugginface t… (len 27) | 1 | huggingface-access-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 84 | tribe 2/huggingface/… (len 28) | 2 | huggingface-access-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 85 | tribe 2/lens/Activat… (len 31) | 3 | jwt | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 86 | tribe 2/livekit/Edus… (len 39) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 87 | tribe 2/mailgun/API … (len 26) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 88 | tribe 2/medcom/AWS C… (len 37) | 5 | generic-api-key,aws-access-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 89 | tribe 2/medcom/AWS P… (len 39) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 90 | tribe 2/medcom/CMNRe… (len 39) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 91 | tribe 2/medcom/Medco… (len 30) | 1 | private-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 92 | tribe 2/medcom/Supab… (len 34) | 2 | jwt | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 93 | tribe 2/mindtrust/be… (len 40) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 94 | tribe 2/mindtrust/be… (len 39) | 2 | generic-api-key,aws-access-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 95 | tribe 2/mindtrust/be… (len 41) | 3 | generic-api-key,stripe-access-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 96 | tribe 2/mindtrust/be… (len 56) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 97 | tribe 2/mindtrust/be… (len 40) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 98 | tribe 2/mindtrust/ed… (len 32) | 2 | generic-api-key,aws-access-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 99 | tribe 2/mindtrust/ma… (len 48) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 100 | tribe 2/mindtrust/Se… (len 37) | 3 | sendgrid-api-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 101 | tribe 2/mindtrust/sy… (len 41) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 102 | tribe 2/mindtrust/Te… (len 33) | 2 | github-pat,hashicorp-tf-api-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 103 | tribe 2/minikube/Doc… (len 32) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 104 | tribe 2/mistral/API … (len 26) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 105 | tribe 2/mistral/gqad… (len 39) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 106 | tribe 2/mistral/Trib… (len 37) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 107 | tribe 2/Monday.com/A… (len 31) | 1 | jwt | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 108 | tribe 2/obsidian/Git… (len 23) | 1 | github-pat | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 109 | tribe 2/Open AI/API … (len 30) | 1 | openai-api-key | rotated | no live credential remains after the 2026-10-11 OpenAI key revocation (§2) |
| 110 | tribe 2/Open AI/Azur… (len 37) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 111 | tribe 2/Open AI/Brow… (len 34) | 2 | openai-api-key | rotated | no live credential remains after the 2026-10-11 OpenAI key revocation (§2) |
| 112 | tribe 2/Open AI/gqad… (len 43) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 113 | tribe 2/Open AI/me.c… (len 25) | 2 | openai-api-key | rotated | no live credential remains after the 2026-10-11 OpenAI key revocation (§2) |
| 114 | tribe 2/Open AI/Trib… (len 37) | 1 | openai-api-key | rotated | no live credential remains after the 2026-10-11 OpenAI key revocation (§2) |
| 115 | tribe 2/opendevin/GP… (len 26) | 1 | openai-api-key | rotated | no live credential remains after the 2026-10-11 OpenAI key revocation (§2) |
| 116 | tribe 2/Optimum Inte… (len 33) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 117 | tribe 2/perplexity/A… (len 29) | 1 | perplexity-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 118 | tribe 2/personal/Aut… (len 24) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 119 | tribe 2/personal/Lin… (len 25) | 5 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 120 | tribe 2/personal/Pas… (len 28) | 1 | stripe-access-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 121 | tribe 2/Postman/Api … (len 26) | 1 | postman-api-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 122 | tribe 2/sendgrid/API… (len 27) | 2 | sendgrid-api-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 123 | tribe 2/Supabase Tok… (len 25) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 124 | tribe 2/syra/CircleC… (len 24) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 125 | tribe 2/syra/test gr… (len 28) | 5 | curl-auth-header,generic-api-key,jwt | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 126 | tribe 2/syra/Test Kr… (len 32) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 127 | tribe 2/tjames@mindt… (len 43) | 1 | aws-access-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 128 | tribe 2/Tooljet Goog… (len 31) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 129 | tribe 2/Tribe Core/L… (len 29) | 4 | generic-api-key,openai-api-key,jwt | rotated | no live credential remains after the 2026-10-11 OpenAI key revocation (§2) |
| 130 | tribe 2/tribe health… (len 33) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 131 | tribe 2/tribe health… (len 35) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 132 | tribe 2/UTD/BlackBoa… (len 29) | 2 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 133 | TribeMedia/Web Zitad… (len 31) | 1 | generic-api-key | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 134 | zitadel/SMTP Sendgri… (len 24) | 1 | sendgrid-api-token | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |

### Name-list adjudication (36/36)

| # | name (abbreviated) | len | kw | verdict | note |
|---|--------------------|-----|----|---------|------|
| 1 | Obsidian-wiki/wiki/c… (len 61) | 61 | cert | false positive | name-only match; no content finding in the scan |
| 2 | Obsidian-wiki/wiki/c… (len 45) | 45 | cert | false positive | name-only match; no content finding in the scan |
| 3 | TRemote/Azure/Passwo… (len 25) | 25 | password | false positive | name-only match; no content finding in the scan |
| 4 | cal.com/Password.md… (len 19) | 19 | password | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 5 | pinata/Credentials f… (len 31) | 31 | credential | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 6 | prometheus/postgres/… (len 40) | 40 | password | false positive | name-only match; no content finding in the scan |
| 7 | skytok/Bsky App Pass… (len 27) | 27 | password | false positive | name-only match; no content finding in the scan |
| 8 | tribe 2/1Password.md… (len 20) | 20 | password | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 9 | tribe 2/AT&T/Site Pa… (len 29) | 29 | password | false positive | name-only match; no content finding in the scan |
| 10 | tribe 2/Azure/Passwo… (len 25) | 25 | password | false positive | name-only match; no content finding in the scan |
| 11 | tribe 2/BitBucket fo… (len 44) | 44 | password | false positive | name-only match; no content finding in the scan |
| 12 | tribe 2/GPG Notes an… (len 49) | 49 | gpg, gpg, password | false positive | name-only match; no content finding in the scan |
| 13 | tribe 2/ITForP passw… (len 26) | 26 | password | false positive | name-only match; no content finding in the scan |
| 14 | tribe 2/Iota/Shimmer… (len 46) | 46 | password | false positive | name-only match; no content finding in the scan |
| 15 | tribe 2/Musiq Soulch… (len 74) | 74 | cert, cert | false positive | name-only match; no content finding in the scan |
| 16 | tribe 2/Proem/Passwo… (len 36) | 36 | password | false positive | name-only match; no content finding in the scan |
| 17 | tribe 2/QuickBooks/P… (len 30) | 30 | password | false positive | name-only match; no content finding in the scan |
| 18 | tribe 2/Tribe Core/U… (len 66) | 66 | gpg | false positive | name-only match; no content finding in the scan |
| 19 | tribe 2/budibase/sec… (len 27) | 27 | secret | false positive | name-only match; no content finding in the scan |
| 20 | tribe 2/code interpr… (len 53) | 53 | password | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 21 | tribe 2/livekit/Edus… (len 39) | 39 | credential | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 22 | tribe 2/medcom/AWS C… (len 37) | 37 | credential | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 23 | tribe 2/medcom/AWS P… (len 39) | 39 | password | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 24 | tribe 2/memphis/Loca… (len 46) | 46 | password | false positive | name-only match; no content finding in the scan |
| 25 | tribe 2/microk8s/CA … (len 27) | 27 | cert | false positive | name-only match; no content finding in the scan |
| 26 | tribe 2/microk8s/CRD… (len 47) | 47 | cert | false positive | name-only match; no content finding in the scan |
| 27 | tribe 2/mindtrust/ma… (len 48) | 48 | credential | kept | kept — bulk verdict; operator reviewed the full printed list 2026-10-11 and directed completion; per-file liveness not individually verified; protection is at-rest encryption to the operator's own node (D-E) |
| 28 | tribe 2/mindtrust/sy… (len 44) | 44 | password | false positive | name-only match; no content finding in the scan |
| 29 | tribe 2/minikube/Sel… (len 37) | 37 | cert | false positive | name-only match; no content finding in the scan |
| 30 | tribe 2/minikube/Sel… (len 39) | 39 | cert | false positive | name-only match; no content finding in the scan |
| 31 | tribe 2/personal/AT&… (len 33) | 33 | password | false positive | name-only match; no content finding in the scan |
| 32 | tribe 2/stanley/Pass… (len 27) | 27 | password | false positive | name-only match; no content finding in the scan |
| 33 | tribe 2/supabase/My … (len 38) | 38 | password | false positive | name-only match; no content finding in the scan |
| 34 | tribe 2/syra/Argo Ad… (len 35) | 35 | password | false positive | name-only match; no content finding in the scan |
| 35 | tribe 2/tribe health… (len 45) | 45 | password | false positive | name-only match; no content finding in the scan |
| 36 | tribe 2/tribemedia/A… (len 39) | 39 | password | false positive | name-only match; no content finding in the scan |

## 2. Operator gate 2.2 — OpenAI key rotation

- Rotation date: 2026-10-11
- Old key revoked: yes — operator's words: "revoked N old keys on 2026-10-11; no
  replacement needed, I use the local proxy" (the local proxy at
  `http://localhost:8181` attaches to Codex and needs no API key, so no replacement
  was issued)
- New key issued and stored: not applicable — no replacement needed
- No key bytes in the repository, this record, or the publishable set (2.1 confirms
  the last): confirmed — the scan reports were redacted and live only in `/tmp`;
  the key-shaped strings remaining in vault notes are the revoked (dead) keys

## 3. Demo plan decisions (tasks 2.3d/D-D and the key decision)

Resolved by decision D-E (2026-10-11): the demo runs via the CLI gate build, so —

- The 195.4 MiB file (`Obsidian-wiki/.llm-wiki/file-change-queue.json`): **published as
  is** — the CLI has no read cap; the plugin-route read-cap decision is moot for the demo.
- `.llm-wiki/` (1,461 churning files): **stays in** (default; it is the churn the
  hardening exists for).
- Publication key: **Option B — fresh name `obsidian-vault-real`** (D-E default; the
  operator did not override). `obsidian-vault-sync` keeps pointing at the mvp-06 demo
  root; the new key is created by the publish and its ID recorded in the demo config file.
- User exclusion additions from 2.1: none (no exclusion verdicts; the CLI path could not
  implement them — D-E).
- Exclusion hash: not applicable on the CLI path (no user-exclusion option); the plugin
  settings-tab hash is recorded only if the optional plugin smoke run happens.

## 4. Task 3.1 — publish (agent-run under D-E, CLI gate build)

- Command: `IPFS_SYNC_RPC_URL/IPFS_SYNC_GATEWAY_URL=https://ipfs.prometheusags.ai
  IPFS_SYNC_PASSPHRASE_FILE=/Users/gqadonis/.ipfs-sync-secrets/obsidian-real.pass
  node dist/cli/ipfs-sync.mjs publish /Users/gqadonis/obsidian
  --mfs-root /obsidian-vault-sync/real-obsidian --key obsidian-vault-real
  --config /Users/gqadonis/.config/ipfs-sync/config.json`
- Build: gate build from task 1.2 (`dist/cli/ipfs-sync.mjs` sha256
  `fc579fea7ad476bc4ed1f1939bca64e2bb7d1a23ff519e103105b78810c8062b`), Node v26.8.2
- Adopt path: plain publish, no `--repair`, no init — exactly as proven at 2.3; the
  leftover `keyslots.json`/passphrase pair was adopted (sequence starts at 1)
- Wall time: 652 s (2026-10-11T21:44:45Z → 21:55:37Z)
- Bytes sent: not printed by the CLI; the plaintext publishable set was
  1,001,531,092 bytes (954.9 MiB) — the pre-encryption figure; ciphertext adds
  per-file framing overhead
- File count: **4825 written, 0 removed** (equals the publishable set exactly)
- Publication key: `obsidian-vault-real`, created by this publish, ID
  `k51qzi5uqu5dlend4qc9g19x832i7tta6rxrz35ycnmbio8dndzvrx1cfpv4eb`, recorded in the
  demo config file's `ownedKeys`
- Root CID (IPNS value): `bafybeihoemb6amr2txinn4w4oabcttv3wpcufxbmmsyej6xxpeu54qzzwa`
- Snapshot (`current/`): `bafybeigcdchpg53d5z5kbrbniftd7t6ndnrxgbibh4cxygxqesqxjbdpny`
- Sequence: 1
- IPNS resolution result: `/ipns/k51qzi5uqu5dlend4qc9g19x832i7tta6rxrz35ycnmbio8dndzvrx1cfpv4eb`
  → `/ipfs/bafybeihoemb6amr2txinn4w4oabcttv3wpcufxbmmsyej6xxpeu54qzzwa` (matches)
- Skipped files: **none** — no file changed or vanished mid-read during the run; the 2
  known dangling symlinks are not regular files, so they are outside the publishable set
  by construction (silently skipped by design)
- CLI publish summary (paste):

  ```
  created key k51qzi5uqu5dlend4qc9g19x832i7tta6rxrz35ycnmbio8dndzvrx1cfpv4eb and recorded it in the config file
  root CID   bafybeihoemb6amr2txinn4w4oabcttv3wpcufxbmmsyej6xxpeu54qzzwa  (IPNS value)
  snapshot  bafybeigcdchpg53d5z5kbrbniftd7t6ndnrxgbibh4cxygxqesqxjbdpny  (current/)
  sequence  1
  4825 written, 0 removed
  ```

- Node-side confirmation (read-only, kubectl context `know-me`, ns `ipfs`, pod `ipfs-0`):

  ```
  $ ipfs files stat --hash /obsidian-vault-sync/real-obsidian/manifest.enc
  bafybeic6afqgyfrume5tjrjuvroc2oghqvdvnp5tabg7ivdjawun6i7y6u  (1,595,014 bytes)
  $ ipfs files ls -l /obsidian-vault-sync/real-obsidian
  current/        bafybeigcdchpg53d5z5kbrbniftd7t6ndnrxgbibh4cxygxqesqxjbdpny
  keyslots.json   bafkreifaiwkj3ubsr5xay64psolyksrxqxeklryp7ahvfhznnxe3kvx7y4  594
  manifest.enc    bafybeic6afqgyfrume5tjrjuvroc2oghqvdvnp5tabg7ivdjawun6i7y6u  1595014
  manifests/      bafybeiat3k74wl4q5tn25vvkza5weycydmqax2c5vl4md2yjatikaz6jaa
  ```

- Full publish log: session task output `bash-bm9sf86h` (4,825 `added` lines + summary).

## 5. Task 3.2 — pull into a fresh directory and compare (agent-run under D-E)

- Destination: `/tmp/mvp10-pull-target` (fresh, empty); same passphrase file;
  `--accept-first-pull` given (non-interactive harness).
- First attempt exited 1: the pull exceeded the CLI's 512 MiB confirmation ceiling and
  every file was reported unfetched (nothing was written). Re-ran with `--accept-large`
  — recorded here as a CLI ergonomics note for the docs.
- Pull result (21:57:26Z → 22:03:10Z, 343.4 s): **4825 fetched, 0 unchanged,
  0 conflicts, 0 integrity-failed, 0 unfetched, 0 skipped, 0 remote-deleted,
  0 locally modified**; root CID `bafybeihoemb6amr2txinn4w4oabcttv3wpcufxbmmsyej6xxpeu54qzzwa`
  equals the publish's IPNS value; sequence 1.
- Counts: published set 4,825 | pulled 4,825 | policy-skipped 0.
- sha256 comparison (`shasum -a 256` over both trees, the publish log's `added` list as
  the authoritative published set, target's `.ipfs-sync/` state excluded):
  **4,825 joined, 4,825 equal, 0 differ, 0 missing, 0 extra. Mismatch count: 0.**
- Expected drift: none observed — no file churned between publish and comparison.
- `ipfs-sync history` from a fresh CLI process (on-disk database; the middle row is the
  ceiling-declined first attempt):

  ```
  2026-10-11T22:03:10.090Z  pull      bafybeihoemb6amr2txinn4w4oabcttv3wpcufxbmmsyej6xxpeu54qzzwa  fetched 4825, unchanged 0, conflicted 0, failed 0, removed remotely 0, kept locally 0, 338710 ms
  2026-10-11T21:57:02.866Z  pull      bafybeihoemb6amr2txinn4w4oabcttv3wpcufxbmmsyej6xxpeu54qzzwa  fetched 0, unchanged 0, conflicted 0, failed 4825, removed remotely 0, kept locally 0, 2866 ms
  2026-10-11T21:55:37.486Z  publish   bafybeihoemb6amr2txinn4w4oabcttv3wpcufxbmmsyej6xxpeu54qzzwa  written 4825, removed 0, 650357 ms
  ```

## 6. Task 3.3 — mobile attempt (optional)

not run — mobile stays unverified (T3)

## 7. Release record and approval evidence (tasks 5.2, 5.3)

- Release record path: `dist/release/v0.4.0/` (local; `dist/` is gitignored, as with
  v0.3.0) — `main.js`, `manifest.json`, `ipfs-sync-cli-0.4.0.tgz`, `SHA256SUMS`,
  `release-notes.md`, `evidence.json`
- Checksum re-verification: the tool re-verified at write time; independently re-run:

  ```
  $ cd dist/release/v0.4.0 && shasum -a 256 -c SHA256SUMS
  ipfs-sync-cli-0.4.0.tgz: OK
  main.js: OK   (fd46e105… — identical to the demo gate build)
  manifest.json: OK
  ```

- Release notes gate check: `grep -ci 'airplane\|on-device' release-notes.md` → 1 hit,
  inside the gate sentence that says the iPhone run has not happened; the notes open
  with the can/cannot paragraph.
- Approval: the operator's 2026-10-06 pre-approval ("outward steps for v0.4.0 are
  pre-approved once the demo record is green", `.kbd-orchestrator/phases/mvp/execution.md`)
  stands as the single batched approval (D-B); the demo record went green (§5: 0
  mismatches) before any outward step ran.
- Executed outward steps: commit `87b87f8` ("feat: mvp-10 real-vault round trip and
  Release 3 (v0.4.0)"); annotated tag `v0.4.0` (tag object `d46008d6…`, target commit
  `87b87f8c90f98693bd4faaedaa97614488e24e50` — the SHA that shipped); branch push
  `ecb73dd..87b87f8 mvp-07b-guard-removal`; tag push;
  `gh release create v0.4.0 --repo Prometheus-AGS/obsidian-ipfs-sync --verify-tag
  --prerelease --latest=false` with the four assets and the notes file.
- `gh release view v0.4.0` output:

  ```json
  {"assets":["ipfs-sync-cli-0.4.0.tgz","main.js","manifest.json","SHA256SUMS"],"prerelease":true,"tag":"v0.4.0","target":"main","url":"https://github.com/Prometheus-AGS/obsidian-ipfs-sync/releases/tag/v0.4.0"}
  ```

- Publication receipt: **pending** — no first-party page with absolute asset URLs exists
  (same standing as Release 2).

## 8. Cleanup evidence (task 6.1 — pre-approved, executed once)

- Confirmation source: operator pre-approval "demo-root cleanup after each feature op"
  (`.kbd-orchestrator/phases/mvp/execution.md`, 2026-10-06 entry; cited by the amended
  task 6.1)
- Executed 2026-10-11, after §5 passed:
  `kubectl --context know-me -n ipfs exec ipfs-0 -c ipfs -- ipfs files rm -r
  /obsidian-vault-sync/publish-real-20260929`
- Before `files/ls /obsidian-vault-sync` (13 roots):

  ```
  mvp02-demo mvp03-demo mvp04-demo mvp05-demo mvp06-demo mvp06-probe mvp07a-demo
  mvp07b-demo mvp08-demo phone-test-1 phone-test-big publish-real-20260929 real-obsidian
  ```

- After (12 roots; the staging tree is gone, nothing else changed):

  ```
  mvp02-demo mvp03-demo mvp04-demo mvp05-demo mvp06-demo mvp06-probe mvp07a-demo
  mvp07b-demo mvp08-demo phone-test-1 phone-test-big real-obsidian
  ```

- No `key/rm`, no `pin/rm`, no other node state touched.

## 9. Unverified list and goal statement (task 6.2)

- Unverified: mobile (3.3 not run — T3); Android; non-macOS hosts; the CLI's missing
  read cap and exclusion option (plugin-only features; the demo's CLI route published
  the 195.4 MiB file uncapped); metadata visibility per T4 (file count, sizes, timing
  and access patterns of the operator's vault are visible to the node and the DHT);
  the publication receipt (pending, §7); an authenticated endpoint (the shared node's
  RPC takes no credential).
- Scanner coverage caveat carried from §1: gitleaks read 671.95 MB of the 954.9 MiB
  publishable set (binary-detected files skipped); the name-scan adjudication covers all
  36 names regardless.
- Supporting evidence cited, not re-run: mvp-09's green `pnpm test:e2e` (2026-10-06,
  5/5 scenarios against ipfs.prometheusags.ai, exit 0) — goal-6 supporting evidence.
- **Phase goals 6 and 7: met.** Goal 6: the operator's real vault (4,825 files,
  1,001,531,092 bytes publishable) was published encrypted to the operator's own node —
  §4 (652 s, sequence 1, root CID
  `bafybeihoemb6amr2txinn4w4oabcttv3wpcufxbmmsyej6xxpeu54qzzwa`, IPNS resolving).
  Goal 7: it was reproduced into a fresh directory with **0 mismatches** across the
  published set — §5 (4,825 fetched, 4,825/4,825 sha256-equal, 0 missing, 0 extra).
  This record is the evidence.
