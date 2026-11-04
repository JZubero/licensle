# Licens*le*
A command-line tool for collecting dependency licenses from a project.

## Installing

Node.js is pinned to 26.13.0 (LTS) in `.nvmrc` and `package.json`.

`npm i -g licensle`

## Usage

Run `licensle` from the project root. Node.js projects use `package.json` and
installed dependencies in `node_modules`, including npm scoped packages and
pnpm symlinks. PHP projects use `composer.json` and their installed vendor directory.
The CLI collects direct production dependencies (`dependencies` or `require`);
development dependencies are excluded. Projects without production dependencies
produce an empty summary, even without a dependency directory.

```bash
> licensle --help
Usage: licensle [options]

Options:
  -V, --version                output the version number
  -g, --generate               generate a static license summary file
  -b, --browser                open up a browser and show generated static license summary file
  --no-browser                 prevents the browser from popping open
  -i, --info                   provides information about all direct dependency licenses
  -o, --outputFilePath <path>  specify path and name of the output file
  -v, --verbose                activate verbose logging 
  --no-exclude-workspace-packages  include same-monorepo dependencies (excluded by default)
  --review-licenses            review unresolved licenses before generating the report (automatic in a terminal)
  --no-review-licenses         skip interactive license review
  --monorepo                   scan all manifests at a pnpm workspace root (automatic when detected)
  --no-monorepo                skip automatic workspace discovery (additional files still apply)
  --additional-files <paths...>  include extra package.json or composer.json files
  --config <path>              read a configuration file instead of ./licensle.config.json
  -h, --help                   output usage information
```

## Node.js license metadata

