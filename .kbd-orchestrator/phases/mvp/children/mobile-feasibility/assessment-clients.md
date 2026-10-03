# Mobile client options: assessment (p2p-engineer)

Phase: KBD `mvp` > child `mobile-feasibility`, assess stage. Date: 2026-10-01. Author role: p2p-engineer.
Scope: should the phone use something other than HTTPS gateway fetch? Research only. Nothing was run on a phone or in
Obsidian. No repository file other than this one was changed.

What I actually ran: file reads of `DESIGN.md`, `openspec/changes/mvp-07-encrypted-pull-second-device/design.md`,
`src/sync/blob-source.ts`, `src/sync/pull-budget.ts`, `src/plugin/request-url-transport.ts`, `src/plugin/obsidian-fs.ts`
(grep), `versions.toml`, `manifest.json`; page fetches of the sources listed at the end; and five read-only HTTPS requests
against the operator's node `ipfs.prometheusags.ai` (headers and one 22-byte range of the public `keyslots.json`, the node's
`id` and `version`). Probe output is quoted below where it matters.

## 1. Recommendation

**Keep the plugin plus HTTPS design (option A) as the mobile architecture for 07a/07b, and change its transport rule. Do not
build Helia, a native Rust companion, or an embedded runtime now.** The change is small and it removes most of what the
brief lists as the limits of A:

1. **Read blobs from the gateway with the WebView's own `fetch`, not `requestUrl`.** Live probe of the operator's node
   (2026-10-01, `Origin: app://obsidian.md`, `Range: bytes=0-21`, path `/ipfs/<root>/keyslots.json`): `HTTP/2 206`,
   `accept-ranges: bytes`, `content-range: bytes 0-21/594`, `access-control-allow-origin: *`,
   `access-control-allow-headers: Content-Type,Range,User-Agent,X-Requested-With`,
   `access-control-expose-headers: Content-Length,Content-Range,...`; the `OPTIONS` preflight for `Range` returned 200 with
   the same headers. The same origin against `POST /api/v0/version` returned `403` with `vary: Origin`. So the README
   quirk 4 ("CORS blocks the Obsidian WebView") is true for the RPC path and **not** for `/ipfs/` and `/ipns/`. A `fetch`
   transport for gateway URLs gives streaming bodies, `AbortSignal`, and a Range that the node is proven to honour, and it
   leaves `requestUrl` for the few RPC calls. This is one new `Transport` (the client already takes a pluggable
   `transport`, `createKuboClient({ transport })`); it is not a redesign.
2. **Keep the RPC closed to browser origins.** Do not "fix" the 403 by opening CORS on `/api/v0`.
3. **Optional, later: resolve the IPNS name from the gateway** (`GET /ipns/<k51...>?format=ipns-record` returned 200,
   `content-type: application/vnd.ipfs.ipns-record`, 396 bytes, `access-control-allow-origin: *`) and verify the record's
   signature in the plugin. Then a pull-only phone needs no RPC credential and no `name/resolve` DHT round trip.
   It adds authenticity of the pointer; it does not add freshness (`cache-control: public, max-age=300` on that response).
4. Decide the passphrase-at-rest question for phones (section 6, item 6) before 07b removes the guard.

**Why not more.** The vault is already encrypted and authenticated: AES-256-GCM per segment with the blob header, vault id,
node name and segment index in the AAD, plus a manifest `sha256` per file (`DESIGN.md` 8.3). A gateway that lies about
bytes cannot get them past decryption. What a gateway can still do is withhold, replay an older genuine object, or serve a
stale pointer (`DESIGN.md` 8.5). No client option in this document closes replay or freeze on its own; that is the
sequence floor in 07a. So CID-verified retrieval (Helia, trustless gateway clients) buys almost nothing here, and the gateway
is sufficient for integrity and confidentiality. Where a native app or a peer link genuinely adds something is
background refresh, hardware-backed key storage, LAN transfer and very large files, and each of those costs a second
implementation of the vault format plus a new store listing.

