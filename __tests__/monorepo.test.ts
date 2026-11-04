import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const entryPoint = fileURLToPath(new URL('../index.ts', import.meta.url));
const promptsEntry = fileURLToPath(new URL('../node_modules/prompts/index.js', import.meta.url));

describe('pnpm monorepo CLI', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'licensle monorepo '));
    outside = mkdtempSync(join(tmpdir(), 'licensle outside workspace '));
    write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n');
    write('package.json', { name: 'workspace-root' });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  function write(file: string, content: string | object): void {
    const location = join(root, file);
    mkdirSync(dirname(location), { recursive: true });
    writeFileSync(location, typeof content === 'string' ? content : JSON.stringify(content));
  }

  function nodeDependency(project: string, name: string, version = '1.0.0', license = 'MIT', notice?: string): void {
    write(`${project}/node_modules/${name}/package.json`, { name, version, license });
    write(`${project}/node_modules/${name}/LICENSE`, notice ?? `${name} ${version} notice.`);
  }

  function composerProject(project: string, vendor = 'vendor'): void {
    write(`${project}/composer.json`, {
      require: { 'example/php-library': '^1', php: '^8.3' },
      'require-dev': { 'example/dev': '*' },
      config: { 'vendor-dir': vendor },
    });
    write(`${project}/${vendor}/composer/installed.json`, { packages: [
      { name: 'example/php-library', version: '1.2.3', license: 'BSD-3-Clause', 'install-path': '../example/php-library' },
    ] });
    write(`${project}/${vendor}/example/php-library/LICENSE`, `PHP notice from ${project}.`);
  }

  function run(args: string[] = [], cwd = root, overrides: NodeJS.ProcessEnv = {}) {
    const outputFile = join(root, 'combined report.html');
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', ...overrides };
    if (!overrides.COMPOSER_VENDOR_DIR) delete env.COMPOSER_VENDOR_DIR;
    const result = spawnSync(process.execPath, [entryPoint, '--generate', '--no-browser', '--no-review-licenses', '--info', '--outputFilePath', outputFile, ...args], {
      cwd, encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return { ...result, outputFile };
  }

  it('combines root, app, package, and Composer-only manifests into one report', () => {
    write('package.json', { name: 'workspace-root', dependencies: { 'root-dep': '1.0.0' } });
    nodeDependency('.', 'root-dep');
    composerProject('.');
    write('apps/web/package.json', {
      name: '@same/web', dependencies: { shared: '1.0.0', '@same/lib': 'workspace:*' },
      devDependencies: { 'not-installed-dev': '*' },
    });
    nodeDependency('apps/web', 'shared');
    composerProject('apps/web', 'custom vendor');
    write('packages/lib/package.json', { name: '@same/lib', dependencies: { shared: '2.0.0' } });
    nodeDependency('packages/lib', 'shared', '2.0.0', 'GPL-3.0-only');
    composerProject('apps/php');

    const { stdout, stderr, outputFile } = run();
    const html = readFileSync(outputFile, 'utf-8');

    expect(stdout).toContain('Monorepo mode: found 6 workspace manifests.');
    expect(stdout).toContain('Scanned 6 of 6 workspace manifests; found 6 dependency occurrences.');
    expect(stdout.match(/Creating license HTML file/g)).toHaveLength(1);
    expect(stdout).toContain('Excluded 1 same-monorepo workspace packages.');
    expect(stdout).not.toContain('Which source file');
    expect(stdout).not.toContain('not-installed-dev');
    expect(html).not.toContain('example/dev');
    for (const manifest of ['package.json', 'composer.json', 'apps/web/package.json', 'apps/web/composer.json', 'packages/lib/package.json', 'apps/php/composer.json']) {
      expect(html).toContain(`<li>${manifest}</li>`);
    }
    expect(html).toContain('shared 1.0.0 notice.');
    expect(html).toContain('shared 2.0.0 notice.');
    expect(html).toContain('Project: apps/web/package.json. Version: 1.0.0.');
    expect(html).toContain('Project: packages/lib/package.json. Version: 2.0.0.');
    expect(html).toContain('PHP notice from apps/web.');
    expect(stderr).toContain('shared@2.0.0 (packages/lib/package.json): GPL-3.0-only');
  });

  it('honors overlapping globs and exclusions while ignoring installed manifests', () => {
    write('pnpm-workspace.yaml', "packages:\n  - './apps/**'\n  - 'apps/*'\n  - '!**/excluded/**'\n  - '!apps/ignored'\n");
    write('apps/web/package.json', {});
    composerProject('apps/web', '_custom_vendor');
    symlinkSync(join(root, 'apps/web'), join(root, 'apps/alias'), 'junction');
    for (const directory of ['apps/excluded', 'apps/excluded/child', 'apps/ignored', 'outside-scope', 'apps/web/node_modules/noise', 'apps/web/vendor/noise', 'apps/web/.git/noise', 'apps/web/_custom_vendor/noise']) {
      write(`${directory}/package.json`, { dependencies: { 'should-not-scan': '*' } });
      write(`${directory}/composer.json`, { require: { 'should-not/scan': '*' } });
    }

    const { stdout, outputFile } = run();

    expect(stdout).toContain('found 3 workspace manifests.');
    expect(stdout).not.toContain('should-not');
    expect(readFileSync(outputFile, 'utf-8')).not.toContain('should-not');
  });

  it('supports a workspace root without its own dependency manifest', () => {
    rmSync(join(root, 'package.json'));
    composerProject('apps/php');

    const { stdout, outputFile } = run();

    expect(stdout).toContain('Scanned 1 of 1 workspace manifests; found 1 dependency occurrences.');
    expect(readFileSync(outputFile, 'utf-8')).toContain('PHP notice from apps/php.');
  });

  it.each(['catalog: {}\n', 'packages: []\n'])('keeps an omitted or empty package list scoped to the root: %j', config => {
    write('pnpm-workspace.yaml', config);
    write('apps/not-declared/package.json', { dependencies: { ignored: '*' } });

    const { stdout } = run();

    expect(stdout).toContain('Scanned 1 of 1 workspace manifests; found 0 dependency occurrences.');
    expect(stdout).not.toContain('apps/not-declared');
  });

  it('can opt out and scan only the root', () => {
    write('apps/web/package.json', { dependencies: { ignored: '*' } });

    const { stdout, outputFile } = run(['--no-monorepo']);

    expect(stdout).not.toContain('Monorepo mode');
    expect(stdout).toContain('Found 0 dependencies.');
    expect(readFileSync(outputFile, 'utf-8')).not.toContain('Workspace license report');
  });

  it('keeps a run inside one member scoped to that project', () => {
    write('apps/web/package.json', { dependencies: { shared: '*' } });
    nodeDependency('apps/web', 'shared');
    write('apps/other/package.json', { dependencies: { ignored: '*' } });

    const { stdout } = run([], join(root, 'apps/web'));

    expect(stdout).not.toContain('Monorepo mode');
    expect(stdout).toContain('Found 1 license files');
    expect(stdout).not.toContain('ignored');
  });

  it('resolves a workspace dependency hoisted to the root node_modules', () => {
    write('apps/web/package.json', { dependencies: { '@example/hoisted': '*' } });
    nodeDependency('.', '@example/hoisted');

    const { stdout, outputFile } = run();

    expect(stdout).toContain('found 1 dependency occurrences.');
    expect(stdout).toContain('Found 1 license files');
    expect(readFileSync(outputFile, 'utf-8')).toContain('@example/hoisted 1.0.0 notice.');
  });

  it('retains missing installations beside successfully scanned projects', () => {
    write('apps/missing/package.json', { dependencies: { shared: '*' } });
    write('apps/php/composer.json', { require: { 'example/missing': '*' } });
    write('packages/good/package.json', { dependencies: { shared: '*' } });
    nodeDependency('packages/good', 'shared');

    const { stdout, outputFile } = run();
    const html = readFileSync(outputFile, 'utf-8');

    expect(stdout).toContain('found 3 dependency occurrences.');
    expect(stdout).toContain('No license file found (2)');
    expect(stdout).toContain('shared (apps/missing/package.json)');
    expect(stdout).toContain('example/missing (apps/php/composer.json)');
    expect(html).toContain('No license file provided.');
    expect(html).toContain('shared 1.0.0 notice.');
  });

  it('continues after an invalid manifest and labels the incomplete report', () => {
    write('apps/<broken>/package.json', '{');
    composerProject('apps/php');

    const { stdout, stderr, outputFile } = run();
    const html = readFileSync(outputFile, 'utf-8');

    expect(stderr).toContain('Could not scan apps/<broken>/package.json');
    expect(stdout).toContain('Scanned 2 of 3 workspace manifests');
    expect(html).toContain('Incomplete scan: 1 workspace manifests failed');
    expect(html).toContain('apps/&lt;broken&gt;/package.json');
    expect(html).not.toContain('apps/<broken>');
    expect(html).toContain('PHP notice from apps/php.');
  });

  it('does not follow workspace directory symlinks outside the repository', () => {
    writeFileSync(join(outside, 'package.json'), '{"dependencies":{"outside":"*"}}');
    mkdirSync(join(root, 'apps'));
    symlinkSync(outside, join(root, 'apps/external'), 'junction');

    const { stdout } = run();

    expect(stdout).toContain('found 1 workspace manifests.');
    expect(stdout).not.toContain('apps/external');
  });

  it('supports explicitly including local workspace dependencies', () => {
    write('apps/web/package.json', { dependencies: { '@same/lib': 'workspace:*' } });
    write('packages/lib/package.json', { name: '@same/lib', version: '1.2.0', license: 'MIT' });
    write('packages/lib/LICENSE', 'Internal workspace notice.');
    mkdirSync(join(root, 'apps/web/node_modules/@same'), { recursive: true });
    symlinkSync(join(root, 'packages/lib'), join(root, 'apps/web/node_modules/@same/lib'), 'junction');

    const { stdout, outputFile } = run(['--no-exclude-workspace-packages']);

    expect(stdout).not.toContain('Excluded');
    expect(readFileSync(outputFile, 'utf-8')).toContain('Internal workspace notice.');
  });

  it('resolves a relative COMPOSER_VENDOR_DIR separately for each workspace project', () => {
    composerProject('apps/a', 'env vendor');
    composerProject('apps/b', 'env vendor');
    write('apps/a/composer.json', { require: { 'example/php-library': '*' }, config: { 'vendor-dir': 'wrong' } });

    const { stdout, outputFile } = run([], root, { COMPOSER_VENDOR_DIR: 'env vendor' });
    const html = readFileSync(outputFile, 'utf-8');

    expect(stdout).toContain('Found 2 license files');
    expect(html).toContain('PHP notice from apps/a.');
    expect(html).toContain('PHP notice from apps/b.');
  });

  it('reviews once after all scans and resolves only the selected occurrence', () => {
    for (const project of ['a', 'b', 'c']) {
      write(`apps/${project}/package.json`, { dependencies: { shared: '*' } });
      write(`apps/${project}/node_modules/shared/package.json`, { version: `${project === 'a' ? 1 : 2}.0.0` });
    }
    write('apps/c/node_modules/shared/LICENSE', 'Already collected notice.');
    const notice = join(root, 'manual notice.txt');
    write('manual notice.txt', 'Manually supplied notice.');
    const outputFile = join(root, 'review report.html');
    const script = `import prompts from ${JSON.stringify(promptsEntry)};
      import { main } from ${JSON.stringify(entryPoint)};
      prompts.inject(['GPL-3.0-only', ${JSON.stringify(notice)}, ':skip']);
      await main({ generate: true, browser: false, reviewLicenses: true, outputFilePath: ${JSON.stringify(outputFile)} });
      console.log('Final working directory: ' + process.cwd());`;

    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.match(/Manual license review:/g)).toHaveLength(1);
    expect(result.stdout).toContain('Manual license review: 2 dependencies need attention.');
    expect(result.stdout.indexOf('Manual license review:')).toBeGreaterThan(result.stdout.indexOf('Scanned 4 of 4'));
    expect(result.stdout).toContain('No license file found (1)');
    expect(result.stdout).toContain('shared@2.0.0 (apps/b/package.json)');
    expect(result.stdout).toContain(`Final working directory: ${root}`);
    expect(result.stderr).toContain('shared@1.0.0 (apps/a/package.json): GPL-3.0-only');
    const html = readFileSync(outputFile, 'utf-8');
    expect(html.match(/License selected manually/g)).toHaveLength(1);
    expect(html).toContain('Manually supplied notice.');
    expect(html).toContain('Already collected notice.');
    expect(html).toContain('No license file provided.');
  });

  it.each(['packages: 42\n', 'packages: [apps/*, 42]\n'])('rejects malformed workspace patterns without generating a misleading report: %j', config => {
    write('pnpm-workspace.yaml', config);

    const { stderr } = run();

    expect(stderr).toContain('Invalid workspace package patterns');
  });

  it('requires a workspace file when monorepo mode is explicitly requested', () => {
    rmSync(join(root, 'pnpm-workspace.yaml'));

    expect(run(['--monorepo']).stderr).toContain('Monorepo mode requires pnpm-workspace.yaml');
  });
});
