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
import os from 'os';
import path from 'path';

import debug from 'debug';
import { escapeWithQuotes } from '@isomorphic/stringUtils';
import { disposeAll } from '@isomorphic/disposable';
import { eventsHelper } from '@utils/eventsHelper';
import { isPathInside, isSystemDirectory, isWritable } from '@utils/fileUtils';
import { playwright } from '../../inprocess';

import { Tab } from './tab';
import { buildStealthInitScript } from './stealthInitScript';

import type * as playwrightTypes from '../../..';
import type { SessionLog } from './sessionLog';
import type { Disposable } from '@isomorphic/disposable';
import type { ToolCapability } from './tool';

const testDebug = debug('pw:mcp:test');

export type ContextConfig = {
  allowUnrestrictedFileAccess?: boolean;
  allowedTools?: string[];
  capabilities?: ToolCapability[];
  codegen?: 'typescript' | 'none';
  console?: { level?: 'error' | 'warning' | 'info' | 'debug' };
  disableDownloads?: boolean;
  filterInternalUrls?: boolean;
  imageResponses?: 'allow' | 'omit';
  network?: {
    allowedOrigins?: string[];
    blockedOrigins?: string[];
  };
  outputDir?: string;
  outputMode?: 'file' | 'stdout';
  saveSession?: boolean;
  saveTrace?: boolean;
  secrets?: Record<string, string>;
  snapshot?: {
    mode?: 'full' | 'none';
  };
  suppressFocus?: boolean;
  /**
   * CDP stealth mode. Defaults to true (set explicitly to false to disable).
   * Drives renderer-side init scripts that mask common automation tells.
   * Core-side CDP-domain minimization is no longer a single bundled behavior —
   * PRD #1045 decomposed it into the per-feature `cdpStealth` set (`log-skip`,
   * `runtime-cycle`, `worker-runtime`; see packages/playwright-core/src/server/cdpStealth.ts
   * and chromium/cdpStealthGates.ts). This boolean controls only the renderer
   * init-script bundle today.
   * Disabled in extension mode (the content-script delivery path patches the page
   * instead) and skipped when an embedder owns the page via cdpEndpoint without
   * launchOptions.stealthMode.
   */
  stealth?: boolean;
  testIdAttribute?: string;
  timeouts?: {
    action?: number;
    download?: number;
    navigation?: number;
    expect?: number;
  };
  browser?: {
    initScript?: string[];
    initPage?: string[];
  };
  skillMode?: boolean;
};

type ContextOptions = {
  config: ContextConfig;
  sessionLog?: SessionLog;
  cwd: string;
};

export type RouteEntry = {
  pattern: string;
  status?: number;
  body?: string;
  contentType?: string;
  addHeaders?: Record<string, string>;
  removeHeaders?: string[];
  handler: (route: playwrightTypes.Route) => Promise<void>;
};

export type FilenameTemplate = {
  prefix: string;
  ext: string;
  suggestedFilename?: string;
  date?: Date;
};

type VideoParams = { size?: { width: number; height: number } };

export class Context {
  readonly config: ContextConfig;
  readonly sessionLog: SessionLog | undefined;
  readonly options: ContextOptions;
  private _rawBrowserContext: playwrightTypes.BrowserContext;
  private _browserContextPromise: Promise<playwrightTypes.BrowserContext> | undefined;
  private _tabs: Tab[] = [];
  private _currentTab: Tab | undefined;
  private _routes: RouteEntry[] = [];
  private _video: {
    params: VideoParams;
    fileNames: string[];
    fileName: string;
  } | undefined;
  private _disposables: Disposable[] = [];

  private _runningToolName: string | undefined;
  private _pendingUnhandledRejections: unknown[] = [];
  private _unhandledRejectionListeners = new Set<(reason: unknown) => void>();
  private _onUnhandledRejection = (reason: unknown) => {
    this._pendingUnhandledRejections.push(reason);
    for (const listener of this._unhandledRejectionListeners)
      listener(reason);
  };

  constructor(browserContext: playwrightTypes.BrowserContext, options: ContextOptions) {
    this.config = options.config;
    this.sessionLog = options.sessionLog;
    this.options = options;
    this._rawBrowserContext = browserContext;
    testDebug('create context');
    process.on('unhandledRejection', this._onUnhandledRejection);
  }

