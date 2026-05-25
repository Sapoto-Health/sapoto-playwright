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

import { chromium } from 'playwright';

import { test, expect, parseResponse } from './fixtures';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Browser, Page } from 'playwright';
import type { StartClient } from './fixtures';
import type { TestInfo } from '@playwright/test';

type ParsedResponse = ReturnType<typeof parseResponse>;
type FocusVisibilityEntry = {
  eventName: string;
  visibilityState: string;
  hasFocus: boolean;
};

const sapotoBridgeCandidates = [
  '__sapotoBackgroundOpen',
  '__sapotoBridge',
  '__sapotoMainWorldBridge',
  '__sapotoOpen',
  '__sapotoPopupBridge',
  '__sapotoPopupOpen',
];

async function startSapotoClient(startClient: StartClient, testInfo: TestInfo, options?: {
  capabilities?: string[],
  policy?: Record<string, boolean>,
  profileName?: string,
}) {
  return (await startClient({
    config: {
      browser: {
        sapotoRuntime: true,
        userDataDir: testInfo.outputPath(options?.profileName ?? 'sapoto-profile'),
      },
      capabilities: options?.capabilities as any,
      sapotoRuntimePolicy: options?.policy,
    },
  })).client;
}

function snapshotFrom(response: ParsedResponse): string | undefined {
  return response?.inlineSnapshot ?? response?.snapshot;
}

function refFor(snapshot: string | undefined, name: string): string {
  const match = snapshot?.match(new RegExp(`"${name}"[^\\n]*\\[ref=([^\\]]+)\\]`));
  expect(match, `Missing ref for "${name}" in snapshot:\n${snapshot}`).toBeTruthy();
  return match![1];
}

async function sapotoRuntimeCDPPort(client: Client): Promise<string> {
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'chrome://version' },
  });
  const result = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => document.getElementById("command_line").innerText' },
  });
  const match = result.content[0].text.match(/--remote-debugging-port=(\d+)/);
  expect(match).toBeTruthy();
  return match![1];
}

async function connectSapotoRuntime(client: Client): Promise<Browser> {
  return await chromium.connectOverCDP(`http://127.0.0.1:${await sapotoRuntimeCDPPort(client)}`);
}

async function enableTargetObservation(browser: Browser) {
  const session = await browser.newBrowserCDPSession();
  const observed: any[] = [];
  const record = (eventName: string, targetInfo: any) => {
    if (targetInfo?.type === 'page')
      observed.push({ eventName, ...targetInfo });
  };
  session.on('Target.targetCreated', ({ targetInfo }) => record('targetCreated', targetInfo));
  session.on('Target.targetInfoChanged', ({ targetInfo }) => record('targetInfoChanged', targetInfo));
  await session.send('Target.setDiscoverTargets', { discover: true });
  return { session, observed };
}

async function waitForObservedURL(observed: any[], url: string) {
  await expect.poll(() => observed.some(target => target.url === url)).toBe(true);
  return observed.find(target => target.url === url)!;
}

async function waitForHostPage(browser: Browser, url: string): Promise<Page> {
  await expect.poll(() => browser.contexts().flatMap(context => context.pages()).map(page => page.url())).toContain(url);
  return browser.contexts().flatMap(context => context.pages()).find(page => page.url() === url)!;
}

async function expectNoMainWorldBridge(client: Client) {
  const response = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: `() => {
        const names = ${JSON.stringify(sapotoBridgeCandidates)};
        return Object.fromEntries(names.map(name => [name, {
          own: Object.prototype.hasOwnProperty.call(window, name),
          type: typeof window[name],
        }]));
      }`,
    },
  });
  const values = JSON.parse(parseResponse(response).result || '{}');
  for (const name of sapotoBridgeCandidates) {
    expect(values[name], name).toEqual({
      own: false,
      type: 'undefined',
    });
  }
}

test('Sapoto runtime observes popup targets and records final URLs from Target events', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Sapoto runtime popup handling is Chromium-specific');

  const popupFinalURL = server.PREFIX + '/sapoto-popup-final?source=target-observation';
  server.setRoute('/sapoto-popup-start', (req, res) => {
    res.writeHead(302, { location: popupFinalURL });
    res.end();
  });
  server.setContent('/sapoto-popup-opener', `
    <!doctype html>
    <html>
      <body>
        <button onclick="window.open('/sapoto-popup-start', '_blank')">Open final popup</button>
      </body>
    </html>
  `, 'text/html');
  server.setContent('/sapoto-popup-final', `
    <!doctype html>
    <html>
      <head><title>Sapoto popup final</title></head>
      <body>Popup reached final URL</body>
    </html>
  `, 'text/html');

  const client = await startSapotoClient(startClient, testInfo);
  const browser = await connectSapotoRuntime(client);
  try {
    const { observed } = await enableTargetObservation(browser);
    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + '/sapoto-popup-opener' },
    });
    const snapshot = snapshotFrom(parseResponse(await client.callTool({ name: 'browser_snapshot' })));

    await client.callTool({
      name: 'browser_click',
      arguments: {
        element: 'Open final popup button',
        target: refFor(snapshot, 'Open final popup'),
      },
    });

    const observedTarget = await waitForObservedURL(observed, popupFinalURL);
    expect(observedTarget.eventName).toBe('targetInfoChanged');

    expect(await client.callTool({
      name: 'browser_tabs',
      arguments: { action: 'list' },
    })).toHaveResponse({
      result: expect.stringContaining(`](${popupFinalURL})`),
    });
  } finally {
    await browser.close();
  }
});

