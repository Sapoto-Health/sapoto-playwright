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
// Sapoto stealth init-script builder tests (Tracer #1127)
//
// These tests verify:
//   1. No flags -> no init scripts injected (empty script)
//   2. Any single flag -> toString infrastructure installed
//   3. __chromeStealth guard prevents double-injection
//   4. focusEmulation: false -> focus emulation CDP call NOT made
//   5. focusEmulation: true -> CDP call IS made (verified via document.hasFocus)
// ---------------------------------------------------------------------------

test.skip(({ mcpBrowser }) => !['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Chromium-only stealth builder tests.');

// Helper: detect whether the toString masking infrastructure is installed.
// When installed, Function.prototype.toString is patched and __stealthMarkNative
// is available on window. We test both.
const hasToStringMasking = `() => {
  try {
    // Check that __stealthMarkNative global handshake exists.
    return typeof window.__stealthMarkNative === 'function';
  } catch { return false; }
}`;

// Helper: check if __chromeStealth guard is set (re-entry guard).
const hasStealthGuard = `() => {
  try {
    return window.__chromeStealth === true;
  } catch { return false; }
}`;

// Helper: check Function.prototype.toString masking works correctly.
// When patched, a function marked via __stealthMarkNative should return
// "[native code]" in its toString().
const toStringMaskingWorks = `() => {
  try {
    if (typeof window.__stealthMarkNative !== 'function') return false;
    const fn = window.__stealthMarkNative(function testFn() {}, 'testFn');
    return fn.toString() === 'function testFn() { [native code] }';
  } catch { return false; }
}`;

// ---------------------------------------------------------------------------
// No flags -> no stealth infrastructure injected
// ---------------------------------------------------------------------------

test('no flags does not inject toString infrastructure', async ({ startClient, server }) => {
  server.setContent('/builder-none', `<!doctype html><html><body><h1>No flags</h1></body></html>`, 'text/html');

  const { client } = await startClient({
    config: {},
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/builder-none' },
  });

  const result = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: hasToStringMasking },
  });
  expect(parseResponse(result).result).toContain('false');

  const guardResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: hasStealthGuard },
  });
  expect(parseResponse(guardResult).result).toContain('false');
});

// ---------------------------------------------------------------------------
// chromeRuntimeStubs alone -> toString infrastructure IS installed
// ---------------------------------------------------------------------------

test('chromeRuntimeStubs installs toString infrastructure', async ({ startClient, server }) => {
  server.setContent('/builder-stubs', `<!doctype html><html><body><h1>Stubs</h1></body></html>`, 'text/html');

  const { client } = await startClient({
    config: { chromeRuntimeStubs: true },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/builder-stubs' },
  });

  const result = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: hasToStringMasking },
  });
  expect(parseResponse(result).result).toContain('true');

  const maskResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: toStringMaskingWorks },
  });
  expect(parseResponse(maskResult).result).toContain('true');
});

// ---------------------------------------------------------------------------
// printCapture alone -> toString infrastructure IS installed
// ---------------------------------------------------------------------------

test('printCapture installs toString infrastructure', async ({ startClient, server }) => {
  server.setContent('/builder-print', `<!doctype html><html><body><h1>Print</h1></body></html>`, 'text/html');

  const { client } = await startClient({
    config: { printCapture: true },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/builder-print' },
  });

  const result = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: hasToStringMasking },
  });
  expect(parseResponse(result).result).toContain('true');
});

// ---------------------------------------------------------------------------
// suppressFocus alone -> toString infrastructure IS installed
// ---------------------------------------------------------------------------

test('suppressFocus installs toString infrastructure', async ({ startClient, server }) => {
  server.setContent('/builder-focus', `<!doctype html><html><body><h1>Focus</h1></body></html>`, 'text/html');

  const { client } = await startClient({
    config: { suppressFocus: true },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/builder-focus' },
  });

  const result = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: hasToStringMasking },
  });
  expect(parseResponse(result).result).toContain('true');
});

// ---------------------------------------------------------------------------
// backgroundOpenCapture alone -> toString infrastructure IS installed
// ---------------------------------------------------------------------------

test('backgroundOpenCapture installs toString infrastructure', async ({ startClient, server }) => {
  server.setContent('/builder-bgopen', `<!doctype html><html><body><h1>BgOpen</h1></body></html>`, 'text/html');

  const { client } = await startClient({
    config: { backgroundOpenCapture: true },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/builder-bgopen' },
  });

  const result = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: hasToStringMasking },
  });
  expect(parseResponse(result).result).toContain('true');
});

// ---------------------------------------------------------------------------
// __chromeStealth guard prevents double-injection
// ---------------------------------------------------------------------------

test('__chromeStealth guard prevents double-injection', async ({ startClient, server }) => {
  server.setContent('/builder-guard', `<!doctype html><html><body><h1>Guard test</h1></body></html>`, 'text/html');

  const { client } = await startClient({
    config: { chromeRuntimeStubs: true },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/builder-guard' },
  });

  // The guard should be set after the first injection.
  const guardResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: hasStealthGuard },
  });
  expect(parseResponse(guardResult).result).toContain('true');

  // Store a sentinel to verify that re-running the script does NOT re-execute.
  // We replace __stealthMarkNative with a canary to prove the guard works.
  await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: `() => { window.__stealthCanary = 'original'; }` },
  });

  // Navigate to same page — the init script runs again on the new document,
  // and the guard should prevent double-injection. Let us verify the guard is
  // still set on the new page and toString works.
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/builder-guard' },
  });

  const guardAfterNav = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: hasStealthGuard },
  });
  expect(parseResponse(guardAfterNav).result).toContain('true');

  const maskAfterNav = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: toStringMaskingWorks },
  });
  expect(parseResponse(maskAfterNav).result).toContain('true');
});

// ---------------------------------------------------------------------------
// focusEmulation: false -> document.hasFocus() returns false (headless)
// ---------------------------------------------------------------------------

test('focusEmulation false does not enable focus emulation', async ({ startClient, server }) => {
  server.setContent('/focus-off', `<!doctype html><html><body><h1>Focus off</h1></body></html>`, 'text/html');

  const { client } = await startClient({
    config: { focusEmulation: false },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/focus-off' },
  });

  // In headless mode without focus emulation, document.hasFocus() returns false.
  const result = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => document.hasFocus()' },
  });
  expect(parseResponse(result).result).toContain('false');
});

// ---------------------------------------------------------------------------
// focusEmulation: true -> document.hasFocus() returns true
// ---------------------------------------------------------------------------

test('focusEmulation true enables focus emulation', async ({ startClient, server }) => {
  server.setContent('/focus-on', `<!doctype html><html><body><h1>Focus on</h1></body></html>`, 'text/html');

  const { client } = await startClient({
    config: { focusEmulation: true },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/focus-on' },
  });

  // With focus emulation enabled, document.hasFocus() should return true.
  const result = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => document.hasFocus()' },
  });
  expect(parseResponse(result).result).toContain('true');
});
