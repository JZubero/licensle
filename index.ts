#!/usr/bin/env node
import { program } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import open from 'open';
import yesno from 'yesno';
import prompts from 'prompts';
import fs from 'fs';
import os from 'os';
import https from 'https';
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

interface RequestResponse {
  code: number;
  data: string;
}

export const LICENSE_FILENAMES: string[] = ['LICENSE', 'LICENSE.md', 'license', 'license.md', 'LICENSE.txt'];
export const README_FILENAMES: string[] = ['README.md', 'readme.md', 'README', 'readme'];

export async function main(options: any) {
  try {
    const packageFileExists = fs.existsSync('./package.json');
    const composerFileExists = fs.existsSync('./composer.json');
    const nodeModulesExists = fs.existsSync('./node_modules');
    const vendorFolderExists = fs.existsSync('./vendor');

    if (!packageFileExists && !composerFileExists) {
      console.error(chalk.red('There is no dependency file (package.json or composer.json) in the current directory.'));
      return;
    }

    if (!nodeModulesExists && !vendorFolderExists) {
      console.error(chalk.red('There is no dependency folder (node_modules/ or vendor/) in the current directory.'));
      return;
    }

    let sourceFile: string;
    if (packageFileExists && composerFileExists) {
      const promptResponse = await prompts({
        type: 'select',
        name: 'sourceFile',
        message: chalk.magentaBright('Which source file should get parsed?'),
        initial: 0,
        choices: [
          { title: chalk.blueBright('package.json'), value: 'package.json' },
          { title: chalk.blueBright('composer.json'), value: 'composer.json' }
        ],
      });
      sourceFile = promptResponse['sourceFile'];
    } else {
      sourceFile = packageFileExists ? 'package.json' : 'composer.json';
    }

    const isPackageMode = (): boolean => sourceFile === 'package.json';
    const isComposerMode = (): boolean => sourceFile === 'composer.json';
    const folder: string = isPackageMode() ? 'node_modules' : 'vendor';

    const content: string = fs.readFileSync('./' + sourceFile, 'utf-8');
    let dependencies: string[] = Object.keys(JSON.parse(content)[isPackageMode() ? 'dependencies' : 'require']);
    if (isComposerMode()) dependencies = dependencies.filter(d => d.indexOf('/') >= 0);
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

    for (let dependency of dependencies) {
      try {
        let dependencyFolder = fs.existsSync(`./${folder}/${dependency}`) ?
          `./${folder}/${dependency}` :
          `./${dependency.split('/').reverse()[0]}`;
        const dependencyFolderFiles = fs.readdirSync(dependencyFolder);
        const descriptionFile = JSON.parse(fs.readFileSync(`./${dependencyFolder}/${sourceFile}`, 'utf-8'));

        const licenseItem: LicenseItem = {
          module: dependency,
          type: sanitizeLicenseLabel(descriptionFile.license),
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
            const url = descriptionFile.repository.url;
            const repoUrl = url.replace(/^git\+/, '').replace(/\.git$/, '').replace('ssh://git@', 'https://');
            rawUrl = repoUrl.replace('https://github.com', 'https://raw.githubusercontent.com');
          } else {
            rawUrl = `https://raw.githubusercontent.com/${dependency}`;
          }

          for (let branch of ['main', 'master', 'dev', 'develop']) {
            for (let licenseFilename of LICENSE_FILENAMES) {
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
      } catch (e: any) {
        if (options.verbose) console.warn(chalk.red('Did not find directory for "%s"'), dependency, e.message);
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
      for (let fail of failures) {
        console.log(chalk.redBright(' - ' + fail));
      }
    }

    if (options.info) {
      const licenseInfo: LicenseInfo = licenseItems.reduce((result: LicenseInfo, current) => {
        if (!current.type) return result;
        const licenseType = sanitizeLicenseLabel(current.type) || 'unknown';
        if (!result[licenseType]) {
          result[licenseType] = [];
        }
        result[licenseType].push(current.module);
        return result;
      }, {});

      for (let licenseType of Object.keys(licenseInfo)) {
        console.log(chalk.blueBright.bold(`${licenseType} (${licenseInfo[licenseType].length} usages)`));
        for (let module of licenseInfo[licenseType]) {
          console.log(chalk.blueBright(`  |-- ${module}`));
        }
      }
    }

    if (options.generate) {
      const filePath = options.outputFilePath || (os.tmpdir() + '/license.html');
      console.log(chalk.cyanBright('Creating license HTML file (' + filePath + ')...'));
      let html = '';
      for (let f of licenseItems) {
        let licenseText = f.license || 'No license file provided.';
        html += `
          <h2>${f.module}</h2>
          <p>${f.type ? `<strong>${f.type}</strong> - ` : ''}${f.description}</p>
          <pre>${licenseText}</pre>
          <hr>
        `;
      }
      fs.writeFileSync(filePath, html, 'utf-8');

      if (options.browser !== false) {
        let showInBrowser = options.browser;
        if (!showInBrowser) {
          showInBrowser = await yesno({
            question: chalk.cyanBright('Show output file in browser? (Y/n)'),
            defaultValue: true
          });
        }
        if (showInBrowser) open(filePath);
      }
    }
  } catch (e: any) {
    console.error(chalk.red(e.message));
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

if (import.meta.url === `file://${process.argv[1]}`) {
  program
    .version(version)
    .option('-g, --generate', 'generate a static license summary file')
    .option('-b, --browser', 'open up a browser and show generated static license summary file')
    .option('--no-browser', 'prevents the browser from popping open')
    .option('-i, --info', 'provides information about all direct dependency licenses')
    .option('-o, --outputFilePath <path>', 'specify path and name of the output file')
    .option('-v, --verbose', 'activate verbose logging ');

  program.parse(process.argv);
  const options = program.opts();

  if (options.outputFilePath && !options.generate) {
    console.warn(chalk.bgYellow.black('Warning: Using --outputFilePath without -g (--generate) will not have any effect.'));
  }

  if (options.browser && !options.generate) {
    console.warn(chalk.bgYellow.black('Warning: Using --browser without -g (--generate) will not have any effect.'));
  }

  main(options);
}