test('Sapoto host-owned planned open preserves cookies and avoids page-owned open hooks', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Sapoto runtime popup handling is Chromium-specific');

  let plannedOpenCookie = '';
  const plannedURL = server.PREFIX + '/sapoto-planned-open-target?from=form&document=statement';
  server.setRoute('/sapoto-planned-open-source', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Set-Cookie': 'sapoto_session=host-owned; Path=/; SameSite=Lax',
    });
    res.end(`
      <!doctype html>
      <html>
        <body>
          <script>
            window.__sapotoPageOpenCalls = [];
            const nativeOpen = window.open;
            window.open = (...args) => {
              window.__sapotoPageOpenCalls.push(args.map(String));
              return nativeOpen.apply(window, args);
            };
          </script>
          <a id="planned-link" href="${plannedURL}">Statement link</a>
          <form id="planned-form" action="/sapoto-planned-open-target" method="GET" target="_blank">
            <input name="from" value="form">
            <input name="document" value="statement">
            <button>Open statement</button>
          </form>
        </body>
      </html>
    `);
  });
  server.setRoute('/sapoto-planned-open-target', (req, res) => {
    plannedOpenCookie = req.headers.cookie || '';
    res.setHeader('Content-Type', 'text/html');
    res.end(`
      <!doctype html>
      <html>
        <head><title>Sapoto planned open</title></head>
        <body>cookie: ${plannedOpenCookie}</body>
      </html>
    `);
  });

  const client = await startSapotoClient(startClient, testInfo);
  const browser = await connectSapotoRuntime(client);
  const { observed } = await enableTargetObservation(browser);
  try {
    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + '/sapoto-planned-open-source' },
    });
    const intent = parseResponse(await client.callTool({
      name: 'browser_evaluate',
      arguments: {
        function: `() => {
          localStorage.setItem('sapoto_session_state', 'source-tab');
          const form = document.querySelector('#planned-form');
          const search = new URLSearchParams(new FormData(form)).toString();
          return {
            linkURL: document.querySelector('#planned-link').href,
            formURL: new URL(form.getAttribute('action') + '?' + search, location.href).href,
            cookie: document.cookie,
          };
        }`,
      },
    }));
    const plannedIntent = JSON.parse(intent.result || '{}');
    expect(plannedIntent).toEqual({
      linkURL: plannedURL,
      formURL: plannedURL,
      cookie: 'sapoto_session=host-owned',
    });

    const openerPage = await waitForHostPage(browser, server.PREFIX + '/sapoto-planned-open-source');
    await client.callTool({
      name: 'browser_tabs',
      arguments: {
        action: 'new',
        url: plannedIntent.formURL,
      },
    });

    const targetState = parseResponse(await client.callTool({
      name: 'browser_evaluate',
      arguments: {
        function: `() => ({
          cookie: document.cookie,
          sessionState: localStorage.getItem('sapoto_session_state'),
        })`,
      },
    }));
    expect(JSON.parse(targetState.result || '{}')).toEqual({
      cookie: 'sapoto_session=host-owned',
      sessionState: 'source-tab',
    });
    await waitForObservedURL(observed, plannedURL);

    expect(await openerPage.evaluate('window.__sapotoPageOpenCalls')).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('Sapoto isolated-world bridge fallback signals host without main-page visibility', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Sapoto runtime popup handling is Chromium-specific');

  const bridgeURL = server.PREFIX + '/sapoto-isolated-bridge';
  server.setContent('/sapoto-isolated-bridge', `
    <!doctype html>
    <html>
      <body>
        <script>
          window.__sapotoMainWorldProbe = Object.fromEntries(${JSON.stringify(sapotoBridgeCandidates)}.map(name => [name, typeof window[name]]));
        </script>
        <main>Bridge probe</main>
      </body>
    </html>
  `, 'text/html');

  const client = await startSapotoClient(startClient, testInfo, {
    policy: { isolatedWorldBridge: true },
  });
  const browser = await connectSapotoRuntime(client);
  try {
    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: bridgeURL },
    });
    await expectNoMainWorldBridge(client);

    const page = await waitForHostPage(browser, bridgeURL);
    const session = await page.context().newCDPSession(page);
    const bindingCalls: any[] = [];
    session.on('Runtime.bindingCalled', event => bindingCalls.push(event));

    await session.send('Runtime.enable');
    await session.send('Runtime.addBinding', {
      name: '__sapotoIsolatedPopupBridge',
      executionContextName: 'sapoto-isolated-popup-fallback',
    });
    const { frameTree } = await session.send('Page.getFrameTree');
    const { executionContextId } = await session.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: 'sapoto-isolated-popup-fallback',
      grantUniveralAccess: false,
    });
    await session.send('Runtime.evaluate', {
      contextId: executionContextId,
      expression: `window.__sapotoIsolatedPopupBridge(JSON.stringify({ href: location.href, source: 'isolated-world' }))`,
      awaitPromise: true,
    });

    await expect.poll(() => bindingCalls.length).toBe(1);
    expect(JSON.parse(bindingCalls[0].payload)).toEqual({
      href: bridgeURL,
      source: 'isolated-world',
    });
    await expectNoMainWorldBridge(client);
  } finally {
    await browser.close();
  }
});

