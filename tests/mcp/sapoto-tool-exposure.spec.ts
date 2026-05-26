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

import { test, expect } from './fixtures';

// ---------------------------------------------------------------------------
// MCP tool exposure tests
//
// These tests verify that the allowedTools, caps, and their interaction
// correctly control which tools are exposed via client.listTools().
// ---------------------------------------------------------------------------

test.skip(({ mcpBrowser }) => mcpBrowser !== 'chrome', 'Tool exposure tests are channel-agnostic.');

// ---------------------------------------------------------------------------
// --allowed-tools restricts the tool list
// ---------------------------------------------------------------------------

test('allowedTools restricts to only the named tools', async ({ startClient }) => {
  const { client } = await startClient({
    config: { allowedTools: ['browser_navigate', 'browser_click'] },
  });

  const result = await client.listTools();
  const toolNames = result.tools.map(t => t.name);

  expect(toolNames).toContain('browser_navigate');
  expect(toolNames).toContain('browser_click');
  // Core tools that are NOT in the allow-list should be absent.
  expect(toolNames).not.toContain('browser_snapshot');
  expect(toolNames).not.toContain('browser_type');
  expect(toolNames).not.toContain('browser_tabs');
  expect(toolNames.length).toBe(2);
});

// ---------------------------------------------------------------------------
// No --allowed-tools → all core tools available
// ---------------------------------------------------------------------------

test('no allowedTools exposes all core tools', async ({ startClient }) => {
  const { client } = await startClient({
    config: {},
  });

  const result = await client.listTools();
  const toolNames = result.tools.map(t => t.name);

  // Spot-check that common core tools are present.
  expect(toolNames).toContain('browser_navigate');
  expect(toolNames).toContain('browser_click');
  expect(toolNames).toContain('browser_snapshot');
  expect(toolNames).toContain('browser_type');
  expect(toolNames).toContain('browser_tabs');
  // Many more tools are exposed — just verify we have a reasonable count.
  expect(toolNames.length).toBeGreaterThan(10);
});

// ---------------------------------------------------------------------------
// --caps=pdf → PDF tools available
// ---------------------------------------------------------------------------

test('caps=pdf exposes browser_pdf_save', async ({ startClient }) => {
  const { client } = await startClient({
    args: ['--caps=pdf'],
  });

  const result = await client.listTools();
  const toolNames = result.tools.map(t => t.name);

  expect(toolNames).toContain('browser_pdf_save');
});

// ---------------------------------------------------------------------------
// Without --caps=pdf → PDF tools NOT available
// ---------------------------------------------------------------------------

test('without caps=pdf browser_pdf_save is not exposed', async ({ startClient }) => {
  const { client } = await startClient({
    config: {},
  });

  const result = await client.listTools();
  const toolNames = result.tools.map(t => t.name);

  expect(toolNames).not.toContain('browser_pdf_save');
});

// ---------------------------------------------------------------------------
// --allowed-tools + --caps interaction: allowed-tools restricts AFTER caps expands
// ---------------------------------------------------------------------------

test('allowedTools restricts even when caps would expand the set', async ({ startClient }) => {
  // caps=pdf would add browser_pdf_save, but allowedTools restricts to only
  // browser_navigate. So browser_pdf_save should be absent.
  const { client } = await startClient({
    args: ['--caps=pdf'],
    config: { allowedTools: ['browser_navigate'] },
  });

  const result = await client.listTools();
  const toolNames = result.tools.map(t => t.name);

  expect(toolNames).toContain('browser_navigate');
  expect(toolNames).not.toContain('browser_pdf_save');
  expect(toolNames.length).toBe(1);
});

test('allowedTools can include a caps-gated tool when caps is set', async ({ startClient }) => {
  // caps=pdf expands to include browser_pdf_save, and allowedTools includes it.
  const { client } = await startClient({
    args: ['--caps=pdf'],
    config: { allowedTools: ['browser_navigate', 'browser_pdf_save'] },
  });

  const result = await client.listTools();
  const toolNames = result.tools.map(t => t.name);

  expect(toolNames).toContain('browser_navigate');
  expect(toolNames).toContain('browser_pdf_save');
  expect(toolNames.length).toBe(2);
});

test('allowedTools names a caps-gated tool but caps is not set → tool absent', async ({ startClient }) => {
  // allowedTools includes browser_pdf_save but caps=pdf is not set.
  // The caps filter runs first and removes browser_pdf_save; allowedTools
  // then operates on the reduced set.
  const { client } = await startClient({
    config: { allowedTools: ['browser_navigate', 'browser_pdf_save'] },
  });

  const result = await client.listTools();
  const toolNames = result.tools.map(t => t.name);

  expect(toolNames).toContain('browser_navigate');
  // browser_pdf_save is absent because caps=pdf is not set.
  expect(toolNames).not.toContain('browser_pdf_save');
  expect(toolNames.length).toBe(1);
});
