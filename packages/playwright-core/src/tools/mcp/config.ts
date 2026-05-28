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

import fs from 'fs';
import path from 'path';
import os from 'os';

import dotenv from 'dotenv';
import { CDP_STEALTH_CLI_FEATURES, parseCdpStealthCLI } from '@isomorphic/cdpStealthCLIParser';
import { isSystemDirectory } from '@utils/fileUtils';
import { playwright } from '../../inprocess';
import { configFromIniFile } from './configIni';

import type * as playwrightTypes from '../../..';
import type { Config, ToolCapability } from './config.d';

async function fileExistsAsync(resolved: string) {
  try { return (await fs.promises.stat(resolved)).isFile(); } catch { return false; }
}

type ViewportSize = { width: number; height: number };

export type CLIOptions = {
  allowedHosts?: string[];
  allowedOrigins?: string[];
  allowUnrestrictedFileAccess?: boolean;
  blockedOrigins?: string[];
  blockServiceWorkers?: boolean;
  browser?: string;
  caps?: string[];
  cdpEndpoint?: string;
  cdpHeader?: Record<string, string>;
  cdpTimeout?: number;
  codegen?: 'typescript' | 'none';
  config?: string;
  consoleLevel?: 'error' | 'warning' | 'info' | 'debug';
  device?: string;
  endpoint?: string;
  extension?: boolean;
  executablePath?: string;
  grantPermissions?: string[];
  headless?: boolean;
  host?: string;
  humanizeInput?: boolean;
  ignoreHttpsErrors?: boolean;
  initScript?: string[];
  initPage?: string[];
  isolated?: boolean;
  imageResponses?: 'allow' | 'omit';
  sandbox?: boolean;
  outputDir?: string;
  port?: number;
  proxyBypass?: string;
  proxyServer?: string;
  remoteHeader?: Record<string, string>;
  saveSession?: boolean;
  secrets?: Record<string, string>;
  sharedBrowserContext?: boolean;
  snapshotMode?: 'full' | 'none';
  storageState?: string;
  testIdAttribute?: string;
  timeoutAction?: number;
  timeoutDownload?: number;
  timeoutNavigation?: number;
  userAgent?: string;
  userDataDir?: string;
  viewportSize?: ViewportSize;
  allowedTools?: string[];
  filterInternalUrls?: boolean;
  suppressFocus?: boolean;
  disableDownloads?: boolean;
  // Currently a no-op against upstream (which no longer auto-closes the browser
  // when the last tab closes). Accepted here so commander does not exit 1 on
  // downstream embedders (e.g., Sapoto's four agent runners pass this flag).
  // Not threaded into the returned Config — there is no consumer to wire it to.
  keepBrowserAlive?: boolean;
  // Legacy boolean alias. PRD #1045 / Tracer A2 retains it for one release
  // cycle; new callers should pass `cdpStealth` directly.
  stealth?: boolean;
  // PRD #1045 / Tracer A2 — decomposed CDP-stealth feature set. The CLI
  // surface `--cdp-stealth=<comma-list>` runs through
  // `parseCdpStealthCLI` (in `@isomorphic/cdpStealthCLIParser`) before
  // landing here, so by the time this field is set it is already a
  // validated `string[]` (or absent).
  cdpStealth?: string[];
  printCapture?: boolean;
  focusEmulation?: boolean;
};

const defaultConfig: MergedConfig = {
  browser: {
    launchOptions: {},
    contextOptions: {},
  },
  timeouts: {
    action: 5000,
    navigation: 60000,
    expect: 5000,
    download: 30000,
  },
};

type BrowserUserConfig = NonNullable<Config['browser']>;

export type MergedConfig = Config & {
  browser: BrowserUserConfig & {
    launchOptions: NonNullable<BrowserUserConfig['launchOptions']>;
    contextOptions: NonNullable<BrowserUserConfig['contextOptions']>;
  }
};

export type FullConfig = MergedConfig & {
  browser: MergedConfig['browser'] & {
    browserName: 'chromium' | 'firefox' | 'webkit';
  },
  skillMode?: boolean;
  configFile?: string;
};

export async function resolveConfig(config: Config): Promise<FullConfig> {
  const merged = mergeConfig(defaultConfig, config);
  const browser = await validateBrowserConfig(merged.browser);
  return { ...merged, browser };
}