test('Sapoto main-world popup shims stay disabled by default and require explicit policy', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Sapoto runtime popup handling is Chromium-specific');

  server.setContent('/sapoto-main-world-bridge', `
    <!doctype html>
    <html>
      <body>Main-world bridge probe</body>
    </html>
  `, 'text/html');

  const strictClient = await startSapotoClient(startClient, testInfo, {
    capabilities: ['config'],
    profileName: 'sapoto-strict-profile',
  });
  await strictClient.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/sapoto-main-world-bridge' },
  });
  await expectNoMainWorldBridge(strictClient);
  expect(await strictClient.callTool({ name: 'browser_get_config' })).toHaveResponse({
    result: expect.not.stringContaining('"mainWorldBridge": true'),
  });
  await strictClient.close();

  const fallbackClient = await startSapotoClient(startClient, testInfo, {
    capabilities: ['config'],
    policy: { mainWorldBridge: true },
    profileName: 'sapoto-main-world-profile',
  });
  expect(await fallbackClient.callTool({ name: 'browser_get_config' })).toHaveResponse({
    result: expect.stringContaining('"mainWorldBridge": true'),
  });
});

test('Sapoto popup probe documents focus and visibility churn', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Sapoto runtime popup handling is Chromium-specific');

  const popupURL = server.PREFIX + '/sapoto-focus-popup';
  const eventRecorder = `
    window.__sapotoFocusVisibilityLog = [];
    window.__sapotoRecordFocusVisibility = eventName => {
      window.__sapotoFocusVisibilityLog.push({
        eventName,
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
      });
    };
    window.__sapotoRecordFocusVisibility('initial');
    for (const eventName of ['focus', 'blur', 'visibilitychange'])
      window.addEventListener(eventName, () => window.__sapotoRecordFocusVisibility(eventName));
  `;
  server.setContent('/sapoto-focus-opener', `
    <!doctype html>
    <html>
      <body>
        <script>${eventRecorder}</script>
        <button onclick="window.open('${popupURL}', '_blank')">Open focus popup</button>
      </body>
    </html>
  `, 'text/html');
  server.setContent('/sapoto-focus-popup', `
    <!doctype html>
    <html>
      <head><title>Sapoto focus popup</title></head>
      <body>
        <script>${eventRecorder}</script>
        Popup focus probe
      </body>
    </html>
  `, 'text/html');

  const openerURL = server.PREFIX + '/sapoto-focus-opener';
  const client = await startSapotoClient(startClient, testInfo);
  const browser = await connectSapotoRuntime(client);
  try {
    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: openerURL },
    });
    const snapshot = snapshotFrom(parseResponse(await client.callTool({ name: 'browser_snapshot' })));
    await client.callTool({
      name: 'browser_click',
      arguments: {
        element: 'Open focus popup button',
        target: refFor(snapshot, 'Open focus popup'),
      },
    });

    const opener = await waitForHostPage(browser, openerURL);
    const popup = await waitForHostPage(browser, popupURL);
    await opener.bringToFront();
    await popup.bringToFront();
    await opener.bringToFront();

    const observations = {
      opener: await opener.evaluate('window.__sapotoFocusVisibilityLog') as FocusVisibilityEntry[],
      popup: await popup.evaluate('window.__sapotoFocusVisibilityLog') as FocusVisibilityEntry[],
    };
    expect(observations.opener[0]).toMatchObject({
      eventName: 'initial',
      visibilityState: expect.stringMatching(/^(hidden|visible)$/),
      hasFocus: expect.any(Boolean),
    });
    expect(observations.popup[0]).toMatchObject({
      eventName: 'initial',
      visibilityState: expect.stringMatching(/^(hidden|visible)$/),
      hasFocus: expect.any(Boolean),
    });
    for (const log of [observations.opener, observations.popup]) {
      expect(log.length).toBeGreaterThan(0);
      expect(new Set(log.map(entry => entry.eventName)).has('initial')).toBe(true);
      expect(log.every(entry => ['initial', 'focus', 'blur', 'visibilitychange'].includes(entry.eventName))).toBe(true);
    }
  } finally {
    await browser.close();
  }
});
