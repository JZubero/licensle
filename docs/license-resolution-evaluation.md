# Missing license text: evaluated methods and VR Star findings

Reviewed 2026-11-04 against VR Star `240bcfde5` and installed dependencies.

## Coverage after workspace exclusion

The original scan contained 217 direct production dependency occurrences across
16 project directories. Seven occurrences belonged to `@vrstar/lib`,
`@vrstar/theme`, or `@vrstar/core`. The default workspace exclusion now removes
those seven from the report and its missing-text denominator.

The rerun retains 210 external dependency occurrences, with text collected for
207 and missing for 3: **98.57% text collection**. All 16 reports were generated,
and neither the VR Star checkout nor its installed dependencies were modified.
These are occurrence counts, not unique package counts. The scope is direct
production dependencies, not automatic workspace or transitive traversal.

Full text, declared license identity, attribution, and source provenance need
separate coverage measures. A known SPDX identifier is useful evidence but
is not a recovered package notice. Conversely, a collected LICENSE file may
contain custom terms that still need classification.

## What is actually missing

| Package / installed version | Version-matched publisher declaration | Text findings | Required resolution |
| --- | --- | --- | --- |
| `@capacitor/google-maps` 8.0.1 | `MIT` in both the published package and `plugin/package.json` at its registry `gitHead` | No license-named file in the integrity-verified 59-file npm tarball or exact source tree | Obtain a publisher notice or explicitly review a version-scoped MIT notice/attribution record |
| `silverstripe/config` 1.6.0 | `BSD-3-Clause` in its exact source manifest and installed Composer metadata | No notice in the installed package or exact source archive; a LICENSE was added later | Review the later publisher notice for applicability to 1.6.0, or obtain confirmation; retain the provenance difference |
| `betterbrief/silverstripe-googlemapfield` dev-master, commit `06fdaa0d…` (same commit as published v2.2.1) | `BSD` in the exact source manifest and Packagist release metadata | No notice in installed files or exact source archive; no current upstream license endpoint result | Obtain the precise BSD variant and applicable notice from the publisher; do not silently convert `BSD` to BSD-3-Clause |

### Capacitor evidence