export async function resolveCLIConfigForMCP(cliOptions: CLIOptions, env?: NodeJS.ProcessEnv): Promise<FullConfig> {
  const envOverrides = configFromEnv(env);
  const cliOverrides = configFromCLIOptions(cliOptions);
  const configFile = cliOverrides.configFile ?? envOverrides.configFile;
  const configInFile = await loadConfig(configFile);
  const configDir = configFile ? path.dirname(path.resolve(configFile)) : process.cwd();

  let result = defaultConfig;
  result = mergeConfig(result, resolveConfigPaths(configInFile, configDir));
  result = mergeConfig(result, resolveConfigPaths(envOverrides, process.cwd()));
  result = mergeConfig(result, resolveConfigPaths(cliOverrides, process.cwd()));

  // PRD #1045 / Tracer A2 — apply default-on semantics for `--focus-emulation`
  // AFTER the CLI/env/config merge. The CLI translator intentionally drops the
  // undefined case (so an unset CLI flag does not stomp env or config values
  // during merge); the price of that is that nothing fills in the spec-mandated
  // default unless we do it here. Only fill in the gap when the field is still
  // undefined post-merge — preserves explicit `off` (false) and any config-file
  // false, but turns the no-input case into true so BrowserOptions sees the
  // documented default instead of `!!undefined === false`.
  const launchOptions = result.browser.launchOptions as typeof result.browser.launchOptions & {
    focusEmulation?: boolean,
    cdpStealth?: string[],
  };
  if (launchOptions.focusEmulation === undefined)
    launchOptions.focusEmulation = true;

  // PRD #1045 / Tracer A2 — derive the top-level `config.stealth` from
  // `launchOptions.cdpStealth` during the A2→A5 transition. Background:
  //   - The legacy `--no-stealth` alias sets `config.stealth = false`.
  //   - The new `--cdp-stealth=` surface sets `launchOptions.cdpStealth = []`
  //     but leaves `config.stealth` untouched.
  //   - The init-script gate in tools/backend/context.ts defaults
  //     `stealth = (config.stealth !== false)`, which means
  //     `--cdp-stealth=` alone would leave the init script installed even
  //     though the user has decomposed the feature set to zero. Asymmetric.
  // Deriving `config.stealth` here makes the two CLI surfaces behaviorally
  // equivalent for the init-script gate: empty cdpStealth → stealth=false,
  // non-empty cdpStealth → stealth=true. Explicit `--stealth` (true) and
  // `--no-stealth` (false) at the CLI win, since they set `result.stealth`
  // before this fallback runs. A5 will eventually consume
  // focusEmulation directly and this derivation can shrink, but for the
  // transition it removes the dual-source foot-gun.
  if (result.stealth === undefined && launchOptions.cdpStealth !== undefined)
    result.stealth = launchOptions.cdpStealth.length > 0;

  const browser = await validateBrowserConfig(result.browser);
  if (browser.launchOptions.headless === undefined)
    browser.launchOptions.headless = os.platform() === 'linux' && !process.env.DISPLAY;

  validateOutputDir(result.outputDir);

  return { ...result, browser, configFile };
}

function validateOutputDir(outputDir: string | undefined) {
  if (!outputDir)
    return;
  if (isSystemDirectory(outputDir))
    throw new Error(`--output-dir cannot point to a system directory: ${path.resolve(outputDir)}.`);
}

