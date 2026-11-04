import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const entryPoint = fileURLToPath(new URL('../index.ts', import.meta.url));

describe('same-monorepo workspace exclusion', () => {
  let root: string;
  let outside: string;
  let app: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'licensle workspace '));
    outside = mkdtempSync(join(tmpdir(), 'licensle external '));
    app = join(root, 'apps/app');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  function write(file: string, content: string | object): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }

  function workspace(manager = 'pnpm', specifier = 'workspace:*'): void {
    write(join(root, 'package.json'), {
      name: 'monorepo',
      ...(manager === 'npm' ? { workspaces: ['apps/*', 'packages/*'] } : {}),
      ...(manager === 'yarn' ? { workspaces: { packages: ['apps/*', 'packages/*'] } } : {}),
    });
    if (manager === 'pnpm') write(join(root, 'pnpm-workspace.yaml'), "packages:\n  - './apps/*'\n  - 'packages//*'\n  - '!./packages/excluded'\n");
    write(join(app, 'package.json'), { name: '@same/app', dependencies: { '@same/lib': specifier } });
    write(join(root, 'packages/lib/package.json'), { name: '@same/lib', version: '1.0.0' });
  }

  function link(name: string, directory: string): void {
    const destination = join(app, 'node_modules', name);
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(directory, destination, 'junction');
  }

  function run(...args: string[]) {
    const result = spawnSync(process.execPath, [entryPoint, ...args], {
      cwd: app,
      encoding: 'utf-8',
      timeout: 10_000,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return result;
  }

  it.each(['pnpm', 'npm', 'yarn'])('excludes a linked member of the same %s workspace by default', manager => {
    workspace(manager, manager === 'pnpm' ? 'workspace:*' : '^1.0.0');
    link('@same/lib', join(root, 'packages/lib'));

    const { stdout, stderr } = run();

    expect(stdout).toContain('Excluded 1 same-monorepo workspace packages.');
    expect(stdout).toContain('Found 0 dependencies.');
    expect(stdout).not.toContain('No license file found');
    expect(stderr).not.toContain('Could not');
  });

  it('lets users include workspace packages explicitly', () => {
    workspace();
    link('@same/lib', join(root, 'packages/lib'));

    const { stdout } = run('--no-exclude-workspace-packages');

    expect(stdout).not.toContain('Excluded');
    expect(stdout).toContain('Found 1 dependencies.');
    expect(stdout).toContain('No license file found (1)');
    expect(stdout).toContain('@same/lib');
  });

  it('does not exclude an external registry package whose name matches a local member', () => {
    workspace('pnpm', '^1.0.0');
    const directory = join(root, 'node_modules/.pnpm/same-lib@1/node_modules/@same/lib');
    write(join(directory, 'package.json'), { name: '@same/lib', license: 'MIT' });
    write(join(directory, 'LICENSE'), 'External registry license.');
    link('@same/lib', directory);

    const { stdout } = run();

    expect(stdout).not.toContain('Excluded');
    expect(stdout).toContain('Found 1 license files');
  });

  it('does not exclude an arbitrary external symlink', () => {
    workspace();
    write(join(outside, 'package.json'), { name: '@same/lib', license: 'MIT' });
    write(join(outside, 'LICENSE'), 'External linked package license.');
    link('@same/lib', outside);

    const { stdout } = run();

    expect(stdout).not.toContain('Excluded');
    expect(stdout).toContain('Found 1 license files');
  });

  it('honors negative workspace patterns instead of excluding any local path', () => {
    workspace();
    const excludedMember = join(root, 'packages/excluded');
    write(join(excludedMember, 'package.json'), { name: '@same/lib', license: 'MIT' });
    write(join(excludedMember, 'LICENSE'), 'Not a declared workspace member.');
    link('@same/lib', excludedMember);

    const { stdout } = run();

    expect(stdout).not.toContain('Excluded');
    expect(stdout).toContain('Found 1 license files');
  });

  it('can exclude an uninstalled workspace: dependency with a confirmed local member', () => {
    workspace();

    const { stdout, stderr } = run();

    expect(stdout).toContain('Excluded 1 same-monorepo workspace packages.');
    expect(stdout).toContain('Found 0 dependencies.');
    expect(stderr).not.toContain('There is no dependency folder');
  });

  it('does not silently exclude an unrecognized workspace: dependency', () => {
    workspace();
    write(join(app, 'package.json'), { name: '@same/app', dependencies: { '@same/missing': 'workspace:*' } });

    const { stdout, stderr } = run();

    expect(stdout).not.toContain('Excluded');
    expect(stderr).toContain('There is no dependency folder');
  });

  it('rejects malformed workspace settings and allows opting out of exclusion', () => {
    workspace();
    write(join(root, 'pnpm-workspace.yaml'), 'packages: 42\n');
    link('@same/lib', join(root, 'packages/lib'));
    write(join(root, 'packages/lib/LICENSE'), 'Local source license.');

    expect(run().stderr).toContain('Invalid workspace package patterns');
    expect(run('--no-exclude-workspace-packages').stdout).toContain('Found 1 license files');
  });
});