The published 8.0.1 registry metadata points to commit
`262a5e4c49e71f0bd95400a67bac4b644513041f`. The actual package lives in `plugin/`,
although its repository metadata omits `repository.directory`. Both its
[version-matched source manifest](https://github.com/ionic-team/capacitor-google-maps/blob/262a5e4c49e71f0bd95400a67bac4b644513041f/plugin/package.json)
and installed manifest declare MIT. The
[podspec](https://github.com/ionic-team/capacitor-google-maps/blob/262a5e4c49e71f0bd95400a67bac4b644513041f/plugin/CapacitorGoogleMaps.podspec)
reads that same field rather than identifying a separate notice file.

Downloaded the exact [npm tarball](https://registry.npmjs.org/@capacitor/google-maps/-/google-maps-8.0.1.tgz)
and verified its SHA-512 against the registry integrity field. It contains 59
regular files and no license-named file. The exact upstream archive was also
inspected. Gradle wrapper scripts contain their own Apache notices; those
notices do not describe the plugin's MIT declaration.

### SilverStripe evidence

The [exact 1.6.0 source manifest](https://github.com/silverstripe/silverstripe-config/blob/46dd212b175347362b4fb2b843fbe43cc4d67884/composer.json)
declares BSD-3-Clause. No license notice was found in that revision's complete
source archive or local package. The
[June 26, 2023 publisher commit](https://github.com/silverstripe/silverstripe-config/commit/67de47dc41e5e693c900575b224721c0289d687b)
adds a BSD-3-Clause LICENSE with SilverStripe Limited attribution.
This is a useful candidate notice, but it is later evidence rather than a file
present at the installed revision. A fallback must label that distinction.

### BetterBrief evidence

The [installed commit's manifest](https://github.com/timezoneone/silverstripe-googlemapfield/blob/06fdaa0db8c83ad634900abbd9063e07e8d34122/composer.json)
only says `BSD`. The
[Packagist release](https://packagist.org/packages/betterbrief/silverstripe-googlemapfield#v2.2.1)
points to the same commit and repeats that label. The complete exact source
archive, installed files, original repository alias, README, and current
repository license endpoint yielded no applicable full notice. A newer fork's
BSD-3-Clause declaration would not by itself resolve the old installed version.
The `LICENSE`, `LICENSE.md`, and `LICENCE` path histories up to the installed
commit are empty for both BetterBrief and Capacitor.

## Evaluated methods

| Method | Assessment | Findings for these cases |
| --- | --- | --- |
| Additional filenames and bounded local search | Useful for nonstandard names, `SEE LICENSE IN …`, nested notice files, and copyright files | None of the three exact upstream trees has a license-named file, so a longer name list cannot close these gaps |
| README sections and source-file headers | Useful where actual terms or an explicit publisher license link are embedded | No applicable package notice found; unrelated Gradle notices must remain scoped to their files |
| Exact-version npm registry / Composer metadata and lockfile references | High-value identity evidence; resolve the actual release before fetching source | Confirms MIT, BSD-3-Clause, and ambiguous BSD; supplies immutable source references |
| `repository.directory` or verified source-tree package discovery | Useful for upstream monorepos; verify package name and version before selecting a directory | Finds Capacitor's `plugin/` directory, but that directory still has no notice |
| GitHub contents/tree/license APIs at an exact ref | Useful when filename or location is unknown; follows repository renames and supports caching | Exact trees corroborate absence; querying only the current default branch gives misleading version coverage for SilverStripe |
| Integrity-verified published tarballs / pinned source archives | Strongest check for notices omitted from the installed layout or package metadata | Checked all three source archives and Capacitor's published tarball; no applicable full notice recovered |
| Publisher history, tags, and sibling releases | Good evidence candidates, with explicit applicability review | Finds SilverStripe's later LICENSE; does not automatically make it a version-matched notice |
| Canonical SPDX text | Useful as a clearly labeled standard-terms reference for an unambiguous identifier | Can describe MIT/BSD-3-Clause terms, but cannot invent attribution or disambiguate bare BSD; must not be counted as recovered upstream text |
| Reviewed, version-scoped evidence overrides | Needed when publishers omit notices or metadata is ambiguous | Practical route for these remaining exceptions once supporting notice/applicability evidence is supplied |
| File-level tools such as ScanCode or FOSSology | Useful for embedded third-party notices and custom terms | A later layer beyond the current direct-package scanner; cannot reconstruct absent publisher notices |

## Recommended resolution pipeline

The CLI now offers interactive review after discovery and before final output.
It displays available source and registry links, validates a manually selected
SPDX expression, and optionally imports a supplied notice file. Reports retain
the original declaration and label manual selections. An identifier without
notice text does not clear a missing-text entry. These selections apply to the
current run; persistent version-scoped overrides and strict coverage mode below
remain future work.

1. Keep every external dependency in a structured result, even if discovery fails.
   Record ecosystem, package name, installed version, immutable reference or
   tarball integrity, declared expression, and text/attribution status separately.
2. Resolve local files, explicit `SEE LICENSE IN` pointers, README sections, and
   bounded notice/header discovery within the package's actual scope.
3. Use exact release metadata to select repository, package subdirectory, and
   revision. Try known paths, then a contents/tree lookup at that revision,
   then the integrity-verified distribution/source archive. Cache negative
   lookups to avoid repeated branch/filename probes.
4. Surface publisher history and canonical SPDX text as labeled evidence
   candidates. Do not silently replace a missing version-specific notice with
   an arbitrary newer notice or a generic template.
5. Add reviewed overrides keyed by ecosystem/name/version or immutable commit,
   with the precise license expression, applicable full notice, attribution,
   source URL, content hash, reviewer, and rationale. An override should become
   invalid when the installed identity changes.
6. Add a strict coverage mode that exits unsuccessfully while required evidence
   is unresolved. Maintain separate counts for recovered text, unambiguous
   declaration, reviewed override, ambiguous/missing evidence, and excluded
   workspace packages. A partial report must remain available for review.

For **100% resolved coverage**, the three records need applicable notices;
BetterBrief additionally needs its BSD variant clarified. The present evidence
supports reporting all three situations, but not claiming that all three full
notices have been recovered. Publisher confirmation or reviewed evidence can
close that gap; more speculative downloads cannot.

## Additional provenance gap in otherwise collected text

Five successful downloads in the earlier VR Star scan used moving `main` or
`master` branches: Firebase (two occurrences), TypeORM, Ionic Storage, and RxFire.
Their text is collected, but the current scanner does not record version-specific
provenance for those npm downloads. Before using a stricter 100% evidence target,
these should also be tied to installed `gitHead`, release metadata, or an
integrity-verified distribution archive. The 98.57% figure above is text
collection coverage, not a claim that every collected notice is version-pinned.

Raw API responses, archive hashes, and archive scans are saved locally under
`/tmp/licensle-license-investigation-2026-11-04/`. The complete rerun's HTML and
logs are under `/tmp/licensle-vrstar-excluding-workspaces-2026-11-04/`.