The parser supports all current string forms in npm's
[license-field documentation](https://docs.npmjs.com/cli/v12/configuring-npm/package-json#license):
SPDX identifiers, SPDX expressions (`AND`, `OR`, and `WITH`),
`SEE LICENSE IN <filename>`, and `UNLICENSED`.

For compatibility, both `license` and the deprecated plural `licenses` field
accept the same forms, including legacy `{ "type": "MIT", "url": "…" }`
objects and arrays of strings or objects. This includes `ssh2`'s
`licenses: [{ type: "MIT", url: "…" }]` shape. Arrays are displayed as `OR`
alternatives, preserving compound expressions and removing duplicate labels.
A usable `license` field takes precedence; `licenses` is the fallback when
`license` is absent, empty, or has an unsupported structure.

`SEE LICENSE IN` paths are read from the installed package before checking
generic license filenames. Custom filenames and paths containing spaces are
supported; referenced files must stay within that package. Missing or unreadable
references leave the regular file, README, and repository fallbacks available.
The pointer is retained in the report rather than guessing an SPDX identifier.

`UNLICENSED` explicitly means no license grant. It is displayed as such and does
not require a license text file or trigger a manual review prompt.

## Monorepo mode

Run `licensle` at a directory containing `pnpm-workspace.yaml` to automatically
scan the root and all directories matched by its
[`packages` globs](https://pnpm.io/settings#packages). Both
`package.json` and `composer.json` are scanned when present, including
Composer-only projects matched by those patterns. No manifest-selection prompt
is shown in this mode.

```bash
licensle --generate --no-browser --outputFilePath licenses.html
```

The CLI produces one combined summary and HTML report. Each dependency occurrence
is labeled with its source manifest and installed version, so different versions
and licenses across projects remain visible. License review runs once after all
projects have been scanned, followed by the combined copyleft warnings and output.
Each project's dependency directories and Composer configuration are resolved
relative to that project. Node dependencies hoisted to a parent `node_modules`
directory are supported.

Workspace exclusions (`!…`) are respected. Overlapping globs and directory aliases
are scanned once; `node_modules`, Composer vendor directories, `.git`, and
workspace paths pointing outside the repository are excluded from discovery.
The root manifests are always included. An omitted or empty `packages` list
includes only the root. Files outside the declared patterns can be included
with `additionalFiles`, described below.

Missing dependency installations remain in the combined report. Invalid
manifests are reported without stopping the other projects, and the HTML marks
the scan as incomplete when a manifest could not be scanned.

Use `--no-monorepo` to skip automatic workspace discovery. Running inside a workspace
member also scans only that member. `--monorepo` explicitly requests root mode
and requires `pnpm-workspace.yaml` in the current directory. Programmatic callers
can pass `main({ monorepo: false })` or `main({ monorepo: true })`.

## Additional manifests

Create `licensle.config.json` in the directory where you run the CLI to include
manifests outside the workspace patterns. For example, include a separate PHP
admin project without changing its pnpm workspace membership:

```json
{
  "additionalFiles": ["admin/composer.json"]
}
```

For a one-off scan, supply extra paths on the command line:

```bash
licensle --additional-files admin/composer.json "legacy app/package.json" --generate --no-browser
```

`--additional-files` accepts multiple paths and can be repeated. Its entries
are added to the configured list. `--config path/to/settings.json` selects a
different JSON configuration file instead of the automatically detected file.
Currently, `additionalFiles` is the supported configuration-file option.

Configured paths are relative to the configuration file's directory; command-line
and programmatic paths are relative to the current directory. Absolute paths and
`~`/`$HOME` prefixes are also supported. Entries must name individual `package.json`
or `composer.json` files; directory paths and globs are not supported. Explicit
paths may point outside the scan root. Duplicate files, workspace overlaps, and
symlink aliases are scanned once.

Additional manifests join the same summary, manual review, and HTML report.
They also work without a pnpm workspace, and remain active with `--no-monorepo`.
When extra files are specified, both root manifest types are included if present.
Listing a Node project here does not make it an internal workspace package for
license exclusions.

Missing files, unsupported filenames, and invalid configuration produce a clear
error before report generation. If a listed manifest exists but cannot be
parsed, the other projects are scanned and the report marks the scan incomplete.
Programmatic callers can pass `main({ additionalFiles: ['admin/composer.json'] })`;
the `config` option selects a custom configuration file.

## Workspace packages

`excludeWorkspacePackages` defaults to `true`. Packages belonging to the same
declared pnpm, npm, or Yarn workspace are excluded from license reports and
missing-license counts. Workspace membership and the installed package's real
path are checked; external pnpm-store packages and unrelated symlinks stay in
scope. The scanner prints the number excluded, and `--verbose` lists their names.

To include workspace packages, run:

```bash
licensle --no-exclude-workspace-packages
```

Programmatic callers can pass `main({ excludeWorkspacePackages: false })`.
This exclusion applies to Node.js workspace packages; Composer scanning keeps
its existing dependency scope. Internal packages' own external dependencies are
still collected when their manifests are scanned in monorepo mode.

## Manual license review

After scanning, the CLI prompts only when no license information was found,
before printing the final summary and generating HTML. A publisher declaration,
local license file, README license section, or downloaded license text avoids a
prompt even if the manifest lacks a valid SPDX identifier. Empty files, unknown
placeholders, and unresolved `SEE LICENSE IN …` pointers do not supply license
information. Each prompt shows the installed version, declared license,
source repository link when available, and npm or Packagist link. Repository
links include the installed revision and package subdirectory when provided
by the package metadata.

Enter an SPDX identifier or expression, such as `BSD-3-Clause` or
`MIT OR Apache-2.0`. Custom `LicenseRef-…` identifiers and `UNLICENSED` are
also accepted. Then optionally supply a path to a readable license text file;
enter a local path such as `/tmp/publisher-LICENSE.txt`, rather than pasting
license text. The CLI reads that file's contents into the report. Leaving the
path empty supplies no additional text. Choosing a license identifier alone
leaves a missing license text entry unresolved; `UNLICENSED` instead records
that no license grant exists and needs no notice file.

Missing full-text notices are reported separately, even when a declaration
already identifies a license and no prompt is needed. Collected terms without
a declared identifier appear under `License text available (unclassified)` in
`--info` output. The scanner preserves publisher labels such as `BSD` and does
not silently choose a more specific license variant.

Leave the license empty or enter `:skip` to skip a package. Enter `:done` or
press Ctrl+C to finish reviewing and continue with the report; completed
selections are retained. Selections affect this run only. HTML records manual
selections, the original declaration, and whether notice text was supplied.
The summary and copyleft warnings use the selected expression.

Review runs automatically when input and output are terminals and `CI` is
unset. Use `--no-review-licenses` to skip it, or `--review-licenses` to request
it explicitly with terminal input. Unattended runs continue without prompting.
Programmatic callers can set `main({ reviewLicenses: false })` or
`main({ reviewLicenses: true })`.

## Copyleft warnings

Every scan automatically prints a highlighted `COPYLEFT WARNING` block to stderr
when declared dependency licenses include recognized copyleft identifiers. It
lists the affected packages and their complete license expressions, with or
without `--info` or `--verbose`. The warning appears after the spinner finishes
so it stays visible, using a bold yellow banner when terminal colors are enabled.

Detection covers GPL, LGPL, AGPL, MPL, EPL, CPL, CDDL, EUPL, and OSL identifiers,
including deprecated GNU `+` and exception forms. Composer license arrays and
SPDX `AND`, `OR`, and `WITH` expressions are supported. An `OR` alternative or
exception may affect which terms apply; the warning preserves the expression
for review. See the [SPDX expression specification](https://spdx.github.io/spdx-spec/v2.3.1/SPDX-license-expressions/)
and [GNU license classifications](https://www.gnu.org/licenses/license-list.html).

Detection uses declared license metadata. Custom `LicenseRef` labels, missing
metadata, and other unrecognized licenses are not classified; the absence of a
warning does not classify a license as permissive. Scanning and report generation
continue after the warning.

## Composer support

The scanner reads production `require` entries and excludes platform requirements
such as PHP, extensions, libraries, and Composer's runtime/plugin APIs.

The vendor directory defaults to `vendor`. Project `config.vendor-dir` and the
`COMPOSER_VENDOR_DIR` environment override are supported, including absolute
paths and home-directory prefixes (`~` and `$HOME`).

Composer 1 and 2 `composer/installed.json` metadata supplies license declarations
and package locations. This supports archives without `composer.json`, custom
installer paths, symlinked path repositories, and metapackages without package
files. If installation metadata is absent, the scanner reads each package's
`composer.json` in the conventional vendor layout.

Installed providers and replacements are scanned under their actual package
names and deduplicated. If several installed runtime packages provide a required
virtual package, each is included; version constraints are not re-solved.

License files and README license sections take priority over downloads. GitHub
fallbacks use the installed package's `source.url` and exact `source.reference`.
SPDX identifiers and expressions are preserved. Missing license text or a failed
download leaves the dependency in the report with its declared license metadata.
Metapackages retain their metadata without requiring a license file.

## Development

Use the pnpm version pinned in `package.json` (10.34.9).

```bash
nvm install
nvm use
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
node dist/index.js --help
```

`pnpm test` runs unit tests and CLI integration checks once; `pnpm test:watch`
starts watch mode. The CLI checks run the source using Node 26's TypeScript
support. The build emits the CLI and TypeScript declarations into `dist/`,
excluding tests.
`pnpm pack` builds a local package tarball without publishing it.

See [DEPENDENCY_AUDIT.md](DEPENDENCY_AUDIT.md) for the dependency review,
security findings, and upgrade compatibility notes.

## Maintainer
- Julian Scheuchenzuber <js@lvl51.de>