  async dispose() {
    process.off('unhandledRejection', this._onUnhandledRejection);
    await disposeAll(this._disposables);
    for (const tab of this._tabs)
      await tab.dispose();
    this._tabs.length = 0;
    this._currentTab = undefined;
    await this.stopVideoRecording();
  }

  drainPendingUnhandledRejections(): unknown[] {
    const reasons = this._pendingUnhandledRejections.slice();
    this._pendingUnhandledRejections.length = 0;
    return reasons;
  }

  onUnhandledRejection(listener: (reason: unknown) => void): () => void {
    this._unhandledRejectionListeners.add(listener);
    return () => this._unhandledRejectionListeners.delete(listener);
  }

  debugger() {
    return this._rawBrowserContext.debugger;
  }

  tabs(): Tab[] {
    return this._tabs;
  }

  currentTab(): Tab | undefined {
    return this._currentTab;
  }

  currentTabOrDie(): Tab {
    if (!this._currentTab)
      throw new Error('No open pages available.');
    return this._currentTab;
  }

  async newTab(): Promise<Tab> {
    const browserContext = await this.ensureBrowserContext();
    const page = await browserContext.newPage();
    this._currentTab = this._tabs.find(t => t.page === page)!;
    return this._currentTab;
  }

  async selectTab(index: number) {
    const tab = this._tabs[index];
    if (!tab)
      throw new Error(`Tab ${index} not found`);
    if (!this.config.suppressFocus)
      await tab.page.bringToFront();
    this._currentTab = tab;
    return tab;
  }

  async ensureTab(): Promise<Tab> {
    await this.ensureBrowserContext();
    const crashed = this._currentTab?.crashed;
    if (crashed) {
      await this._currentTab!.page.close().catch(() => {});
      this._currentTab = undefined;
    }
    if (!this._currentTab)
      await this.newTab();
    if (crashed)
      this._currentTab!.logErrorMessage('Page crashed and was reset to about:blank.');
    return this._currentTab!;
  }

  async closeTab(index: number | undefined): Promise<string> {
    const tab = index === undefined ? this._currentTab : this._tabs[index];
    if (!tab)
      throw new Error(`Tab ${index} not found`);
    const url = tab.page.url();
    await tab.page.close();
    return url;
  }

  async workspaceFile(fileName: string, perCallWorkspaceDir: string | undefined): Promise<string> {
    return await workspaceFile(this.options, fileName, perCallWorkspaceDir);
  }

  async outputFile(template: FilenameTemplate, options: { origin: 'code' | 'llm' }): Promise<string> {
    const baseName = template.suggestedFilename || `${template.prefix}-${(template.date ?? new Date()).toISOString().replace(/[:.]/g, '-')}${template.ext ? '.' + template.ext : ''}`;
    return await outputFile(this.options, baseName, options);
  }

  async startVideoRecording(fileName: string, params: VideoParams) {
    if (this._video)
      throw new Error('Video recording has already been started.');
    this._video = { params, fileName, fileNames: [] };
    const browserContext = await this.ensureBrowserContext();
    for (const page of browserContext.pages())
      await this._startPageVideo(page);
  }

  async stopVideoRecording(): Promise<string[]> {
    if (!this._video)
      return [];
    const video = this._video;
    for (const page of this._rawBrowserContext.pages())
      await page.screencast.stop();
    this._video = undefined;
    return [...video.fileNames];
  }

  private async _startPageVideo(page: playwrightTypes.Page) {
    if (!this._video)
      return;
    const suffix = this._video.fileNames.length ? `-${this._video.fileNames.length}` : '';
    let fileName = this._video.fileName;
    if (fileName && suffix) {
      const ext = path.extname(fileName);
      fileName = path.basename(fileName, ext) + suffix + ext;
    }
    this._video.fileNames.push(fileName);
    await page.screencast.start({ path: fileName, ...this._video.params });
  }

  private _onPageCreated(page: playwrightTypes.Page) {
    const tab = new Tab(this, page, tab => this._onPageClosed(tab));
    this._tabs.push(tab);
    if (!this._currentTab)
      this._currentTab = tab;
    this._startPageVideo(page).catch(() => {});
  }

