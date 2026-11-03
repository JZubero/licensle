import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Node 26 runs the TypeScript entry point directly, keeping watch-mode checks fresh.
const entryPoint = fileURLToPath(new URL('../index.ts', import.meta.url));

describe('Node.js project CLI', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'licensle node project '));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  function run(...args: string[]): string {
    return execFileSync(process.execPath, [entryPoint, ...args], {
      cwd: project,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
  }

  function installDependency(folder: string): void {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'package.json'), JSON.stringify({
      name: '@example/test-dep',
      version: '1.0.0',
      license: 'MIT',
      description: 'A Node.js dependency',
    }));
    writeFileSync(join(folder, 'LICENSE'), 'Node.js fixture license text.');
  }

  it.each(['npm', 'pnpm'])('scans scoped dependencies installed with an %s layout', (manager) => {
    writeFileSync(join(project, 'package.json'), JSON.stringify({
      dependencies: { '@example/test-dep': '1.0.0' },
      devDependencies: { 'not-installed-dev-dep': '1.0.0' },
    }));
    const scopeFolder = join(project, 'node_modules', '@example');
    mkdirSync(scopeFolder, { recursive: true });
    const dependency = join(scopeFolder, 'test-dep');
    if (manager === 'pnpm') {
      const storedDependency = join(project, 'node_modules', '.pnpm', '@example+test-dep@1.0.0', 'node_modules', '@example', 'test-dep');
      installDependency(storedDependency);
      symlinkSync(storedDependency, dependency, 'junction');
    } else {
      installDependency(dependency);
    }

    const outputFile = join(project, 'licenses.html');
    const output = run('--generate', '--no-browser', '--info', '--outputFilePath', outputFile);

    expect(output).toContain('Found 1 dependencies.');
    expect(output).toContain('Found 1 license files');
    expect(output).toContain('MIT (1 usages)');
    expect(output).toContain('@example/test-dep');
    expect(output).not.toContain('not-installed-dev-dep');
    expect(readFileSync(outputFile, 'utf-8')).toContain('Node.js fixture license text.');
  });

  it.each([
    { name: 'no dependencies', manifest: {} },
    { name: 'only development dependencies', manifest: { devDependencies: { typescript: '^7.0.2' } } },
  ])('supports $name without a node_modules folder', ({ manifest }) => {
    writeFileSync(join(project, 'package.json'), JSON.stringify(manifest));

    expect(run('--info')).toContain('Found 0 dependencies.');
  });

  it('keeps browser opening opt-in when both browser flags are registered', () => {
    writeFileSync(join(project, 'package.json'), '{}');
    mkdirSync(join(project, 'node_modules'));

    // With no --browser flag, generation must still ask before opening anything.
    const output = execFileSync(process.execPath, [entryPoint, '--generate', '--outputFilePath', join(project, 'licenses.html')], {
      cwd: project,
      encoding: 'utf-8',
      input: 'n\n',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    expect(output).toContain('Show output file in browser?');
  });
});
