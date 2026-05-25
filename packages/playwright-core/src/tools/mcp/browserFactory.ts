/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';

import { playwright } from '../../inprocess';
import { registryDirectory } from '../../server/registry/index';
import { testDebug } from './log';
import { outputDir } from '../backend/context';
import { createExtensionBrowser } from './extensionContextFactory';
import { connectToBrowserAcrossVersions } from '../utils/connect';
import { serverRegistry } from '../../serverRegistry';
import { resolveExtensionOptions } from './config';
// eslint-disable-next-line no-restricted-imports
import { connectToBrowser } from '../../client/connect';

import type { CLIOptions, FullConfig } from './config';
import type { ClientInfo } from '../utils/mcp/server';
// eslint-disable-next-line no-restricted-imports
import type { Playwright } from '../../client/playwright';
import type * as playwrightTypes from '../../..';
import type { BrowserInfo } from '../../serverRegistry';

type BrowserWithInfo = {
  browser: playwrightTypes.Browser,
  browserInfo: BrowserInfo,
  canBind: boolean,
  ownership: 'attached' | 'own',
};

export async function createBrowserWithInfo(config: FullConfig, clientInfo: ClientInfo, cliOptions: CLIOptions): Promise<BrowserWithInfo> {
  if (config.browser.remoteEndpoint)
    return await createRemoteBrowser(config);

  let browser: playwrightTypes.Browser;
  let canBind = false;
  let ownership: 'attached' | 'own' = 'own';
  if (config.browser.cdpEndpoint) {
    browser = await createCDPBrowser(config, clientInfo);
    canBind = true;
    ownership = 'attached';
  } else if (config.browser.isolated) {
    browser = await createIsolatedBrowser(config, clientInfo);
    canBind = true;
    ownership = 'own';
  } else if (config.extension) {
    const { channel, executablePath } = resolveExtensionOptions(cliOptions);
    browser = await createExtensionBrowser(channel, executablePath, clientInfo.clientName);
    ownership = 'attached';
  } else {
    browser = await createPersistentBrowser(config, clientInfo);
    canBind = true;
    ownership = 'own';
  }

  return { browser, browserInfo: browserInfo(browser, config), canBind, ownership };
}

export interface BrowserContextFactory {
  contexts(clientInfo: ClientInfo): Promise<playwrightTypes.BrowserContext[]>;
  createContext(clientInfo: ClientInfo): Promise<playwrightTypes.BrowserContext>;
}

function browserInfo(browser: playwrightTypes.Browser, config: FullConfig): BrowserInfo {
  return {
    // eslint-disable-next-line no-restricted-syntax
    guid: (browser as any)._guid,
    browserName: config.browser.browserName,
    launchOptions: config.browser.launchOptions,
    userDataDir: config.browser.userDataDir
  };
}

async function createIsolatedBrowser(config: FullConfig, clientInfo: ClientInfo): Promise<playwrightTypes.Browser> {
  testDebug('create browser (isolated)');
  const browserType = playwright[config.browser.browserName];
  const tracesDir = await computeTracesDir(config, clientInfo);
  const browser = await browserType.launch({
    tracesDir,
    ...config.browser.launchOptions,
    handleSIGINT: false,
    handleSIGTERM: false,
  }).catch(error => {
    throwIfExecutableMissing(error, config);
    throw error;
  });
  return browser;
}

async function createCDPBrowser(config: FullConfig, clientInfo: ClientInfo): Promise<playwrightTypes.Browser> {
  testDebug('create browser (cdp)');
  const artifactsDir = await computeTracesDir(config, clientInfo);
  const launchOptions = config.browser.launchOptions as playwrightTypes.LaunchOptions & {
    cdpStealth?: string[],
  };
  const browser = await playwright.chromium.connectOverCDP(config.browser.cdpEndpoint!, {
    headers: config.browser.cdpHeaders,
    timeout: config.browser.cdpTimeout,
    artifactsDir,
    cdpStealth: launchOptions.cdpStealth,
  } as playwrightTypes.ConnectOverCDPOptions & { cdpStealth?: string[] });
  return browser;
}

async function createRemoteBrowser(config: FullConfig): Promise<BrowserWithInfo> {
  testDebug('create browser (remote)');
  const descriptor = await serverRegistry.find(config.browser.remoteEndpoint!);
  if (descriptor) {
    const browser = await connectToBrowserAcrossVersions(descriptor);
    return {
      browser,
      browserInfo: {
        guid: descriptor.browser.guid,
        browserName: descriptor.browser.browserName,
        launchOptions: descriptor.browser.launchOptions,
        userDataDir: descriptor.browser.userDataDir
      },
      canBind: false,
      ownership: 'attached'
    };
  }

  const endpoint = config.browser.remoteEndpoint!;
  const playwrightObject = playwright as Playwright;
  // Use connectToBrowser instead of playwright[browserName].connect because we don't have browserName.
  const browser = await connectToBrowser(playwrightObject, {
    endpoint,
    headers: config.browser.remoteHeaders,
  });
  browser._connectToBrowserType(playwrightObject[browser._browserName], {}, undefined);
  return { browser, browserInfo: browserInfo(browser, config), canBind: false, ownership: 'attached' };
}

