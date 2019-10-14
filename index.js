#!/usr/bin/env node
const program = require('commander');
const ora = require('ora');
const chalk = require('chalk');
const opn = require('opn');
const yesno = require('yesno');
const prompts = require('prompts');
const fs = require('fs');
const os = require('os');
const https = require('https');

const {version} = require('./package');

program
.version(version)
.option('-g, --generate', 'generate a static license summary file')
.option('-b, --browser', 'open up a browser and show generated static license summary file')
.option('--no-browser', 'prevents the browser from popping open')
.option('-i, --info', 'provides information about all direct dependency licenses')
.option('-o, --outputFilePath <path>', 'specify path and name of the output file')
.option('-v, --verbose', 'activate verbose logging ')
.parse(process.argv);

if (program.outputFilePath && !program.generate) {
  console.warn(chalk.bgYellow.black('Warning: Using --outputFilePath without -g (--generate) will not have any effect.'));
}

if (program.browser && !program.generate) {
  console.warn(chalk.bgYellow.black('Warning: Using --browser without -g (--generate) will not have any effect.'));
}

const LICENSE_FILENAMES = ['LICENSE', 'LICENSE.md', 'license', 'license.md', 'LICENSE.txt'];

(async function () {
  try {
    const packageFileExists = fs.existsSync('./package.json');
    const composerFileExists = fs.existsSync('./composer.json');
    const nodeModulesExists = fs.existsSync('./node_modules');
    const vendorFolderExists = fs.existsSync('./vendor');

    if (!packageFileExists && !composerFileExists) {
      console.error(chalk.red('There is no dependency file (package,json or composer.json) in the current directory.'));

      return;
    }

    if (!nodeModulesExists && !vendorFolderExists) {
      console.error(chalk.red('There is no dependency folder (node_modules/ or vendor/) in the current directory.'));

      return;
    }

    let sourceFile;
    if (packageFileExists && composerFileExists) {
      const promptResponse = await prompts({
        type: 'select',
        name: 'sourceFile',
        message: chalk.magentaBright('Which source file should get parsed?'),
        initial: 0,
        choices: [
          {title: chalk.blueBright('package.json'), value: 'package.json'},
          {title: chalk.blueBright('composer.json'), value: 'composer.json'}
        ],
      });

      sourceFile = promptResponse['sourceFile'];
    } else {
      sourceFile = packageFileExists ? 'package.json' : 'composer.json';
    }

    const isPackageMode = () => sourceFile === 'package.json';
    const isComposerMode = () => sourceFile === 'composer.json';
    const folder = isPackageMode() ? 'node_modules' : 'vendor';

    const content = fs.readFileSync('./' + sourceFile, 'utf-8');
    let dependencies = Object.keys(JSON.parse(content)[isPackageMode() ? 'dependencies' : 'require']);
    if (isComposerMode()) dependencies = dependencies.filter(d => d.indexOf('/') >= 0);
    console.log(chalk.magentaBright('Found %d dependencies.'), dependencies.length);

    const spinner = ora({
      text: chalk.magentaBright('Scanning ' + folder + '/'),
      color: 'magenta'
    });
    if (!program.verbose) spinner.start();

    const sanitizeLicenseLabel = (label) => {
      if (!label) return null;

      return label
      .replace('-', ' ');
    };

    const licenseItems = [];
    const licenseDownloads = {};
    const failures = [];
    let licenseFileCounter = 0;
    let licenseDownloadCounter = 0;
    for (let dependency of dependencies) {
      try {
        let dependencyFolder = fs.existsSync(`./${folder}/${dependency}`) ?
          `./${folder}/${dependency}` :
          `./${dependency.split('/').reverse()[0]}`;
        const dependencyFolderFiles = fs.readdirSync(dependencyFolder);
        const descriptionFile = JSON.parse(fs.readFileSync(`./${dependencyFolder}/${sourceFile}`, 'utf-8'));

        const licenseItem = {
          module: dependency,
          type: sanitizeLicenseLabel(descriptionFile.license),
          description: descriptionFile.description || null
        };

        // Check for license file
        const licenseFile = LICENSE_FILENAMES.filter(f => dependencyFolderFiles.includes(f));
        if (licenseFile.length > 0) {
          licenseFileCounter++;
          licenseItem['license'] = fs.readFileSync(`./${dependencyFolder}/${licenseFile[0]}`, 'utf-8');

          licenseItems.push(licenseItem);
          continue;
        }

        // Check for repository
        if ((isPackageMode() && descriptionFile.hasOwnProperty('repository')) || isComposerMode()) {
          const fetchLicenseFileFromRepo = async (url) => {
            let message = 'Trying to fetch license file from "' + url + '"... ';
            const response = await request(url);
            message += response.code >= 400 ? 'failed (' + response.code + ')' : 'succeeded';
            if (program.verbose) console.log(chalk.blueBright(message));

            return response;
          };

          let rawUrl;
          if (isPackageMode()) {
            const url = descriptionFile.repository.url;
            const repoUrl = url.replace(/^git\+/, '')
            .replace(/\.git$/, '')
            .replace('ssh://git@', 'https://');

            rawUrl = repoUrl
            .replace('https://github.com', 'https://raw.githubusercontent.com');
          } else {
            rawUrl = 'https://raw.githubusercontent.com/' + dependency;
          }

          for (let branch of ['master', 'dev', 'develop']) {
            for (let licenseFilename of LICENSE_FILENAMES) {
              const fullRequestUrl = `${rawUrl}/${branch}/${licenseFilename}`;

              if (Object.keys(licenseDownloads).indexOf(fullRequestUrl) > -1) {
                licenseDownloadCounter++;
                licenseItem['license'] = licenseDownloads[fullRequestUrl];

                licenseItems.push(licenseItem);
                break;
              } else {
                const response = await fetchLicenseFileFromRepo(fullRequestUrl);

                if (response.code === 200) {
                  licenseDownloadCounter++;
                  licenseItem['license'] = response.data;
                  licenseDownloads[fullRequestUrl] = response.data;

                  licenseItems.push(licenseItem);
                  break;
                }
              }
            }

            if (licenseItem.hasOwnProperty('license')) break;
          }

          if (licenseItem.hasOwnProperty('license')) continue;
        }

        failures.push(dependency);
        if (program.verbose) console.warn(chalk.red('No file or download available for "%s"'), dependency);
        licenseItems.push(licenseItem);
      } catch (e) {
        if (program.verbose) console.warn(chalk.red('Did not find directory for "%s"'), dependency, e);
      }
    }
    if (!program.verbose) spinner.succeed(chalk.magentaBright('Scanning node_modules/... done!'));

    console.log(chalk.magentaBright('The following licenses are used:'),
      [...new Set(licenseItems.map(i => i.type))].filter(i => i).join(', ')
    );
    console.log(chalk.magentaBright('Found %d license files'), licenseFileCounter);
    console.log(chalk.magentaBright('Downloaded %d license files'), licenseDownloadCounter);
    if (failures.length > 0) {
      console.log(chalk.red('No license file found (%d):'), failures.length);
      for (let fail of failures) {
        console.log(chalk.redBright(' - ' + fail));
      }
    }

    if (program.info) {
      const licenseInfo = licenseItems.map(i => {
        return {
          module: i.module,
          license: sanitizeLicenseLabel(i.type)
        };
      }).reduce((result, current) => {
        if (!current.license) return result;

        if (!result.hasOwnProperty(current.license)) {
          result[current.license] = [current.module];
        } else {
          result[current.license].push(current.module);
        }

        return result;
      }, {});
      for (let licenseType of Object.keys(licenseInfo)) {
        console.log(chalk.blueBright.bold(`${licenseType} (%d usages)`), licenseInfo[licenseType].length);
        for (let module of licenseInfo[licenseType]) {
          console.log(chalk.blueBright(`  |-- ${module}`));
        }
      }
    }

    if (program.generate) {
      const filePath = program.outputFilePath || (os.tmpdir() + '/license.html');

      console.log(chalk.cyanBright('Creating license HTML file (' + filePath + ')...'));
      let html = '';
      for (let f of licenseItems) {
        // TODO: Skip entries with no license information at all
        let licenseText = f['license'] || `${f['type']}. No license file provided.`;

        html += `
      <h2>${f['module']}</h2>
      <p>${f['description']}</p>
      <pre>${licenseText}</pre>
      <hr>
    `;
      }

      fs.writeFileSync(filePath, html, 'utf-8');

      if (program.browser !== false) {
        let showInBrowser = program.browser;
        if (!showInBrowser) {
          showInBrowser = await yesno({
            question: chalk.cyanBright('Show output file in browser? (Y/n)'),
            defaultValue: 'y'
          });
        }

        if (showInBrowser) opn(filePath);
      }
    }
  } catch (e) {
    console.error(chalk.red(e));
  }
})();

/**
 * Async http GET method
 * @param url
 * @returns {Promise<any>}
 */
function request(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });

      response.on('end', () => {
        resolve({
          code: response.statusCode,
          data
        });
      });
    }).on('error', (err) => {
      console.warn(chalk.red('Error requesting url "%s"'), url, err);

      reject(err);
    });
  })
}
