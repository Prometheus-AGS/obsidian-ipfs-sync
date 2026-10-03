## Purpose

Defines which manifest paths a pull refuses and how, so an authenticated manifest from a compromised device, or an honest manifest from another platform, cannot make the pull write into the state folder, the configuration folder, a VCS folder, a device name, outside the vault, or over another file. It replaces the first draft's list of individual aliases (U+0131, U+017F), which was incomplete by construction.

## ADDED Requirements

### Requirement: Path policy over the whole manifest
The pull SHALL evaluate the path policy over every path of the authenticated manifest before any blob is requested, and again at write time. The policy SHALL refuse a path that: is empty, absolute (leading `/` or a drive letter), or contains a backslash, a control character (C0, DEL, C1), an empty, `.` or `..` segment; lies under `.ipfs-sync`, `.obsidian`, `.git` or the host's configuration folder name (`vault.configDir` in the plugin) by the fold key below; lies under `.obsidian/plugins/`; matches the effective exclusion list; or has a segment listed under "Windows forms". Every refusal SHALL carry a severity and, for `unsafe`, a class: `expected` (configuration folder or exclusion-list match); `unsafe`/`shape` (empty, absolute, backslash, control character, empty or dot segment, protected folder name by fold key including `.obsidian/plugins/`, state folder); `unsafe`/`platform` (Windows forms, reserved names, 8.3 shapes, collision groups, file and directory prefix groups). The exclusion list SHALL be matched by a pull-only matcher that uses the fold key; the publisher's exclusion matcher (used by the scan and the idle check) SHALL NOT change. The policy SHALL NOT be applied inside the manifest decoder used by the publisher.

#### Scenario: Publisher exclusions unchanged
- **WHEN** the publisher's exclusion matcher is run over a fixed list of paths before and after this change
- **THEN** the results are identical, including for `Private/` versus `private/` when only one is excluded

#### Scenario: Plugin code
- **WHEN** an authentic manifest lists `.obsidian/plugins/x/main.js`
- **THEN** the entry is skipped with severity `unsafe` and no file is written

#### Scenario: Configuration file from an older build
- **WHEN** an authentic manifest lists `.obsidian/app.json`
- **THEN** the entry is skipped with severity `expected`

#### Scenario: Traversal (policy level)
Policy-level scenario: it holds for a path that reaches the policy, for example a unit vector fed to `path-policy.ts` directly. In production the manifest decoder refuses such a path first (see "Decoder strictness" below and the next scenario).
- **WHEN** the policy is given the path `../outside.md`
- **THEN** it is skipped with severity `unsafe` (class `shape`) and nothing is written outside the vault

#### Scenario: Traversal in an authentic manifest (production decode path)
- **WHEN** an authentic manifest lists `../outside.md` among otherwise ordinary paths
- **THEN** the decoder refuses the whole manifest as `manifest-unsupported`, no blob is requested, nothing is written, and the rest of the manifest is not restored

### Requirement: Path limits
The policy and the manifest decoder SHALL share one definition of path limits (`src/sync/path-limits.ts`, `PATH_LIMITS`): a whole path of at most 4096 UTF-8 bytes, a segment of at most 255 UTF-8 bytes, and at most 128 `/`-separated segments. The limits are checked first, before any splitting, fold key or matcher work. At policy level a path over a limit is skipped with severity `unsafe`, class `shape`, and a fixed reason by code: `path-too-long` ("path is longer than 4096 bytes"), `segment-too-long` ("a path segment is longer than 255 bytes"), `too-many-segments` ("path has more than 128 segments"). The reason never contains the path. In production the decoder refuses the whole manifest (see "Decoder strictness") with a path-free `ManifestFormatError`.

#### Scenario: Over-long path (policy level)
- **WHEN** the policy is given a path longer than 4096 UTF-8 bytes
- **THEN** it is skipped with severity `unsafe`, class `shape`, code `path-too-long` and the fixed reason, and nothing is written