export async function resolveCLIConfigForCLI(daemonProfilesDir: string, sessionName: string, options: any, env?: NodeJS.ProcessEnv): Promise<FullConfig> {
  const config = options.config ? path.resolve(options.config) : undefined;
  try {
    const defaultConfigFile = path.resolve('.playwright', 'cli.config.json');
    if (!config && fs.existsSync(defaultConfigFile))
      options.config = defaultConfigFile;
  } catch {
  }

  const daemonOverrides = configFromCLIOptions({
    endpoint: options.endpoint,
    cdpEndpoint: options.cdp,
    config: options.config,
    browser: options.browser,
    headless: options.headed ? false : undefined,
    extension: options.extension,
    userDataDir: options.profile,
    snapshotMode: 'full',
  });

  const envOverrides = configFromEnv(env);
  const configFile = daemonOverrides.configFile ?? envOverrides.configFile;
  const configInFile = await loadConfig(configFile);
  const configDir = configFile ? path.dirname(path.resolve(configFile)) : process.cwd();
  const globalConfigPath = path.join((env ?? process.env)['PWTEST_CLI_GLOBAL_CONFIG'] ?? os.homedir(), '.playwright', 'cli.config.json');
  const globalConfigExists = fs.existsSync(globalConfigPath);
  const globalConfigInFile = await loadConfig(globalConfigExists ? globalConfigPath : undefined);
  const globalConfigDir = globalConfigExists ? path.dirname(globalConfigPath) : process.cwd();

  let result = defaultConfig;
  result = mergeConfig(result, resolveConfigPaths(globalConfigInFile, globalConfigDir));
  result = mergeConfig(result, resolveConfigPaths(configInFile, configDir));
  result = mergeConfig(result, resolveConfigPaths(envOverrides, process.cwd()));
  result = mergeConfig(result, resolveConfigPaths(daemonOverrides, process.cwd()));

  if (result.browser.isolated === undefined)
    result.browser.isolated = !options.profile && !options.persistent && !result.browser.userDataDir && !result.browser.remoteEndpoint && !result.browser.cdpEndpoint && !result.extension;

  if (result.browser.launchOptions.headless === undefined)
    result.browser.launchOptions.headless = true;

  const browser = await validateBrowserConfig(result.browser);

  validateOutputDir(result.outputDir);

  if (!result.extension && !browser.isolated && !browser.userDataDir && !browser.remoteEndpoint && !browser.cdpEndpoint) {
    // No custom value provided, use the daemon data dir.
    const browserToken = browser.launchOptions?.channel ?? browser?.browserName;
    const userDataDir = path.resolve(daemonProfilesDir, `ud-${sessionName}-${browserToken}`);
    browser.userDataDir = userDataDir;
  }

  return { ...result, browser, configFile, skillMode: true };
}

export function resolveExtensionOptions(cliOptions: CLIOptions): { channel: string, executablePath?: string } {
  const browser = cliOptions.browser ?? envToString(process.env.PLAYWRIGHT_MCP_BROWSER);
  const { channel } = resolveBrowserParam(browser);
  const executablePath = cliOptions.executablePath ?? envToString(process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH);
  return { channel: channel ?? 'chrome', executablePath };
}

async function validateBrowserConfig(browser: MergedConfig['browser']): Promise<FullConfig['browser']> {
  let browserName = browser.browserName;
  if (!browserName) {
    browserName = 'chromium';
    // Assign channel only if the browserName is not provided, otherwise assume full control to the user.
    if (browser.launchOptions.channel === undefined)
      browser.launchOptions.channel = 'chrome';
  }

  if (browser.browserName === 'chromium' && browser.launchOptions.chromiumSandbox === undefined) {
    if (process.platform === 'linux')
      browser.launchOptions.chromiumSandbox = browser.launchOptions.channel !== 'chromium' && browser.launchOptions.channel !== 'chrome-for-testing';
    else
      browser.launchOptions.chromiumSandbox = true;
  }

  if (browser.isolated && browser.userDataDir)
    throw new Error('Browser userDataDir is not supported in isolated mode.');

  if (browser.initScript) {
    for (const script of browser.initScript) {
      if (!await fileExistsAsync(script))
        throw new Error(`Init script file does not exist: ${script}`);
    }
  }
  if (browser.initPage) {
    for (const page of browser.initPage) {
      if (!await fileExistsAsync(page))
        throw new Error(`Init page file does not exist: ${page}`);
    }
  }
  if (browser.contextOptions.viewport === undefined) {
    if (browser.launchOptions.headless)
      browser.contextOptions.viewport = { width: 1280, height: 720 };
    else
      browser.contextOptions.viewport = null;
  }

  if (browserName === 'chromium') {
    browser.launchOptions.args = browser.launchOptions.args ?? [];
    if (!browser.launchOptions.args.some(a => a.includes('--disable-blink-features')))
      browser.launchOptions.args.push(`--disable-blink-features=AutomationControlled`);
  }

  return { ...browser, browserName };
}