**The uncomfortable scenario that most hurts this recommendation.** The operator's stated primary use case is mobile, and
the expectation behind it is probably "my phone is current when I pick it up", like Obsidian Sync. Option A cannot do
that, and the plugin recommendation does not change it. iOS suspends a backgrounded app by default and gives only
opportunistic, discretionary background time (Apple WWDC25 session 227: "By default, backgrounded apps are suspended. They
don't get CPU time"; background execution "isn't guaranteed"). `DESIGN.md` section 2 already says "fast catch-up on app
open, never background". A companion app does not fix this on iOS either (BGAppRefresh and BGProcessing are opportunistic
too). If the operator's real requirement is background currency, the honest answer is that no option here delivers it on iOS,
and the only partial answer is a native companion on Android plus opportunistic refresh on iOS. The second hurt: the
decisive unknown is not the transport but **Argon2id at 64 MiB, t=3 in a phone WebView**, which has never been timed
(`DESIGN.md` 8.7 "Mobile"), plus whether the key session survives iOS killing the WebView (section 6, items 1 and 6).
If Argon2id does not fit, every option that runs it in JS fails, and only a native companion (native Argon2) rescues the
design. That is the strongest argument for keeping option C alive as a v2, and for measuring on a real device first.

## 2. Comparison

"Trustless" means the client verifies that bytes match a hash or signature without trusting the server. In this design the
AEAD already provides that for content; the column asks what the option adds beyond it.

| Option | Trustless retrieval | Offline / LAN | Large files | Background | Cost to build | Hard limits inside Obsidian's sandbox |
|---|---|---|---|---|---|---|
| A. Status quo (`requestUrl` for everything) | AEAD plus manifest hash already cover content; pointer trusted to the node | No | Bounded only if Range works; `requestUrl` buffers every body and has no stream, abort or timeout | None on iOS; none expected on Android | Zero | No streaming (`RequestUrlParam`: body, contentType, headers, method, throw, url; response: arrayBuffer, headers, json, status, text) |
| **A+ (recommended): `fetch` for gateway reads, `requestUrl` for RPC, optional gateway IPNS record** | Same as A; optional: signed pointer verified client-side | No | Streamed and abortable; Range proven on the node; write path already chunked with `appendBinary` | None | Small: one transport, one settings rule, device tests | `fetch` behaviour in the mobile WebView unverified (section 6); no partial file read for upload (README: adapter has no partial read) |
| B. Helia / js-libp2p in the plugin | Adds block-level CID verification and Bitswap, which the AEAD already covers | LAN discovery not available to a WebView (no mDNS); I found no source that says otherwise | Blockstore copy in IndexedDB or memory on top of the vault copy | None (WebView suspended) | Large: bundle, transports, node reachability work | Node-side: the node's advertised peers are reached through a circuit relay (see B) |
| B-lite. `@helia/http` or verified-fetch over the gateway | Verifies blocks against CIDs over HTTP | No | Many block requests instead of one Range request | None | Small to medium; mostly redundant | Same `fetch` and CORS facts as A+ |
| C. Native companion with a Rust client (iroh or other) via UniFFI | Peer link with BLAKE3 verified streaming, a different hash from IPFS CIDs | Yes with a desktop peer (not verified) | Best: stream to disk, native Argon2 | Opportunistic on iOS, better on Android | Very large: second implementation of key slots, blobs, manifest v2, state, locks; two app stores; picker UX | Cannot write the vault without a user-granted folder (iOS) or a storage grant (Android) |
| C-lite. Native companion, plain HTTPS client | Same as A | No | Native streaming | Opportunistic on iOS | Large (same vault-format rewrite, no Rust) | Same file-access constraints as C |
| D. Embedded JS runtime or WebView with Helia in a companion | As B | As B | As B | As C | Large; reuses the TypeScript core, which is its one advantage | Same file-access constraints as C, plus B's limits |
| E1. iroh compiled to WASM inside the plugin (relay-only) | Peer link, E2E encrypted, via relay | Via relay only; no direct connections in a browser | Unknown | None | Large; no npm package exists, you wrap it yourself | Needs an online desktop peer and a relay; blobs hash is not a CID |
| E2. File-provider or Syncthing style transport | n/a | Yes | Yes | Android yes (Syncthing-Fork); iOS no | Medium; replaces this project's transport | Obsidian on iOS does not support these providers (below) |

