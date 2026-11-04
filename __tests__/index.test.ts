import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PathLike, PathOrFileDescriptor } from 'node:fs';
import { EventEmitter } from 'node:events';
import { main } from '../index.js';
import prompts from 'prompts';

const fs = vi.hoisted(() => ({
  existsSync: vi.fn<(path: PathLike) => boolean>(),
  readdirSync: vi.fn<(path: PathLike) => string[]>(),
  readFileSync: vi.fn<(path: PathOrFileDescriptor, encoding: string) => string>(),
  writeFileSync: vi.fn(),
  realpathSync: vi.fn(),
  statSync: vi.fn(),
}));

const network = vi.hoisted(() => ({
  get: vi.fn<(url: string, options: { signal: AbortSignal }, callback: (response: EventEmitter & { statusCode: number }) => void) => EventEmitter>(),
}));

vi.mock('node:fs', () => ({ default: fs }));
vi.mock('node:https', () => ({ default: network }));
vi.mock('prompts');

function mockFiles(files: Record<string, string>, rootManifest = '{"dependencies":{"test-dep":"1.0.0"}}', license: unknown = 'MIT', metadata: Record<string, unknown> = {}) {
  fs.readdirSync.mockReturnValue(['package.json', ...Object.keys(files)]);
  fs.readFileSync.mockImplementation((path) => {
    const name = path.toString();
    if (name.includes('node_modules/test-dep/package.json')) {
      return JSON.stringify({ license, description: 'A test dependency', ...metadata });
    }
    if (name === './package.json') return rootManifest;
    for (const [filename, content] of Object.entries(files)) {
      if (name.endsWith(`/${filename}`)) return content;
    }
    throw new Error(`Unexpected file read: ${name}`);
  });
}

function mockComposerSource(source?: { url: string; reference?: string }, license: unknown = 'MIT'): void {
  fs.existsSync.mockImplementation(file => ['./composer.json', 'vendor', 'vendor/composer/installed.json'].includes(file.toString()));
  fs.readdirSync.mockReturnValue([]);
  fs.readFileSync.mockImplementation(file => file.toString() === './composer.json'
    ? JSON.stringify({ require: { 'example/library': '^1.0' } })
    : JSON.stringify({ packages: [{ name: 'example/library', license, source, 'install-path': '../example/library' }] }));
}

