import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const entryPoint = fileURLToPath(new URL('../index.ts', import.meta.url));

describe('copyleft warnings in CLI output', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'licensle copyleft '));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  function write(file: string, content: string | object): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }

  function run(args: string[] = [], color = '1') {
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: color };
    delete env.COMPOSER_VENDOR_DIR;
    const result = spawnSync(process.execPath, [entryPoint, ...args], {
      cwd: project,
      encoding: 'utf-8',
      timeout: 10_000,
      env,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return result;
  }

  it.each([
    { source: 'npm', verbose: false, color: '1' },
    { source: 'npm', verbose: true, color: '1' },
    { source: 'Composer', verbose: false, color: '1' },
    { source: 'npm', verbose: false, color: '0' },
  ])('highlights affected dependencies for $source (verbose=$verbose, color=$color)', ({ source, verbose, color }) => {
    const composer = source === 'Composer';
    const manifest = composer ? 'composer.json' : 'package.json';
    const folder = composer ? 'vendor' : 'node_modules';
    const scope = composer ? 'example' : '@example';
    const dependencies = {
      [`${scope}/gnu`]: '1.0.0',
      [`${scope}/dual`]: '1.0.0',
      [`${scope}/permissive`]: '1.0.0',
    };
    write(join(project, manifest), { [composer ? 'require' : 'dependencies']: dependencies });
    for (const [name, license] of [
      ['gnu', 'GPL-3.0-only'],
      ['dual', ['MIT', 'MPL-2.0']],
      ['permissive', 'MIT'],
    ] as const) {
      const directory = join(project, folder, scope, name);
      write(join(directory, manifest), { license });
      write(join(directory, 'LICENSE'), 'Fixture license text.');
    }

    const { stdout, stderr } = run(verbose ? ['--verbose'] : [], color);

    expect(stdout).toContain('Found 3 dependencies.');
    expect(stdout).toContain('Found 3 license files');
    expect(stderr.match(/COPYLEFT WARNING/g)).toHaveLength(1);
    expect(stderr).toContain('Copyleft licenses detected in 2 dependencies:');
    expect(stderr).toContain(`${scope}/gnu: GPL-3.0-only`);
    expect(stderr).toContain(`${scope}/dual: MIT OR MPL-2.0`);
    expect(stderr).not.toContain(`${scope}/permissive`);
    if (color === '1') {
      expect(stderr).toContain('\u001b[43m'); // Yellow background.
      expect(stderr).toContain('\u001b[30m'); // Black text.
      expect(stderr).toContain('\u001b[1m'); // Bold.
    } else {
      expect(stderr).not.toContain('\u001b[');
    }
  });

  it('warns for Composer metapackages even though they have no license files', () => {
    write(join(project, 'composer.json'), { require: { 'example/meta': '^1.0' } });
    write(join(project, 'vendor/composer/installed.json'), { packages: [
      { name: 'example/meta', license: 'LGPL-2.1-or-later', type: 'metapackage', 'install-path': null },
    ] });

    const { stdout, stderr } = run([], '0');

    expect(stdout).toContain('Found 0 license files');
    expect(stderr).toContain('COPYLEFT WARNING');
    expect(stderr).toContain('Copyleft licenses detected in 1 dependency:');
    expect(stderr).toContain('example/meta: LGPL-2.1-or-later');
  });

  it('continues generating the HTML report after a warning', () => {
    write(join(project, 'package.json'), { dependencies: { 'test-dep': '1.0.0' } });
    write(join(project, 'node_modules/test-dep/package.json'), { license: 'GPL-3.0-only' });
    write(join(project, 'node_modules/test-dep/LICENSE'), 'GPL fixture license text.');
    const outputFile = join(project, 'licenses.html');

    const { stdout, stderr } = run(['--generate', '--no-browser', '--outputFilePath', outputFile], '0');

    expect(stderr).toContain('COPYLEFT WARNING');
    expect(stdout).toContain('Creating license HTML file');
    expect(readFileSync(outputFile, 'utf-8')).toContain('GPL fixture license text.');
  });
});
