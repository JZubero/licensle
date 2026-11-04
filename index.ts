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
  licenseTypes?: string[];
  description: string | null;
  license?: string;
  version?: string;
  sourceUrl?: string;
  packageUrl?: string;
  project?: string;
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
  monorepo?: boolean;
  additionalFiles?: string[];
  config?: string;
}

interface LegacyLicense {
  type: string;
  url?: string;
}

type LicenseEntry = string | LegacyLicense;
type LicenseDeclaration = LicenseEntry | LicenseEntry[];

interface DependencyManifest {
  name?: string;
  version?: string;
  gitHead?: string;
  dependencies?: Record<string, unknown>;
  require?: Record<string, unknown>;
  replace?: Record<string, unknown>;
  provide?: Record<string, unknown>;
  license?: LicenseDeclaration;
  licenses?: LicenseDeclaration;
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

type SourceFile = 'package.json' | 'composer.json';

interface ScanProject {
  directory: string;
  sourceFile: SourceFile;
  label?: string;
}

interface ScanResult {
  licenseItems: LicenseItem[];
  failures: LicenseItem[];
  licenseFileCounter: number;
  licenseDownloadCounter: number;
  readmeLicenseCounter: number;
}

function additionalFileList(value: unknown, source: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((file: unknown) => typeof file === 'string' && file.trim().length > 0)) {
    throw new Error(`Invalid additionalFiles in ${source}: expected an array of non-empty manifest paths.`);
  }
  return value as string[];
}

