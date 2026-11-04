import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const entryPoint = fileURLToPath(new URL('../index.ts', import.meta.url));

describe('additional manifest configuration', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'licensle additional files '));
    outside = mkdtempSync(join(tmpdir(), 'licensle explicit external '));
    write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n');
    write('package.json', { name: 'workspace-root' });
    write('apps/web/package.json', { name: '@same/web' });
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

  function composer(directory = 'admin'): void {
    write(`${directory}/composer.json`, { require: { 'example/php-library': '*' }, config: { 'vendor-dir': 'custom vendor' } });
    write(`${directory}/custom vendor/composer/installed.json`, { packages: [
      { name: 'example/php-library', version: '1.2.3', license: 'BSD-3-Clause', 'install-path': '../example/php-library' },
    ] });
    write(`${directory}/custom vendor/example/php-library/LICENSE`, `PHP notice from ${directory}.`);
  }

  function nodeProject(directory = 'legacy tools'): void {
    write(`${directory}/package.json`, { dependencies: { shared: '*' } });
    write(`${directory}/node_modules/shared/package.json`, { name: 'shared', version: '2.0.0', license: 'MIT' });
    write(`${directory}/node_modules/shared/LICENSE`, 'Additional Node notice.');
  }

  function run(args: string[] = []) {
    const outputFile = join(root, 'report.html');
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0' };
    delete env.COMPOSER_VENDOR_DIR;
    const result = spawnSync(process.execPath, [entryPoint, '--generate', '--no-browser', '--no-review-licenses', '--info', '--outputFilePath', outputFile, ...args], {
      cwd: root, encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return { ...result, outputFile };
  }

  it('automatically includes configured Composer files without changing workspace membership', () => {
    composer();
    write('licensle.config.json', { additionalFiles: ['admin/composer.json'] });

    const { stdout, outputFile } = run();
    const html = readFileSync(outputFile, 'utf-8');

    expect(stdout).toContain('Monorepo mode: found 2 workspace manifests.');
    expect(stdout).toContain('Included 1 additional manifests.');
    expect(stdout).toContain('Scanned 3 of 3 manifests; found 1 dependency occurrences.');
    expect(stdout.match(/Creating license HTML file/g)).toHaveLength(1);
    expect(html).toContain('<li>admin/composer.json</li>');
    expect(html).toContain('PHP notice from admin.');
    expect(html).toContain('Project: admin/composer.json. Version: 1.2.3.');
    expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf-8')).toBe('packages:\n  - apps/*\n');
  });

  it('accepts multiple CLI paths and repeated options, including spaces and duplicates', () => {
    composer();
    nodeProject();

    const { stdout, outputFile } = run(['--additional-files', 'admin/composer.json', 'legacy tools/package.json', '--additional-files', './admin/composer.json']);

    expect(stdout).toContain('Included 2 additional manifests.');
    expect(stdout).toContain('Scanned 4 of 4 manifests; found 2 dependency occurrences.');
    const html = readFileSync(outputFile, 'utf-8');
    expect(html).toContain('PHP notice from admin.');
    expect(html).toContain('Additional Node notice.');
    expect(html.match(/<li>admin\/composer.json<\/li>/g)).toHaveLength(1);
  });

  it('merges CLI files with the configuration list', () => {
    composer();
    nodeProject();
    write('licensle.config.json', { additionalFiles: ['admin/composer.json'] });

    expect(run(['--additional-files', 'legacy tools/package.json']).stdout).toContain('Included 2 additional manifests.');
  });

  it('resolves configured paths relative to a custom config file and replaces automatic config selection', () => {
    composer();
    write('settings/review config.json', { additionalFiles: ['../admin/composer.json'] });
    write('licensle.config.json', { additionalFiles: ['does-not-exist/composer.json'] });

    const { stdout, outputFile } = run(['--config', 'settings/review config.json']);

    expect(stdout).toContain('Included 1 additional manifests.');
    expect(readFileSync(outputFile, 'utf-8')).toContain('PHP notice from admin.');
  });

  it('deduplicates workspace files and additional aliases by their resolved manifest path', () => {
    composer();
    symlinkSync(join(root, 'admin'), join(root, 'admin-alias'), 'junction');
    write('licensle.config.json', { additionalFiles: ['apps/web/package.json', 'admin/composer.json', 'admin-alias/composer.json'] });

    const { stdout, outputFile } = run(['--additional-files', join(root, 'admin/composer.json')]);

    expect(stdout).toContain('Included 1 additional manifests.');
    expect(stdout).toContain('Scanned 3 of 3 manifests; found 1 dependency occurrences.');
    expect(readFileSync(outputFile, 'utf-8').match(/<li>apps\/web\/package.json<\/li>/g)).toHaveLength(1);
  });

  it('does not treat additional Node projects as internal workspace members', () => {
    write('package.json', { dependencies: { '@extra/lib': 'file:./legacy/lib' } });
    write('legacy/lib/package.json', { name: '@extra/lib', version: '1.0.0', license: 'MIT' });
    write('legacy/lib/LICENSE', 'Explicit additional library notice.');
    write('licensle.config.json', { additionalFiles: ['legacy/lib/package.json'] });
    mkdirSync(join(root, 'node_modules/@extra'), { recursive: true });
    symlinkSync(join(root, 'legacy/lib'), join(root, 'node_modules/@extra/lib'), 'junction');

    const { stdout, outputFile } = run();

    expect(stdout).not.toContain('Excluded');
    expect(stdout).toContain('found 1 dependency occurrences.');
    expect(readFileSync(outputFile, 'utf-8')).toContain('Explicit additional library notice.');
  });

  it('keeps additional files active when automatic monorepo discovery is disabled', () => {
    composer();
    write('licensle.config.json', { additionalFiles: ['admin/composer.json'] });

    const { stdout, outputFile } = run(['--no-monorepo']);
    const html = readFileSync(outputFile, 'utf-8');

    expect(stdout).not.toContain('Monorepo mode');
    expect(stdout).toContain('Scanned 2 of 2 manifests; found 1 dependency occurrences.');
    expect(html).not.toContain('apps/web/package.json');
    expect(html).toContain('Combined license report');
  });

  it('combines both root manifest types and extra files without a pnpm workspace', () => {
    rmSync(join(root, 'pnpm-workspace.yaml'));
    composer('.');
    nodeProject();

    const { stdout, outputFile } = run(['--additional-files', 'legacy tools/package.json']);

    expect(stdout).not.toContain('Which source file');
    expect(stdout).toContain('Scanned 3 of 3 manifests; found 2 dependency occurrences.');
    expect(readFileSync(outputFile, 'utf-8')).toContain('Additional Node notice.');
  });

  it('supports additional files as the only manifests to scan', () => {
    rmSync(join(root, 'pnpm-workspace.yaml'));
    rmSync(join(root, 'package.json'));
    composer();

    expect(run(['--additional-files', 'admin/composer.json']).stdout).toContain('Scanned 1 of 1 manifests; found 1 dependency occurrences.');
  });

  it('accepts explicitly listed manifests outside the root', () => {
    writeFileSync(join(outside, 'package.json'), '{"name":"explicit-external"}');

    const { stdout, outputFile } = run(['--additional-files', join(outside, 'package.json')]);

    expect(stdout).toContain('Included 1 additional manifests.');
    expect(readFileSync(outputFile, 'utf-8')).toContain(relative(root, join(outside, 'package.json')));
  });

  it.each([{}, { additionalFiles: [] }])('leaves normal discovery unchanged for an empty configuration: %j', config => {
    write('licensle.config.json', config);

    const { stdout } = run();

    expect(stdout).toContain('Scanned 2 of 2 workspace manifests; found 0 dependency occurrences.');
    expect(stdout).not.toContain('Included');
  });

  it.each(['admin/composer.json', 42, null, [42], ['']])('rejects malformed file lists: %j', additionalFiles => {
    write('licensle.config.json', { additionalFiles });

    const { stderr, outputFile } = run();

    expect(stderr).toContain('Invalid additionalFiles');
    expect(existsSync(outputFile)).toBe(false);
  });

  it.each(['null', '[]', '"invalid"'])('rejects a config that is not an object: %s', config => {
    write('licensle.config.json', config);

    expect(run().stderr).toContain('Invalid configuration');
  });

  it('reports a missing custom configuration instead of falling back silently', () => {
    expect(run(['--config', 'missing-config.json']).stderr).toContain('Could not read configuration');
  });

  it('reports invalid JSON configuration', () => {
    write('licensle.config.json', '{');

    expect(run().stderr).toContain('Could not read configuration');
  });

  it('reports unknown configuration keys to catch misspelled options', () => {
    write('licensle.config.json', { additionalFile: ['admin/composer.json'] });

    expect(run().stderr).toContain('Unknown configuration option "additionalFile"');
  });

  it('reports missing additional files before generating a report', () => {
    write('licensle.config.json', { additionalFiles: ['missing/composer.json'] });

    const { stderr, outputFile } = run();

    expect(stderr).toContain('Could not include additional file');
    expect(stderr).toContain('missing/composer.json');
    expect(existsSync(outputFile)).toBe(false);
  });

  it('rejects files that are not supported dependency manifests', () => {
    write('admin/metadata.json', {});

    expect(run(['--additional-files', 'admin/metadata.json']).stderr).toContain('Additional file must be named package.json or composer.json');
  });

  it('rejects directories named like a manifest', () => {
    mkdirSync(join(root, 'admin/composer.json'), { recursive: true });

    expect(run(['--additional-files', 'admin/composer.json']).stderr).toContain('Not a regular file');
  });

  it('retains successful results when an additional manifest cannot be parsed', () => {
    write('admin/composer.json', '{');
    write('licensle.config.json', { additionalFiles: ['admin/composer.json'] });

    const { stdout, stderr, outputFile } = run();

    expect(stdout).toContain('Scanned 2 of 3 manifests');
    expect(stderr).toContain('Could not scan admin/composer.json');
    expect(readFileSync(outputFile, 'utf-8')).toContain('Incomplete scan: 1 manifests failed');
  });

  it('supports additionalFiles for programmatic callers', () => {
    composer();
    const outputFile = join(root, 'programmatic.html');
    const script = `import { main } from ${JSON.stringify(entryPoint)};
      await main({ additionalFiles: ['admin/composer.json'], generate: true, browser: false,
        reviewLicenses: false, outputFilePath: ${JSON.stringify(outputFile)} });`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Included 1 additional manifests.');
    expect(readFileSync(outputFile, 'utf-8')).toContain('PHP notice from admin.');
  });
});