## 3. Per-option evidence

### A. Status quo

- `src/plugin/request-url-transport.ts` builds a `Response` from `result.arrayBuffer`, so the body is fully downloaded
  before the sync code sees a byte. The Obsidian docs list no stream, signal or timeout field on `RequestUrlParam` or
  `RequestUrlResponse`
  (docs.obsidian.md/Reference/TypeScript+API/RequestUrlParam and /RequestUrlResponse). A forum feature request to stream
  `requestUrl` bodies ("Support streaming the request() and requestUrl() response body", opened Aug 2024, 36 likes) has
  posts as late as "Mar 10" (the year was not shown in what I read); I could not confirm it was implemented, and the API
  reference I read has no such field.
- Range through `requestUrl` is still unverified on a device. The node itself honours Range (probe above), so the open
  question is only whether Obsidian forwards the header and returns `Content-Range` in `result.headers`.
- `blob-source.ts` already defends against a gateway or a transport that ignores Range (range probe, 32 MiB whole-body
  limit, `unfetched` outcomes). That logic stays valid under A+.
- Where a gateway is sufficient: everything about confidentiality and integrity of file contents. Where it is not: pointer
  freshness and availability (a node operator can freeze or roll back, `DESIGN.md` 8.5).
- Other A limits that no transport fixes: iOS suspension; the plugin cannot use Keychain or Keystore. Obsidian's
  `SecretStorage` (since 1.11.4) is documented as "stored in local storage, keyed to the specific vault"
  (docs.obsidian.md/plugins/guides/secret-storage), so it is WebView storage, not a hardware keystore. The plugin does not
  use it today (grep of `src/` found nothing).
- Write side is better than the brief assumes: `src/plugin/obsidian-fs.ts` already appends in chunks with
  `adapter.appendBinary` (line 178), and the Obsidian typings list `appendBinary` on the Capacitor adapter since 1.12.3,
  the plugin's `minAppVersion`. Download-to-disk can therefore be bounded by one segment. The read side for upload is the
  weak point: `readBinary` loads a whole file (README "Plugin limitations").

### A+. What I verified on the operator's node, and what I did not

Verified 2026-10-01 by `curl` from my machine (no Obsidian, no phone):

- Gateway `/ipfs/<root>/keyslots.json` with `Range: bytes=0-21` and `Origin: app://obsidian.md`: 206, correct
  `Content-Range`, `access-control-allow-origin: *`, `cache-control: public, max-age=29030400, immutable`.
- `OPTIONS` with `Access-Control-Request-Headers: range`: 200 with `Range` allowed.
- `POST /api/v0/version` with the same `Origin`: 403, `vary: Origin`, body 16 bytes. A request without an `Origin` header
  returned the version (`kubo 0.42.0`, commit 969853d, go1.26.4) and `/api/v0/id` returned the node identity. The RPC
  therefore appears to be gated by `Origin`, not by authentication, which agrees with README's warning that the RPC is open.
  I did not test authenticated access.
- Gateway `/ipns/k51qzi5u...?format=ipns-record`: 200, `application/vnd.ipfs.ipns-record`, 396 bytes.

Not verified: any of this from a phone; the Origin string the iOS and Android Obsidian WebViews send (the desktop value
`app://obsidian.md` is in the forum thread; I could not confirm the mobile values); whether the WebView's `fetch` returns a
streamable `response.body` (caniuse lists Safari iOS 10.3 to 27.x as "partial support" for fetch response streams;
I did not read which part is partial); large-body behaviour (idle timeouts or buffering at the operator's proxy for blobs
of tens of MiB); the effect of `max-age=300` on freshness after a publish.

Why `fetch` is better than `requestUrl` for blobs: bounded memory even when Range is ignored (read the stream, abort at the
cap), real timeouts, cancellation when the app is backgrounded, and the 8 MiB segment fits the existing
`SEGMENT_MEMORY_BUDGET` arithmetic in `pull-budget.ts`. It does not change the ciphertext format or the security model, so
no crypto review is needed for it; the transport change is its own small review item.