async function createPersistentBrowser(config: FullConfig, clientInfo: ClientInfo): Promise<playwrightTypes.Browser> {
  testDebug('create browser (persistent)');
  const userDataDir = config.browser.userDataDir ?? await createUserDataDir(config, clientInfo);
  const tracesDir = await computeTracesDir(config, clientInfo);

  if (await isProfileLocked5Times(userDataDir))
    throw new Error(`Browser is already in use for ${userDataDir}, use --isolated to run multiple instances of the same browser`);

  const browserType = playwright[config.browser.browserName];
  const configIgnoreDefaultArgs = config.browser.launchOptions?.ignoreDefaultArgs;
  const launchOptions: playwrightTypes.LaunchOptions & playwrightTypes.BrowserContextOptions = {
    tracesDir,
    ...config.browser.launchOptions,
    ...config.browser.contextOptions,
    handleSIGINT: false,
    handleSIGTERM: false,
    ignoreDefaultArgs: configIgnoreDefaultArgs === true
      ? true
      : [
        '--disable-extensions',
        ...Array.isArray(configIgnoreDefaultArgs) ? configIgnoreDefaultArgs : [],
      ],
  };
  if (config.browser.sapotoRuntime)
    await prepareSapotoChromeRuntimeProfile(userDataDir, launchOptions);
  try {
    const browserContext = await browserType.launchPersistentContext(userDataDir, launchOptions);
    const browser = browserContext.browser()!;
    return browser;
  } catch (error: any) {
    throwIfExecutableMissing(error, config);
    if (error.message.includes('cannot open shared object file: No such file or directory')) {
      const browserName = launchOptions.channel ?? config.browser.browserName;
      throw new Error(`Missing system dependencies required to run browser ${browserName}. Install them with: sudo npx playwright install-deps ${browserName}`);
    }
    if (error.message.includes('ProcessSingleton') || error.message.includes('exitCode=21'))
      throw new Error(`Browser is already in use for ${userDataDir}, use --isolated to run multiple instances of the same browser`);
    throw error;
  }
}

async function createUserDataDir(config: FullConfig, clientInfo: ClientInfo) {
  const dir = process.env.PWMCP_PROFILES_DIR_FOR_TEST ?? registryDirectory;
  const browserToken = config.browser.launchOptions?.channel ?? config.browser?.browserName;
  const profilePrefix = config.browser.sapotoRuntime ? 'sapoto' : 'mcp';
  // Hesitant putting hundreds of files into the user's workspace, so using it for hashing instead.
  const rootPathToken = createHash(clientInfo.cwd);
  const result = path.join(dir, `${profilePrefix}-${browserToken}-${rootPathToken}`);
  await fs.promises.mkdir(result, { recursive: true });
  return result;
}

async function prepareSapotoChromeRuntimeProfile(userDataDir: string, launchOptions: playwrightTypes.LaunchOptions & playwrightTypes.BrowserContextOptions) {
  launchOptions.args = launchOptions.args ?? [];
  if (!launchOptions.args.some(arg => arg.startsWith('--remote-debugging-port=')))
    launchOptions.args.push(`--remote-debugging-port=${await findFreePort()}`);
  await seedSapotoChromePreferences(userDataDir);
}

async function findFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string')
    throw new Error('Unable to allocate a local remote debugging port.');
  return address.port;
}

async function seedSapotoChromePreferences(userDataDir: string): Promise<void> {
  const defaultProfileDir = path.join(userDataDir, 'Default');
  await fs.promises.mkdir(defaultProfileDir, { recursive: true });
  const preferencesPath = path.join(defaultProfileDir, 'Preferences');
  let preferences: any = {};
  try {
    preferences = JSON.parse(await fs.promises.readFile(preferencesPath, 'utf8'));
  } catch (error: any) {
    if (error.code !== 'ENOENT')
      throw error;
  }
  preferences.download = {
    ...preferences.download,
    default_directory: path.join(userDataDir, 'Sapoto Downloads'),
    prompt_for_download: false,
  };
  preferences.plugins = {
    ...preferences.plugins,
    always_open_pdf_externally: true,
  };
  await fs.promises.writeFile(preferencesPath, JSON.stringify(preferences, undefined, 2));
}

function createHash(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 7);
}

async function computeTracesDir(config: FullConfig, clientInfo: ClientInfo): Promise<string | undefined> {
  return path.resolve(outputDir({ config, cwd: clientInfo.cwd }), 'traces');
}

async function isProfileLocked5Times(userDataDir: string): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    if (!isProfileLocked(userDataDir))
      return false;
    await new Promise(f => setTimeout(f, 1000));
  }
  return true;
}

export function isProfileLocked(userDataDir: string): boolean {
  const lockFile = process.platform === 'win32' ? 'lockfile' : 'SingletonLock';
  const lockPath = path.join(userDataDir, lockFile);

  if (process.platform === 'win32') {
    try {
      const fd = fs.openSync(lockPath, 'r+');
      fs.closeSync(fd);
      return false;
    } catch (e: any) {
      return e.code !== 'ENOENT';
    }
  }

  try {
    const target = fs.readlinkSync(lockPath);
    const pid = parseInt(target.split('-').pop() || '', 10);
    if (isNaN(pid))
      return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function throwIfExecutableMissing(error: Error, config: FullConfig): void {
  // The "Executable doesn't exist" prefix is shared by all managed binaries
  // (browser, ffmpeg, winldd). Disambiguate by the path so the user is told
  // which dependency to install.
  if (!error.message.includes(`Executable doesn't exist`))
    return;
  const target = error.message.includes('ffmpeg') ? 'ffmpeg' : (config.browser.launchOptions?.channel ?? config.browser.browserName);
  const label = target === 'ffmpeg' ? 'FFmpeg' : `Browser "${target}"`;
  if (config.skillMode)
    throw new Error(`${label} is not installed. Run \`playwright-cli install-browser ${target}\` to install`);
  throw new Error(`${label} is not installed. Run \`npx @playwright/mcp install-browser ${target}\` to install`);
}
