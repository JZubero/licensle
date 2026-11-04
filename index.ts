#!/usr/bin/env node
import { program } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import open from 'open';
import yesno from 'yesno';
import prompts from 'prompts';
import parseSpdxExpression from 'spdx-expression-parse';
import { parse as parseYaml } from 'yaml';
import fs from 'node:fs';
import os from 'node:os';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from './package.json' with { type: 'json' };

const { version } = pkg;

export interface LicenseItem {
  module: string;
  type: string | null;
  description: string | null;
  license?: string;
  version?: string;
  sourceUrl?: string;
  packageUrl?: string;
  manualReview?: { declaredType: string | null; licenseFile?: string };
}

export interface LicenseInfo {
  [licenseType: string]: string[];
}

export interface CliOptions {
  generate?: boolean;
  browser?: boolean;
  info?: boolean;
  outputFilePath?: string;
  verbose?: boolean;
  excludeWorkspacePackages?: boolean;
  reviewLicenses?: boolean;
}

interface DependencyManifest {
  name?: string;
  version?: string;
  gitHead?: string;
  dependencies?: Record<string, unknown>;
  require?: Record<string, unknown>;
  replace?: Record<string, unknown>;
  provide?: Record<string, unknown>;
  license?: string | string[] | { type: string };
  description?: string;
  repository?: string | { url: string; directory?: string };
  source?: { url: string; reference?: string };
  vendorDir?: string;
  type?: string;
}

interface InstalledComposerPackage {
  manifest: DependencyManifest;
  directory: string | null;
  dev: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readWorkspaceMembers(projectDirectory: string): Map<string, string> {
  let root = path.resolve(projectDirectory);
  while (true) {
    const workspaceFile = path.join(root, 'pnpm-workspace.yaml');
    const rootManifestFile = path.join(root, 'package.json');
    const rootManifest: unknown = fs.existsSync(rootManifestFile)
      ? JSON.parse(fs.readFileSync(rootManifestFile, 'utf-8')) : undefined;
    let patterns: unknown;
    if (fs.existsSync(workspaceFile)) {
      const config: unknown = parseYaml(fs.readFileSync(workspaceFile, 'utf-8'));
      if (!isRecord(config) && config !== null) throw new Error(`Invalid workspace configuration: ${workspaceFile}`);
      patterns = isRecord(config) ? config.packages ?? [] : [];
    } else if (isRecord(rootManifest) && rootManifest.workspaces !== undefined) {
      patterns = isRecord(rootManifest.workspaces) ? rootManifest.workspaces.packages : rootManifest.workspaces;
    }
    if (patterns !== undefined) {
      if (!Array.isArray(patterns) || !patterns.every((pattern: unknown) => typeof pattern === 'string')) {
        throw new Error(`Invalid workspace package patterns in ${root}`);
      }
      const normalizedPatterns = (patterns as string[]).map(pattern => {
        const negative = pattern.startsWith('!');
        return { negative, pattern: path.posix.normalize((negative ? pattern.slice(1) : pattern).replaceAll('\\', '/')) };
      });
      const excluded = normalizedPatterns.filter(pattern => pattern.negative).map(pattern => pattern.pattern);
      const canonicalRoot = fs.realpathSync(root);
      const members = new Map<string, string>([[canonicalRoot, isRecord(rootManifest) && typeof rootManifest.name === 'string' ? rootManifest.name : '']]);
      for (const { pattern, negative } of normalizedPatterns) {
        if (negative) continue;
        for (const file of fs.globSync(`${pattern}/package.json`, { cwd: root, exclude: ['**/node_modules/**', '**/.git/**'] })) {
          const declaredDirectory = path.dirname(path.resolve(root, file));
          const declaredRelative = path.relative(root, declaredDirectory).split(path.sep).join('/');
          if (excluded.some(pattern => path.matchesGlob(declaredRelative, pattern))) continue;
          const directory = fs.realpathSync(declaredDirectory);
          const relative = path.relative(canonicalRoot, directory).split(path.sep).join('/');
          if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) continue;
          if (relative.split('/').includes('node_modules')) continue;
          const member: unknown = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf-8'));
          if (isRecord(member) && typeof member.name === 'string') members.set(directory, member.name);
        }
      }
      return members.has(fs.realpathSync(projectDirectory)) ? members : new Map();
    }
    const parent = path.dirname(root);
    if (parent === root) return new Map();
    root = parent;
  }
}