Security note: `access-control-allow-origin: *` on `/ipfs/` lets any web page fetch public ciphertext and the public key-slot
file. That is already the threat model in `DESIGN.md` 8.5 (the slot is public, the adversary can read everything stored).
It is not a new exposure.

### B. Helia / js-libp2p in the plugin WebView

- **Version and size (bundlephobia API, 2026-10-01):** `helia` 7.1.16 is 1,102,305 bytes minified, 317,686 bytes gzip, 31
  direct dependencies including `libp2p` (167 KB), `@libp2p/kad-dht` (393 KB), `@libp2p/webrtc` (105 KB) and
  `@libp2p/circuit-relay-v2` (111 KB). `@helia/verified-fetch` 8.1.2 is 1,321,333 bytes, 382,435 gzip. `@helia/http` 4.0.8
  (HTTP-only, no libp2p transport stack) is 97,318 bytes, 29,887 gzip. Bundlephobia sizes are for the package, not a
  tree-shaken application bundle, so treat them as upper bounds; I did not build a bundle. The current plugin build
  (`dist/plugin/main.js`, dated 2026-09-30, possibly stale) is 409,716 bytes.
- **Transports a WebView can use** (libp2p docs, libp2p.io/docs/webrtc-browser-connectivity): WebSocket works but "requires
  the relay to have CA-signed TLS certificate and a domain name"; WebTransport is "Supported by Chrome, Firefox, Opera, and
  Edge, but not Safari" in that page, while caniuse now lists Safari 26.4 as supported (March 2026), so coverage depends on
  the WKWebView version inside Obsidian, which I could not determine; WebRTC works in most browsers; WebRTC-direct works in
  all browsers that support WebRTC. A WebView cannot listen, so a phone is a client dialling out.
- **What the node would need.** Kubo 0.42.0 is running (the current kubo on npm is 0.43.1, so the node is one minor behind).
  Kubo documents `AutoTLS.Enabled` (default true) to issue `*.<peerid>.libp2p.direct` certificates for Secure WebSocket on a
  `/tcp` port, and says it "requires a publicly reachable node". The node's `id` output lists **no directly dialable public
  address for its own peer**: the only non-loopback addresses are `.../p2p/12D3KooWHdZM98.../p2p-circuit/p2p/12D3KooWFqw77...`,
  i.e. through a relay peer at 15.235.14.184 (which advertises `tls/ws` on a libp2p.direct name, `quic-v1`, `webtransport` and
  `webrtc-direct`). A phone would reach the vault node through that relay. The circuit-relay v2 spec says relayed connections
  carry a duration and data cap ("the maximum number of bytes allowed to be transmitted in each direction"); I could not
  confirm the caps configured on this relay, so I cannot say whether a multi-megabyte blob would pass. This is a node-ops
  task (publicly reachable libp2p listener, or an unlimited relay) that the plugin cannot do.
- **Obsidian constraints:** a plugin ships exactly `main.js`, `manifest.json`, `styles.css` (docs.obsidian.md, Submit your
  plugin), so no native code, no background service, no extra WebView. Node and Electron APIs are unavailable on mobile
  (Mobile development page). Helia in the plugin would also need a persistent blockstore choice (IndexedDB quota versus
  memory), which I did not evaluate.
- **What it adds over A:** Bitswap and block verification, which help when content lives on many peers. Here there is one
  node. **What it cannot do:** run in the background, find LAN peers, or avoid needing an always-on reachable node.
- Verdict: not worth it for this data model. If CID verification is ever wanted, B-lite over HTTP is the cheaper form.

### C. Companion native app with a Rust client, writing into the vault

**Client side (iroh).** iroh 1.3.0 is the current crate (crates.io, updated 2026-09-28). Swift and Kotlin bindings exist
(`n0-computer/iroh-ffi`, generated by uniffi-rs; `hello-iroh-ffi` lists iOS and Android as "working"). `iroh-blobs` names
data by BLAKE3 hash with verified streaming and range requests (docs.iroh.computer/protocols/blobs). That is a different
hash and protocol from IPFS CIDs and Bitswap, so a phone cannot fetch from kubo with it. A v2 iroh link means a desktop or
daemon peer that serves this project's encrypted blobs over iroh; kubo is out of that path. (One scraper summary I received
claimed iroh-blobs is "compatible with IPFS CIDs/bitswap". The page text I then read says BLAKE3 and does not say
that; I discarded the claim.) I did not evaluate a Rust IPFS client for mobile and could not confirm a maintained one.

