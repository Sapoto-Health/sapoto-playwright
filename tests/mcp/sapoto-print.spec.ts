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

import { test, expect } from './fixtures';

test('Sapoto runtime supports host-owned printToPDF without console markers', async ({ startClient, mcpBrowser, server }) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Sapoto runtime print capture is Chromium-specific.');

  server.setContent('/sapoto-print-viewer', `
    <!doctype html>
    <html>
      <head>
        <title>Sapoto print fixture</title>
        <style>
          @media print {
            body::after {
              content: "printed";
            }
          }
        </style>
      </head>
      <body>
        <main>
          <h1>Sapoto print fixture</h1>
          <p>Host-owned CDP print capture.</p>
        </main>
        <script>
          window.__sapotoPrintObservations = [];
          window.addEventListener('beforeprint', () => window.__sapotoPrintObservations.push('beforeprint'));
          window.addEventListener('afterprint', () => window.__sapotoPrintObservations.push('afterprint'));
        </script>
      </body>
    </html>
  `, 'text/html');

  const { client } = await startClient({
    config: {
      browser: {
        sapotoRuntime: true,
      },
    },
  });

  const { tools } = await client.listTools();
  const toolNames = tools.map(tool => tool.name);
  expect(toolNames).not.toContain('browser_pdf_save');
  expect(toolNames.filter(name => /auto.*print|print.*auto/i.test(name))).toEqual([]);

  const port = await sapotoRuntimeCDPPort(client);
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/sapoto-print-viewer' },
  });

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url() === server.PREFIX + '/sapoto-print-viewer');
    expect(page).toBeTruthy();

    const session = await page!.context().newCDPSession(page!);
    const { data } = await session.send('Page.printToPDF', { printBackground: true });
    const pdf = Buffer.from(data, 'base64');

    expect(pdf.length).toBeGreaterThan(1000);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('%%EOF');
  } finally {
    await browser.close();
  }

  expect(await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => window.__sapotoPrintObservations' },
  })).toHaveResponse({
    result: expect.stringMatching(/"beforeprint"[\s\S]*"afterprint"/),
  });
});

async function sapotoRuntimeCDPPort(client: { callTool: (params: { name: string, arguments?: any }) => Promise<any> }): Promise<string> {
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
