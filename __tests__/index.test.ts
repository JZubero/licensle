import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PathLike, PathOrFileDescriptor } from 'node:fs';
import { main } from '../index.js';
import prompts from 'prompts';

const fs = vi.hoisted(() => ({
  existsSync: vi.fn<(path: PathLike) => boolean>(),
  readdirSync: vi.fn<(path: PathLike) => string[]>(),
  readFileSync: vi.fn<(path: PathOrFileDescriptor, encoding: string) => string>(),
  writeFileSync: vi.fn(),
  realpathSync: vi.fn(),
}));

vi.mock('node:fs', () => ({ default: fs }));
vi.mock('prompts');

function mockFiles(files: Record<string, string>, rootManifest = '{"dependencies":{"test-dep":"1.0.0"}}') {
  fs.readdirSync.mockReturnValue(['package.json', ...Object.keys(files)]);
  fs.readFileSync.mockImplementation((path) => {
    const name = path.toString();
    if (name.includes('node_modules/test-dep/package.json')) {
      return JSON.stringify({ license: 'MIT', description: 'A test dependency' });
    }
    if (name === './package.json') return rootManifest;
    for (const [filename, content] of Object.entries(files)) {
      if (name.endsWith(`/${filename}`)) return content;
    }
    throw new Error(`Unexpected file read: ${name}`);
  });
}

describe('main', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.existsSync.mockImplementation((path) => {
      const name = path.toString();
      return name.endsWith('package.json') || name.endsWith('node_modules') || name.includes('test-dep');
    });
    vi.mocked(prompts).mockResolvedValue({ sourceFile: 'package.json' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('finds a license in README.md when no license file is present', async () => {
    mockFiles({ 'README.md': '# Test Dep\n\n## Licence\n\nThis is the license text.' });
    await main({ verbose: true, generate: true, browser: false });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found 1 licenses in README files'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found 0 license files'));
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('This is the license text.'), 'utf-8');
  });

  it('prefers the license file over a README license section', async () => {
    mockFiles({ LICENSE: 'The license text.', 'README.md': '## Licence\nIgnored text.' });
    await main({ verbose: true });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found 1 license files'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found 0 licenses in README files'));
  });

  it('reports a README with no license section', async () => {
    mockFiles({ 'README.md': '# Test Dep\n\nThis is a test dependency.' });
    await main({ verbose: true });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No license file found (1)'));
  });

  it('accepts a project without production dependencies', async () => {
    mockFiles({}, '{}');
    await main({ verbose: true });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found 0 dependencies.'));
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(['null', '[]', '{"dependencies":"invalid"}'])('rejects an invalid manifest: %s', async (manifest) => {
    mockFiles({}, manifest);
    await main({ verbose: true });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Invalid'));
    expect(fs.readdirSync).not.toHaveBeenCalled();
  });

  it('stops cleanly when source selection is cancelled', async () => {
    fs.existsSync.mockReturnValue(true);
    vi.mocked(prompts).mockResolvedValue({});
    await main({ verbose: true });
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('reads Composer license arrays and excludes PHP platform requirements', async () => {
    fs.existsSync.mockImplementation((path) => !path.toString().includes('package.json') && !path.toString().includes('node_modules'));
    fs.readdirSync.mockReturnValue(['composer.json', 'LICENSE']);
    fs.readFileSync.mockImplementation((path) => {
      if (path.toString() === './composer.json') {
        return JSON.stringify({ require: { php: '^8.3', 'vendor/test-dep': '^1.0' } });
      }
      if (path.toString().endsWith('/composer.json')) {
        return JSON.stringify({ license: ['MIT', 'Apache-2.0'], description: 'Composer test' });
      }
      return 'Composer license text';
    });
    await main({ verbose: true, info: true, generate: true, browser: false, outputFilePath: '/tmp/composer-licenses.html' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found 1 dependencies.'));
    expect(fs.writeFileSync).toHaveBeenCalledWith('/tmp/composer-licenses.html', expect.stringContaining('MIT OR Apache 2.0'), 'utf-8');
    expect(console.error).not.toHaveBeenCalled();
  });

  it('reads legacy npm license objects', async () => {
    mockFiles({ LICENSE: 'License text' });
    fs.readFileSync.mockImplementation((path) => path.toString() === './package.json'
      ? '{"dependencies":{"test-dep":"1.0.0"}}'
      : path.toString().endsWith('/package.json') ? '{"license":{"type":"MIT"}}' : 'License text');
    await main({ verbose: true, info: true });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('MIT (1 usages)'));
    expect(console.error).not.toHaveBeenCalled();
  });
});