#### Scenario: Over-long segment (policy level)
- **WHEN** the policy is given a path with one segment longer than 255 UTF-8 bytes
- **THEN** it is skipped with severity `unsafe`, class `shape`, code `segment-too-long` and the fixed reason

#### Scenario: Too many segments (policy level)
- **WHEN** the policy is given a path with more than 128 segments
- **THEN** it is skipped with severity `unsafe`, class `shape`, code `too-many-segments` and the fixed reason

#### Scenario: Path over a limit in an authentic manifest (production decode path)
- **WHEN** an authentic manifest lists a path over any of the three limits among otherwise valid paths
- **THEN** the decoder refuses the whole manifest with a path-free `ManifestFormatError`, nothing is requested or written, and a publish that decodes this manifest also refuses

#### Scenario: Over-limit local path on the publisher side
- **WHEN** a publish finds a local path over any of the three limits (for example a note title of about 85 CJK characters, which is over 255 UTF-8 bytes)
- **THEN** the publish refuses, fails closed, and nothing is published; the message names the local path (control characters escaped) and the limit that was exceeded, and never says "written by a newer or incompatible version" or asks the operator to update `ipfs-sync`

### Requirement: Decoder strictness
The manifest decoder SHALL apply a strict shape check to every path (control characters, an empty, `.` or `..` segment, absolute forms, a backslash, a lowercase `.ipfs-sync` segment) and SHALL refuse the manifest as a whole, as `manifest-unsupported`, when one path fails it. This is intended: it fails closed on every device (pull and publish both stop), and the publisher decodes its own manifests with the same check. The policy-level `unsafe` skip, carry-forward and `needsAttention` outcomes apply only to paths that pass the decoder, such as `.obsidian/plugins/x/main.js`, Windows forms, fold-key matches and collisions. The cost is stated: one forged entry from a compromised device makes the vault unpullable and unpublishable until the manifest is replaced, and the message names the shape refusal rather than a version problem.

#### Scenario: One malformed path refuses the manifest
- **WHEN** an authentic manifest lists a path with a backslash, a control character or an absolute form, and 99 other valid paths
- **THEN** none of the 100 is restored, the CLI exits non-zero with `manifest-unsupported`, and a publish from any device that decodes this manifest also refuses

#### Scenario: Passing the decoder, refused by the policy
- **WHEN** an authentic manifest lists `.obsidian/plugins/x/main.js` and 99 valid paths
- **THEN** the decoder accepts it and the policy skips the one path with severity `unsafe`, and the rest is restored

#### Scenario: Renamed configuration folder
- **WHEN** the plugin runs in a vault whose `configDir` is `.cfg` and a manifest lists `.cfg/app.json`
- **THEN** the entry is skipped

### Requirement: Fold key
For the folder-name comparisons the policy SHALL compute a fold key: Unicode NFKC, then full case folding taken from a generated table (Unicode `CaseFolding.txt`, statuses C and F), then a supplement (U+0131 maps to `i`; a U+0307 that directly follows `i` is removed, so U+0130 and U+0131 both reach `i`), then removal of every code point with the `Default_Ignorable_Code_Point` property, repeated until the result is stable (at most three passes), and SHALL compare the fold key of a path segment with the fold key of each protected name. The table SHALL be a checked-in generated file whose header records the Unicode version and the sha256 of each source data file, produced by a generator script and never edited by hand; a unit test SHALL check the vector list against the table and a second SHALL fail if the file differs from its recorded body hash. A test vector file SHALL include at least: U+0131 (dotless i), U+017F (long s), U+212A (Kelvin sign), U+1E9E, fullwidth Latin letters, a zero-width joiner inside `.git`, a soft hyphen inside `.obsidian`, and U+0130.

#### Scenario: Folded folder names
- **WHEN** an authentic manifest lists `.ıpfs-sync/state.json` (dotless i) or `.ipfſ-sync/x` (long s)
- **THEN** the entry is skipped with severity `unsafe`

