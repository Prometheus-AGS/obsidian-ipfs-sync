---
title: Mobile setup
description: Installing the plugin on a phone through BRAT — a procedure for testers. Mobile sync is unverified; read the caveats before you touch a real vault.
---

# Mobile setup

:::danger Unverified on mobile
**Mobile sync has never run** (standing verification gap T3). No encrypted
publish or pull has run on a phone, and **Android is untested**. This page is a
procedure for people testing the build, not a statement of support. Do not rely
on it, and do not point it at a vault you cannot lose.
:::

<!-- source: README.md L40, L309-314, L441-442, L978-986 -->

## The caveats, stated plainly

<!-- source: README.md L309-314, L394-399, L616-618 -->

- **Mobile sync has never run.** The encrypted flow — publish, pull, unlock,
  every dialog — has not been exercised on a phone. Phone behaviour with a real
  vault (memory under buffering, background and suspend) is unmeasured.
- **Android is untested** and is not claimed at all.
- On mobile, every request goes through Obsidian's **`requestUrl`, which buffers
  each whole response body in memory and follows redirects**. The size caps and
  streaming that protect the desktop path do not apply; there is no option to
  stop a redirect and no way to read the final URL.
- **Credential leak on redirect (iOS).** Because redirects are followed, a
  custom-header credential (for example `X-Api-Key`) can leak cross-origin on
  iOS — the header is forwarded to the redirect target. Use **Bearer or Basic**
  on a phone: iOS strips those on a cross-origin hop. Point the plugin only at
  an endpoint you control and trust not to redirect. See
  [Security](security.md#redirects).
- **No iCloud vaults, and no manual iCloud copies.** Do not install into an
  iCloud vault or copy a vault through iCloud by hand: a manual copy hung the
  app at "Loading plugins", a file-provider hang that cleared only by
  restarting the phone.
- **High-cost key slots may not unlock on a phone.** Whether a phone can
  complete Argon2id at the High preset (128 MiB, 4 iterations) was not
  measured. The default-cost derivation was timed on an iPhone (about 0.57–1.1
  s depending on the build measured), but that says nothing about the encrypted
  pull or a High-cost slot.

What was actually measured on an iPhone (iOS 27.2 beta, Obsidian 1.13.7),
recorded 2026-10-02 from operator screenshots and not reproduced by an agent:
the release 0.2.0 **plaintext** pull of 5 files (24 KB) worked, as did pulls of
a 50 MB and a 5 MB file, and Argon2id at the default cost completed in about a
second. These are measurements of old plaintext builds. They say nothing about
the current encrypted flow on a phone.

<!-- source: README.md L99-101 -->

The manifest sets `isDesktopOnly: false`, but that is a declaration, not
evidence: mobile has not been run.

## Installing through BRAT

<!-- source: README.md L309-314 -->

The exact plugin build reaches a phone through the BRAT plugin from a GitHub
**pre-release that carries the reviewed bytes and has its own tag** — never the
main release tag.

1. On the phone, install and enable the
   [BRAT](https://github.com/TfTHacker/obsidian42-brat) community plugin.
2. In BRAT, add this repository (`Prometheus-AGS/obsidian-ipfs-sync`) and
   select the pre-release tag that carries the build you intend to test (for
   example `v0.4.0`). Do not track the main tag.
3. Let BRAT install `main.js` and `manifest.json`, then enable **IPFS Sync**
   under **Settings → Community Plugins**.
4. Open the settings tab and enter the RPC URL and gateway URL of your own
   hardened node — there is no default node on mobile either — with a Bearer or
   Basic credential (never a custom header; see the caveats above).
5. Use a throwaway vault. Not an iCloud vault, and not your notes.

## If you test it anyway

<!-- source: README.md L616-618, L978-986 -->

- Expect the app to be slow or memory-pressured on large pulls: every response
  body is buffered whole.
- Unlock a default-cost vault by hand before expecting anything automated; the
  auto-publish timer and catch-up pull never ask the passphrase or cost
  questions.
- A hang at "Loading plugins" after touching vault files through iCloud is the
  known file-provider hang; restart the phone.
- Report what you see. The honest status of this page is "unverified on
  mobile", and a report is how that changes.
