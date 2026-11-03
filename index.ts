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
  license?: string | string[] | { type: string };
  description?: string;
  repository?: string | { url: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readManifest(filePath: string): DependencyManifest {
  const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (!isRecord(value)) throw new Error(`Invalid dependency manifest: ${filePath}`);

  const manifest: DependencyManifest = {};
  for (const key of ['dependencies', 'require'] as const) {
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
  return manifest;
}

function licenseLabel(license: DependencyManifest['license']): string | null {
  if (typeof license === 'string') return license;
  if (Array.isArray(license)) return license.join(' OR ');
  return license?.type ?? null;
}

interface RequestResponse {
  code: number;
  data: string;
}

export const LICENSE_FILENAMES: string[] = ['LICENSE', 'LICENSE.md', 'license', 'license.md', 'LICENSE.txt'];
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
    const folder: string = isPackageMode() ? 'node_modules' : 'vendor';

    const manifest = readManifest('./' + sourceFile);
    let dependencies = Object.keys((isPackageMode() ? manifest.dependencies : manifest.require) ?? {});
    if (isComposerMode()) dependencies = dependencies.filter(d => d.indexOf('/') >= 0);
    if (dependencies.length > 0 && !fs.existsSync(`./${folder}`)) {
      console.error(chalk.red(`There is no dependency folder (${folder}/) in the current directory.`));
      return;
    }
    console.log(chalk.magentaBright(`Found ${dependencies.length} dependencies.`));

    const spinner = ora({
      text: chalk.magentaBright('Scanning ' + folder + '/'),
      color: 'magenta'
    });
    if (!options.verbose) spinner.start();

    const sanitizeLicenseLabel = (label: string | null): string | null => {
      if (!label) return null;
      return label.replace('-', ' ');
    };

    const licenseItems: LicenseItem[] = [];
    const licenseDownloads: { [url: string]: string } = {};
    const failures: string[] = [];
    let licenseFileCounter = 0;
    let licenseDownloadCounter = 0;
    let readmeLicenseCounter = 0;

    for (const dependency of dependencies) {
      try {
        const dependencyFolder = fs.existsSync(`./${folder}/${dependency}`) ?
          `./${folder}/${dependency}` :
          `./${dependency.split('/').reverse()[0]}`;
        const dependencyFolderFiles = fs.readdirSync(dependencyFolder);
        const descriptionFile = readManifest(`./${dependencyFolder}/${sourceFile}`);

        const licenseItem: LicenseItem = {
          module: dependency,
          type: sanitizeLicenseLabel(licenseLabel(descriptionFile.license)),
          description: descriptionFile.description || null
        };

        const licenseFile = LICENSE_FILENAMES.find(f => dependencyFolderFiles.includes(f));
        if (licenseFile) {
          licenseFileCounter++;
          licenseItem.license = fs.readFileSync(`./${dependencyFolder}/${licenseFile}`, 'utf-8');
          licenseItems.push(licenseItem);
          continue;
        }

        if ((isPackageMode() && descriptionFile.repository) || isComposerMode()) {
          const fetchLicenseFileFromRepo = async (url: string): Promise<RequestResponse> => {
            let message = `Trying to fetch license file from "${url}"... `;
            const response = await request(url);
            message += response.code >= 400 ? `failed (${response.code})` : 'succeeded';
            if (options.verbose) console.log(chalk.blueBright(message));
            return response;
          };

          let rawUrl: string;
          if (isPackageMode()) {
            const repository = descriptionFile.repository;
            const url = typeof repository === 'string' ? repository : repository?.url;
            if (!url) throw new Error(`Missing repository URL for ${dependency}`);
            const repoUrl = url.replace(/^git\+/, '').replace(/\.git$/, '').replace('ssh://git@', 'https://');
            rawUrl = repoUrl.replace('https://github.com', 'https://raw.githubusercontent.com');
          } else {
            rawUrl = `https://raw.githubusercontent.com/${dependency}`;
          }

          for (const branch of ['main', 'master', 'dev', 'develop']) {
            for (const licenseFilename of LICENSE_FILENAMES) {
              const fullRequestUrl = `${rawUrl}/${branch}/${licenseFilename}`;
              if (licenseDownloads[fullRequestUrl]) {
                licenseDownloadCounter++;
                licenseItem.license = licenseDownloads[fullRequestUrl];
                licenseItems.push(licenseItem);
                break;
              } else {
                const response = await fetchLicenseFileFromRepo(fullRequestUrl);
                if (response.code === 200) {
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

        const readmeFile = README_FILENAMES.find(f => dependencyFolderFiles.includes(f));
        if (readmeFile) {
          const readmeContent = fs.readFileSync(`./${dependencyFolder}/${readmeFile}`, 'utf-8');
          const licenseSection = readmeContent.match(/#+ \b(License|Licence)\b\s*([\s\S]*)/i);
          if (licenseSection && licenseSection[2]) {
            readmeLicenseCounter++;
            licenseItem.license = licenseSection[2].trim();
            licenseItems.push(licenseItem);
            continue;
          }
        }

        failures.push(dependency);
        if (options.verbose) console.warn(chalk.red('No file or download available for "%s"'), dependency);
        licenseItems.push(licenseItem);
      } catch (error: unknown) {
        if (options.verbose) console.warn(chalk.red('Could not scan "%s"'), dependency, error instanceof Error ? error.message : String(error));
      }
    }
    if (!options.verbose) spinner.succeed(chalk.magentaBright(`Scanning ${folder}/... done!`));

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
        const licenseType = sanitizeLicenseLabel(current.type) || 'unknown';
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
    https.get(url, (response) => {
      let data = '';
      response.on('data', (chunk) => data += chunk);
      response.on('end', () => resolve({ code: response.statusCode || 500, data }));
    }).on('error', (err) => {
      console.warn(chalk.red('Error requesting url "%s"'), url, err);
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