**Writing into Obsidian's vault, per platform.**

- *iOS.* Obsidian's own docs describe two vault homes on iOS: iCloud Drive under `iCloud Drive/Obsidian/<vault>`
  (obsidian.md/help/sync-notes: "Vaults should be inside the Obsidian folder within iCloud Drive"), and a local vault
  (an Obsidian forum post, April 2021, shows the path "On My iPhone/iPad > Obsidian"; the current help pages I read do not
  restate it, so treat it as dated). Another app cannot reach those paths on its own. It must ask the user to pick the folder
  with a folder document picker and keep a security-scoped bookmark, then call `startAccessingSecurityScopedResource()`
  before each use (Apple's sandbox article, developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox,
  is the macOS page; the iOS flow with `UIDocumentPickerViewController(forOpeningContentTypes: [.folder])` is described in a
  third-party write-up citing Apple's "Providing Access to Directories"; I did not open Apple's iOS page).
  **Working Copy is the proof it works in practice:** its guide says it can "Link external directory" and names Obsidian among
  the apps it can be used with, with the caveat that "depending on the app in question they can be confused if the document
  files are changed while they are running" (workingcopyapp.com/users-guide, 6.4). Obsidian's own help page recommends the
  same pattern (sync-notes, "Working Copy"). The guide also says Working Copy "needs folder-level access which can only work
  with Files app locations that support picking folders such as iCloud Drive, On My Device".
