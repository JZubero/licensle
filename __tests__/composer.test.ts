import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const entryPoint = fileURLToPath(new URL('../index.ts', import.meta.url));

describe('Composer project CLI', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'licensle composer project '));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  function write(file: string, content: string | object): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }

  function run(vendorDir?: string): { output: string; html: string } {
    const outputFile = join(project, 'licenses.html');
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0' };
    delete env.COMPOSER_VENDOR_DIR;
    if (vendorDir) env.COMPOSER_VENDOR_DIR = vendorDir;
    const output = execFileSync(process.execPath, [entryPoint, '--generate', '--no-browser', '--info', '--outputFilePath', outputFile], {
      cwd: project,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    return { output, html: readFileSync(outputFile, 'utf-8') };
  }

  it('scans a conventional vendor layout and preserves SPDX expressions', () => {
    write(join(project, 'composer.json'), {
      require: { php: '^8.3', 'php-64bit': '*', 'ext-json': '*', 'lib-curl': '*', 'composer-runtime-api': '^2.0', 'example/library': '^1.0' },
      'require-dev': { 'example/dev-package': '^1.0' },
    });
    write(join(project, 'vendor/example/library/composer.json'), { license: '(MIT AND Apache-2.0)', description: 'Composer library' });
    write(join(project, 'vendor/example/library/LICENCE.txt'), 'Composer license text.');

    const { output, html } = run();
    expect(output).toContain('Found 1 dependencies.');
    expect(output).toContain('(MIT AND Apache-2.0) (1 usages)');
    expect(html).toContain('Composer license text.');
    expect(html).not.toContain('example/dev-package');
  });

  it.each(['Composer 1', 'Composer 2'])('uses %s installation metadata when a package has no composer.json', (version) => {
    write(join(project, 'composer.json'), { require: { 'example/library': '^1.0' } });
    const packages = [{ name: 'example/library', license: ['MIT', 'Apache-2.0'], description: 'Metadata description',
      ...(version === 'Composer 2' ? { 'install-path': '../example/library' } : {}),
    }];
    write(join(project, 'vendor/composer/installed.json'), version === 'Composer 1' ? packages : { packages, 'dev-package-names': [] });
    write(join(project, 'vendor/example/library/LICENSE'), 'Metadata package license.');

    const { output, html } = run();
    expect(output).toContain('Found 1 license files');
    expect(html).toContain('MIT OR Apache-2.0');
    expect(html).toContain('Metadata description');
    expect(html).toContain('Metadata package license.');
  });

  it.each(['relative config', 'absolute config', 'environment override', 'tilde config', '$HOME config'])('honors a custom vendor directory via %s', (mode) => {
    const configured = mode === 'absolute config' ? join(project, 'custom vendor')
      : mode === 'tilde config' ? `~/${relative(homedir(), join(project, 'custom vendor'))}`
      : mode === '$HOME config' ? `$HOME/${relative(homedir(), join(project, 'custom vendor'))}` : 'custom vendor';
    const folder = mode === 'environment override' ? 'environment vendor' : 'custom vendor';
    write(join(project, 'composer.json'), { require: { 'example/library': '^1.0' }, config: { 'vendor-dir': configured } });
    write(join(project, folder, 'example/library/composer.json'), { license: 'BSD-3-Clause' });
    write(join(project, folder, 'example/library/LICENSE'), 'Custom vendor license.');

    const { output, html } = run(mode === 'environment override' ? join(project, folder) : undefined);
    expect(output).toContain('Found 1 license files');
    expect(html).toContain('BSD-3-Clause');
    expect(html).toContain('Custom vendor license.');
  });

  it('follows installer paths outside vendor and accepts symlinked packages', () => {
    write(join(project, 'composer.json'), { require: { 'example/plugin': '^1.0', 'example/local': '^1.0' } });
    write(join(project, 'vendor/composer/installed.json'), { packages: [
      { name: 'example/plugin', license: 'MIT', 'install-path': '../../plugins/example' },
      { name: 'example/local', license: 'MIT', 'install-path': '../example/local' },
    ] });
    write(join(project, 'plugins/example/LICENSE'), 'Plugin license text.');
    write(join(project, 'packages/local/LICENSE'), 'Symlinked license text.');
    mkdirSync(join(project, 'vendor/example'), { recursive: true });
    symlinkSync(join(project, 'packages/local'), join(project, 'vendor/example/local'), 'junction');

    const { output, html } = run();
    expect(output).toContain('Found 2 license files');
    expect(html).toContain('Plugin license text.');
    expect(html).toContain('Symlinked license text.');
  });

  it('retains metapackage license metadata without requiring package files', () => {
    write(join(project, 'composer.json'), { require: { 'example/meta': '^1.0' } });
    write(join(project, 'vendor/composer/installed.json'), { packages: [
      { name: 'example/meta', type: 'metapackage', license: 'MIT', description: 'A metapackage', 'install-path': null },
    ] });

    const { output, html } = run();
    expect(output).toContain('MIT (1 usages)');
    expect(output).not.toContain('No license file found');
    expect(html).toContain('example/meta');
    expect(html).toContain('No license file provided.');
  });

  it('uses a local README license before attempting a repository download', () => {
    write(join(project, 'composer.json'), { require: { 'example/library': '^1.0' } });
    write(join(project, 'vendor/composer/installed.json'), { packages: [
      { name: 'example/library', license: 'MIT', source: { url: 'https://github.com/actual-owner/different-repository.git', reference: 'abc123' } },
    ] });
    write(join(project, 'vendor/example/library/README.md'), '# Library\n\n## License\n\nREADME license text.');

    const { output, html } = run();
    expect(output).toContain('Found 1 licenses in README files');
    expect(output).toContain('Downloaded 0 license files');
    expect(html).toContain('README license text.');
  });

  it('resolves installed replacements and virtual providers without duplicating packages', () => {
    write(join(project, 'composer.json'), { require: { 'old/library': '^1.0', 'virtual/implementation': '*', 'example/provider': '^1.0' } });
    write(join(project, 'vendor/composer/installed.json'), {
      packages: [
        { name: 'example/provider', license: 'MIT', replace: { 'old/library': 'self.version' }, provide: { 'virtual/implementation': '*' } },
        { name: 'example/dev-provider', license: 'MIT', provide: { 'virtual/implementation': '*' } },
      ],
      'dev-package-names': ['example/dev-provider'],
    });
    write(join(project, 'vendor/example/provider/LICENSE'), 'Provider license text.');

    const { output, html } = run();
    expect(output).toContain('Found 1 dependencies.');
    expect(html).toContain('example/provider');
    expect(html).not.toContain('example/dev-provider');
    expect(html).not.toContain('old/library');
  });

  it('reports uninstalled requirements instead of silently dropping them', () => {
    write(join(project, 'composer.json'), { require: { 'example/missing': '^1.0' } });
    mkdirSync(join(project, 'vendor'));

    const { output, html } = run();
    expect(output).toContain('No license file found (1)');
    expect(html).toContain('example/missing');
  });

  it.each([{}, { require: { php: '^8.3', 'ext-json': '*', 'composer-plugin-api': '^2.0' } }])('accepts projects without installable requirements', (manifest) => {
    write(join(project, 'composer.json'), manifest);

    const { output, html } = run();
    expect(output).toContain('Found 0 dependencies.');
    expect(html).toBe('');
  });
});