#### Scenario: Invisible characters
- **WHEN** a segment is `.ob‍sidian`
- **THEN** it is skipped as the configuration folder

#### Scenario: Ordinary names are not caught
- **WHEN** a path is `notes/ipfs-sync.md` or `.gitignore`
- **THEN** the policy accepts it

### Requirement: Windows forms
Because a vault may be synced to Windows, the policy SHALL refuse on every host any path with a segment that ends in a dot or a space, contains `:` (alternate data stream syntax such as `::$DATA`), equals a reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, `LPT1` to `LPT9`, including superscript-digit forms) with or without an extension after the fold, or has the shape of an 8.3 short name that could stand for a protected folder. That shape SHALL be a segment matching `^([^.~/]{1,6})~[0-9]+(\.[^./]{0,3})?$` (case-insensitive) whose captured prefix, after the fold key, is a prefix of the fold key of a protected folder name without its leading dot (`obsidian`, `ipfs-sync`, `git`, the host's configuration folder).

#### Scenario: Windows forms
- **WHEN** an entry has a trailing dot or space in a segment, `::$DATA`, `CON.md`, or the 8.3 name `OBSIDI~1/x`
- **THEN** the entry is skipped with severity `unsafe`, class `platform`

#### Scenario: Short names
- **WHEN** entries are `GIT~1/x`, `IPFS-S~1/x` and `OBS~1/x`
- **THEN** each is skipped with severity `unsafe`

#### Scenario: Ordinary tilde name
- **WHEN** an entry is `abc~1.md`
- **THEN** the policy accepts it

### Requirement: Collisions
The policy SHALL compute the fold key of every manifest path and refuse, as a group and with severity `unsafe`, every path whose key equals another path's key (differences only of case or normalisation), and every path that has another manifest path as a proper prefix directory (a file and a directory with the same name). The output SHALL name at most three members of a group and a count, and say which to rename on the originating device.

#### Scenario: Case collision
- **WHEN** a manifest lists `Note.md` and `note.md`
- **THEN** both are skipped (severity `unsafe`, class `platform`) and neither overwrites the other

#### Scenario: Normalisation collision
- **WHEN** a manifest lists the NFC and NFD forms of the same name
- **THEN** both are skipped

#### Scenario: File and directory
- **WHEN** a manifest lists `a` as a file and `a/b.md`
- **THEN** both are skipped

### Requirement: Containment on the file system
Before each create, write and rename the pull SHALL refuse a path whose existing prefix is a symbolic link (the `lstat` prefix walk, where the host has `lstat`), and on the Node CLI SHALL also require that the real path of the destination's parent directory lies inside the real path of the vault root. The documentation SHALL state that the Obsidian adapter cannot see symbolic links.

#### Scenario: Symlinked folder
- **WHEN** a vault folder is a symbolic link to a directory outside the vault and the manifest lists a file under it
- **THEN** the CLI skips the file with severity `unsafe` and writes nothing through the link

### Requirement: Safe output
Shown paths and node-supplied text SHALL have C0 and C1 control characters (including U+009B) and bidirectional override characters escaped, and notices that echo node-supplied text SHALL use fixed strings. The manifest `device` field SHALL be escaped the same way where it is displayed.

#### Scenario: Control characters (policy level)
- **WHEN** the policy or a display sink is given a path that contains U+009B (a manifest carrying it is refused whole by the decoder, "Decoder strictness")
- **THEN** the skip line shows it escaped

### Requirement: Publisher advisory
The publisher SHALL, without refusing, warn when it is about to publish a path that the pull policy would refuse, listing at most three and a count.

#### Scenario: Linux-only name
- **WHEN** a vault contains `CON.md` and is published
- **THEN** the publish succeeds and warns that no device will restore that path by pull (the policy is host-independent, so a Linux device does not either)

#### Scenario: Windows-form name survives another device
- **WHEN** a device that skipped `CON.md` publishes
- **THEN** `CON.md` remains in the manifest (see `second-device-publish`, paths this device could not restore)
