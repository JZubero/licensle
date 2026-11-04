import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const entryPoint = fileURLToPath(new URL('../index.ts', import.meta.url));

describe('manual review in unattended CLI runs', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'licensle review cli '));
    const dependency = join(project, 'node_modules/test-dep');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(project, 'package.json'), '{"dependencies":{"test-dep":"1.0.0"}}');
    writeFileSync(join(dependency, 'package.json'), '{"name":"test-dep","version":"1.0.0"}');
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it.each(['default', 'disabled', 'forced'])('does not wait for terminal input when stdin is closed: %s', mode => {
    const outputFile = join(project, 'report.html');
    const args = mode === 'disabled' ? ['--no-review-licenses'] : mode === 'forced' ? ['--review-licenses'] : [];
    const result = spawnSync(process.execPath, [entryPoint, '--generate', '--no-browser', '--outputFilePath', outputFile, ...args], {
      cwd: project,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('License (SPDX expression)');
    expect(readFileSync(outputFile, 'utf-8')).toContain('No license file provided.');
    expect(readFileSync(outputFile, 'utf-8')).not.toContain('License selected manually.');
    if (mode === 'default') expect(result.stdout).toContain('Manual license review skipped');
    if (mode === 'forced') expect(result.stderr).toContain('requires terminal input; skipped');
  });
});
