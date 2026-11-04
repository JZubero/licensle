#!/usr/bin/env node
import { program } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import open from 'open';
import yesno from 'yesno';
import prompts from 'prompts';
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
}

interface DependencyManifest {
  dependencies?: Record<string, unknown>;
  require?: Record<string, unknown>;
  replace?: Record<string, unknown>;
  provide?: Record<string, unknown>;
  license?: string | string[] | { type: string };
  description?: string;
  repository?: string | { url: string };
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

function readManifest(filePath: string): DependencyManifest {
  const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return parseManifest(value, filePath);
}

function parseManifest(value: unknown, filePath: string): DependencyManifest {
  if (!isRecord(value)) throw new Error(`Invalid dependency manifest: ${filePath}`);

  const manifest: DependencyManifest = {};
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
    const failures: string[] = [];
    let licenseFileCounter = 0;
    let licenseDownloadCounter = 0;
    let readmeLicenseCounter = 0;

    for (const dependency of dependencies) {
      let licenseItem: LicenseItem = { module: dependency, type: null, description: null };
      try {
        const installed = composerPackages.get(dependency);
        const defaultFolder = path.join(folder, dependency);
        const dependencyFolder = installed ? installed.directory :
          isPackageMode() && !fs.existsSync(defaultFolder) ? `./${dependency.split('/').reverse()[0]}` : defaultFolder;
        const descriptionFile = installed ? installed.manifest : readManifest(path.join(dependencyFolder ?? '', sourceFile));
        licenseItem = {
          module: dependency,
          type: licenseLabel(descriptionFile.license),
          description: descriptionFile.description || null
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
        html += `
          <h2>${f.module}</h2>
          <p>${f.type ? `<strong>${f.type}</strong> - ` : ''}${f.description}</p>
          <pre>${licenseText}</pre>
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
    .option('-v, --verbose', 'activate verbose logging ');

  program.parse(process.argv);
  const options = program.opts<CliOptions>();

  if (options.outputFilePath && !options.generate) {
    console.warn(chalk.bgYellow.black('Warning: Using --outputFilePath without -g (--generate) will not have any effect.'));
  }

  if (options.browser && !options.generate) {
    console.warn(chalk.bgYellow.black('Warning: Using --browser without -g (--generate) will not have any effect.'));
  }

  await main(options);
}