function readManifest(filePath: string): DependencyManifest {
  const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return parseManifest(value, filePath);
}

function parseManifest(value: unknown, filePath: string): DependencyManifest {
  if (!isRecord(value)) throw new Error(`Invalid dependency manifest: ${filePath}`);

  const manifest: DependencyManifest = {};
  for (const key of ['name', 'version', 'gitHead'] as const) {
    if (typeof value[key] === 'string') manifest[key] = value[key];
  }
  for (const key of ['dependencies', 'require', 'replace', 'provide'] as const) {
    if (value[key] !== undefined) {
      if (!isRecord(value[key])) throw new Error(`Invalid ${key} in ${filePath}`);
      manifest[key] = value[key];
    }
  }
  if (typeof value.description === 'string') manifest.description = value.description;
  if (typeof value.license === 'string') manifest.license = value.license;
  else if (Array.isArray(value.license) && value.license.every((item: unknown) => typeof item === 'string')) {
    manifest.license = value.license;
  } else if (isRecord(value.license) && typeof value.license.type === 'string') {
    manifest.license = { type: value.license.type };
  }
  if (typeof value.repository === 'string') manifest.repository = value.repository;
  else if (isRecord(value.repository) && typeof value.repository.url === 'string') {
    manifest.repository = { url: value.repository.url };
    if (typeof value.repository.directory === 'string') manifest.repository.directory = value.repository.directory;
  }
  if (typeof value.type === 'string') manifest.type = value.type;
  if (isRecord(value.source) && typeof value.source.url === 'string') {
    manifest.source = { url: value.source.url };
    if (typeof value.source.reference === 'string') manifest.source.reference = value.source.reference;
  }
  if (isRecord(value.config) && value.config['vendor-dir'] !== undefined) {
    if (typeof value.config['vendor-dir'] !== 'string' || !value.config['vendor-dir']) {
      throw new Error(`Invalid config.vendor-dir in ${filePath}`);
    }
    manifest.vendorDir = value.config['vendor-dir'];
  }
  return manifest;
}

function readComposerPackages(folder: string): Map<string, InstalledComposerPackage> {
  const installedFile = path.join(folder, 'composer', 'installed.json');
  const packages = new Map<string, InstalledComposerPackage>();
  if (!fs.existsSync(installedFile)) return packages;
  const value: unknown = JSON.parse(fs.readFileSync(installedFile, 'utf-8'));
  const entries: unknown = Array.isArray(value) ? value : isRecord(value) ? value.packages : undefined;
  if (!Array.isArray(entries)) throw new Error(`Invalid Composer installation metadata: ${installedFile}`);
  const devPackages = isRecord(value) && Array.isArray(value['dev-package-names']) ? value['dev-package-names'] : [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      throw new Error(`Invalid Composer package in ${installedFile}`);
    }
    const manifest = parseManifest(entry, installedFile);
    const installPath = entry['install-path'];
    const directory = manifest.type === 'metapackage' || installPath === null ? null
      : typeof installPath === 'string' ? path.resolve(path.dirname(installedFile), installPath)
      : path.resolve(folder, entry.name);
    packages.set(entry.name, { manifest, directory, dev: devPackages.includes(entry.name) });
  }
  return packages;
}

