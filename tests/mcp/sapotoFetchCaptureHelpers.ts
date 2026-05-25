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
import net from 'net';
import path from 'path';
import { chromium } from 'playwright';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Browser, CDPSession } from 'playwright';
import type { TestServer } from '../config/testserver';

export type FetchCaptureBody = {
  url: string;
  method: string;
  status: number;
  body: string;
};

export type FetchCaptureProbeCase = {
  name: string;
  capturePatterns: string[];
  expectedCapture: FetchCaptureBody | null;
  expectedFilename: string;
  expectedDownloadedBody: string;
  limitation?: string;
  prepare: () => Promise<void>;
  trigger: (client: Client) => Promise<void>;
};

type BrowserDownloadWillBegin = {
  guid: string;
  url: string;
  suggestedFilename: string;
};

type BrowserDownloadProgress = {
  guid: string;
  state: 'inProgress' | 'completed' | 'canceled';
  receivedBytes: number;
  totalBytes: number;
};

export type FetchCaptureProbeResult = {
  name: string;
  enabledPatterns: string[];
  expectedCapture: FetchCaptureBody | null;
  limitation?: string;
  capturedBodies: FetchCaptureBody[];
  suggestedFilename: string;
  completed: boolean;
  fileExists: boolean;
  downloadedBody: string;
  browserEvents: {
    willBegin: BrowserDownloadWillBegin;
    progress: BrowserDownloadProgress[];
  };
};

