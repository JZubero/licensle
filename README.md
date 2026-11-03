# Licens*le*
A command-line tool for collecting dependency licenses from a project.

## Installing

Node.js is pinned to 26.13.0 (LTS) in `.nvmrc` and `package.json`.

`npm i -g licensle`

## Usage

Run `licensle` from the project root. Node.js projects use `package.json` and
installed dependencies in `node_modules`, including npm scoped packages and
pnpm symlinks. PHP projects use `composer.json` and `vendor`.
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
support. The build
emits the CLI and TypeScript declarations into `dist/`, excluding tests.
`pnpm pack` builds a local package tarball without publishing it.

See [DEPENDENCY_AUDIT.md](DEPENDENCY_AUDIT.md) for the dependency review,
security findings, and upgrade compatibility notes.

## Maintainer
- Julian Scheuchenzuber <js@lvl51.de>