function githubRawUrl(repository: string): string | null {
  const normalized = repository.replace(/^git\+/, '').replace(/^git@github.com:/, 'https://github.com/')
    .replace(/^ssh:\/\/git@github.com\//, 'https://github.com/');
  try {
    const url = new URL(normalized);
    const repositoryPath = url.pathname.replace(/\/$/, '').replace(/\.git$/, '');
    if (url.hostname !== 'github.com' || !/^\/[^/]+\/[^/]+$/.test(repositoryPath)) return null;
    return `https://raw.githubusercontent.com${repositoryPath}`;
  } catch {
    return null;
  }
}

function licenseLabel(license: DependencyManifest['license']): string | null {
  if (typeof license === 'string') return license;
  if (Array.isArray(license)) return license.join(' OR ');
  return license?.type ?? null;
}

function repositoryBrowserUrl(repository: string): URL | null {
  let normalized = repository.replace(/^git\+/, '').replace(/^git:\/\//, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/').replace(/^ssh:\/\/(?:git@)?/, 'https://');
  if (/^[\w.-]+\/[\w.-]+$/.test(normalized)) normalized = `https://github.com/${normalized}`;
  normalized = normalized.replace(/^github:/, 'https://github.com/').replace(/^gitlab:/, 'https://gitlab.com/')
    .replace(/^bitbucket:/, 'https://bitbucket.org/');
  try {
    const url = new URL(normalized);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/$/, '').replace(/\.git$/, '');
    return url;
  } catch {
    return null;
  }
}

function reviewSourceUrl(manifest: DependencyManifest, composer: boolean): string | undefined {
  const repository = composer ? manifest.source?.url : typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  const url = repository ? repositoryBrowserUrl(repository) : null;
  if (!url) return undefined;
  const reference = composer ? manifest.source?.reference : manifest.gitHead;
  const directory = !composer && typeof manifest.repository === 'object' ? manifest.repository.directory : undefined;
  const suffix = directory ? '/' + directory.replaceAll('\\', '/').split('/').filter(part => part && part !== '.' && part !== '..').map(encodeURIComponent).join('/') : '';
  if (reference && url.hostname === 'github.com') url.pathname += `/tree/${encodeURIComponent(reference)}${suffix}`;
  else if (reference && (url.hostname === 'gitlab.com' || url.hostname.startsWith('gitlab.'))) url.pathname += `/-/tree/${encodeURIComponent(reference)}${suffix}`;
  else if (reference && url.hostname === 'bitbucket.org') url.pathname += `/src/${encodeURIComponent(reference)}${suffix}`;
  return url.href;
}

function validLicenseExpression(value: string | null): boolean {
  if (!value?.trim()) return false;
  if (value.trim().toUpperCase() === 'UNLICENSED') return true;
  try {
    parseSpdxExpression(value.trim());
    return true;
  } catch {
    return false;
  }
}

function noticeFilePath(value: string): string {
  return path.resolve(value.trim().replace(/^(\$HOME|~)(?=[/\\]|$)/, () => os.homedir()));
}

function validateNoticeFile(value: unknown): true | string {
  if (typeof value !== 'string') return 'Enter a file path or leave empty.';
  if (!value.trim()) return true;
  try {
    const file = noticeFilePath(value);
    if (!fs.statSync(file).isFile() || !fs.readFileSync(file, 'utf-8').trim()) return 'Choose a readable, non-empty license text file.';
    return true;
  } catch {
    return 'Choose a readable, non-empty license text file.';
  }
}

async function reviewMissingLicenses(items: LicenseItem[]): Promise<{ reviewed: number; files: number }> {
  const result = { reviewed: 0, files: 0 };
  console.log(chalk.cyanBright.bold(`Manual license review: ${items.length} ${items.length === 1 ? 'dependency needs' : 'dependencies need'} attention.`));
  console.log('Enter a SPDX expression, leave empty to skip, or enter :done to finish reviewing.');
  for (const item of items) {
    console.log(chalk.cyanBright.bold(`\n${item.module}${item.version ? `@${item.version}` : ''}`));
    console.log(`Declared license: ${item.type || 'not specified'}`);
    if (item.sourceUrl) console.log(`Source: ${item.sourceUrl}`);
    if (item.packageUrl) console.log(`Package: ${item.packageUrl}`);
    let cancelled = false;
    const answers = await prompts<'license' | 'licenseFile'>([
      {
        type: 'text', name: 'license', message: 'License (SPDX expression)',
        validate: (value: unknown) => typeof value === 'string' && (!value.trim() || [':skip', ':done'].includes(value.trim()) || validLicenseExpression(value))
          ? true : 'Enter an SPDX expression such as MIT or BSD-3-Clause, or leave empty to skip.',
      },
      {
        type: (previous: unknown) => typeof previous === 'string' && previous.trim() && !previous.trim().startsWith(':') ? 'text' : null,
        name: 'licenseFile', message: 'License text file (optional; empty to keep existing text)',
        validate: validateNoticeFile,
      },
    ], { onCancel: () => { cancelled = true; } });
    const license: unknown = answers.license;
    const enteredLicense = typeof license === 'string' ? license.trim() : undefined;
    const licenseFile: unknown = answers.licenseFile;
    if (cancelled || enteredLicense === undefined || enteredLicense === ':done') {
      console.log(chalk.yellow('Manual review stopped. Unresolved dependencies remain in the report.'));
      break;
    }
    if (!enteredLicense || enteredLicense === ':skip') continue;
    if (!validLicenseExpression(enteredLicense)) continue;
    let text: string | undefined;
    const providedFile = typeof licenseFile === 'string' && licenseFile.trim() ? noticeFilePath(licenseFile) : undefined;
    if (providedFile) {
      try {
        text = fs.readFileSync(providedFile, 'utf-8');
        if (!text.trim()) throw new Error('Empty license file');
      } catch (error: unknown) {
        console.warn(chalk.yellow(`Could not apply manual review for ${item.module}: ${error instanceof Error ? error.message : String(error)}`));
        continue;
      }
    }
    item.manualReview = { declaredType: item.type, ...(providedFile ? { licenseFile: providedFile } : {}) };
    item.type = enteredLicense;
    if (text !== undefined) {
      item.license = text;
      result.files++;
    }
    result.reviewed++;
  }
  return result;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

// Common software copyleft licenses; classify declared identifiers, not license prose.
const COPYLEFT_LICENSES = new Set([
  'GPL', 'GPL-1.0', 'GPL-2.0', 'GPL-3.0',
  'LGPL', 'LGPL-2.0', 'LGPL-2.1', 'LGPL-3.0',
  'AGPL', 'AGPL-1.0', 'AGPL-3.0',
  'MPL-1.0', 'MPL-1.1', 'MPL-2.0', 'MPL-2.0-NO-COPYLEFT-EXCEPTION',
  'EPL-1.0', 'EPL-2.0', 'CPL-1.0', 'CDDL-1.0', 'CDDL-1.1',
  'EUPL-1.0', 'EUPL-1.1', 'EUPL-1.2',
  'OSL-1.0', 'OSL-1.1', 'OSL-2.0', 'OSL-2.1', 'OSL-3.0',
]);

function hasCopyleftLicense(label: string | null): boolean {
  const identifiers = label?.match(/[a-z0-9][a-z0-9.+:-]*/gi) ?? [];
  return identifiers.some(identifier => {
    const normalized = identifier.toUpperCase().replace(/(?:-ONLY|-OR-LATER|\+)$/, '');
    if (COPYLEFT_LICENSES.has(normalized)) return true;
    // Deprecated SPDX GNU identifiers sometimes encode the exception in the name.
    return /^(?:A?GPL|LGPL)-(?:1\.0|2\.0|2\.1|3\.0)-WITH-[A-Z0-9.-]+-EXCEPTION$/.test(normalized);
  });
}

interface RequestResponse {
  code: number;
  data: string;
}

export const LICENSE_FILENAMES: string[] = ['LICENSE', 'LICENSE.md', 'license', 'license.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'LICENCE.txt', 'COPYING'];
export const README_FILENAMES: string[] = ['README.md', 'readme.md', 'README', 'readme'];

export async function main(options: CliOptions): Promise<void> {
  try {
    const packageFileExists = fs.existsSync('./package.json');
    const composerFileExists = fs.existsSync('./composer.json');

    if (!packageFileExists && !composerFileExists) {
      console.error(chalk.red('There is no dependency file (package.json or composer.json) in the current directory.'));
      return;
    }

    let sourceFile: string;
    if (packageFileExists && composerFileExists) {
      const promptResponse = await prompts<'sourceFile'>({
        type: 'select',
        name: 'sourceFile',
        message: chalk.magentaBright('Which source file should get parsed?'),
        initial: 0,
        choices: [
          { title: chalk.blueBright('package.json'), value: 'package.json' },
          { title: chalk.blueBright('composer.json'), value: 'composer.json' }
        ],
      });
      const selectedSource: unknown = promptResponse.sourceFile;
      if (selectedSource !== 'package.json' && selectedSource !== 'composer.json') return;
      sourceFile = selectedSource;
    } else {
      sourceFile = packageFileExists ? 'package.json' : 'composer.json';
    }

    const isPackageMode = (): boolean => sourceFile === 'package.json';
    const isComposerMode = (): boolean => sourceFile === 'composer.json';
    const manifest = readManifest('./' + sourceFile);
    const configuredFolder = process.env.COMPOSER_VENDOR_DIR || manifest.vendorDir || 'vendor';
    const folder = isPackageMode() ? 'node_modules' : configuredFolder.replace(/^(\$HOME|~)(?=[/\\]|$)/, () => os.homedir());
    let dependencies = Object.keys((isPackageMode() ? manifest.dependencies : manifest.require) ?? {});
    if (isComposerMode()) dependencies = dependencies.filter(d => d.indexOf('/') >= 0);
    if (isPackageMode() && options.excludeWorkspacePackages !== false && dependencies.length > 0) {
      const workspaceMembers = readWorkspaceMembers(process.cwd());
      const workspaceNames = new Set(workspaceMembers.values());
      const excluded: string[] = [];
      dependencies = dependencies.filter(dependency => {
        const installedDirectory = path.join(folder, dependency);
        const specifier = manifest.dependencies?.[dependency];
        let internal = false;
        if (workspaceMembers.size > 0) {
          try {
            internal = fs.existsSync(installedDirectory)
              ? workspaceMembers.has(fs.realpathSync(installedDirectory))
              : typeof specifier === 'string' && specifier.startsWith('workspace:') && workspaceNames.has(dependency);
          } catch {
            // Unverified paths stay in scope and are reported by the regular scan.
          }
        }
        if (internal) excluded.push(dependency);
        return !internal;
      });
      if (excluded.length > 0) {
        console.log(chalk.magentaBright(`Excluded ${excluded.length} same-monorepo workspace packages.`));
        if (options.verbose) for (const dependency of excluded) console.log(chalk.blueBright(` - ${dependency}`));
      }
    }
    if (dependencies.length > 0 && !fs.existsSync(folder)) {
      console.error(chalk.red(`There is no dependency folder (${folder}/) in the current directory.`));
      return;
    }
    const composerPackages = isComposerMode() ? readComposerPackages(folder) : new Map<string, InstalledComposerPackage>();
    if (isComposerMode()) {
      dependencies = [...new Set(dependencies.flatMap(dependency => {
        if (composerPackages.has(dependency)) return [dependency];
        const providers = [...composerPackages].filter(([, item]) => !item.dev &&
          (item.manifest.replace?.[dependency] !== undefined || item.manifest.provide?.[dependency] !== undefined));
        if (providers.length === 0) return [dependency];
        if (options.verbose) console.log(chalk.blueBright(`${dependency} is provided or replaced by ${providers.map(([name]) => name).join(', ')}`));
        return providers.map(([name]) => name);
      }))];
    }
    console.log(chalk.magentaBright(`Found ${dependencies.length} dependencies.`));

    const spinner = ora({
      text: chalk.magentaBright('Scanning ' + folder + '/'),
      color: 'magenta'
    });
    if (!options.verbose) spinner.start();

    const licenseItems: LicenseItem[] = [];
    const licenseDownloads: { [url: string]: string } = {};
    let failures: string[] = [];
    let licenseFileCounter = 0;
    let licenseDownloadCounter = 0;
    let readmeLicenseCounter = 0;

    for (const dependency of dependencies) {
      const registry = isComposerMode() ? 'https://packagist.org/packages/' : 'https://www.npmjs.com/package/';
      let licenseItem: LicenseItem = {
        module: dependency, type: null, description: null,
        packageUrl: registry + dependency.split('/').map(encodeURIComponent).join('/'),
      };
      try {
        const installed = composerPackages.get(dependency);
        const defaultFolder = path.join(folder, dependency);
        const dependencyFolder = installed ? installed.directory :
          isPackageMode() && !fs.existsSync(defaultFolder) ? `./${dependency.split('/').reverse()[0]}` : defaultFolder;
        const descriptionFile = installed ? installed.manifest : readManifest(path.join(dependencyFolder ?? '', sourceFile));
        licenseItem = {
          module: dependency,
          type: licenseLabel(descriptionFile.license),
          description: descriptionFile.description || null,
          version: descriptionFile.version,
          sourceUrl: reviewSourceUrl(descriptionFile, isComposerMode()),
          packageUrl: registry + (descriptionFile.name || dependency).split('/').map(encodeURIComponent).join('/'),
        };
        if (dependencyFolder === null) {
          licenseItems.push(licenseItem);
          continue;
        }
        const dependencyFolderFiles = fs.readdirSync(dependencyFolder);

        const licenseFile = dependencyFolderFiles.find(file => LICENSE_FILENAMES.some(candidate => candidate.toLowerCase() === file.toLowerCase()));
        if (licenseFile) {
          licenseItem.license = fs.readFileSync(path.join(dependencyFolder, licenseFile), 'utf-8');
          licenseFileCounter++;
          licenseItems.push(licenseItem);
          continue;
        }

        const readmeFile = dependencyFolderFiles.find(file => README_FILENAMES.some(candidate => candidate.toLowerCase() === file.toLowerCase()));
        if (readmeFile) {
          const readmeContent = fs.readFileSync(path.join(dependencyFolder, readmeFile), 'utf-8');
          const licenseSection = readmeContent.match(/#+ \b(License|Licence)\b\s*([\s\S]*)/i);
          if (licenseSection && licenseSection[2]) {
            readmeLicenseCounter++;
            licenseItem.license = licenseSection[2].trim();
            licenseItems.push(licenseItem);
            continue;
          }
        }

        const repository = isComposerMode() ? descriptionFile.source?.url :
          typeof descriptionFile.repository === 'string' ? descriptionFile.repository : descriptionFile.repository?.url;
        const rawUrl = repository ? githubRawUrl(repository) : null;
        const references = isComposerMode() ? descriptionFile.source?.reference ? [descriptionFile.source.reference] : []
          : ['main', 'master', 'dev', 'develop'];
        if (rawUrl && references.length > 0) {
          const fetchLicenseFileFromRepo = async (url: string): Promise<RequestResponse> => {
            let message = `Trying to fetch license file from "${url}"... `;
            const response = await request(url);
            message += response.code >= 400 ? `failed (${response.code})` : 'succeeded';
            if (options.verbose) console.log(chalk.blueBright(message));
            return response;
          };

          download: for (const reference of references) {
            for (const licenseFilename of LICENSE_FILENAMES) {
              const fullRequestUrl = `${rawUrl}/${encodeURIComponent(reference)}/${licenseFilename}`;
              if (licenseDownloads[fullRequestUrl]) {
                licenseDownloadCounter++;
                licenseItem.license = licenseDownloads[fullRequestUrl];
                licenseItems.push(licenseItem);
                break;
              } else {
                let response: RequestResponse;
                try {
                  response = await fetchLicenseFileFromRepo(fullRequestUrl);
                } catch (error: unknown) {
                  if (options.verbose) console.warn(chalk.red(`Could not download license for ${dependency}: ${error instanceof Error ? error.message : String(error)}`));
                  break download;
                }
                if (response.code === 200 && response.data.trim()) {
                  licenseDownloadCounter++;
                  licenseItem.license = response.data;
                  licenseDownloads[fullRequestUrl] = response.data;
                  licenseItems.push(licenseItem);
                  break;
                }
              }
            }
            if (licenseItem.license) break;
          }
          if (licenseItem.license) continue;
        }

        failures.push(dependency);
        if (options.verbose) console.warn(chalk.red('No file or download available for "%s"'), dependency);
        licenseItems.push(licenseItem);
      } catch (error: unknown) {
        failures.push(dependency);
        licenseItems.push(licenseItem);
        if (options.verbose) console.warn(chalk.red('Could not scan "%s"'), dependency, error instanceof Error ? error.message : String(error));
      }
    }
    if (!options.verbose) spinner.succeed(chalk.magentaBright(`Scanning ${folder}/... done!`));

    const reviewItems = licenseItems.filter(item => failures.includes(item.module) || !validLicenseExpression(item.type));
    const interactiveTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);
    if (reviewItems.length > 0 && (options.reviewLicenses ?? interactiveTerminal)) {
      const reviewed = await reviewMissingLicenses(reviewItems);
      if (reviewed.reviewed > 0) console.log(chalk.cyanBright(`Manually reviewed ${reviewed.reviewed} ${reviewed.reviewed === 1 ? 'dependency' : 'dependencies'}.`));
      if (reviewed.files > 0) console.log(chalk.cyanBright(`Provided ${reviewed.files} license text ${reviewed.files === 1 ? 'file' : 'files'} manually.`));
      failures = failures.filter(dependency => !licenseItems.some(item => item.module === dependency && item.license));
    } else if (reviewItems.length > 0 && options.reviewLicenses !== false) {
      console.log(chalk.yellow(`Manual license review skipped for ${reviewItems.length} ${reviewItems.length === 1 ? 'dependency' : 'dependencies'}. Run with --review-licenses in a terminal to review.`));
    }

    const copyleftItems = licenseItems.filter(item => hasCopyleftLicense(item.type));
    if (copyleftItems.length > 0) {
      console.warn(chalk.bgYellow.black.bold(' COPYLEFT WARNING '));
      console.warn(chalk.yellow.bold(`Copyleft licenses detected in ${copyleftItems.length} ${copyleftItems.length === 1 ? 'dependency' : 'dependencies'}:`));
      for (const item of copyleftItems) {
        console.warn(chalk.yellow(` - ${item.module}: ${item.type}`));
      }
      console.warn(chalk.yellow('Review the declared terms, including any OR alternatives and WITH exceptions.'));
    }

    console.log(chalk.magentaBright('The following licenses are used:'),
      [...new Set(licenseItems.map(i => i.type))].filter(i => i).join(', ')
    );
    console.log(chalk.magentaBright(`Found ${licenseFileCounter} license files`));
    console.log(chalk.magentaBright(`Found ${readmeLicenseCounter} licenses in README files`));
    console.log(chalk.magentaBright(`Downloaded ${licenseDownloadCounter} license files`));
    if (failures.length > 0) {
      console.log(chalk.red(`No license file found (${failures.length}):`));
      for (const fail of failures) {
        console.log(chalk.redBright(' - ' + fail));
      }
    }

    if (options.info) {
      const licenseInfo: LicenseInfo = licenseItems.reduce((result: LicenseInfo, current) => {
        if (!current.type) return result;
        const licenseType = current.type;
        (result[licenseType] ??= []).push(current.module);
        return result;
      }, {});

      for (const [licenseType, modules] of Object.entries(licenseInfo)) {
        console.log(chalk.blueBright.bold(`${licenseType} (${modules.length} usages)`));
        for (const module of modules) {
          console.log(chalk.blueBright(`  |-- ${module}`));
        }
      }
    }

    if (options.generate) {
      const filePath = options.outputFilePath || (os.tmpdir() + '/license.html');
      console.log(chalk.cyanBright('Creating license HTML file (' + filePath + ')...'));
      let html = '';
      for (const f of licenseItems) {
        const licenseText = f.license || 'No license file provided.';
        const manualDetails = f.manualReview ? `
          <p><strong>License selected manually.</strong> Original declaration: ${escapeHtml(f.manualReview.declaredType || 'not specified')}.</p>
          <p>Version: ${escapeHtml(f.version || 'unknown')}.${f.sourceUrl ? ` <a href="${escapeHtml(f.sourceUrl)}">Source repository</a>.` : ''}${f.packageUrl ? ` <a href="${escapeHtml(f.packageUrl)}">Package metadata</a>.` : ''}</p>
          <p>${f.manualReview.licenseFile ? `License text supplied manually (${escapeHtml(path.basename(f.manualReview.licenseFile))}).` : f.license ? 'Existing license text retained.' : 'No full license text supplied.'}</p>
        ` : '';
        html += `
          <h2>${escapeHtml(f.module)}</h2>
          <p>${f.type ? `<strong>${escapeHtml(f.type)}</strong> - ` : ''}${escapeHtml(f.description || '')}</p>
          ${manualDetails}
          <pre>${escapeHtml(licenseText)}</pre>
          <hr>
        `;
      }
      fs.writeFileSync(filePath, html, 'utf-8');

      if (options.browser !== false) {
        let showInBrowser: boolean = options.browser ?? false;
        if (!showInBrowser) {
          showInBrowser = await yesno({
            question: chalk.cyanBright('Show output file in browser? (Y/n)'),
            defaultValue: true
          });
        }
        if (showInBrowser) await open(filePath);
      }
    }
  } catch (error: unknown) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  }
}

async function request(url: string): Promise<RequestResponse> {
  return new Promise((resolve, reject) => {
    https.get(url, { signal: AbortSignal.timeout(5_000) }, (response) => {
      let data = '';
      response.on('data', (chunk) => data += chunk);
      response.on('error', reject);
      response.on('end', () => resolve({ code: response.statusCode || 500, data }));
    }).on('error', (err) => {
      reject(err);
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  program
    .version(version)
    .option('-g, --generate', 'generate a static license summary file')
    .option('-b, --browser', 'open up a browser and show generated static license summary file')
    .option('--no-browser', 'prevents the browser from popping open')
    .option('-i, --info', 'provides information about all direct dependency licenses')
    .option('-o, --outputFilePath <path>', 'specify path and name of the output file')
    .option('-v, --verbose', 'activate verbose logging ')
    .option('--no-exclude-workspace-packages', 'include dependencies from the same monorepo (excluded by default)')
    .option('--review-licenses', 'review unresolved licenses before generating the report (automatic in a terminal)')
    .option('--no-review-licenses', 'skip interactive license review');

  program.parse(process.argv);
  const options = program.opts<CliOptions>();

  if (options.reviewLicenses && !process.stdin.isTTY) {
    console.warn(chalk.yellow('Manual license review requires terminal input; skipped.'));
    options.reviewLicenses = false;
  }

  if (options.outputFilePath && !options.generate) {
    console.warn(chalk.bgYellow.black('Warning: Using --outputFilePath without -g (--generate) will not have any effect.'));
  }

  if (options.browser && !options.generate) {
    console.warn(chalk.bgYellow.black('Warning: Using --browser without -g (--generate) will not have any effect.'));
  }

  await main(options);
}