- *Android.* Obsidian offers device storage ("a shared location on your device ... accessed by other apps and services,
  such as third-party sync tools") and asks for "All files" access (obsidian.md/help/android). A companion can use the
  Storage Access Framework: `ACTION_OPEN_DOCUMENT_TREE` grants a whole directory tree, except on Android 11+ the root of the
  internal volume, SD card roots and `Download` (developer.android.com/training/data-storage/shared/documents-files), so a
  vault folder inside shared storage is selectable. The alternative is `MANAGE_EXTERNAL_STORAGE`, which Google Play restricts
  to cases where "your app can't effectively make use of the more privacy-friendly APIs" and which needs a declaration
  (developer.android.com/training/data-storage/manage-all-files). Obsidian recommends Syncthing-Fork on Android, so a
  companion that writes into the shared vault is an established pattern there. I did not confirm the default vault path
  Obsidian uses on Android.
- Obsidian "automatically refreshes your vault to keep up with any external changes" (obsidian.md/help/data-storage), which
  is what makes a companion's writes visible; the Working Copy caveat above is the counterweight.

**What C adds over A:** native Argon2id (the one thing that rescues the design if the JS KDF does not fit a phone),
Keychain or Keystore for the passphrase-derived material with biometric unlock, streaming to and from disk without
Obsidian's adapter limits, opportunistic background refresh on iOS (BGAppRefresh and BGProcessing, both discretionary) and
more room on Android, and a direct device link when paired with a desktop peer. **What it costs:** a second implementation of
the entire vault format (key slots, blob v1, manifest v2, path policy, state v3, journal, lock), pinned byte for byte against
the TypeScript vectors; a first-run folder-grant flow that users will find confusing; two store reviews; ongoing parity
work. **What it cannot do inside the sandbox:** write the vault without a user-granted location; avoid conflicts with a
running Obsidian (the Working Copy caveat); run continuously on iOS.

Effort: months, not weeks. A cheaper form, C-lite, drops Rust and uses the platform HTTP stack plus a native Argon2
library; it still needs the vault-format rewrite unless the TypeScript core is reused (option D).

### D. Embedded JS runtime or WebView hosting Helia in a companion app

Same folder-access problem as C, plus B's constraints, so it dominates nothing. Its single real advantage is reuse of the
existing TypeScript core (`src/crypto`, `src/sync`) instead of a Rust rewrite. If a companion is ever built, "reuse the TS
core in an embedded runtime, with native Argon2 and native file access" is the option to compare against Rust. I did not
verify that any Capacitor plugin offers persistent folder access outside the app sandbox, so I cannot say Capacitor makes D
cheaper. Embedding Helia in that app adds nothing for the reasons in B.

### E. Other options

- **E1. iroh WASM in the plugin.** iroh documents browser support: "All connections from browsers to somewhere else need to
  flow via a relay server", no hole punching, E2E encrypted anyway, built with `default-features = false` and wasm-bindgen,
  and "Currently we don't bundle iroh's Wasm build as an NPM package" (docs.iroh.computer/languages/wasm-browser).
  `iroh-gossip` supports browsers; I found no statement that `iroh-blobs` does. It needs an online desktop peer and a
  relay, produces a WASM payload inside `main.js` (size not measured), and gives no background. Fits the v2 "mobile is a
  client only" rule, and it is the least work of the peer-link options because it stays inside the plugin, but it adds a
  second always-online dependency (the desktop) to a design whose current strength is that the VPS node is always there.
  Park it for v2 behind the Argon2 result.
- **E2. File-provider or Syncthing pattern.** Obsidian states services without whole-vault access are unsupported on iOS:
  "Obsidian requires access to the entire vault", and Dropbox, Google Drive, OneDrive and Syncthing "aren't officially
  supported on iOS" (obsidian.md/help/sync-notes). I could not confirm whether Obsidian can open a vault from a third-party
  File Provider extension, so an Obsidian-Sync-style provider on iOS is unproven and I would not plan on it. On Android the
  pattern works today with Syncthing-Fork.
- **E3. Working Copy style linked folder (iOS).** This is C-lite in practice. It is the only iOS pattern with a documented
  working precedent for an outside app writing into an Obsidian vault.
- **E4. Second gateway endpoint on the LAN or a tailnet.** Settings could accept a list of gateways (the desktop's own kubo
  gateway first, the VPS second). This gives LAN speed and a partial offline story with no new code paths beyond endpoint
  selection. Whether the mobile WebView can reach an `http://` LAN address (mixed content, platform network policy) is
  untested; `requestUrl` may be the route there. Cheap to test, so worth testing.

## 4. What this changes for 07a and 07b (inference, for the lead to confirm)

- 07a decision 14 and the README treat the gateway as `requestUrl`-only and Range as unverified. Add a task for a `fetch`
  gateway transport (owner ipfs-engineer, files under `src/plugin/`), with `requestUrl` kept for RPC. The existing
  `RangedBlobSources` stays; only the transport under it changes.
- `DESIGN.md` section 2 row "WebView has only HTTP(S)/WSS" and section 3/6 (phones reaching a Helia daemon over WSS) do not
  match the observed topology (vault node reached through a relay, no Helia daemon). Documentation-specialist should reconcile
  them once the lead decides. README quirk 4 should say it applies to `/api/v0`.
- The Argon2id phone timing and the key-session survival question should gate mobile claims, not transport work. 07b already
  lists phone timing; it should be run before 07a resumes, per the child goals.
- A passphrase-at-rest decision is missing from both changes (section 6, item 6).

## 5. Findings that conflict with the project's own text

- README line 414 and the plugin comment in `request-url-transport.ts` say the node returns 403 to the WebView origin. True
  for `/api/v0`, false for `/ipfs/` and `/ipns/` on the node I probed on 2026-10-01. The blanket statement led to the
  `requestUrl`-for-everything rule.
- `DESIGN.md` 8.7 lists "`requestUrl` with multi-megabyte binary bodies and Range requests" as unverified. The node side of
  Range is now verified; the Obsidian side is not.

## 6. Open questions that need a real device

1. Argon2id (m=65,536 KiB, t=3, p=1, pure JS) wall time, peak memory and main-thread gaps on a low-end Android phone and an
   older iPhone in the Obsidian WebView. Does the WebView get killed? This is the go/no-go for all JS options.
2. `requestUrl` on iOS and Android: does it pass `Range`, return `Content-Range` in `result.headers`, handle 8 to 32 MiB
   binary bodies without corruption, and is it implemented over a native HTTP layer that has its own size or time limit?
3. `fetch` from the Obsidian WebView to the gateway: the actual `Origin` value on each platform, preflight with `Range`,
   whether `response.body` streams (caniuse says "partial" on Safari), and whether `AbortSignal` cancels the connection.
4. WebCrypto in the WebView: HKDF, HMAC-SHA256 and AES-256-GCM known-answer tests (only SHA-256 is recorded as run in
   Obsidian 1.13.7, `DESIGN.md` 8.7), and how WebKit reports a failed GCM decrypt.
5. Adapter behaviour on mobile: `appendBinary` of 8 MiB chunks, `rename` onto an existing target, `stat().mtime`, `list`
   path format, and where the Android vault actually lives.
6. How often iOS terminates Obsidian in normal use, since the key session lives in memory only. Each cold start would mean
   retyping a 25-symbol passphrase and re-running Argon2id. `SecretStorage` is WebView local storage, so persisting the
   passphrase or KEK there is a security decision for the security reviewer, not a convenience toggle.
7. Operator's proxy with large bodies: idle timeouts and buffering for a 32 to 100 MiB range, and whether
   `cache-control: max-age=300` on `/ipns/` hides a publish for up to five minutes.
8. Folder-grant UX for a companion: with Working Copy as a stand-in, can an outside app on current iOS pick and keep access to
   `On My iPhone/Obsidian/<vault>` and to the iCloud Obsidian folder, and does Obsidian pick up its writes promptly?
9. WKWebView version inside Obsidian iOS versus WebTransport (Safari 26.4) and WebRTC, only if B is ever revisited.
10. Relay limits on `12D3KooWHdZM98...` (duration and data caps) and whether the kubo peer can be made directly dialable,
    only if B or a libp2p link is ever revisited.

## Sources read (access date 2026-10-01 unless noted)

- Obsidian: obsidian.md/help/data-storage; /help/sync-notes; /help/android; /help/ios (no vault-location statement);
  docs.obsidian.md Mobile development; Plugin guidelines; Submit your plugin; Reference/TypeScript+API requestUrl,
  RequestUrlParam, RequestUrlResponse, CapacitorAdapter, SecretStorage; plugins/guides/secret-storage;
  forum.obsidian.md "Make HTTP requests from plugins" (desktop origin `app://obsidian.md`), "Support streaming the request()
  and requestUrl() response body", "Setting up iOS git-based syncing ... Working Copy" (2021).
- IPFS and libp2p: specs.ipfs.tech/http-gateways/trustless-gateway; raw.githubusercontent.com/ipfs/kubo/master/docs/config.md
  (AutoTLS, WebTransport, Gateway.PublicGateways); libp2p.io/docs/webrtc-browser-connectivity;
  github.com/libp2p/specs relay/circuit-v2.md; ipshipyard.com/blog/2024-shipyard-improving-ipfs-on-the-web;
  registry.npmjs.org latest for `helia` 7.1.16, `@helia/http` 4.0.8, `@helia/verified-fetch` 8.1.2, `kubo` 0.43.1;
  bundlephobia.com/api/size for the three Helia packages.
- iroh: crates.io/api/v1/crates/iroh (1.3.0); docs.iroh.computer/languages/wasm-browser; /protocols/blobs; /languages/swift;
  github.com/n0-computer/hello-iroh-ffi (search excerpt).
- Platform: caniuse.com/webtransport (Safari 26.4); caniuse.com/streams; developer.apple.com sandbox article (macOS) and
  WWDC25 session 227; developer.android.com data-storage/shared/documents-files and manage-all-files; workingcopyapp.com/users-guide.
- Operator node, read-only, 2026-10-01: gateway `/ipfs/` range and preflight, `/api/v0/version` with and without `Origin`,
  `/api/v0/id`, gateway `/ipns/...?format=ipns-record`.

Could not confirm: mobile WebView `Origin` strings; Obsidian's default Android vault path; whether `iroh-blobs` runs in a
browser; a maintained Rust IPFS client for mobile; relay limits on the operator's relay; Apple's iOS-specific folder
bookmark page (not opened).
