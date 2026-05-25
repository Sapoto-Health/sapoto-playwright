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

export type DownloadProbeSignal = 'Browser events' | 'Network events' | 'Fetch body capture' | 'filesystem confirmation';

export type DownloadProbeCase = {
  name: string;
  expectedFilename: string;
  expectedBody: string;
  requiredSignals: DownloadProbeSignal[];
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

type NetworkRequest = {
  requestId: string;
  url: string;
  method: string;
  hasPostData?: boolean;
};

type NetworkResponse = {
  requestId: string;
  url: string;
  status: number;
  mimeType: string;
  headers: Record<string, string>;
};

export type DownloadProbeResult = {
  name: string;
  expectedBody: string;
  suggestedFilename: string;
  completed: boolean;
  fileExists: boolean;
  filePath: string | null;
  requiredSignals: DownloadProbeSignal[];
  browserEvents: {
    willBegin: BrowserDownloadWillBegin | undefined;
    progress: BrowserDownloadProgress[];
  };
  networkEvents: {
    requests: NetworkRequest[];
    responses: NetworkResponse[];
  };
};

export function createDownloadProbeCases(server: TestServer): DownloadProbeCase[] {
  return [
    {
      name: 'attachment PDF',
      expectedFilename: 'sapoto-attachment.pdf',
      expectedBody: 'sapoto attachment pdf',
      requiredSignals: ['Browser events', 'filesystem confirmation'],
      prepare: async () => {
        server.setRoute('/sapoto-attachment.pdf', (req, res) => {
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', 'attachment; filename=sapoto-attachment.pdf');
          res.end('sapoto attachment pdf');
        });
      },
      trigger: async client => {
        await client.callTool({
          name: 'browser_navigate',
          arguments: { url: server.PREFIX + '/sapoto-attachment.pdf' },
        });
      },
    },
    {
      name: 'redirect-to-attachment',
      expectedFilename: 'sapoto-redirect.txt',
      expectedBody: 'sapoto redirect attachment',
      requiredSignals: ['Browser events', 'Network events', 'filesystem confirmation'],
      prepare: async () => {
        server.setRoute('/sapoto-redirect', (req, res) => {
          res.writeHead(302, { location: '/sapoto-redirect-target' });
          res.end();
        });
        server.setRoute('/sapoto-redirect-target', (req, res) => {
          res.setHeader('Content-Type', 'text/plain');
          res.setHeader('Content-Disposition', 'attachment; filename=sapoto-redirect.txt');
          res.end('sapoto redirect attachment');
        });
      },
      trigger: async client => {
        await client.callTool({
          name: 'browser_navigate',
          arguments: { url: server.PREFIX + '/sapoto-redirect' },
        });
      },
    },
    {
      name: 'POST form attachment',
      expectedFilename: 'sapoto-post.txt',
      expectedBody: 'sapoto post attachment',
      requiredSignals: ['Browser events', 'Network events', 'Fetch body capture', 'filesystem confirmation'],
      prepare: async () => {
        server.setRoute('/sapoto-post-page', (req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end(`<form method="post" action="/sapoto-post-download"><input name="token" value="sapoto"></form>`);
        });
        server.setRoute('/sapoto-post-download', (req, res) => {
          res.setHeader('Content-Type', 'text/plain');
          res.setHeader('Content-Disposition', 'attachment; filename=sapoto-post.txt');
          res.end('sapoto post attachment');
        });
      },
      trigger: async client => {
        await client.callTool({
          name: 'browser_navigate',
          arguments: { url: server.PREFIX + '/sapoto-post-page' },
        });
        await client.callTool({
          name: 'browser_evaluate',
          arguments: { function: '() => document.querySelector("form").submit()' },
        });
      },
    },
    {
      name: 'blob download',
      expectedFilename: 'sapoto-blob.txt',
      expectedBody: 'sapoto blob download',
      requiredSignals: ['Browser events', 'Fetch body capture', 'filesystem confirmation'],
      prepare: async () => {
        server.setRoute('/sapoto-blob-page', (req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end('<body>blob</body>');
        });
      },
      trigger: async client => {
        await client.callTool({
          name: 'browser_navigate',
          arguments: { url: server.PREFIX + '/sapoto-blob-page' },
        });
        await client.callTool({
          name: 'browser_evaluate',
          arguments: {
            function: `() => {
              const anchor = document.createElement('a');
              anchor.download = 'sapoto-blob.txt';
              anchor.href = URL.createObjectURL(new Blob(['sapoto blob download'], { type: 'text/plain' }));
              document.body.appendChild(anchor);
              anchor.click();
            }`,
          },
        });
      },
    },
    {
      name: 'data URL download',
      expectedFilename: 'sapoto-data-url.txt',
      expectedBody: 'sapoto data url download',
      requiredSignals: ['Browser events', 'Fetch body capture', 'filesystem confirmation'],
      prepare: async () => {
        server.setRoute('/sapoto-data-url-page', (req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end('<body>data url</body>');
        });
      },
      trigger: async client => {
        await client.callTool({
          name: 'browser_navigate',
          arguments: { url: server.PREFIX + '/sapoto-data-url-page' },
        });
        await client.callTool({
          name: 'browser_evaluate',
          arguments: {
            function: `() => {
              const anchor = document.createElement('a');
              anchor.download = 'sapoto-data-url.txt';
              anchor.href = 'data:text/plain,sapoto%20data%20url%20download';
              document.body.appendChild(anchor);
              anchor.click();
            }`,
          },
        });
      },
    },
    {
      name: 'cross-origin localhost download',
      expectedFilename: 'sapoto-cross-origin.txt',
      expectedBody: 'sapoto cross origin download',
      requiredSignals: ['Browser events', 'Network events', 'filesystem confirmation'],
      prepare: async () => {
        server.setRoute('/sapoto-cross-origin-page', (req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end(`<a href="${server.CROSS_PROCESS_PREFIX}/sapoto-cross-origin-download">download</a>`);
        });
        server.setRoute('/sapoto-cross-origin-download', (req, res) => {
          res.setHeader('Content-Type', 'text/plain');
          res.setHeader('Content-Disposition', 'attachment; filename=sapoto-cross-origin.txt');
          res.end('sapoto cross origin download');
        });
      },
      trigger: async client => {
        await client.callTool({
          name: 'browser_navigate',
          arguments: { url: server.PREFIX + '/sapoto-cross-origin-page' },
        });
        await client.callTool({
          name: 'browser_evaluate',
          arguments: { function: '() => document.querySelector("a").click()' },
        });
      },
    },
  ];
}

export async function attachSapotoDownloadProbe(options: {
  endpointURL?: string;
  profilesDir: string;
  downloadDir: string;
}): Promise<SapotoDownloadProbe> {
  const endpointURL = options.endpointURL ?? await waitForDevToolsEndpoint(options.profilesDir);
  const browser = await chromium.connectOverCDP({ endpointURL, noDefaults: true } as any);
  const browserSession = await browser.newBrowserCDPSession();
  const probe = new SapotoDownloadProbe(browser, browserSession, options.downloadDir);
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

class SapotoDownloadProbe {
  private _pageSession: CDPSession | undefined;
  private _willBeginEvents: BrowserDownloadWillBegin[] = [];
  private _progressEvents: BrowserDownloadProgress[] = [];
  private _networkRequests: NetworkRequest[] = [];
  private _networkResponses: NetworkResponse[] = [];

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
    await this._attachNetworkProbe();
  }

  async startCase(probeCase: DownloadProbeCase) {
    await fs.promises.rm(path.join(this._downloadDir, probeCase.expectedFilename), { force: true });
    this._willBeginEvents = [];
    this._progressEvents = [];
    this._networkRequests = [];
    this._networkResponses = [];
    await this._attachNetworkProbe();
  }

  async finishCase(probeCase: DownloadProbeCase): Promise<DownloadProbeResult> {
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

    return {
      name: probeCase.name,
      expectedBody: probeCase.expectedBody,
      suggestedFilename: willBegin.suggestedFilename,
      completed: completed.state === 'completed',
      fileExists: true,
      filePath,
      requiredSignals: probeCase.requiredSignals,
      browserEvents: {
        willBegin,
        progress: this._progressEvents.filter(event => event.guid === willBegin.guid),
      },
      networkEvents: {
        requests: this._networkRequests,
        responses: this._networkResponses,
      },
    };
  }

  async close() {
    await this._browser.close();
  }

  private async _attachNetworkProbe() {
    const page = this._browser.contexts()[0]?.pages()[0];
    if (!page)
      return;
    if (this._pageSession)
      return;
    this._pageSession = await page.context().newCDPSession(page);
    this._pageSession.on('Network.requestWillBeSent' as any, event => {
      const payload = event as any;
      this._networkRequests.push({
        requestId: payload.requestId,
        url: payload.request.url,
        method: payload.request.method,
        hasPostData: payload.request.hasPostData,
      });
    });
    this._pageSession.on('Network.responseReceived' as any, event => {
      const payload = event as any;
      this._networkResponses.push({
        requestId: payload.requestId,
        url: payload.response.url,
        status: payload.response.status,
        mimeType: payload.response.mimeType,
        headers: payload.response.headers,
      });
    });
    await this._pageSession.send('Network.enable' as any);
  }
}

async function waitForDevToolsEndpoint(profilesDir: string): Promise<string> {
  const portPath = await waitFor(async () => {
    return await findFile(profilesDir, 'DevToolsActivePort') || undefined;
  }, 'Sapoto DevToolsActivePort');
  const [port] = (await fs.promises.readFile(portPath, 'utf8')).split('\n');
  return `http://127.0.0.1:${port}`;
}

async function findFile(dir: string, fileName: string): Promise<string | null> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === fileName)
      return entryPath;
    if (entry.isDirectory()) {
      const result = await findFile(entryPath, fileName);
      if (result)
        return result;
    }
  }
  return null;
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