function resolveBrowserParam(browserOption: string | undefined): { browserName?: 'chromium' | 'firefox' | 'webkit', channel?: string } {
  switch (browserOption) {
    case 'chrome':
    case 'chrome-beta':
    case 'chrome-canary':
    case 'chrome-dev':
    case 'msedge':
    case 'msedge-beta':
    case 'msedge-canary':
    case 'msedge-dev':
      return { browserName: 'chromium', channel: browserOption };
    case 'chromium':
      return { browserName: 'chromium', channel: 'chrome-for-testing' };
    case 'firefox':
      return { browserName: 'firefox' };
    case 'webkit':
      return { browserName: 'webkit' };
    default:
      return {};
  }
}

function configFromCLIOptions(cliOptions: CLIOptions): Config & { configFile?: string } {
  const { browserName, channel } = resolveBrowserParam(cliOptions.browser);

  // Launch options. Extend the public LaunchOptions surface with the fork-internal
  // humanizeInput / cdpStealth feature-set flags — they're plumbed through the
  // channel & server but not yet part of the published types.
  //
  // PRD #1045 / Tracer A2: `stealthMode: boolean` is gone from the launchOptions
  // wire. The legacy `--stealth` / `--no-stealth` CLI aliases are translated to
  // `cdpStealth: string[]` HERE (see resolveStealthAlias below) so the server
  // side only ever sees the new shape. The validator on
  // `BrowserTypeLaunchParams` accepts cdpStealth/printCapture/focusEmulation,
  // so they flow through as long as we put them on launchOptions.
  type ForkLaunchOptions = playwrightTypes.LaunchOptions & {
    humanizeInput?: boolean;
    cdpStealth?: string[];
    printCapture?: boolean;
    focusEmulation?: boolean;
  };
  const launchOptions: ForkLaunchOptions = {
    channel,
    executablePath: cliOptions.executablePath,
    headless: cliOptions.headless,
  };

  // --sandbox was passed, enable the sandbox
  // --no-sandbox was passed, disable the sandbox
  if (cliOptions.sandbox !== undefined)
    launchOptions.chromiumSandbox = cliOptions.sandbox;

  // --humanize-input on => true, off => false. Emit whenever defined so an
  // explicit `off` can override an env/config-file `true` during merge; the
  // prior truthy-only branch silently dropped the off case.
  if (cliOptions.humanizeInput !== undefined)
    launchOptions.humanizeInput = cliOptions.humanizeInput;

  // PRD #1045 / Tracer A2 — CDP stealth feature set.
  //
  // Two input forms reach this point:
  //   1. `cliOptions.cdpStealth: string[] | undefined` — the new decomposed
  //      surface. Already parsed/validated by `parseCdpStealthCLI` at the
  //      commander layer (or by the env-var path below), so we forward as-is.
  //   2. `cliOptions.stealth: boolean | undefined` — the legacy alias kept
  //      for one release cycle. `true` expands to the canonical 3-feature
  //      bundle, `false` collapses to the empty array.
  //
  // Precedence (mirrors `@isomorphic/cdpStealthAlias.resolveCdpStealthAlias`):
  // explicit `cdpStealth` wins over legacy `stealth`. Both undefined → no
  // emit (pickDefined drops it during merge, so env / config-file values
  // survive). This matters because the CLI is the highest-precedence layer;
  // re-asserting an empty value would stomp lower-precedence config.
  const cdpStealthFromCLI = resolveStealthAlias(cliOptions);
  if (cdpStealthFromCLI !== undefined)
    launchOptions.cdpStealth = cdpStealthFromCLI;

  // PRD #1045 / Tracer A2 — decomposed booleans. Same emit-when-defined
  // pattern as cdpStealth above so an unset CLI flag doesn't stomp env /
  // config-file values during merge.
  if (cliOptions.printCapture !== undefined)
    launchOptions.printCapture = cliOptions.printCapture;
  if (cliOptions.focusEmulation !== undefined)
    launchOptions.focusEmulation = cliOptions.focusEmulation;

  if (cliOptions.device && cliOptions.cdpEndpoint)
    throw new Error('Device emulation is not supported with cdpEndpoint.');

  // Context options
  const contextOptions: playwrightTypes.BrowserContextOptions = cliOptions.device ? playwright.devices[cliOptions.device] : {};

  if (cliOptions.proxyServer) {
    const proxy: playwrightTypes.LaunchOptions['proxy'] = { server: cliOptions.proxyServer };
    if (cliOptions.proxyBypass)
      proxy.bypass = cliOptions.proxyBypass;
    // Set on both to ensure CLI takes precedence over any proxy set in the config file
    // (launchOptions.proxy applies at browser launch, contextOptions.proxy at context creation).
    launchOptions.proxy = proxy;
    contextOptions.proxy = proxy;
  }

  if (cliOptions.storageState)
    contextOptions.storageState = cliOptions.storageState;

  if (cliOptions.userAgent)
    contextOptions.userAgent = cliOptions.userAgent;

  if (cliOptions.viewportSize)
    contextOptions.viewport = cliOptions.viewportSize;

  if (cliOptions.ignoreHttpsErrors)
    contextOptions.ignoreHTTPSErrors = true;

  if (cliOptions.blockServiceWorkers)
    contextOptions.serviceWorkers = 'block';

  if (cliOptions.grantPermissions)
    contextOptions.permissions = cliOptions.grantPermissions;

  const config: Config = {
    browser: {
      browserName,
      isolated: cliOptions.isolated,
      userDataDir: cliOptions.userDataDir,
      launchOptions,
      contextOptions,
      cdpEndpoint: cliOptions.cdpEndpoint,
      cdpHeaders: cliOptions.cdpHeader,
      cdpTimeout: cliOptions.cdpTimeout,
      initPage: cliOptions.initPage,
      initScript: cliOptions.initScript,
      remoteEndpoint: cliOptions.endpoint,
      remoteHeaders: cliOptions.remoteHeader,
    },
    extension: cliOptions.extension,
    server: {
      port: cliOptions.port,
      host: cliOptions.host,
      allowedHosts: cliOptions.allowedHosts,
    },
    capabilities: cliOptions.caps as ToolCapability[],
    console: {
      level: cliOptions.consoleLevel,
    },
    network: {
      allowedOrigins: cliOptions.allowedOrigins,
      blockedOrigins: cliOptions.blockedOrigins,
    },
    allowUnrestrictedFileAccess: cliOptions.allowUnrestrictedFileAccess,
    codegen: cliOptions.codegen,
    saveSession: cliOptions.saveSession,
    secrets: cliOptions.secrets,
    sharedBrowserContext: cliOptions.sharedBrowserContext,
    snapshot: cliOptions.snapshotMode ? { mode: cliOptions.snapshotMode } : undefined,
    outputDir: cliOptions.outputDir,
    imageResponses: cliOptions.imageResponses,
    testIdAttribute: cliOptions.testIdAttribute,
    timeouts: {
      action: cliOptions.timeoutAction,
      navigation: cliOptions.timeoutNavigation,
      download: cliOptions.timeoutDownload,
    },
    allowedTools: cliOptions.allowedTools,
    filterInternalUrls: cliOptions.filterInternalUrls,
    suppressFocus: cliOptions.suppressFocus,
    disableDownloads: cliOptions.disableDownloads,
    // Accepted-but-currently-unconsumed: upstream removed the auto-close path
    // this flag gated, so it's a no-op today. Threaded through configFromCLIOptions
    // so downstream embedders (Sapoto) can pass --keep-browser-alive without
    // commander crashing the MCP child. pickDefined() drops the undefined case.
    keepBrowserAlive: cliOptions.keepBrowserAlive,
    // PRD #1045 / Tracer A2 — legacy boolean alias kept for one release cycle.
    // The decomposed surface is `cdpStealth`/`printCapture`/`focusEmulation`
    // on `launchOptions` above; those three are the new model.
    // `config.stealth` is now derived from `launchOptions.cdpStealth.length > 0`
    // in `resolveCLIConfigForMCP` (post-merge) when undefined, so the
    // `--no-stealth` and `--cdp-stealth=` CLI surfaces are behaviorally
    // equivalent for the init-script gate in tools/backend/context.ts during
    // the A2→A5 transition. The pass-through below preserves explicit user
    // input (true/false) and lets undefined fall through to the derivation.
    stealth: cliOptions.stealth,
  };

  return { ...config, configFile: cliOptions.config };
}

