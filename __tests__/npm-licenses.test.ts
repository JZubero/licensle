import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const entryPoint = fileURLToPath(new URL('../index.ts', import.meta.url));

describe('npm license declarations and referenced notices', () => {
  let root: string;
  let dependency: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'licensle npm licenses '));
    dependency = join(root, 'node_modules/example');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"dependencies":{"example":"1.0.0"}}');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function manifest(fields: object): void {
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'example', version: '1.0.0', ...fields }));
  }

  function run() {
    const outputFile = join(root, 'report.html');
    const result = spawnSync(process.execPath, [entryPoint, '--generate', '--no-browser', '--no-review-licenses', '--info', '--outputFilePath', outputFile], {
      cwd: root, encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return { ...result, html: readFileSync(outputFile, 'utf-8') };
  }

  for (const field of ['license', 'licenses']) {
    it.each([
      'SEE LICENSE IN custom notice.txt',
      { type: 'SEE LICENSE IN custom notice.txt', url: 'https://example.com/terms' },
      ['SEE LICENSE IN custom notice.txt'],
      [{ type: 'SEE LICENSE IN custom notice.txt' }],
    ])(`follows ${field} file references from %j before generic filenames`, value => {
      manifest({ [field]: value });
      writeFileSync(join(dependency, 'custom notice.txt'), 'Authoritative custom terms <publisher> & attribution.');
      writeFileSync(join(dependency, 'LICENSE'), 'Other generic notice.');

      const { stdout, html } = run();

      expect(stdout).toContain('Found 1 license files');
      expect(stdout).not.toContain('No license file found');
      expect(html).toContain('Authoritative custom terms &lt;publisher&gt; &amp; attribution.');
      expect(html).not.toContain('Other generic notice.');
    });

    it(`supports an explicit UNLICENSED declaration in ${field}`, () => {
      manifest({ [field]: 'UNLICENSED' });

      const { stdout, stderr, html } = run();

      expect(stdout).toContain('UNLICENSED (1 usages)');
      expect(stdout).not.toContain('No license file found');
      expect(stderr).not.toContain('COPYLEFT WARNING');
      expect(html).toContain('No license grant (UNLICENSED).');
    });

    it(`retains missing notice status for an unresolved ${field} file reference`, () => {
      manifest({ [field]: 'SEE LICENSE IN absent-notice.txt' });

      const { stdout, html } = run();

      expect(stdout).toContain('No license file found (1)');
      expect(html).toContain('No license file provided.');
    });
  }

  it('uses license in preference to conflicting legacy licenses', () => {
    manifest({ license: 'UNLICENSED', licenses: [{ type: 'MIT' }] });

    const { stdout } = run();

    expect(stdout).toContain('UNLICENSED (1 usages)');
    expect(stdout).not.toContain('MIT');
  });

  it.each([null, '', [], {}, 42, [null, 'GPL-3.0-only']])('falls back to licenses when license has no usable declaration: %j', license => {
    manifest({ license, licenses: [{ type: 'MIT', url: 'http://github.com/mscdex/ssh2/raw/master/LICENSE' }] });

    expect(run().stdout).toContain('MIT (1 usages)');
  });

  it('collects and deduplicates multiple file references', () => {
    manifest({ licenses: ['SEE LICENSE IN first.txt', { type: 'SEE LICENSE IN second.txt' }, 'SEE LICENSE IN ./first.txt'] });
    writeFileSync(join(dependency, 'first.txt'), 'First license terms.');
    writeFileSync(join(dependency, 'second.txt'), 'Second license terms.');

    const { stdout, html } = run();

    expect(stdout).toContain('Found 2 license files');
    expect(html).toContain('Second license terms.');
    expect(html.match(/First license terms\./g)).toHaveLength(1);
  });

  it.each(['SEE LICENSE IN ../../private.txt', 'SEE LICENSE IN linked-terms.txt'])('does not read referenced files outside the installed package: %s', license => {
    manifest({ license });
    const outside = join(root, 'private.txt');
    writeFileSync(outside, 'Do not copy this outside-package content.');
    symlinkSync(outside, join(dependency, 'linked-terms.txt'));

    const { stdout, html } = run();

    expect(stdout).toContain('No license file found (1)');
    expect(html).not.toContain('Do not copy this outside-package content.');
  });
});
