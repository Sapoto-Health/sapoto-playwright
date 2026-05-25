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

import { test, expect, parseResponse } from './fixtures';

import type { StartClient } from './fixtures';
import type { TestInfo } from '@playwright/test';

type ParsedResponse = ReturnType<typeof parseResponse>;

async function startSapotoClient(startClient: StartClient, testInfo: TestInfo) {
  return (await startClient({
    config: {
      browser: {
        sapotoRuntime: true,
        userDataDir: testInfo.outputPath('sapoto-profile'),
      },
    },
  })).client;
}

function refFor(snapshot: string | undefined, name: string): string {
  const match = snapshot?.match(new RegExp(`"${name}"[^\\n]*\\[ref=([^\\]]+)\\]`));
  expect(match, `Missing ref for "${name}" in snapshot:\n${snapshot}`).toBeTruthy();
  return match![1];
}

function snapshotFrom(response: ParsedResponse): string | undefined {
  return response?.inlineSnapshot ?? response?.snapshot;
}

async function expectNoPlaywrightGlobals(client: Awaited<ReturnType<typeof startSapotoClient>>) {
  const result = parseResponse(await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: `() => {
        const names = ['__playwright__binding__', '__pwInitScripts'];
        const own = target => Object.fromEntries(names.map(name => [name, Object.prototype.hasOwnProperty.call(target, name)]));
        const types = target => Object.fromEntries(names.map(name => [name, typeof target[name]]));
        const frame = document.querySelector('iframe')?.contentWindow;
        return {
          topOwn: own(window),
          topTypes: types(window),
          frameOwn: frame ? own(frame) : null,
          frameTypes: frame ? types(frame) : null,
          writes: window.__sapotoProbeWrites,
        };
      }`,
    },
  }));

  expect(JSON.parse(result?.result || '{}')).toEqual({
    topOwn: {
      __playwright__binding__: false,
      __pwInitScripts: false,
    },
    topTypes: {
      __playwright__binding__: 'undefined',
      __pwInitScripts: 'undefined',
    },
    frameOwn: {
      __playwright__binding__: false,
      __pwInitScripts: false,
    },
    frameTypes: {
      __playwright__binding__: 'undefined',
      __pwInitScripts: 'undefined',
    },
    writes: [],
  });
}

test('Sapoto runtime harness navigates, snapshots, acts, and keeps Playwright globals private', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Sapoto runtime is Chromium-specific');

  server.setContent('/', `
    <!DOCTYPE html>
    <html>
      <body>
        <script>
          window.__sapotoProbeWrites = [];
          for (const name of ['__playwright__binding__', '__pwInitScripts']) {
            Object.defineProperty(window, name, {
              configurable: true,
              get: () => undefined,
              set: () => window.__sapotoProbeWrites.push(name),
            });
            delete window[name];
          }
        </script>
        <main>
          <button id="outside" onclick="this.textContent = 'Outside clicked'">Outside action</button>
          <label>Search <input id="search" onkeydown="if (event.key === 'Enter') document.querySelector('#status').textContent = 'submitted:' + this.value"></label>
          <select aria-label="Choice" onchange="document.querySelector('#status').textContent = 'selected:' + this.value">
            <option value="one">One</option>
            <option value="two">Two</option>
          </select>
          <p id="status">idle</p>
          <iframe title="Action frame" srcdoc="
            <button onclick=&quot;this.textContent = 'Frame clicked'&quot;>Frame action</button>
            <label>Frame note <input oninput=&quot;document.querySelector('output').textContent = this.value&quot;></label>
            <output>empty</output>
          "></iframe>
        </main>
      </body>
    </html>
  `, 'text/html');

  const client = await startSapotoClient(startClient, testInfo);

  const navigate = parseResponse(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  }), testInfo.outputPath());
  const navigateSnapshot = snapshotFrom(navigate);
  expect(navigateSnapshot).toContain('button "Outside action"');
  expect(navigateSnapshot).toContain('iframe');
  await expectNoPlaywrightGlobals(client);

  await client.callTool({
    name: 'browser_click',
    arguments: {
      element: 'Outside action button',
      target: refFor(navigateSnapshot, 'Outside action'),
    },
  });

  const afterOutsideClick = parseResponse(await client.callTool({ name: 'browser_snapshot' }));
  const afterOutsideClickSnapshot = snapshotFrom(afterOutsideClick);
  expect(afterOutsideClickSnapshot).toContain('button "Outside clicked"');

  await client.callTool({
    name: 'browser_type',
    arguments: {
      element: 'Search textbox',
      target: refFor(afterOutsideClickSnapshot, 'Search'),
      text: 'sapoto',
    },
  });
  await client.callTool({
    name: 'browser_press_key',
    arguments: { key: 'Enter' },
  });

  const afterTyping = parseResponse(await client.callTool({ name: 'browser_snapshot' }));
  const afterTypingSnapshot = snapshotFrom(afterTyping);
  expect(afterTypingSnapshot).toContain('submitted:sapoto');

  await client.callTool({
    name: 'browser_select_option',
    arguments: {
      element: 'Choice select',
      target: refFor(afterTypingSnapshot, 'Choice'),
      values: ['two'],
    },
  });

  const afterSelect = parseResponse(await client.callTool({ name: 'browser_snapshot' }));
  const afterSelectSnapshot = snapshotFrom(afterSelect);
  expect(afterSelectSnapshot).toContain('option "Two" [selected]');
  expect(afterSelectSnapshot).toContain('selected:two');

  await client.callTool({
    name: 'browser_click',
    arguments: {
      element: 'Frame action button',
      target: refFor(afterSelectSnapshot, 'Frame action'),
    },
  });

  const afterFrameClick = parseResponse(await client.callTool({ name: 'browser_snapshot' }));
  const afterFrameClickSnapshot = snapshotFrom(afterFrameClick);
  expect(afterFrameClickSnapshot).toContain('button "Frame clicked"');

  await client.callTool({
    name: 'browser_type',
    arguments: {
      element: 'Frame note textbox',
      target: refFor(afterFrameClickSnapshot, 'Frame note'),
      text: 'inside frame',
    },
  });

  const finalSnapshot = parseResponse(await client.callTool({ name: 'browser_snapshot' }));
  const finalSnapshotText = snapshotFrom(finalSnapshot);
  expect(finalSnapshotText).toMatch(/textbox "Frame note".*inside frame/);
  expect(finalSnapshotText).toContain('inside frame');
  await expectNoPlaywrightGlobals(client);
});