export function configFromEnv(env?: NodeJS.ProcessEnv): Config & { configFile?: string } {
  const e = env ?? process.env;
  const options: CLIOptions = {};
  options.allowedHosts = commaSeparatedList(e.PLAYWRIGHT_MCP_ALLOWED_HOSTS);
  options.allowedOrigins = semicolonSeparatedList(e.PLAYWRIGHT_MCP_ALLOWED_ORIGINS);
  options.allowUnrestrictedFileAccess = envToBoolean(e.PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS);
  options.blockedOrigins = semicolonSeparatedList(e.PLAYWRIGHT_MCP_BLOCKED_ORIGINS);
  options.blockServiceWorkers = envToBoolean(e.PLAYWRIGHT_MCP_BLOCK_SERVICE_WORKERS);
  options.browser = envToString(e.PLAYWRIGHT_MCP_BROWSER);
  options.caps = commaSeparatedList(e.PLAYWRIGHT_MCP_CAPS);
  options.cdpEndpoint = envToString(e.PLAYWRIGHT_MCP_CDP_ENDPOINT);
  options.cdpHeader = headerParser(envToString(e.PLAYWRIGHT_MCP_CDP_HEADERS));
  options.cdpTimeout = numberParser(e.PLAYWRIGHT_MCP_CDP_TIMEOUT);
  options.config = envToString(e.PLAYWRIGHT_MCP_CONFIG);
  if (e.PLAYWRIGHT_MCP_CONSOLE_LEVEL)
    options.consoleLevel = enumParser<'error' | 'warning' | 'info' | 'debug'>('--console-level', ['error', 'warning', 'info', 'debug'], e.PLAYWRIGHT_MCP_CONSOLE_LEVEL);
  options.device = envToString(e.PLAYWRIGHT_MCP_DEVICE);
  options.executablePath = envToString(e.PLAYWRIGHT_MCP_EXECUTABLE_PATH);
  options.extension = envToBoolean(e.PLAYWRIGHT_MCP_EXTENSION);
  options.grantPermissions = commaSeparatedList(e.PLAYWRIGHT_MCP_GRANT_PERMISSIONS);
  options.headless = envToBoolean(e.PLAYWRIGHT_MCP_HEADLESS);
  options.host = envToString(e.PLAYWRIGHT_MCP_HOST);
  options.humanizeInput = envToBoolean(e.PLAYWRIGHT_MCP_HUMANIZE_INPUT);
  options.ignoreHttpsErrors = envToBoolean(e.PLAYWRIGHT_MCP_IGNORE_HTTPS_ERRORS);
  const initPage = envToString(e.PLAYWRIGHT_MCP_INIT_PAGE);
  if (initPage)
    options.initPage = [initPage];
  const initScript = envToString(e.PLAYWRIGHT_MCP_INIT_SCRIPT);
  if (initScript)
    options.initScript = [initScript];
  options.isolated = envToBoolean(e.PLAYWRIGHT_MCP_ISOLATED);
  if (e.PLAYWRIGHT_MCP_IMAGE_RESPONSES)
    options.imageResponses = enumParser<'allow' | 'omit'>('--image-responses', ['allow', 'omit'], e.PLAYWRIGHT_MCP_IMAGE_RESPONSES);
  options.sandbox = envToBoolean(e.PLAYWRIGHT_MCP_SANDBOX);
  options.outputDir = envToString(e.PLAYWRIGHT_MCP_OUTPUT_DIR);
  options.port = numberParser(e.PLAYWRIGHT_MCP_PORT);
  options.proxyBypass = envToString(e.PLAYWRIGHT_MCP_PROXY_BYPASS);
  options.proxyServer = envToString(e.PLAYWRIGHT_MCP_PROXY_SERVER);
  options.remoteHeader = headerParser(envToString(e.PLAYWRIGHT_MCP_REMOTE_HEADERS));
  options.secrets = dotenvFileLoader(e.PLAYWRIGHT_MCP_SECRETS_FILE);
  options.storageState = envToString(e.PLAYWRIGHT_MCP_STORAGE_STATE);
  options.testIdAttribute = envToString(e.PLAYWRIGHT_MCP_TEST_ID_ATTRIBUTE);
  options.timeoutAction = numberParser(e.PLAYWRIGHT_MCP_TIMEOUT_ACTION);
  options.timeoutDownload = numberParser(e.PLAYWRIGHT_MCP_TIMEOUT_DOWNLOAD);
  options.timeoutNavigation = numberParser(e.PLAYWRIGHT_MCP_TIMEOUT_NAVIGATION);
  options.userAgent = envToString(e.PLAYWRIGHT_MCP_USER_AGENT);
  options.userDataDir = envToString(e.PLAYWRIGHT_MCP_USER_DATA_DIR);
  options.viewportSize = resolutionParser('--viewport-size', e.PLAYWRIGHT_MCP_VIEWPORT_SIZE);
  options.allowedTools = commaSeparatedList(e.PLAYWRIGHT_MCP_ALLOWED_TOOLS);
  options.filterInternalUrls = envToBoolean(e.PLAYWRIGHT_MCP_FILTER_INTERNAL_URLS);
  options.suppressFocus = envToBoolean(e.PLAYWRIGHT_MCP_SUPPRESS_FOCUS);
  options.disableDownloads = envToBoolean(e.PLAYWRIGHT_MCP_DISABLE_DOWNLOADS);
  options.keepBrowserAlive = envToBoolean(e.PLAYWRIGHT_MCP_KEEP_BROWSER_ALIVE);
  // PLAYWRIGHT_MCP_STEALTH=0 / false disables CDP stealth mode (default on).
  // Legacy boolean alias — PRD #1045 / Tracer A2 retains it for one release
  // cycle. The new decomposed surface is PLAYWRIGHT_MCP_CDP_STEALTH below.
  if (e.PLAYWRIGHT_MCP_STEALTH !== undefined)
    options.stealth = envToBoolean(e.PLAYWRIGHT_MCP_STEALTH);
  // PRD #1045 / Tracer A2 — env-var equivalents for the new flag surface.
  // PLAYWRIGHT_MCP_CDP_STEALTH accepts the same comma-list / "all" / empty
  // forms as --cdp-stealth on the CLI. Explicit cdpStealth wins over the
  // legacy stealth alias (resolveStealthAlias enforces precedence).
  if (e.PLAYWRIGHT_MCP_CDP_STEALTH !== undefined)
    options.cdpStealth = parseCdpStealthCLI(e.PLAYWRIGHT_MCP_CDP_STEALTH);
  if (e.PLAYWRIGHT_MCP_PRINT_CAPTURE !== undefined)
    options.printCapture = envToBoolean(e.PLAYWRIGHT_MCP_PRINT_CAPTURE);
  if (e.PLAYWRIGHT_MCP_FOCUS_EMULATION !== undefined)
    options.focusEmulation = envToBoolean(e.PLAYWRIGHT_MCP_FOCUS_EMULATION);
  return configFromCLIOptions(options);
}

