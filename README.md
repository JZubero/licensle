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
  -h, --help                   output usage information
```

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
