import { describe, it, expect, vi, beforeEach } from 'vitest';
import { main } from '../index';
import fs from 'fs';
import prompts from 'prompts';

vi.mock('fs');
vi.mock('prompts');

describe('main', () => {
  let consoleLogSpy: any;

  beforeEach(() => {
    vi.resetAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.mocked(fs.existsSync).mockImplementation((path) => {
      const p = path.toString();
      return (
        p.endsWith('package.json') ||
        p.endsWith('node_modules') ||
        p.includes('test-dep')
      );
    });

    vi.mocked(prompts).mockResolvedValue({ sourceFile: 'package.json' });
  });

  it('should find license in README.md when no license file is present', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(['package.json', 'README.md'] as any);
    vi.mocked(fs.readFileSync).mockImplementation(((path: string) => {
      if (path.includes('node_modules/test-dep/package.json')) {
        return JSON.stringify({ license: 'MIT', description: 'A test dependency' });
      }
      if (path.endsWith('package.json')) {
        return JSON.stringify({ dependencies: { 'test-dep': '1.0.0' } });
      }
      if (path.endsWith('README.md')) {
        return '# Test Dep\\n\\n## Licence\\n\\nThis is the license text.';
      }
      return '';
    }) as any);

    await main({ verbose: false });

    const logOutput = consoleLogSpy.mock.calls.map((call: any) => call.join(' ')).join('\\n');
    expect(logOutput).toContain('Found 1 licenses in README files');
    expect(logOutput).toContain('Found 0 license files');
  });

  it('should not find license in README.md when a license file is present', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(['package.json', 'LICENSE', 'README.md'] as any);
    vi.mocked(fs.readFileSync).mockImplementation(((path: string) => {
      if (path.includes('node_modules/test-dep/package.json')) {
        return JSON.stringify({ license: 'MIT', description: 'A test dependency' });
      }
      if (path.endsWith('package.json')) {
        return JSON.stringify({ dependencies: { 'test-dep': '1.0.0' } });
      }
      if (path.endsWith('LICENSE')) {
        return 'The license text.';
      }
      if (path.endsWith('README.md')) {
        return '# Test Dep\\n\\n## Licence\\n\\nThis is the license text.';
      }
      return '';
    }) as any);

    await main({ verbose: false });

    const logOutput = consoleLogSpy.mock.calls.map((call: any) => call.join(' ')).join('\\n');
    expect(logOutput).toContain('Found 1 license files');
    expect(logOutput).toContain('Found 0 licenses in README files');
  });

  it('should handle README files with no license section', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue(['package.json', 'README.md'] as any);
    vi.mocked(fs.readFileSync).mockImplementation(((path: string) => {
      if (path.includes('node_modules/test-dep/package.json')) {
        return JSON.stringify({ license: 'MIT', description: 'A test dependency' });
      }
      if (path.endsWith('package.json')) {
        return JSON.stringify({ dependencies: { 'test-dep': '1.0.0' } });
      }
      if (path.endsWith('README.md')) {
        return '# Test Dep\\n\\nThis is a test dependency.';
      }
      return '';
    }) as any);

    await main({ verbose: false });

    const logOutput = consoleLogSpy.mock.calls.map((call: any) => call.join(' ')).join('\\n');
    expect(logOutput).toContain('No license file found (1)');
  });
});