export async function loadConfig(configFile: string | undefined): Promise<Config> {
  if (!configFile)
    return {};

  if (configFile.endsWith('.ini'))
    return configFromIniFile(configFile);

  try {
    const data = await fs.promises.readFile(configFile, 'utf8');
    return JSON.parse(data.charCodeAt(0) === 0xFEFF ? data.slice(1) : data);
  } catch {
    return configFromIniFile(configFile);
  }
}

// initPage/initScript paths are resolved against a per-source base dir
// (config-file dir for entries loaded from a --config file, cwd for entries
// supplied via CLI flags or PLAYWRIGHT_MCP_INIT_* env vars) so they keep
// working when the CLI is invoked from a different cwd.
function resolveConfigPaths(config: Config, baseDir: string): Config {
  if (config.browser?.initPage)
    config.browser.initPage = config.browser.initPage.map(p => path.resolve(baseDir, p));
  if (config.browser?.initScript)
    config.browser.initScript = config.browser.initScript.map(p => path.resolve(baseDir, p));
  return config;
}

function pickDefined<T extends object>(obj: T | undefined): Partial<T> {
  return Object.fromEntries(
      Object.entries(obj ?? {}).filter(([_, v]) => v !== undefined)
  ) as Partial<T>;
}

function mergeConfig(base: MergedConfig, overrides: Config): MergedConfig {
  const browser: Config['browser'] = {
    ...pickDefined(base.browser),
    ...pickDefined(overrides.browser),
    browserName: overrides.browser?.browserName ?? base.browser?.browserName,
    isolated: overrides.browser?.isolated ?? base.browser?.isolated,
    launchOptions: {
      ...pickDefined(base.browser?.launchOptions),
      ...pickDefined(overrides.browser?.launchOptions),
    },
    contextOptions: {
      ...pickDefined(base.browser?.contextOptions),
      ...pickDefined(overrides.browser?.contextOptions),
    },
  };

  if (browser.browserName !== 'chromium' && browser.launchOptions)
    delete browser.launchOptions.channel;

  return {
    ...pickDefined(base),
    ...pickDefined(overrides),
    browser,
    console: {
      ...pickDefined(base.console),
      ...pickDefined(overrides.console),
    },
    network: {
      ...pickDefined(base.network),
      ...pickDefined(overrides.network),
    },
    server: {
      ...pickDefined(base.server),
      ...pickDefined(overrides.server),
    },
    snapshot: {
      ...pickDefined(base.snapshot),
      ...pickDefined(overrides.snapshot),
    },
    timeouts: {
      ...pickDefined(base.timeouts),
      ...pickDefined(overrides.timeouts),
    },
  } as FullConfig;
}

