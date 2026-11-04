# Dependency audit - 2026-11-03

Reviewed the direct dependencies, resolved lockfile, npm registry versions,
security advisories, and installed production package license metadata.

## Security results

| Scope | Before | After |
| --- | --- | --- |
| All dependencies | 24 findings: 3 critical, 8 high, 12 moderate, 1 low | 0 findings |
| Production dependencies | 0 findings | 0 findings |

The original findings were in the Vitest development-tool dependency tree,
including Vitest, its mocker, Vite, esbuild, Rollup, PostCSS, nanoid,
source-map-js, and tinypool. They do not establish that the shipped CLI was
exploitable. For example, the [Vitest critical advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp)
requires specific UI/API exposure or Windows browser/UI conditions.

Updated Vitest from 2.1.9 to 5.1.0, which includes the
[manual mock registration fix](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8).
Re-resolved the lockfile so Vitest uses a compatible Vite 8.3.5 dependency tree,
without dependency overrides or ignored advisories. Audit results are a snapshot
of known registry advisories, not a complete security review of this CLI.

## Direct dependency decisions

Versions below are the resolved installed versions. All six runtime dependencies
are imported by the CLI; no unused direct dependency was found.

| Package | Before | After | Decision |
| --- | --- | --- | --- |
| chalk | 5.6.2 | 6.0.1 | Upgrade to major 6; verify styled CLI output. |
| commander | 14.0.2 | 15.0.0 | Upgrade to ESM-only major 15; verify browser flags and option parsing. |
| open | 11.0.0 | 11.0.4 | Apply patch. |
| ora | 9.1.0 | 10.0.0 | Upgrade to major 10; verify spinner output. |
| prompts | 2.4.2 | 2.4.2 | Latest registry release; no deprecation flag. |
| yesno | 0.4.0 | 0.4.0 | Latest registry release; no deprecation flag. |
| @types/node | 24.10.9 | 26.6.6 | Align type definitions with the pinned Node 26 runtime. |
| @types/prompts | 2.4.9 | 2.4.9 | Current registry release. |
| oxlint | 1.41.0 | 1.91.0 | Update within major 1. |
| typescript | 5.9.3 | 7.0.2 | Upgrade to native compiler; verify types, declarations, and package output. |
| vitest | 2.1.9 | 5.1.0 | Upgrade to major 5; verify mocks and CLI integration checks. |

All direct dependencies match their latest stable registry versions at review
time; `pnpm outdated --format json` returns `{}`.

## Major-version compatibility

[Commander 15](https://github.com/tj/commander.js/releases/tag/v15.0.0) is ESM-only
and changes the implicit defaults when positive and negative options are paired.
The CLI already uses ESM and registers both browser options; integration checks
verify `--no-browser` suppresses opening and the default still asks for consent.
[Chalk 6](https://github.com/chalk/chalk/releases/tag/v6.0.0) and
[Ora 10](https://github.com/sindresorhus/ora/releases/tag/v10.0.0) require Node 22;
the pinned Node 26 satisfies this. Their styling and spinner APIs used here are
compatible with the upgraded packages.

TypeScript 7 continues to expose `tsc`. The compiler configuration now explicitly
sets `rootDir` to keep the package layout stable and removes the redundant
`esModuleInterop` option. The build still emits the executable, declarations,
and imported package metadata. [Vitest 5](https://vitest.dev/guide/migration/)
clears mock history before tests by default; the existing per-test reset and
spy setup remains compatible.

## Toolchain pin

The package-manager pin moves from pnpm 10.6.5 to 10.34.9, the latest pnpm 10
release in the registry at review time. pnpm 12.16.1 is a separate major upgrade.
The runtime is pinned to Node 26.13.0 in `.nvmrc` and `package.json`, matching
the latest LTS release in the [official release index](https://nodejs.org/dist/index.json)
at review time. `nvm install` and `nvm use` select this exact version.

Prompts has not released since October 2021, and yesno since June 2022.
Neither is flagged as deprecated or vulnerable in this audit, but the overlapping
prompt libraries are a candidate for consolidation in a later CLI cleanup.

## Production licenses

`pnpm licenses list --prod --json` reports 34 installed runtime dependency
packages: 32 MIT, 1 ISC (`signal-exit`), and 1 labeled `BSD` (`yesno`).
The installed yesno LICENSE identifies the latter as BSD 2-Clause.
No unknown license labels were reported. This checks metadata and the ambiguous
BSD license file; it is not a full review of every distributed source file.

## TypeScript and validation

The checkout already contained TypeScript. The migration completes explicit CLI
option types, validates JSON manifests from `unknown`, handles license strings,
Composer arrays and legacy npm license objects, and removes explicit `any` from
source and tests. NodeNext resolution, strict indexed access, declaration output,
and a separate production build configuration now cover the Node ESM package.
Tests are typechecked but excluded from the published artifact.

Verified locally:

- Frozen-lockfile installation with pnpm 10.34.9.
- Typecheck, lint, all 78 tests, production build, and compiled CLI help
  on the pinned Node 26.13.0 runtime.
- Earlier migration checks also passed on Node 24.15.0 and 22.12.0, before
  pinning the project to Node 26.13.0.
- Local package tarball contents and installation into a temporary consumer.
- Installed symlink command: help, version, npm and Composer HTML generation,
  license information, empty dependencies, and paths containing spaces.
- Importing the installed module does not execute the CLI.
- Node.js CLI integration checks cover npm and pnpm layouts with scoped
  dependencies, projects without production dependencies or `node_modules`,
  and the default browser confirmation.
- Composer CLI checks cover Composer 1/2 metadata, custom vendor directories,
  installer paths, symlinked packages, metapackages, installed replacements and
  providers, platform-only projects, and retained missing-license records.
- Compiled CLI checks against projects installed by Composer 2.10.3: a local
  path repository with a custom vendor directory and metapackage, plus real
  Packagist installations of Monolog 3.12.1 and PSR Log 3.0.2.
- Mocked download checks verify the actual repository and installed revision,
  HTTPS/SSH GitHub URL forms, failure handling, and the bounded request signal.
- Copyleft warning checks cover recognized identifiers, SPDX expressions and
  arrays, permissive and custom-label exclusions, default and verbose scans,
  ANSI highlighting and plain output, Composer metapackages, and continued
  report generation.

Interactive browser launch and live repository downloads were not exercised.

## Recheck commands

```bash
nvm install
nvm use
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm audit
pnpm audit --prod
pnpm outdated --format json
pnpm licenses list --prod --json
pnpm pack --pack-destination /tmp/licensle-package-check
```

Node.js projects scan `package.json.dependencies` and installed `node_modules`;
Composer projects scan `composer.json.require` and the configured vendor directory,
using installed metadata for package paths and license declarations. Development
dependencies are excluded. An empty production dependency set no longer
requires an installed dependency directory.