function additionalProjects(options: CliOptions, root: string): ScanProject[] {
  const configFile = options.config ? path.resolve(root, expandHome(options.config)) : path.join(root, 'licensle.config.json');
  const files: { file: string; base: string }[] = [];
  if (options.config || fs.existsSync(configFile)) {
    let config: unknown;
    try {
      config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    } catch (error: unknown) {
      throw new Error(`Could not read configuration ${configFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(config)) throw new Error(`Invalid configuration in ${configFile}: expected an object.`);
    const unknownOption = Object.keys(config).find(key => key !== 'additionalFiles');
    if (unknownOption) throw new Error(`Unknown configuration option "${unknownOption}" in ${configFile}.`);
    files.push(...additionalFileList(config.additionalFiles, configFile).map(file => ({ file, base: path.dirname(configFile) })));
  }
  files.push(...additionalFileList(options.additionalFiles, 'CLI options').map(file => ({ file, base: root })));
  return files.map(({ file, base }) => {
    const location = path.resolve(base, expandHome(file));
    const sourceFile = path.basename(location);
    if (sourceFile !== 'package.json' && sourceFile !== 'composer.json') {
      throw new Error(`Additional file must be named package.json or composer.json: ${location}`);
    }
    try {
      if (!fs.statSync(location).isFile()) throw new Error('Not a regular file');
      const directory = fs.realpathSync(path.dirname(location));
      return { directory, sourceFile, label: path.relative(root, path.join(directory, sourceFile)).split(path.sep).join('/') };
    } catch (error: unknown) {
      throw new Error(`Could not include additional file ${location}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function pnpmWorkspacePatterns(root: string): unknown {
  const file = path.join(root, 'pnpm-workspace.yaml');
  const config: unknown = parseYaml(fs.readFileSync(file, 'utf-8'));
  if (!isRecord(config) && config !== null) throw new Error(`Invalid workspace configuration: ${file}`);
  return isRecord(config) ? config.packages ?? [] : [];
}

function isWithin(root: string, directory: string): boolean {
  const relative = path.relative(root, directory);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function workspaceDirectories(root: string, patterns: unknown, filenames: SourceFile[]): string[] {
  if (!Array.isArray(patterns) || !patterns.every((pattern: unknown) => typeof pattern === 'string')) {
    throw new Error(`Invalid workspace package patterns in ${root}`);
  }
  const normalizedPatterns = (patterns as string[]).map(pattern => {
    const negative = pattern.startsWith('!');
    return { negative, pattern: path.posix.normalize((negative ? pattern.slice(1) : pattern).replaceAll('\\', '/')) };
  });
  const excluded = normalizedPatterns.filter(pattern => pattern.negative).map(pattern => pattern.pattern);
  const canonicalRoot = fs.realpathSync(root);
  const directories = new Set<string>([canonicalRoot]);
  for (const { pattern, negative } of normalizedPatterns) {
    if (negative) continue;
    for (const file of fs.globSync(filenames.map(filename => `${pattern}/${filename}`), {
      cwd: root, exclude: ['**/node_modules/**', '**/vendor/**', '**/.git/**'],
    })) {
      const declaredDirectory = path.dirname(path.resolve(root, file));
      const declaredRelative = path.relative(root, declaredDirectory).split(path.sep).join('/');
      if (excluded.some(pattern => path.matchesGlob(declaredRelative, pattern) ||
        pattern.endsWith('/**') && path.matchesGlob(declaredRelative, pattern.slice(0, -3)))) continue;
      const directory = fs.realpathSync(declaredDirectory);
      if (!isWithin(canonicalRoot, directory)) continue;
      if (path.relative(canonicalRoot, directory).split(path.sep).some(part => ['node_modules', 'vendor', '.git'].includes(part))) continue;
      directories.add(directory);
    }
  }
  return [...directories].sort((a, b) => a.localeCompare(b));
}

function discoverPnpmProjects(root: string): ScanProject[] {
  const directories = workspaceDirectories(root, pnpmWorkspacePatterns(root), ['package.json', 'composer.json']);
  const projects: ScanProject[] = [];
  const vendorDirectories: string[] = [];
  // Visit parents first so custom Composer vendor directories can be excluded.
  directories.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
  for (const directory of directories) {
    if (vendorDirectories.some(vendor => isWithin(vendor, directory))) continue;
    for (const sourceFile of ['package.json', 'composer.json'] as const) {
      const file = path.join(directory, sourceFile);
      if (!fs.existsSync(file)) continue;
      projects.push({ directory, sourceFile, label: path.relative(root, file).split(path.sep).join('/') });
      if (sourceFile === 'composer.json') {
        try {
          const manifest = readManifest(file);
          const configured = process.env.COMPOSER_VENDOR_DIR || manifest.vendorDir || 'vendor';
          const vendor = path.resolve(directory, expandHome(configured));
          vendorDirectories.push(fs.existsSync(vendor) ? fs.realpathSync(vendor) : vendor);
        } catch {
          // The scan reports invalid manifests alongside the other project results.
        }
      }
    }
  }
  return projects;
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
      patterns = pnpmWorkspacePatterns(root);
    } else if (isRecord(rootManifest) && rootManifest.workspaces !== undefined) {
      patterns = isRecord(rootManifest.workspaces) ? rootManifest.workspaces.packages : rootManifest.workspaces;
    }
    if (patterns !== undefined) {
      const members = new Map<string, string>();
      for (const directory of workspaceDirectories(root, patterns, ['package.json'])) {
        const file = path.join(directory, 'package.json');
        if (!fs.existsSync(file)) continue;
        const member: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (isRecord(member)) members.set(directory, typeof member.name === 'string' ? member.name : '');
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
  manifest.license = parseLicenseDeclaration(value.license);
  manifest.licenses = parseLicenseDeclaration(value.licenses);
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

function parseLicenseDeclaration(value: unknown): LicenseDeclaration | undefined {
  const entry = (item: unknown): LicenseEntry | undefined => {
    if (typeof item === 'string') return item.trim() || undefined;
    if (isRecord(item) && typeof item.type === 'string' && item.type.trim()) {
      return { type: item.type.trim(), ...(typeof item.url === 'string' ? { url: item.url } : {}) };
    }
    return undefined;
  };
  if (!Array.isArray(value)) return entry(value);
  if (value.length === 0) return undefined;
  const entries = value.map(entry);
  return entries.every((item): item is LicenseEntry => item !== undefined) ? entries : undefined;
}

function licenseTypes(license: LicenseDeclaration | undefined): string[] {
  const entries = license === undefined ? [] : Array.isArray(license) ? license : [license];
  return [...new Set(entries.map(entry => typeof entry === 'string' ? entry : entry.type))];
}

function licenseLabel(license: LicenseDeclaration | undefined): string | null {
  const types = licenseTypes(license);
  if (types.length <= 1) return types[0] ?? null;
  return types.map(type => /\s(?:AND|OR)\s/i.test(type) ? `(${type})` : type).join(' OR ');
}

function referencedLicenseTexts(directory: string, types: string[]): string[] {
  const texts: string[] = [];
  const seen = new Set<string>();
  for (const type of types) {
    const reference = type.match(/^SEE LICENSE IN\s+(.+)$/i)?.[1];
    if (!reference) continue;
    try {
      const file = path.resolve(directory, reference.replaceAll('\\', '/'));
      if (!isWithin(path.resolve(directory), file)) continue;
      const canonical = fs.realpathSync(file);
      if (!isWithin(fs.realpathSync(directory), canonical) || seen.has(canonical)) continue;
      if (!fs.statSync(canonical).isFile()) continue;
      const text = fs.readFileSync(canonical, 'utf-8');
      if (!text.trim()) continue;
      seen.add(canonical);
      texts.push(text);
    } catch {
      // Missing or unreadable pointers leave regular local and repository fallbacks available.
    }
  }
  return texts;
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

function hasLicenseInformation(item: LicenseItem): boolean {
  if (item.license?.trim()) return true;
  const types = item.licenseTypes ?? (item.type ? [item.type] : []);
  return types.some(type => type.trim() && !/^SEE LICENSE IN\b/i.test(type) &&
    !/^(?:unknown|unspecified|not specified|noassertion|none|n\/a)$/i.test(type));
}

function noticeFilePath(value: string): string {
  return path.resolve(expandHome(value.trim()));
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
    if (item.project) console.log(`Project: ${item.project}`);
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
        name: 'licenseFile', message: 'Path to local license text file (optional; leave empty to continue)',
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
    item.licenseTypes = [enteredLicense];
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

function expandHome(value: string): string {
  return value.replace(/^(\$HOME|~)(?=[/\\]|$)/, () => os.homedir());
}

function nodeDependencyDirectory(directory: string, dependency: string): string {
  let current = path.resolve(directory);
  while (true) {
    const candidate = path.join(current, 'node_modules', dependency);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return path.join(directory, 'node_modules', dependency);
    current = parent;
  }
}

function dependencyLabel(item: LicenseItem): string {
  return item.project ? `${item.module}${item.version ? `@${item.version}` : ''} (${item.project})` : item.module;
}

async function scanProject(project: ScanProject, options: CliOptions, licenseDownloads: Record<string, string>,
  members?: Map<string, string>): Promise<ScanResult | undefined> {
  const sourceFile = project.sourceFile;
  const isPackageMode = (): boolean => sourceFile === 'package.json';
  const isComposerMode = (): boolean => sourceFile === 'composer.json';
  const inProject = (file: string): string => project.directory === '.' ? file : path.resolve(project.directory, file);
  const manifest = readManifest(inProject('./' + sourceFile));
  const configuredFolder = process.env.COMPOSER_VENDOR_DIR || manifest.vendorDir || 'vendor';
  const folder = inProject(isPackageMode() ? 'node_modules' : expandHome(configuredFolder));
  let dependencies = Object.keys((isPackageMode() ? manifest.dependencies : manifest.require) ?? {});
  if (isComposerMode()) dependencies = dependencies.filter(d => d.indexOf('/') >= 0);
  if (isPackageMode() && options.excludeWorkspacePackages !== false && dependencies.length > 0) {
    const workspaceMembers = members ?? readWorkspaceMembers(path.resolve(project.directory));
    const workspaceNames = new Set(workspaceMembers.values());
    const excluded: string[] = [];
    dependencies = dependencies.filter(dependency => {
      const installedDirectory = project.label ? nodeDependencyDirectory(project.directory, dependency) : path.join(folder, dependency);
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
  if (!project.label && dependencies.length > 0 && !fs.existsSync(folder)) {
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
  const failures: LicenseItem[] = [];
  let licenseFileCounter = 0;
  let licenseDownloadCounter = 0;
  let readmeLicenseCounter = 0;

  for (const dependency of dependencies) {
    const registry = isComposerMode() ? 'https://packagist.org/packages/' : 'https://www.npmjs.com/package/';
    let licenseItem: LicenseItem = {
      module: dependency, type: null, description: null, project: project.label,
      packageUrl: registry + dependency.split('/').map(encodeURIComponent).join('/'),
    };
    try {
      const installed = composerPackages.get(dependency);
      const defaultFolder = isPackageMode() && project.label ? nodeDependencyDirectory(project.directory, dependency) : path.join(folder, dependency);
      const dependencyFolder = installed ? installed.directory :
        isPackageMode() && !project.label && !fs.existsSync(defaultFolder) ? `./${dependency.split('/').reverse()[0]}` : defaultFolder;
      const descriptionFile = installed ? installed.manifest : readManifest(path.join(dependencyFolder ?? '', sourceFile));
      const declaration = descriptionFile.license ?? (isPackageMode() ? descriptionFile.licenses : undefined);
      licenseItem = {
        module: dependency,
        project: project.label,
        type: licenseLabel(declaration),
        licenseTypes: licenseTypes(declaration),
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

      if (isPackageMode()) {
        const texts = referencedLicenseTexts(dependencyFolder, licenseItem.licenseTypes ?? []);
        if (texts.length > 0) {
          licenseItem.license = texts.join('\n\n');
          licenseFileCounter += texts.length;
          licenseItems.push(licenseItem);
          continue;
        }
      }
      const licenseFile = dependencyFolderFiles.find(file => LICENSE_FILENAMES.some(candidate => candidate.toLowerCase() === file.toLowerCase()));
      if (licenseFile) {
        const text = fs.readFileSync(path.join(dependencyFolder, licenseFile), 'utf-8');
        if (text.trim()) {
          licenseItem.license = text;
          licenseFileCounter++;
          licenseItems.push(licenseItem);
          continue;
        }
      }

      const readmeFile = dependencyFolderFiles.find(file => README_FILENAMES.some(candidate => candidate.toLowerCase() === file.toLowerCase()));
      if (readmeFile) {
        const readmeContent = fs.readFileSync(path.join(dependencyFolder, readmeFile), 'utf-8');
        const licenseSection = readmeContent.match(/#+ \b(License|Licence)\b\s*([\s\S]*)/i);
        if (licenseSection && licenseSection[2]?.trim()) {
          readmeLicenseCounter++;
          licenseItem.license = licenseSection[2].trim();
          licenseItems.push(licenseItem);
          continue;
        }
      }

      if (isPackageMode() && licenseItem.type?.toUpperCase() === 'UNLICENSED') {
        licenseItems.push(licenseItem);
        continue;
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

      failures.push(licenseItem);
      if (options.verbose) console.warn(chalk.red('No file or download available for "%s"'), dependency);
      licenseItems.push(licenseItem);
    } catch (error: unknown) {
      failures.push(licenseItem);
      licenseItems.push(licenseItem);
      if (options.verbose) console.warn(chalk.red('Could not scan "%s"'), dependency, error instanceof Error ? error.message : String(error));
    }
  }
  if (!options.verbose) spinner.succeed(chalk.magentaBright(`Scanning ${folder}/... done!`));

  return { licenseItems, failures, licenseFileCounter, licenseDownloadCounter, readmeLicenseCounter };
}

export async function main(options: CliOptions): Promise<void> {
  try {
    const root = process.cwd();
    const extraProjects = additionalProjects(options, root);
    const monorepo = options.monorepo !== false && fs.existsSync('./pnpm-workspace.yaml');
    if (options.monorepo && !monorepo) throw new Error('Monorepo mode requires pnpm-workspace.yaml in the current directory.');
    const combined = monorepo || extraProjects.length > 0;
    const workspaceProjects = monorepo ? discoverPnpmProjects(root) : [];
    const projects: ScanProject[] = [...workspaceProjects];
    if (monorepo) {
      console.log(chalk.magentaBright(`Monorepo mode: found ${projects.length} workspace manifests.`));
    } else if (combined) {
      for (const sourceFile of ['package.json', 'composer.json'] as const) {
        if (fs.existsSync(path.join(root, sourceFile))) projects.push({ directory: root, sourceFile, label: sourceFile });
      }
    } else {
      const packageFileExists = fs.existsSync('./package.json');
      const composerFileExists = fs.existsSync('./composer.json');

      if (!packageFileExists && !composerFileExists) {
        console.error(chalk.red('There is no dependency file (package.json or composer.json) in the current directory.'));
        return;
      }

      let sourceFile: SourceFile;
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

      projects.push({ directory: '.', sourceFile });
    }

    if (extraProjects.length > 0) {
      const seen = new Set(projects.map(project => fs.realpathSync(path.join(project.directory, project.sourceFile))));
      let added = 0;
      for (const project of extraProjects) {
        const identity = fs.realpathSync(path.join(project.directory, project.sourceFile));
        if (seen.has(identity)) continue;
        seen.add(identity);
        projects.push(project);
        added++;
      }
      console.log(chalk.magentaBright(`Included ${added} additional manifests.`));
    }
    if (projects.length === 0) throw new Error('No workspace package.json or composer.json files found.');
    const manifestScope = monorepo && extraProjects.length === 0 ? 'workspace manifests' : 'manifests';
    const members = new Map<string, string>();
    if (monorepo) {
      for (const project of workspaceProjects.filter(project => project.sourceFile === 'package.json')) {
        try {
          members.set(project.directory, readManifest(path.join(project.directory, project.sourceFile)).name ?? '');
        } catch {
          // The scan below records the manifest error without hiding other projects.
        }
      }
    }
    const licenseItems: LicenseItem[] = [];
    let failures: LicenseItem[] = [];
    const licenseDownloads: Record<string, string> = {};
    let licenseFileCounter = 0;
    let licenseDownloadCounter = 0;
    let readmeLicenseCounter = 0;
    const failedProjects: { project: string; message: string }[] = [];
    for (const project of projects) {
      if (project.label) console.log(chalk.cyanBright.bold(`Project: ${project.label}`));
      try {
        const result = await scanProject(project, options, licenseDownloads, monorepo ? members : undefined);
        if (!result) return;
        licenseItems.push(...result.licenseItems);
        failures.push(...result.failures);
        licenseFileCounter += result.licenseFileCounter;
        licenseDownloadCounter += result.licenseDownloadCounter;
        readmeLicenseCounter += result.readmeLicenseCounter;
      } catch (error: unknown) {
        if (!combined) throw error;
        const message = error instanceof Error ? error.message : String(error);
        failedProjects.push({ project: project.label ?? project.sourceFile, message });
        console.error(chalk.red(`Could not scan ${project.label}: ${message}`));
      }
    }
    if (combined) console.log(chalk.magentaBright(`Scanned ${projects.length - failedProjects.length} of ${projects.length} ${manifestScope}; found ${licenseItems.length} dependency occurrences.`));

    const reviewItems = licenseItems.filter(item => !hasLicenseInformation(item));
    const interactiveTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);
    if (reviewItems.length > 0 && (options.reviewLicenses ?? interactiveTerminal)) {
      const reviewed = await reviewMissingLicenses(reviewItems);
      if (reviewed.reviewed > 0) console.log(chalk.cyanBright(`Manually reviewed ${reviewed.reviewed} ${reviewed.reviewed === 1 ? 'dependency' : 'dependencies'}.`));
      if (reviewed.files > 0) console.log(chalk.cyanBright(`Provided ${reviewed.files} license text ${reviewed.files === 1 ? 'file' : 'files'} manually.`));
      failures = failures.filter(item => !item.license && item.type?.toUpperCase() !== 'UNLICENSED');
    } else if (reviewItems.length > 0 && options.reviewLicenses !== false) {
      console.log(chalk.yellow(`Manual license review skipped for ${reviewItems.length} ${reviewItems.length === 1 ? 'dependency' : 'dependencies'}. Run with --review-licenses in a terminal to review.`));
    }

    const copyleftItems = licenseItems.filter(item => hasCopyleftLicense(item.type));
    if (copyleftItems.length > 0) {
      console.warn(chalk.bgYellow.black.bold(' COPYLEFT WARNING '));
      console.warn(chalk.yellow.bold(`Copyleft licenses detected in ${copyleftItems.length} ${copyleftItems.length === 1 ? 'dependency' : 'dependencies'}:`));
      for (const item of copyleftItems) {
        console.warn(chalk.yellow(` - ${dependencyLabel(item)}: ${item.type}`));
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
        console.log(chalk.redBright(' - ' + dependencyLabel(fail)));
      }
    }

    if (options.info) {
      const licenseInfo: LicenseInfo = licenseItems.reduce((result: LicenseInfo, current) => {
        const licenseType = current.type || (current.license?.trim() ? 'License text available (unclassified)' : null);
        if (!licenseType) return result;
        (result[licenseType] ??= []).push(dependencyLabel(current));
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
      let html = combined ? `<h1>${extraProjects.length > 0 ? 'Combined' : 'Workspace'} license report</h1><p>Scanned ${projects.length - failedProjects.length} of ${projects.length} ${manifestScope}; ${licenseItems.length} dependency occurrences.</p><ul>${projects.map(project => `<li>${escapeHtml(project.label ?? project.sourceFile)}</li>`).join('')}</ul>` : '';
      if (failedProjects.length > 0) {
        html += `<h2>Incomplete scan: ${failedProjects.length} ${manifestScope} failed</h2><ul>${failedProjects.map(failure => `<li>${escapeHtml(failure.project)}: ${escapeHtml(failure.message)}</li>`).join('')}</ul>`;
      }
      for (const f of licenseItems) {
        const licenseText = f.license || (f.type?.toUpperCase() === 'UNLICENSED' ? 'No license grant (UNLICENSED).' : 'No license file provided.');
        const manualDetails = f.manualReview ? `
          <p><strong>License selected manually.</strong> Original declaration: ${escapeHtml(f.manualReview.declaredType || 'not specified')}.</p>
          <p>Version: ${escapeHtml(f.version || 'unknown')}.${f.sourceUrl ? ` <a href="${escapeHtml(f.sourceUrl)}">Source repository</a>.` : ''}${f.packageUrl ? ` <a href="${escapeHtml(f.packageUrl)}">Package metadata</a>.` : ''}</p>
          <p>${f.manualReview.licenseFile ? `License text supplied manually (${escapeHtml(path.basename(f.manualReview.licenseFile))}).` : f.license ? 'Existing license text retained.' : 'No full license text supplied.'}</p>
        ` : '';
        html += `
          <h2>${escapeHtml(f.module)}</h2>
          ${f.project ? `<p>Project: ${escapeHtml(f.project)}. Version: ${escapeHtml(f.version || 'unknown')}.</p>` : ''}
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
    .option('--no-review-licenses', 'skip interactive license review')
    .option('--monorepo', 'scan all manifests at a pnpm workspace root (automatic when detected)')
    .option('--no-monorepo', 'skip automatic workspace discovery (additional files still apply)')
    .option('--additional-files <paths...>', 'include extra package.json or composer.json files')
    .option('--config <path>', 'read a configuration file instead of ./licensle.config.json');

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