export function semicolonSeparatedList(value: string | undefined): string[] | undefined {
  if (!value)
    return undefined;
  return value.split(';').map(v => v.trim());
}

export function commaSeparatedList(value: string | undefined): string[] | undefined {
  if (!value)
    return undefined;
  return value.split(',').map(v => v.trim());
}

export function dotenvFileLoader(value: string | undefined): Record<string, string> | undefined {
  if (!value)
    return undefined;
  return dotenv.parse(fs.readFileSync(value, 'utf8'));
}

export function numberParser(value: string | undefined): number | undefined {
  if (!value)
    return undefined;
  return +value;
}

export function resolutionParser(name: string, value: string | undefined): ViewportSize | undefined {
  if (!value)
    return undefined;
  if (value.includes('x')) {
    const [width, height] = value.split('x').map(v => +v);
    if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0)
      throw new Error(`Invalid resolution format: use ${name}="800x600"`);
    return { width, height };
  }

  // Legacy format
  if (value.includes(',')) {
    const [width, height] = value.split(',').map(v => +v);
    if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0)
      throw new Error(`Invalid resolution format: use ${name}="800x600"`);
    return { width, height };
  }

  throw new Error(`Invalid resolution format: use ${name}="800x600"`);
}

export function headerParser(arg: string | undefined, previous?: Record<string, string>): Record<string, string> | undefined {
  if (!arg)
    return previous;
  const result: Record<string, string> = { ...(previous ?? {}) };
  const colonIndex = arg.indexOf(':');

  const name = colonIndex === -1 ? arg.trim() : arg.substring(0, colonIndex).trim();
  const value = colonIndex === -1 ? '' : arg.substring(colonIndex + 1).trim();
  result[name] = value;
  return result;
}