  /**
   * Sapoto Architecture A: the backgroundOpenBridge in the Sapoto Electron
   * app spawns hidden CDP targets via Target.createTarget({background:true})
   * to capture popup-PDF downloads without focus theft. Those targets ARE
   * real pages in the BrowserContext, so without this filter they leak into
   * `browser_tabs` and the agent interacts with them as if they were normal
   * tabs. The bridge creates each hidden target with `about:blank#__sapoto_bg=...`
   * so we can recognise it here, BEFORE the bridge's subsequent Page.navigate
   * replaces the URL with the real download URL. The 'page' event fires
   * synchronously when the page is added to the BrowserContext, with the
   * URL still set to the value passed to Target.createTarget — so reading
   * page.url() at listener entry sees the marker even though it changes
   * later.
   *
   * Refs: Sapoto-Health/automatic-document-fetcher#1083 (perception leak)
   * Refs: Sapoto-Health/automatic-document-fetcher#1044 (Arch A bridge)
   */
  private _isSapotoBackgroundTarget(url: string): boolean {
    return url.startsWith('about:blank#__sapoto_bg=');
  }

  /**
   * Check if a URL is an internal Electron application URL that should
   * be hidden from agents. Matches: file://, data:, chrome-extension://,
   * localhost, 127.0.0.1. Only consulted when `filterInternalUrls` is set.
   */
  private _isInternalUrl(url: string): boolean {
    if (url.startsWith('file://'))
      return true;
    if (url.startsWith('data:'))
      return true;
    if (url.startsWith('chrome-extension://'))
      return true;
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
        return true;
    } catch {
      // invalid URL — not internal
    }
    return false;
  }

  private _onPageClosed(tab: Tab) {
    const index = this._tabs.indexOf(tab);
    if (index === -1)
      return;
    this._tabs.splice(index, 1);

    if (this._currentTab === tab)
      this._currentTab = this._tabs[Math.min(index, this._tabs.length - 1)];
  }

  routes(): RouteEntry[] {
    return this._routes;
  }

  async addRoute(entry: RouteEntry): Promise<void> {
    const browserContext = await this.ensureBrowserContext();
    await browserContext.route(entry.pattern, entry.handler);
    this._routes.push(entry);
  }

  async removeRoute(pattern?: string): Promise<number> {
    let removed = 0;
    const browserContext = await this.ensureBrowserContext();
    if (pattern) {
      const toRemove = this._routes.filter(r => r.pattern === pattern);
      for (const route of toRemove)
        await browserContext.unroute(route.pattern, route.handler);
      this._routes = this._routes.filter(r => r.pattern !== pattern);
      removed = toRemove.length;
    } else {
      for (const route of this._routes)
        await browserContext.unroute(route.pattern, route.handler);
      removed = this._routes.length;
      this._routes = [];
    }
    return removed;
  }

  isRunningTool() {
    return this._runningToolName !== undefined;
  }

  setRunningTool(name: string | undefined) {
    this._runningToolName = name;
  }

  private async _setupRequestInterception(context: playwrightTypes.BrowserContext) {
    if (this.config.network?.allowedOrigins?.length) {
      this._disposables.push(await context.route('**', route => route.abort('blockedbyclient')));

      for (const origin of this.config.network.allowedOrigins) {
        const glob = originOrHostGlob(origin);
        this._disposables.push(await context.route(glob, route => route.continue()));
      }
    }

    if (this.config.network?.blockedOrigins?.length) {
      for (const origin of this.config.network.blockedOrigins)
        this._disposables.push(await context.route(originOrHostGlob(origin), route => route.abort('blockedbyclient')));
    }
  }

  async ensureBrowserContext(): Promise<playwrightTypes.BrowserContext> {
    if (this._browserContextPromise)
      return this._browserContextPromise;
    this._browserContextPromise = this._initializeBrowserContext();
    return this._browserContextPromise;
  }

  private async _initializeBrowserContext() {
    if (this.config.testIdAttribute)
      playwright.selectors.setTestIdAttribute(this.config.testIdAttribute);
    const browserContext = this._rawBrowserContext;
    await this._setupRequestInterception(browserContext);

    if (this.config.saveTrace) {
      await browserContext.tracing.start({
        name: 'trace-' + Date.now(),
        screenshots: true,
        snapshots: true,
        live: true,
      });
      this._disposables.push({
        dispose: async () => {
          await browserContext.tracing.stop();
        },
      });
    }
    for (const initScript of this.config.browser?.initScript || [])
      this._disposables.push(await browserContext.addInitScript({ path: path.resolve(this.options.cwd, initScript) }));

    // CDP stealth init script. The two gates are independent:
    //   - stealth (default ON; --no-stealth opts out) → C1/C2 fingerprint stubs.
    //     Sapoto's chrome mode passes --no-stealth because chrome's real
    //     identity must not be shadowed by stubs.
    //   - suppressFocus (off by default; --suppress-focus opts in) → C3 deferred
    //     print + Path D srcdoc bridge, C4 suppressFocus-mode print override,
    //     C5 window.open focus-steal shim (Sapoto #1036, refactor #1043).
    //     Sapoto's chrome mode enables this even when --no-stealth is set.
    // See stealthInitScript.ts for the per-stub rationale and the third-party-
    // frame guard backstory (Sapoto #1036). If both gates are off, skip the
    // addInitScript entirely — there's nothing to install.
    const stealth = this.config.stealth !== false;
    const suppressFocus = !!this.config.suppressFocus;
    if (stealth || suppressFocus) {
      this._disposables.push(await browserContext.addInitScript(
          buildStealthInitScript({ stealth, suppressFocus })));
    }

    for (const page of browserContext.pages()) {
      const url = page.url();
      if (this._isSapotoBackgroundTarget(url))
        continue;
      if (this.config.filterInternalUrls && this._isInternalUrl(url))
        continue;
      this._onPageCreated(page);
    }
    this._disposables.push(eventsHelper.addEventListener(browserContext, 'page', page => {
      const url = page.url();
      if (this._isSapotoBackgroundTarget(url))
        return;
      if (this.config.filterInternalUrls && this._isInternalUrl(url))
        return;
      this._onPageCreated(page);
    }));

    return browserContext;
  }

  checkUrlAllowed(url: string) {
    if (this.config.allowUnrestrictedFileAccess)
      return;
    if (!URL.canParse(url))
      return;
    if (new URL(url).protocol === 'file:')
      throw new Error(`Access to "file:" protocol is blocked. Attempted URL: "${url}"`);
  }

  lookupSecret(secretName: string): { value: string, code: string } {
    if (!this.config.secrets?.[secretName])
      return { value: secretName, code: escapeWithQuotes(secretName, '\'') };
    return {
      value: this.config.secrets[secretName]!,
      code: `process.env['${secretName}']`,
    };
  }
}