export function createFetchCaptureProbeCases(server: TestServer): FetchCaptureProbeCase[] {
  return [
    {
      name: 'redirect HTTP attachment',
      capturePatterns: [`*${server.PREFIX}/sapoto-fetch-capture-redirect-target`],
      expectedCapture: {
        url: `${server.PREFIX}/sapoto-fetch-capture-redirect-target`,
        method: 'GET',
        status: 200,
        body: 'sapoto fetch redirect body',
      },
      expectedFilename: 'sapoto-fetch-redirect.txt',
      expectedDownloadedBody: 'sapoto fetch redirect body',
      prepare: async () => {
        server.setRoute('/sapoto-fetch-capture-redirect', (req, res) => {
          res.writeHead(302, { location: '/sapoto-fetch-capture-redirect-target' });
          res.end();
        });
        server.setRoute('/sapoto-fetch-capture-redirect-target', (req, res) => {
          res.setHeader('Content-Type', 'text/plain');
          res.setHeader('Content-Disposition', 'attachment; filename=sapoto-fetch-redirect.txt');
          res.end('sapoto fetch redirect body');
        });
      },
      trigger: async client => {
        await client.callTool({
          name: 'browser_navigate',
          arguments: { url: server.PREFIX + '/sapoto-fetch-capture-redirect' },
        });
      },
    },
    {
      name: 'POST HTTP attachment',
      capturePatterns: [`*${server.PREFIX}/sapoto-fetch-capture-post-download`],
      expectedCapture: {
        url: `${server.PREFIX}/sapoto-fetch-capture-post-download`,
        method: 'POST',
        status: 200,
        body: 'sapoto fetch post body',
      },
      expectedFilename: 'sapoto-fetch-post.txt',
      expectedDownloadedBody: 'sapoto fetch post body',
      prepare: async () => {
        server.setRoute('/sapoto-fetch-capture-post-page', (req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end(`<form method="post" action="/sapoto-fetch-capture-post-download"><input name="token" value="sapoto"></form>`);
        });
        server.setRoute('/sapoto-fetch-capture-post-download', async (req, res) => {
          const body = (await req.postBody).toString();
          res.setHeader('Content-Type', 'text/plain');
          res.setHeader('Content-Disposition', 'attachment; filename=sapoto-fetch-post.txt');
          res.end(body === 'token=sapoto' ? 'sapoto fetch post body' : `unexpected post body: ${body}`);
        });
      },
      trigger: async client => {
        await client.callTool({
          name: 'browser_navigate',
          arguments: { url: server.PREFIX + '/sapoto-fetch-capture-post-page' },
        });
        await client.callTool({
          name: 'browser_evaluate',
          arguments: { function: '() => document.querySelector("form").submit()' },
        });
      },
    },
    {
      name: 'XHR source bytes for blob download',
      capturePatterns: [`*${server.PREFIX}/sapoto-fetch-capture-xhr-blob-source`],
      expectedCapture: {
        url: `${server.PREFIX}/sapoto-fetch-capture-xhr-blob-source`,
        method: 'GET',
        status: 200,
        body: 'sapoto fetch xhr blob body',
      },
      expectedFilename: 'sapoto-fetch-xhr-blob.txt',
      expectedDownloadedBody: 'sapoto fetch xhr blob body',
      prepare: async () => {
        server.setRoute('/sapoto-fetch-capture-xhr-blob-page', (req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end('<button>download</button>');
        });
        server.setRoute('/sapoto-fetch-capture-xhr-blob-source', (req, res) => {
          res.setHeader('Content-Type', 'text/plain');
          res.end('sapoto fetch xhr blob body');
        });
      },
      trigger: async client => {
        await client.callTool({
          name: 'browser_navigate',
          arguments: { url: server.PREFIX + '/sapoto-fetch-capture-xhr-blob-page' },
        });
        await client.callTool({
          name: 'browser_evaluate',
          arguments: {
            function: `async () => {
              const response = await fetch('/sapoto-fetch-capture-xhr-blob-source');
              const blob = await response.blob();
              const anchor = document.createElement('a');
              anchor.download = 'sapoto-fetch-xhr-blob.txt';
              anchor.href = URL.createObjectURL(blob);
              document.body.appendChild(anchor);
              anchor.click();
            }`,
          },
        });
      },
    },
    {
      name: 'iframe HTTP attachment',
      capturePatterns: [`*${server.PREFIX}/sapoto-fetch-capture-iframe-file`],
      expectedCapture: {
        url: `${server.PREFIX}/sapoto-fetch-capture-iframe-file`,
        method: 'GET',
        status: 200,
        body: 'sapoto fetch iframe body',
      },
      expectedFilename: 'sapoto-fetch-iframe.txt',
      expectedDownloadedBody: 'sapoto fetch iframe body',
      prepare: async () => {
        server.setRoute('/sapoto-fetch-capture-iframe-page', (req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end('<iframe title="document"></iframe>');
        });
        server.setRoute('/sapoto-fetch-capture-iframe-file', (req, res) => {
          res.setHeader('Content-Type', 'text/plain');
          res.setHeader('Content-Disposition', 'attachment; filename=sapoto-fetch-iframe.txt');
          res.end('sapoto fetch iframe body');
        });
      },
      trigger: async client => {
        await client.callTool({
          name: 'browser_navigate',
          arguments: { url: server.PREFIX + '/sapoto-fetch-capture-iframe-page' },
        });
        await client.callTool({
          name: 'browser_evaluate',
          arguments: { function: '() => document.querySelector("iframe").src = "/sapoto-fetch-capture-iframe-file"' },
        });
      },
    },
    {
      name: 'cross-origin localhost HTTP attachment',
      capturePatterns: [`*${server.CROSS_PROCESS_PREFIX}/sapoto-fetch-capture-cross-origin-download`],
      expectedCapture: {
        url: `${server.CROSS_PROCESS_PREFIX}/sapoto-fetch-capture-cross-origin-download`,
        method: 'GET',
        status: 200,
        body: 'sapoto fetch cross origin body',
      },
      expectedFilename: 'sapoto-fetch-cross-origin.txt',
      expectedDownloadedBody: 'sapoto fetch cross origin body',
      prepare: async () => {
        server.setRoute('/sapoto-fetch-capture-cross-origin-page', (req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end(`<a href="${server.CROSS_PROCESS_PREFIX}/sapoto-fetch-capture-cross-origin-download">download</a>`);
        });
        server.setRoute('/sapoto-fetch-capture-cross-origin-download', (req, res) => {
          res.setHeader('Content-Type', 'text/plain');
          res.setHeader('Content-Disposition', 'attachment; filename=sapoto-fetch-cross-origin.txt');
          res.end('sapoto fetch cross origin body');
        });
      },
      trigger: async client => {
        await client.callTool({
          name: 'browser_navigate',
          arguments: { url: server.CROSS_PROCESS_PREFIX + '/sapoto-fetch-capture-cross-origin-download' },
        });
      },
    },
    {
      name: 'Browser download event without matching Fetch scope',
      capturePatterns: [`*${server.PREFIX}/sapoto-fetch-capture-selected-only`],
      expectedCapture: null,
      expectedFilename: 'sapoto-fetch-browser-only.txt',
      expectedDownloadedBody: 'sapoto fetch browser event only body',
      prepare: async () => {
        server.setRoute('/sapoto-fetch-capture-browser-only', (req, res) => {
          res.setHeader('Content-Type', 'text/plain');
          res.setHeader('Content-Disposition', 'attachment; filename=sapoto-fetch-browser-only.txt');
          res.end('sapoto fetch browser event only body');
        });
      },
      trigger: async client => {
        await client.callTool({
          name: 'browser_navigate',
          arguments: { url: server.PREFIX + '/sapoto-fetch-capture-browser-only' },
        });
      },
    },
  ];
}