export function enumParser<T extends string>(name: string, options: T[], value: string): T {
  if (!options.includes(value as T))
    throw new Error(`Invalid ${name}: ${value}. Valid values are: ${options.join(', ')}`);
  return value as T;
}

function envToBoolean(value: string | undefined): boolean | undefined {
  if (value === 'true' || value === '1')
    return true;
  if (value === 'false' || value === '0')
    return false;
  return undefined;
}

function envToString(value: string | undefined): string | undefined {
  return value ? value.trim() : undefined;
}

/**
 * PRD #1045 / Tracer A2 — translate the CLI-level cdpStealth + legacy stealth
 * inputs into the wire-format `string[]`.
 *
 * Precedence (mirrors @isomorphic/cdpStealthAlias.resolveCdpStealthAlias):
 *   - explicit `cdpStealth` (already validated by parseCdpStealthCLI / env
 *     parser) wins as-is. Empty array survives.
 *   - legacy `stealth: true`  → full 3-feature bundle.
 *   - legacy `stealth: false` → empty array (explicit opt-out).
 *   - both undefined → undefined (no emit; pickDefined drops it during merge).
 */
function resolveStealthAlias(cliOptions: CLIOptions): string[] | undefined {
  if (cliOptions.cdpStealth !== undefined)
    return [...cliOptions.cdpStealth];
  if (cliOptions.stealth === true)
    return [...CDP_STEALTH_CLI_FEATURES];
  if (cliOptions.stealth === false)
    return [];
  return undefined;
}