function originOrHostGlob(originOrHost: string) {
  // Support wildcard port patterns like "http://localhost:*" or "https://example.com:*"
  const wildcardPortMatch = originOrHost.match(/^(https?:\/\/[^/:]+):\*$/);
  if (wildcardPortMatch)
    return `${wildcardPortMatch[1]}:*/**`;

  try {
    const url = new URL(originOrHost);
    // localhost:1234 will parse as protocol 'localhost:' and 'null' origin.
    if (url.origin !== 'null')
      return `${url.origin}/**`;
  } catch {
  }
  // Support for legacy host-only mode.
  return `*://${originOrHost}/**`;
}

export async function workspaceFile(options: ContextOptions, fileName: string, perCallWorkspaceDir?: string): Promise<string> {
  const workspace = perCallWorkspaceDir ?? options.cwd;
  const resolvedName = path.resolve(workspace, fileName);
  await checkFile(options, resolvedName, { origin: 'llm' });
  return resolvedName;
}

export function outputDir(options: ContextOptions): string {
  if (options.config.outputDir)
    return path.resolve(options.config.outputDir);
  const baseName = options.config.skillMode ? '.playwright-cli' : '.playwright-mcp';
  if (isSystemDirectory(options.cwd) || !isWritable(options.cwd))
    return path.join(os.tmpdir(), baseName);
  return path.join(options.cwd, baseName);
}

export async function outputFile(options: ContextOptions, fileName: string, flags: { origin: 'code' | 'llm' }): Promise<string> {
  const resolvedFile = path.resolve(outputDir(options), fileName);
  await checkFile(options, resolvedFile, flags);
  await fs.promises.mkdir(path.dirname(resolvedFile), { recursive: true });
  debug('pw:mcp:file')(resolvedFile);
  return resolvedFile;
}

async function checkFile(options: ContextOptions, resolvedFilename: string, flags: { origin: 'code' | 'llm' }) {
  // Trust code and unrestricted file access.
  if (flags.origin === 'code' || options.config.allowUnrestrictedFileAccess || options.config.skillMode)
    return;

  // Trust llm to use valid characters in file names.
  const output = outputDir(options);
  const workspace = options.cwd;
  if (!isPathInside(output, resolvedFilename) && !isPathInside(workspace, resolvedFilename))
    throw new Error(`File access denied: ${resolvedFilename} is outside allowed roots. Allowed roots: ${output}, ${workspace}`);
}
