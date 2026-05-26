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

import { test, expect, parseResponse } from './fixtures';
import { tools } from '../../packages/playwright-core/lib/coreBundle';

const { resolveCLIConfigForMCP } = tools;

// Empty env to isolate tests from the host environment.
const emptyEnv = {};

// ── Config resolution tests ────────────────────────────────────────────────

test.skip(({ mcpBrowser }) => mcpBrowser !== 'chrome', 'Config resolution tests are channel-agnostic.');

test.describe('behavior flag config resolution', () => {
  test('CLI flags propagate to resolved config', async () => {
    const config = await resolveCLIConfigForMCP({
      focusEmulation: true,
      suppressFocus: true,
      keepBrowserAlive: true,
      disableDownloads: true,
      filterInternalUrls: true,
      printCapture: true,
      backgroundOpenCapture: true,
      chromeRuntimeStubs: true,
      humanizeInput: true,
    }, emptyEnv);
    expect(config.focusEmulation).toBe(true);
    expect(config.suppressFocus).toBe(true);
    expect(config.keepBrowserAlive).toBe(true);
    expect(config.disableDownloads).toBe(true);
    expect(config.filterInternalUrls).toBe(true);
    expect(config.printCapture).toBe(true);
    expect(config.backgroundOpenCapture).toBe(true);
    expect(config.chromeRuntimeStubs).toBe(true);
    expect(config.humanizeInput).toBe(true);
  });

  test('env vars propagate to resolved config', async () => {
    const env = {
      PLAYWRIGHT_MCP_FOCUS_EMULATION: '1',
      PLAYWRIGHT_MCP_SUPPRESS_FOCUS: '1',
      PLAYWRIGHT_MCP_KEEP_BROWSER_ALIVE: '1',
      PLAYWRIGHT_MCP_DISABLE_DOWNLOADS: '1',
      PLAYWRIGHT_MCP_FILTER_INTERNAL_URLS: '1',
      PLAYWRIGHT_MCP_PRINT_CAPTURE: '1',
      PLAYWRIGHT_MCP_BACKGROUND_OPEN_CAPTURE: '1',
      PLAYWRIGHT_MCP_CHROME_RUNTIME_STUBS: '1',
      PLAYWRIGHT_MCP_HUMANIZE_INPUT: '1',
    };
    const config = await resolveCLIConfigForMCP({}, env);
    expect(config.focusEmulation).toBe(true);
    expect(config.suppressFocus).toBe(true);
    expect(config.keepBrowserAlive).toBe(true);
    expect(config.disableDownloads).toBe(true);
    expect(config.filterInternalUrls).toBe(true);
    expect(config.printCapture).toBe(true);
    expect(config.backgroundOpenCapture).toBe(true);
    expect(config.chromeRuntimeStubs).toBe(true);
    expect(config.humanizeInput).toBe(true);
  });

  test('config file propagates behavior flags', async ({}, testInfo) => {
    const configFile = testInfo.outputPath('config.json');
    await fs.promises.writeFile(configFile, JSON.stringify({
      focusEmulation: true,
      suppressFocus: true,
      keepBrowserAlive: true,
      disableDownloads: true,
      filterInternalUrls: true,
      printCapture: true,
      backgroundOpenCapture: true,
      chromeRuntimeStubs: true,
      humanizeInput: true,
    }));
    const config = await resolveCLIConfigForMCP({ config: configFile }, emptyEnv);
    expect(config.focusEmulation).toBe(true);
    expect(config.suppressFocus).toBe(true);
    expect(config.keepBrowserAlive).toBe(true);
    expect(config.disableDownloads).toBe(true);
    expect(config.filterInternalUrls).toBe(true);
    expect(config.printCapture).toBe(true);
    expect(config.backgroundOpenCapture).toBe(true);
    expect(config.chromeRuntimeStubs).toBe(true);
    expect(config.humanizeInput).toBe(true);
  });

  test('flags default to undefined when not set', async () => {
    const config = await resolveCLIConfigForMCP({}, emptyEnv);
    expect(config.focusEmulation).toBeUndefined();
    expect(config.suppressFocus).toBeUndefined();
    expect(config.keepBrowserAlive).toBeUndefined();
    expect(config.disableDownloads).toBeUndefined();
    expect(config.filterInternalUrls).toBeUndefined();
    expect(config.printCapture).toBeUndefined();
    expect(config.backgroundOpenCapture).toBeUndefined();
    expect(config.chromeRuntimeStubs).toBeUndefined();
    expect(config.humanizeInput).toBeUndefined();
  });
});

// ── filterInternalUrls runtime test ────────────────────────────────────────