export function createFetchCaptureLimitationCases(server: TestServer): FetchCaptureProbeCase[] {
  return [
    {
      name: 'data URL download',
      capturePatterns: ['data:*'],
      expectedCapture: null,
      expectedFilename: 'sapoto-fetch-data-url.txt',
      expectedDownloadedBody: 'sapoto fetch data url body',
      limitation: 'Fetch body capture is scoped to HTTP-backed requests; data URL bytes do not produce a page-target Fetch response.',
      prepare: async () => {
        server.setRoute('/sapoto-fetch-capture-data-url-page', (req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end('<body>data url</body>');
        });
      },
      trigger: async client => {
        await client.callTool({
          name: 'browser_navigate',
          arguments: { url: server.PREFIX + '/sapoto-fetch-capture-data-url-page' },
        });
        await client.callTool({
          name: 'browser_evaluate',
          arguments: {
            function: `() => {
              const anchor = document.createElement('a');
              anchor.download = 'sapoto-fetch-data-url.txt';
              anchor.href = 'data:text/plain,sapoto%20fetch%20data%20url%20body';
              document.body.appendChild(anchor);
              anchor.click();
            }`,
          },
        });
      },
    },
    {
      name: 'service worker synthetic attachment',
      capturePatterns: [`*${server.PREFIX}/sapoto-fetch-capture-sw-document`],
      expectedCapture: null,
      expectedFilename: 'sapoto-fetch-sw.txt',
      expectedDownloadedBody: 'sapoto fetch service worker body',
      limitation: 'A page-target Fetch session does not own service-worker synthetic response bodies; a worker-target probe would be needed for this fallback.',
      prepare: async () => {
        server.setRoute('/sapoto-fetch-capture-sw-page', (req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end(`
            <a href="/sapoto-fetch-capture-sw-document">download</a>
            <script>
              window.__sapotoSWReady = false;
              window.__sapotoSWError = null;
              (async () => {
                const registration = await navigator.serviceWorker.register('/sapoto-fetch-capture-sw.js', { scope: '/' });
                await navigator.serviceWorker.ready;
                if (!navigator.serviceWorker.controller) {
                  navigator.serviceWorker.addEventListener('controllerchange', () => window.__sapotoSWReady = true, { once: true });
                  location.reload();
                  return;
                }
                window.__sapotoSWReady = true;
              })().catch(error => window.__sapotoSWError = String(error));
            </script>
          `);
        });
        server.setRoute('/sapoto-fetch-capture-sw.js', (req, res) => {
          res.setHeader('Content-Type', 'application/javascript');
          res.end(`
            self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
            self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
            self.addEventListener('fetch', event => {
              const url = new URL(event.request.url);
              if (url.pathname === '/sapoto-fetch-capture-sw-document') {
                event.respondWith(new Response('sapoto fetch service worker body', {
                  headers: {
                    'Content-Type': 'text/plain',
                    'Content-Disposition': 'attachment; filename=sapoto-fetch-sw.txt',
                  },
                }));
              }
            });
          `);
        });
      },
      trigger: async client => {
        await client.callTool({
          name: 'browser_navigate',
          arguments: { url: server.PREFIX + '/sapoto-fetch-capture-sw-page' },
        });
        await waitForMcpEvaluate(client, `() => {
          if (window.__sapotoSWError)
            throw new Error(window.__sapotoSWError);
          return window.__sapotoSWReady === true ? 'ready' : undefined;
        }`, 'service worker controller');
        await client.callTool({
          name: 'browser_evaluate',
          arguments: { function: '() => document.querySelector("a").click()' },
        });
      },
    },
  ];
}

