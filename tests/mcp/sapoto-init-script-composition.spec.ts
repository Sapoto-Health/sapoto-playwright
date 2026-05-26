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

// ---------------------------------------------------------------------------
// Sapoto init-script composition tests
//
// These tests verify that behavior-control flags cause exactly the right
// init scripts to be injected — no more, no less.
//
// Detection strategy:
//   printCapture:        detectable via window.print() dispatching __sapotoPrintRequest
//                        (native window.print() does NOT dispatch this event).
//   chromeRuntimeStubs:  NOT distinguishable from native Chrome APIs via JS probing
//                        (real Chrome already has chrome.csi/loadTimes). So we test
//                        that enabling chromeRuntimeStubs does NOT inject print capture,
//                        and vice versa. For chrome stubs specifically, we also verify
//                        them through the separate runtime test in behavior-wiring.
//   focusEmulation:      a CDP command (Emulation.setFocusEmulationEnabled), not an
//                        init script. We verify it does NOT inject any init scripts.
//   suppressFocus:       a runtime gate in tab selection, not an init script.
//
// The composition invariant: each flag only injects its own scripts.
// ---------------------------------------------------------------------------

test.skip(({ mcpBrowser }) => !['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Chromium-only init-script tests.');

// Helper: detect whether printCapture init script was injected.
// printCapture replaces window.print() with a function that dispatches
// __sapotoPrintRequest. Native window.print() does NOT dispatch this event.
const hasPrintCapture = `() => {
  try {
    let fired = false;
    const handler = () => { fired = true; };
    window.addEventListener('__sapotoPrintRequest', handler);
    window.print();
    window.removeEventListener('__sapotoPrintRequest', handler);
    return fired;
  } catch { return false; }
}`;

// ---------------------------------------------------------------------------
// No behavior flags → no Sapoto print capture injected
// ---------------------------------------------------------------------------

test('no behavior flags does not inject print capture', async ({ startClient, server }) => {
  server.setContent('/init-test-none', `<!doctype html><html><body><h1>Init test</h1></body></html>`, 'text/html');

  const { client } = await startClient({
    config: {},
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/init-test-none' },
  });

  const printResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: hasPrintCapture },
  });
  expect(parseResponse(printResult).result).toContain('false');
});

// ---------------------------------------------------------------------------
// CDP stealth alone does NOT inject print capture
// ---------------------------------------------------------------------------

test('CDP stealth alone does not inject print capture', async ({ startClient, server }) => {
  server.setContent('/stealth-only', `<!doctype html><html><body><h1>Stealth only</h1></body></html>`, 'text/html');

  // CDP stealth is on by default (runtime-cycle, log-skip, worker-runtime).
  const { client } = await startClient({
    config: {},
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/stealth-only' },
  });

  const printResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: hasPrintCapture },
  });
  expect(parseResponse(printResult).result).toContain('false');
});

// ---------------------------------------------------------------------------
// --print-capture alone → print capture IS injected
// ---------------------------------------------------------------------------

test('printCapture alone injects print capture', async ({ startClient, server }) => {
  server.setContent('/print-only', `<!doctype html><html><body><h1>Print only</h1></body></html>`, 'text/html');

  const { client } = await startClient({
    config: { printCapture: true },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/print-only' },
  });

  const printResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: hasPrintCapture },
  });
  expect(parseResponse(printResult).result).toContain('true');
});

// ---------------------------------------------------------------------------
// --chrome-runtime-stubs=on alone → does NOT inject print capture
// ---------------------------------------------------------------------------

test('chromeRuntimeStubs alone does not inject print capture', async ({ startClient, server }) => {
  server.setContent('/stubs-only', `<!doctype html><html><body><h1>Stubs only</h1></body></html>`, 'text/html');

  const { client } = await startClient({
    config: { chromeRuntimeStubs: true },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/stubs-only' },
  });

  // chromeRuntimeStubs should NOT inject the print capture script.
  const printResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: hasPrintCapture },
  });
  expect(parseResponse(printResult).result).toContain('false');
});

// ---------------------------------------------------------------------------
// --focus-emulation=on alone → no init scripts (it's a CDP command)
// ---------------------------------------------------------------------------

test('focusEmulation alone does not inject print capture', async ({ startClient, server }) => {
  server.setContent('/focus-only', `<!doctype html><html><body><h1>Focus only</h1></body></html>`, 'text/html');

  const { client } = await startClient({
    config: { focusEmulation: true },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/focus-only' },
  });

  const printResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: hasPrintCapture },
  });
  expect(parseResponse(printResult).result).toContain('false');
});

// ---------------------------------------------------------------------------
// --suppress-focus alone → no init scripts (it's a runtime gate)
// ---------------------------------------------------------------------------

test('suppressFocus alone does not inject print capture', async ({ startClient, server }) => {
  server.setContent('/suppress-only', `<!doctype html><html><body><h1>Suppress only</h1></body></html>`, 'text/html');

  const { client } = await startClient({
    config: { suppressFocus: true },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/suppress-only' },
  });

  const printResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: hasPrintCapture },
  });
  expect(parseResponse(printResult).result).toContain('false');
});

// ---------------------------------------------------------------------------
// Multiple flags → correct scripts injected (print + stubs together)
// ---------------------------------------------------------------------------

test('printCapture + chromeRuntimeStubs together injects print capture', async ({ startClient, server }) => {
  server.setContent('/both', `<!doctype html><html><body><h1>Both</h1></body></html>`, 'text/html');

  const { client } = await startClient({
    config: { printCapture: true, chromeRuntimeStubs: true },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/both' },
  });

  const printResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: hasPrintCapture },
  });
  expect(parseResponse(printResult).result).toContain('true');
});

// ---------------------------------------------------------------------------
// Non-script flags + printCapture → only print capture injected
// ---------------------------------------------------------------------------

test('focusEmulation + suppressFocus + printCapture injects only print capture', async ({ startClient, server }) => {
  server.setContent('/mixed', `<!doctype html><html><body><h1>Mixed</h1></body></html>`, 'text/html');

  const { client } = await startClient({
    config: { focusEmulation: true, suppressFocus: true, printCapture: true },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/mixed' },
  });

  const printResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: hasPrintCapture },
  });
  expect(parseResponse(printResult).result).toContain('true');
});

// ---------------------------------------------------------------------------
// Print capture survives navigation (script is added via addScriptToEvaluateOnNewDocument)
// ---------------------------------------------------------------------------

test('printCapture persists across navigations', async ({ startClient, server }) => {
  server.setContent('/page-a', `<!doctype html><html><body><h1>Page A</h1></body></html>`, 'text/html');
  server.setContent('/page-b', `<!doctype html><html><body><h1>Page B</h1></body></html>`, 'text/html');

  const { client } = await startClient({
    config: { printCapture: true },
  });

  // Navigate to page A.
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/page-a' },
  });

  let printResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: hasPrintCapture },
  });
  expect(parseResponse(printResult).result).toContain('true');

  // Navigate to page B.
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/page-b' },
  });

  printResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: hasPrintCapture },
  });
  expect(parseResponse(printResult).result).toContain('true');
});