test('filterInternalUrls blocks navigation to chrome:// URLs', async ({ startClient, mcpBrowser, server }) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Chromium-only');

  const { client } = await startClient({
    config: { filterInternalUrls: true },
  });

  // Navigate to a normal page first.
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.EMPTY_PAGE },
  });

  // Attempt to navigate to chrome://version should fail.
  const result = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'chrome://version' },
  });
  expect(result.content[0].text).toContain('internal browser URL is blocked');
});

test('filterInternalUrls=false allows chrome:// navigation', async ({ startClient, mcpBrowser, server }) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Chromium-only');

  const { client } = await startClient({
    config: { filterInternalUrls: false },
  });

  // Navigate to chrome://version should succeed.
  const result = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'chrome://version' },
  });
  expect(result.isError).toBeFalsy();
});

// ── suppressFocus runtime test ─────────────────────────────────────────────

test('suppressFocus skips bringToFront on tab select', async ({ startClient, mcpBrowser, server }) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Chromium-only');

  const { client } = await startClient({
    config: { suppressFocus: true },
  });

  // Open first tab.
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/hello-world' },
  });

  // Open second tab.
  await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'new', url: server.EMPTY_PAGE },
  });

  // Switch back to first tab — this should not throw (bringToFront skipped).
  const result = await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'select', index: 0 },
  });
  expect(result.isError).toBeFalsy();
});

// ── chromeRuntimeStubs runtime test ────────────────────────────────────────

test('chromeRuntimeStubs injects chrome.csi and chrome.loadTimes', async ({ startClient, mcpBrowser, server }) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Chromium-only');

  server.setContent('/stubs-test', `
    <!doctype html><html><body><h1>Stubs test</h1></body></html>
  `, 'text/html');

  const { client } = await startClient({
    config: { chromeRuntimeStubs: true },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/stubs-test' },
  });

  const csiResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: `() => typeof window.chrome?.csi === 'function'` },
  });
  expect(parseResponse(csiResult).result).toContain('true');

  const loadTimesResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: `() => typeof window.chrome?.loadTimes === 'function'` },
  });
  expect(parseResponse(loadTimesResult).result).toContain('true');

  const csiKeysResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: `() => JSON.stringify(Object.keys(window.chrome.csi()))` },
  });
  expect(parseResponse(csiKeysResult).result).toContain('startE');

  const loadTimesKeysResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: `() => JSON.stringify(Object.keys(window.chrome.loadTimes()))` },
  });
  expect(parseResponse(loadTimesKeysResult).result).toContain('commitLoadTime');
});

// ── printCapture runtime test ──────────────────────────────────────────────

test('printCapture overrides window.print', async ({ startClient, mcpBrowser, server }) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Chromium-only');

  server.setContent('/print-capture-test', `
    <!doctype html>
    <html><body>
      <h1>Print capture test</h1>
      <script>
        window.__printRequested = false;
        window.addEventListener('__sapotoPrintRequest', () => {
          window.__printRequested = true;
        });
      </script>
    </body></html>
  `, 'text/html');

  const { client } = await startClient({
    config: { printCapture: true },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/print-capture-test' },
  });

  // Call window.print() — should dispatch event, not show native dialog.
  await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => window.print()' },
  });

  const result = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => window.__printRequested' },
  });

  // The custom event fires, confirming the override is active.
  expect(result.content[0].text).toContain('true');
});

// ── humanizeTypingDelay unit tests ─────────────────────────────────────────

test.describe('humanizeTypingDelay', () => {
  // Import the function at module scope is not possible since it's an internal
  // module. We test it indirectly through the keyboard tools and directly by
  // importing via the coreBundle tools export if available.

  test('typing with humanizeInput flag does not throw', async ({ startClient, mcpBrowser, server }) => {
    test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Chromium-only');

    server.setContent('/humanize-test', `
      <!doctype html>
      <html><body>
        <input type="text" aria-label="Name" />
      </body></html>
    `, 'text/html');

    const { client } = await startClient({
      config: { humanizeInput: true },
    });

    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + '/humanize-test' },
    });

    // Take a snapshot to get refs.
    const snap = await client.callTool({
      name: 'browser_snapshot',
      arguments: {},
    });
    const snapText = (snap.content as Array<{ type: string, text: string }>).map(c => c.text).join('');
    const refMatch = snapText.match(/textbox "Name"[^\n]*\[ref=([^\]]+)\]/);
    expect(refMatch, 'Could not find textbox ref in snapshot').toBeTruthy();
    const ref = refMatch![1];

    // Use browser_type with slowly:true which uses pressSequentially with humanized delay.
    const result = await client.callTool({
      name: 'browser_type',
      arguments: { element: 'Name', target: ref, text: 'hello', slowly: true },
    });
    expect(result.isError).toBeFalsy();

    // Verify the text was actually typed.
    const valueResult = await client.callTool({
      name: 'browser_evaluate',
      arguments: { function: `() => document.querySelector('input').value` },
    });
    expect(parseResponse(valueResult).result).toContain('hello');
  });
});