export async function attachSapotoFetchCaptureProbe(options: {
  endpointURL: string;
  downloadDir: string;
}): Promise<SapotoFetchCaptureProbe> {
  const browser = await chromium.connectOverCDP({ endpointURL: options.endpointURL, noDefaults: true } as any);
  const browserSession = await browser.newBrowserCDPSession();
  const probe = new SapotoFetchCaptureProbe(browser, browserSession, options.downloadDir);
  await probe.initialize();
  return probe;
}

export async function findFreePort(): Promise<number> {
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

class SapotoFetchCaptureProbe {
  private _pageSession: CDPSession | undefined;
  private _willBeginEvents: BrowserDownloadWillBegin[] = [];
  private _progressEvents: BrowserDownloadProgress[] = [];
  private _capturedBodies: FetchCaptureBody[] = [];
  private _enabledPatterns: string[] = [];
  private _fetchErrors: string[] = [];

  constructor(
    private _browser: Browser,
    private _browserSession: CDPSession,
    private _downloadDir: string,
  ) {
  }

  async initialize() {
    this._browserSession.on('Browser.downloadWillBegin' as any, event => this._willBeginEvents.push(event as BrowserDownloadWillBegin));
    this._browserSession.on('Browser.downloadProgress' as any, event => this._progressEvents.push(event as BrowserDownloadProgress));
    await this._browserSession.send('Browser.setDownloadBehavior' as any, {
      behavior: 'allow',
      downloadPath: this._downloadDir,
      eventsEnabled: true,
    });
    await this._attachPageProbe();
  }

  async startCase(probeCase: FetchCaptureProbeCase) {
    await fs.promises.rm(path.join(this._downloadDir, probeCase.expectedFilename), { force: true });
    this._willBeginEvents = [];
    this._progressEvents = [];
    this._capturedBodies = [];
    this._fetchErrors = [];
    this._enabledPatterns = probeCase.capturePatterns;
    await this._attachPageProbe();
    await this._pageSession!.send('Fetch.disable' as any).catch(() => {});
    if (probeCase.capturePatterns.length) {
      await this._pageSession!.send('Fetch.enable' as any, {
        patterns: probeCase.capturePatterns.map(urlPattern => ({ urlPattern, requestStage: 'Response' })),
      });
    }
  }

  async finishCase(probeCase: FetchCaptureProbeCase): Promise<FetchCaptureProbeResult> {
    const willBegin = await waitFor(() => {
      return this._willBeginEvents.find(event => event.suggestedFilename === probeCase.expectedFilename);
    }, `downloadWillBegin for ${probeCase.expectedFilename}`);
    const completed = await waitFor(() => {
      return this._progressEvents.find(event => event.guid === willBegin.guid && event.state === 'completed');
    }, `downloadProgress completed for ${probeCase.expectedFilename}`);
    const filePath = path.join(this._downloadDir, probeCase.expectedFilename);
    await waitFor(async () => {
      const stat = await fs.promises.stat(filePath).catch(() => null);
      return stat?.isFile() ? filePath : undefined;
    }, `downloaded file ${probeCase.expectedFilename}`);

    if (probeCase.expectedCapture) {
      await waitFor(() => {
        return this._capturedBodies.find(capture => capture.url === probeCase.expectedCapture!.url && capture.body === probeCase.expectedCapture!.body);
      }, `Fetch body capture for ${probeCase.name}`);
    }
    if (this._fetchErrors.length)
      throw new Error(`Fetch capture failed for ${probeCase.name}: ${this._fetchErrors.join('; ')}`);

    return {
      name: probeCase.name,
      enabledPatterns: this._enabledPatterns,
      expectedCapture: probeCase.expectedCapture,
      limitation: probeCase.limitation,
      capturedBodies: this._capturedBodies,
      suggestedFilename: willBegin.suggestedFilename,
      completed: completed.state === 'completed',
      fileExists: true,
      downloadedBody: await fs.promises.readFile(filePath, 'utf8'),
      browserEvents: {
        willBegin,
        progress: this._progressEvents.filter(event => event.guid === willBegin.guid),
      },
    };
  }

  async close() {
    await this._pageSession?.send('Fetch.disable' as any).catch(() => {});
    await this._browser.close();
  }

  private async _attachPageProbe() {
    if (this._pageSession)
      return;
    const page = this._browser.contexts()[0]?.pages()[0];
    if (!page)
      throw new Error('Unable to attach Sapoto Fetch capture probe: no page target.');
    this._pageSession = await page.context().newCDPSession(page);
    this._pageSession.on('Fetch.requestPaused' as any, event => {
      void this._onRequestPaused(event as any);
    });
  }

  private async _onRequestPaused(event: any) {
    if (!this._pageSession)
      return;
    try {
      if (event.responseStatusCode === undefined || isRedirect(event)) {
        await this._continueResponse(event);
        return;
      }

      const responseBody = await this._pageSession.send('Fetch.getResponseBody' as any, { requestId: event.requestId });
      const body = responseBody.base64Encoded ? Buffer.from(responseBody.body, 'base64') : Buffer.from(responseBody.body);
      this._capturedBodies.push({
        url: event.request.url,
        method: event.request.method,
        status: event.responseStatusCode,
        body: body.toString('utf8'),
      });
      await this._pageSession.send('Fetch.fulfillRequest' as any, {
        requestId: event.requestId,
        responseCode: event.responseStatusCode,
        responsePhrase: event.responseStatusText,
        responseHeaders: event.responseHeaders,
        body: body.toString('base64'),
      });
    } catch (error: any) {
      this._fetchErrors.push(error.message);
      await this._continueResponse(event).catch(() => {});
    }
  }

  private async _continueResponse(event: any) {
    if (!this._pageSession)
      return;
    await this._pageSession.send('Fetch.continueResponse' as any, { requestId: event.requestId }).catch(async () => {
      await this._pageSession!.send('Fetch.continueRequest' as any, { requestId: event.requestId });
    });
  }
}

function isRedirect(event: any): boolean {
  return event.responseStatusCode >= 300 && event.responseStatusCode <= 399;
}

async function waitForMcpEvaluate(client: Client, expression: string, description: string): Promise<void> {
  await waitFor(async () => {
    const result = await client.callTool({
      name: 'browser_evaluate',
      arguments: { function: expression },
    });
    return result.content[0].text.includes('"ready"') ? true : undefined;
  }, description);
}

async function waitFor<T>(callback: () => T | undefined | Promise<T | undefined>, description: string): Promise<T> {
  const deadline = monotonicTime() + 10000;
  let lastError: Error | undefined;
  while (monotonicTime() < deadline) {
    try {
      const result = await callback();
      if (result)
        return result;
    } catch (error: any) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? ': ' + lastError.message : ''}`);
}

function monotonicTime(): number {
  const [seconds, nanoseconds] = process.hrtime();
  return seconds * 1000 + nanoseconds / 1000000;
}