describe('main', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.existsSync.mockImplementation((path) => {
      const name = path.toString();
      return name === './package.json' || name === 'node_modules' || name.includes('node_modules/test-dep');
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
    fs.existsSync.mockImplementation(file => ['./package.json', './composer.json', 'node_modules', 'vendor'].includes(file.toString()));
    vi.mocked(prompts).mockResolvedValue({});
    await main({ verbose: true });
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('reads Composer license arrays and excludes PHP platform requirements', async () => {
    fs.existsSync.mockImplementation((path) => path.toString() === './composer.json' || path.toString() === 'vendor');
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
    expect(fs.writeFileSync).toHaveBeenCalledWith('/tmp/composer-licenses.html', expect.stringContaining('MIT OR Apache-2.0'), 'utf-8');
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

  it('applies manual selections before the summary, copyleft warning, and HTML output', async () => {
    mockFiles({}, undefined, null, {
      version: '1.2.3', gitHead: 'release/ref',
      repository: { url: 'git+https://github.com/owner/repository.git', directory: 'packages/library' },
    });
    vi.mocked(prompts).mockResolvedValueOnce({ license: 'GPL-3.0-only OR MIT', licenseFile: '' });

    await main({ verbose: true, reviewLicenses: true, info: true, generate: true, browser: false });

    expect(console.log).toHaveBeenCalledWith('Source: https://github.com/owner/repository/tree/release%2Fref/packages/library');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('test-dep@1.2.3'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('GPL-3.0-only OR MIT (1 usages)'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('test-dep: GPL-3.0-only OR MIT'));
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('License selected manually.'), 'utf-8');
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('No full license text supplied.'), 'utf-8');
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('Original declaration: not specified'), 'utf-8');
  });

  it('does not count a manually chosen identifier as recovered license text', async () => {
    mockComposerSource(undefined, null);
    vi.mocked(prompts).mockResolvedValueOnce({ license: 'BSD-3-Clause', licenseFile: '' });

    await main({ verbose: true, reviewLicenses: true, generate: true, browser: false });

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No license file found (1)'));
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('No full license text supplied.'), 'utf-8');
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('Original declaration: not specified.'), 'utf-8');
    expect(console.log).toHaveBeenCalledWith('Package: https://packagist.org/packages/example/library');
  });

  it('imports a supplied notice, escapes its contents, and clears the missing-text entry', async () => {
    mockFiles({ 'manual-notice.txt': 'Copyright <example> & notice text.' }, undefined, null);
    vi.mocked(prompts).mockResolvedValueOnce({ license: 'BSD-3-Clause', licenseFile: '/tmp/manual-notice.txt' });

    await main({ verbose: true, reviewLicenses: true, generate: true, browser: false });

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Provided 1 license text file manually.'));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('No license file found'));
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('Copyright &lt;example&gt; &amp; notice text.'), 'utf-8');
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('License text supplied manually (manual-notice.txt).'), 'utf-8');
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('rejects ambiguous or invalid manual expressions and validates notice paths', async () => {
    mockFiles({ 'manual-notice.txt': 'Existing notice.' }, undefined, null);
    vi.mocked(prompts).mockResolvedValueOnce({ license: '' });
    await main({ verbose: true, reviewLicenses: true });
    const questions = vi.mocked(prompts).mock.calls[0]?.[0];
    if (!Array.isArray(questions)) throw new Error('Expected a manual review question queue');
    const licenseQuestion = questions.find(question => question.name === 'license');
    const fileQuestion = questions.find(question => question.name === 'licenseFile');
    if (!licenseQuestion?.validate || !fileQuestion?.validate) throw new Error('Expected input validators');

    for (const expression of ['MIT', 'GPL-2.0-only WITH Classpath-exception-2.0', 'LicenseRef-Private', '', ':skip', ':done']) {
      expect(licenseQuestion.validate(expression, {}, licenseQuestion)).toBe(true);
    }
    for (const expression of ['BSD', 'made-up-license', '<script>']) {
      expect(licenseQuestion.validate(expression, {}, licenseQuestion)).toEqual(expect.any(String));
    }
    expect(fileQuestion.validate('', {}, fileQuestion)).toBe(true);
    fs.statSync.mockReturnValue({ isFile: () => false });
    expect(fileQuestion.validate('/tmp/directory', {}, fileQuestion)).toEqual(expect.any(String));
    fs.statSync.mockReturnValue({ isFile: () => true });
    expect(fileQuestion.validate('/tmp/manual-notice.txt', {}, fileQuestion)).toBe(true);
    if (typeof fileQuestion.type !== 'function') throw new Error('Expected conditional notice prompt');
    expect(fileQuestion.type('', {}, fileQuestion)).toBeNull();
    expect(fileQuestion.type(':done', {}, fileQuestion)).toBeNull();
  });

  it.each(['', ':skip', ' :done '])('retains unresolved entries when review is skipped or finished: %j', async (license) => {
    mockFiles({}, undefined, null);
    vi.mocked(prompts).mockResolvedValueOnce({ license });

    await main({ verbose: true, reviewLicenses: true, generate: true, browser: false });

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No license file found (1)'));
    expect(fs.writeFileSync).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining('License selected manually.'), 'utf-8');
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('test-dep'), 'utf-8');
  });

  it('discards a partial answer on cancellation and still produces the report', async () => {
    mockFiles({}, undefined, null);
    vi.mocked(prompts).mockImplementationOnce(async (_questions, options) => {
      options?.onCancel?.({ type: 'text', name: 'licenseFile' }, {});
      return { license: 'GPL-3.0-only' };
    });

    await main({ verbose: true, reviewLicenses: true, generate: true, browser: false });

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Manual review stopped.'));
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('COPYLEFT WARNING'));
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('No license file provided.'), 'utf-8');
  });

  it('strips credentials from repository links displayed for manual review', async () => {
    mockFiles({}, undefined, null, {
      repository: 'https://user:SHOULD_NOT_LEAK@gitlab.example.com/group/repo.git?token=SHOULD_NOT_LEAK', gitHead: 'abcdef',
    });
    vi.mocked(prompts).mockResolvedValueOnce({ license: ':skip' });

    await main({ verbose: true, reviewLicenses: true });

    expect(console.log).toHaveBeenCalledWith('Source: https://gitlab.example.com/group/repo/-/tree/abcdef');
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('SHOULD_NOT_LEAK');
  });

  it('can explicitly disable review without prompting', async () => {
    mockFiles({}, undefined, null);

    await main({ verbose: true, reviewLicenses: false });

    expect(prompts).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No license file found (1)'));
  });

  it.each([null, 'SEE LICENSE IN LICENSE'])('does not prompt when local license text is available despite metadata %j', async type => {
    mockFiles({ LICENSE: 'Publisher license terms.' }, undefined, type);

    await main({ verbose: true, reviewLicenses: true, info: true });

    expect(prompts).not.toHaveBeenCalled();
    if (!type) expect(console.log).toHaveBeenCalledWith(expect.stringContaining('License text available (unclassified) (1 usages)'));
  });

  it('does not prompt when a README license section supplies the information', async () => {
    mockFiles({ 'README.md': '# Library\n\n## License\nPublisher license terms.' }, undefined, null);

    await main({ verbose: true, reviewLicenses: true });

    expect(prompts).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found 1 licenses in README files'));
  });

  it('does not prompt when upstream license text was downloaded without a manifest license field', async () => {
    mockComposerSource({ url: 'https://github.com/owner/repository.git', reference: 'installed-commit' }, null);
    network.get.mockImplementation((_url, _options, callback) => {
      const response = Object.assign(new EventEmitter(), { statusCode: 200 });
      callback(response);
      queueMicrotask(() => {
        response.emit('data', 'Version-matched upstream license terms.');
        response.emit('end');
      });
      return new EventEmitter();
    });

    await main({ verbose: true, reviewLicenses: true, generate: true, browser: false });

    expect(prompts).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Downloaded 1 license files'));
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('Version-matched upstream license terms.'), 'utf-8');
  });

  it.each(['MIT', 'BSD-3-Clause', 'BSD', 'LicenseRef-Publisher', 'proprietary'])('retains missing-text status without prompting when the declaration provides information: %s', async type => {
    mockFiles({}, undefined, type);

    await main({ verbose: true, reviewLicenses: true });

    expect(prompts).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No license file found (1)'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('The following licenses are used:'), type);
  });

  it('treats UNLICENSED as an explicit absence of a license grant without requesting a notice file', async () => {
    mockFiles({}, undefined, 'UNLICENSED', { repository: 'https://github.com/owner/repo' });

    await main({ verbose: true, reviewLicenses: true, generate: true, browser: false });

    expect(prompts).not.toHaveBeenCalled();
    expect(network.get).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('No license file found'));
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('No license grant (UNLICENSED).'), 'utf-8');
  });

  it('applies the same no-grant semantics to a manually selected UNLICENSED label', async () => {
    mockFiles({}, undefined, null);
    vi.mocked(prompts).mockResolvedValueOnce({ license: 'UNLICENSED', licenseFile: '' });

    await main({ verbose: true, reviewLicenses: true, generate: true, browser: false });

    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('No license file found'));
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('No license grant (UNLICENSED).'), 'utf-8');
  });

  for (const field of ['license', 'licenses']) {
    it.each([
      { value: 'MIT', expected: 'MIT' },
      { value: '(ISC OR GPL-3.0)', expected: '(ISC OR GPL-3.0)' },
      { value: 'GPL-2.0-only WITH Classpath-exception-2.0', expected: 'GPL-2.0-only WITH Classpath-exception-2.0' },
      { value: { type: 'ISC', url: 'https://opensource.org/licenses/ISC' }, expected: 'ISC' },
      { value: [{ type: 'MIT', url: 'http://github.com/mscdex/ssh2/raw/master/LICENSE' }], expected: 'MIT' },
      { value: [{ type: 'MIT' }, { type: 'Apache-2.0' }], expected: 'MIT OR Apache-2.0' },
      { value: ['MIT', 'Apache-2.0'], expected: 'MIT OR Apache-2.0' },
      { value: ['MIT', { type: 'GPL-3.0-only' }], expected: 'MIT OR GPL-3.0-only' },
      { value: [{ type: 'MIT AND Apache-2.0' }, 'GPL-3.0-only'], expected: '(MIT AND Apache-2.0) OR GPL-3.0-only' },
      { value: [' MIT ', { type: 'MIT' }], expected: 'MIT' },
      { value: ['SEE LICENSE IN missing.txt', 'MIT'], expected: 'SEE LICENSE IN missing.txt OR MIT' },
    ])(`interprets ${field} declaration $value as $expected without requiring manual review`, async ({ value, expected }) => {
      mockFiles({}, undefined, null, { [field]: value });

      await main({ verbose: true, reviewLicenses: true, info: true });

      expect(prompts).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`${expected} (1 usages)`));
    });
  }

  it.each([null, 'UNKNOWN', 'NOASSERTION', 'SEE LICENSE IN missing.txt'])('prompts only when neither terms nor an informative declaration were found: %j', async type => {
    mockFiles({}, undefined, type);
    vi.mocked(prompts).mockResolvedValueOnce({ license: '' });

    await main({ verbose: true, reviewLicenses: true });

    expect(prompts).toHaveBeenCalledTimes(1);
  });

  it('does not count an empty license file as license information', async () => {
    mockFiles({ LICENSE: ' \n\t ' }, undefined, null);
    vi.mocked(prompts).mockResolvedValueOnce({ license: '' });

    await main({ verbose: true, reviewLicenses: true });

    expect(prompts).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found 0 license files'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No license file found (1)'));
  });

  it.each([
    'GPL', 'GPL-2.0', 'GPL-3.0-only', 'GPL-2.0+',
    'LGPL-2.1-or-later', 'AGPL-3.0-only', 'MPL-2.0',
    'MPL-2.0-no-copyleft-exception', 'EPL-2.0', 'CDDL-1.0',
    'CPL-1.0', 'EUPL-1.2', 'OSL-3.0', 'gpl-3.0-only',
    'MIT OR GPL-3.0-only', '(Apache-2.0 AND LGPL-2.1-only)',
    'GPL-2.0-only WITH Classpath-exception-2.0', 'GPL-2.0-with-classpath-exception',
  ])('warns about the declared copyleft license: %s', async (license) => {
    mockFiles({ LICENSE: 'License text.' }, undefined, license);

    await main({ verbose: true });

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('COPYLEFT WARNING'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`test-dep: ${license}`));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('OR alternatives and WITH exceptions'));
  });

  it.each([
    'MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'AFL-3.0',
    'MIT OR Apache-2.0', 'LicenseRef-GPL-3.0-only',
    'DocumentRef-example:LicenseRef-GPL-2.0', 'UNLICENSED', null,
  ])('does not label permissive or unrecognized licenses as copyleft: %s', async (license) => {
    mockFiles({ LICENSE: 'License text.' }, undefined, license);

    await main({ verbose: true });

    expect(console.warn).not.toHaveBeenCalled();
  });

  it('warns for a dual-license array while retaining its permissive alternative', async () => {
    mockFiles({ LICENSE: 'License text.' }, undefined, ['MIT', 'GPL-3.0-only']);

    await main({ verbose: true });

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('test-dep: MIT OR GPL-3.0-only'));
  });

  it('warns when Composer license metadata is present but license text is missing', async () => {
    mockComposerSource(undefined, 'GPL-2.0-only');

    await main({ verbose: true });

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('COPYLEFT WARNING'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('example/library: GPL-2.0-only'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No license file found (1)'));
  });

  it.each([
    'https://github.com/actual-owner/actual-repository.git',
    'git@github.com:actual-owner/actual-repository.git',
    'ssh://git@github.com/actual-owner/actual-repository.git',
  ])('downloads the installed Composer revision from source metadata: %s', async (url) => {
    mockComposerSource({ url, reference: 'installed-commit' });
    network.get.mockImplementation((_url, _options, callback) => {
      const response = Object.assign(new EventEmitter(), { statusCode: 200 });
      callback(response);
      queueMicrotask(() => {
        response.emit('data', 'Pinned revision license.');
        response.emit('end');
      });
      return new EventEmitter();
    });

    await main({ verbose: true, generate: true, browser: false });

    expect(network.get).toHaveBeenCalledExactlyOnceWith(
      'https://raw.githubusercontent.com/actual-owner/actual-repository/installed-commit/LICENSE',
      { signal: expect.any(AbortSignal) },
      expect.any(Function),
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('Pinned revision license.'), 'utf-8');
  });

  it('retains a Composer dependency and its license label if a download fails', async () => {
    mockComposerSource({ url: 'https://github.com/owner/repository.git', reference: 'installed-commit' });
    network.get.mockImplementation(() => {
      const request = new EventEmitter();
      queueMicrotask(() => request.emit('error', new Error('Offline')));
      return request;
    });

    await main({ verbose: true, generate: true, browser: false });

    expect(network.get).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No license file found (1)'));
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('<strong>MIT</strong>'), 'utf-8');
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('example/library'), 'utf-8');
  });

  it.each([
    undefined,
    { url: 'https://github.com/owner/repository.git' },
    { url: 'https://gitlab.com/owner/repository.git', reference: 'installed-commit' },
  ])('does not guess GitHub repositories or revisions from Composer package names: %j', async (source) => {
    mockComposerSource(source);

    await main({ verbose: true });

    expect(network.get).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No license file found (1)'));
  });

  it.each([{}, null, { packages: {} }, [null]])('rejects invalid installed Composer metadata: %j', async (metadata) => {
    mockComposerSource();
    fs.readFileSync.mockImplementation(file => file.toString() === './composer.json'
      ? '{"require":{"example/library":"^1.0"}}' : JSON.stringify(metadata));

    await main({ verbose: true });

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Invalid Composer'));
    expect(network.get).not.toHaveBeenCalled();
  });

  it('scans Composer when selected in a project that also has package.json', async () => {
    fs.existsSync.mockImplementation(file => ['./package.json', './composer.json', 'vendor'].includes(file.toString()));
    vi.mocked(prompts).mockResolvedValue({ sourceFile: 'composer.json' });
    fs.readFileSync.mockImplementation(file => file.toString() === './composer.json'
      ? '{"require":{"example/library":"^1.0"}}' : file.toString().endsWith('composer.json') ? '{"license":"MIT"}' : 'PHP license text.');
    fs.readdirSync.mockReturnValue(['composer.json', 'LICENSE']);

    await main({ verbose: true, generate: true, browser: false });

    expect(fs.readFileSync).not.toHaveBeenCalledWith('./package.json', 'utf-8');
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('PHP license text.'), 'utf-8');
    expect(console.error).not.toHaveBeenCalled();
  });
});
