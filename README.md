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
  -h, --help                   output usage information
```

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
its existing scope. Workspaces are still scanned individually.

## Manual license review

After scanning, the CLI prompts for dependencies with missing license text or
an unrecognized license expression, before printing the final summary and
generating HTML. Each prompt shows the installed version, declared license,
source repository link when available, and npm or Packagist link. Repository
links include the installed revision and package subdirectory when provided
by the package metadata.

Enter an SPDX identifier or expression, such as `BSD-3-Clause` or
`MIT OR Apache-2.0`. Custom `LicenseRef-…` identifiers and `UNLICENSED` are
also accepted. Then optionally supply a path to a readable license text file;
leaving that path empty retains any text already collected. Choosing an
identifier alone leaves a missing license text entry unresolved.

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
