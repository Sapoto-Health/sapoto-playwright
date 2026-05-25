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

import fs from 'node:fs';
import path from 'node:path';

import { test, expect, parseResponse } from './fixtures';
import type { Config } from '../../packages/playwright-core/src/tools/mcp/config.d';

test('config user data dir', async ({ startClient, server }, testInfo) => {
  server.setContent('/', `
    <title>Title</title>
    <body>Hello, world!</body>
  `, 'text/html');

  const config: Config = {
    browser: {
      userDataDir: testInfo.outputPath('user-data-dir'),
    },
  };
  const configPath = testInfo.outputPath('config.json');
  await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));

  const { client } = await startClient({ args: ['--config', configPath] });
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  })).toHaveResponse({
    snapshot: expect.stringContaining(`Hello, world!`),
  });

  const files = await fs.promises.readdir(config.browser!.userDataDir!);
  expect(files.length).toBeGreaterThan(0);
});

test('config with UTF-8 BOM', async ({ startClient, server }, testInfo) => {
  server.setContent('/', `
    <title>Title</title>
    <body>Hello, world!</body>
  `, 'text/html');

  const config: Config = {
    browser: {
      userDataDir: testInfo.outputPath('user-data-dir'),
    },
  };
  const configPath = testInfo.outputPath('config.json');
  // Write config with UTF-8 BOM prefix, as some Windows editors (Notepad, PowerShell) do.
  await fs.promises.writeFile(configPath, '\uFEFF' + JSON.stringify(config, null, 2));

  const { client } = await startClient({ args: ['--config', configPath] });
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  })).toHaveResponse({
    snapshot: expect.stringContaining(`Hello, world!`),
  });

  const files = await fs.promises.readdir(config.browser!.userDataDir!);
  expect(files.length).toBeGreaterThan(0);
});

test('executable path', async ({ startClient, server }, testInfo) => {
  const { client } = await startClient({ args: ['--executable-path', testInfo.outputPath('missing-executable')] });
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  })).toHaveResponse({
    isError: true,
    error: expect.stringMatching(/Failed to launch.*missing-executable/),
  });
});

test.describe(() => {
  test.use({ mcpBrowser: '' });
  test('browserName', { annotation: { type: 'issue', description: 'https://github.com/microsoft/playwright-mcp/issues/458' } }, async ({ startClient }, testInfo) => {
    const config: Config = {
      browser: {
        browserName: 'firefox',
      },
    };
    const configPath = testInfo.outputPath('config.json');
    await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));

    const { client } = await startClient({ args: ['--config', configPath] });
    expect(await client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'data:text/html,<script>document.title = navigator.userAgent</script>' },
    })).toHaveResponse({
      page: expect.stringContaining(`Firefox`),
    });
  });
});

test('config ignoreDefaultArgs merged with persistent mode defaults', async ({ startClient, mcpBrowser }, testInfo) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'chrome://version is Chromium-specific');
  const config: Config = {
    browser: {
      userDataDir: testInfo.outputPath('user-data-dir'),
      launchOptions: {
        ignoreDefaultArgs: ['--password-store=basic'],
      },
    },
  };
  const { client } = await startClient({ config });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'chrome://version' },
  });

  const result = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => document.getElementById("command_line").innerText' },
  });
  const commandLine = result.content[0].text;

  // User-specified arg should be removed.
  expect(commandLine).not.toContain('--password-store=basic');
  // Persistent mode's built-in --disable-extensions should also be removed.
  expect(commandLine).not.toContain('--disable-extensions');
  // Other default args should still be present.
  expect(commandLine).toContain('--use-mock-keychain');
});

test('Sapoto runtime launches Chrome with explicit CDP port and no automation switches', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Sapoto runtime is Chromium-specific');

  const { client } = await startClient({
    config: {
      browser: {
        sapotoRuntime: true,
      },
    },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'chrome://version' },
  });

  const commandLineResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => document.getElementById("command_line").innerText' },
  });
  const commandLine = commandLineResult.content[0].text;
  expect(commandLine).toMatch(/--remote-debugging-port=(?!0(?:\s|$))\d+/);
  expect(commandLine).not.toContain('--remote-debugging-port=0');
  expect(commandLine).not.toContain('--enable-automation');
  expect(commandLine).toContain(`${path.sep}sapoto-${mcpBrowser}-`);

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  expect(await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => navigator.webdriver' },
  })).toHaveResponse({
    result: `false`,
  });

  const profilesDir = testInfo.outputPath('ms-playwright');
  const profileDir = (await fs.promises.readdir(profilesDir)).find(entry => entry.startsWith('sapoto-chrome-'));
  expect(profileDir).toBeTruthy();
  const profileFiles = await fs.promises.readdir(path.join(profilesDir, profileDir!));
  expect(profileFiles.length).toBeGreaterThan(0);
});

test('Sapoto runtime persists localStorage across launches of the same profile', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Sapoto runtime is Chromium-specific');

  const config = {
    browser: {
      sapotoRuntime: true,
    },
  };

  const first = await startClient({ config });
  await first.client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  await first.client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => localStorage.setItem("sapoto-profile-proof", "persisted")' },
  });
  await first.client.close();

  const second = await startClient({ config });
  await second.client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  expect(await second.client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => localStorage.getItem("sapoto-profile-proof")' },
  })).toHaveResponse({
    result: `"persisted"`,
  });
});

test('Sapoto runtime honors seeded Chrome download preferences', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Sapoto runtime is Chromium-specific');

  server.setRoute('/sapoto-download', (req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename=sapoto-download.txt');
    res.end('sapoto download');
  });
  const profilesDir = testInfo.outputPath('ms-playwright');
  const { client } = await startClient({
    config: {
      browser: {
        sapotoRuntime: true,
      },
    },
  });
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/sapoto-download' },
  });

  await expect.poll(async () => await findFile(profilesDir, 'sapoto-download.txt')).not.toBe(null);
  const downloadPath = await findFile(profilesDir, 'sapoto-download.txt');
  expect(await fs.promises.readFile(downloadPath!, 'utf8')).toBe('sapoto download');
});

test('Sapoto runtime hides runtime diagnostics from the public MCP tool list by default', async ({ startClient, mcpBrowser }) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Sapoto runtime is Chromium-specific');

  const { client } = await startClient({
    config: {
      browser: {
        sapotoRuntime: true,
      },
    },
  });

  const { tools } = await client.listTools();
  const toolNames = tools.map(tool => tool.name);
  expect(toolNames).not.toContain('browser_run_code_unsafe');
  expect(toolNames).not.toContain('browser_console_messages');
  expect(toolNames).toContain('browser_navigate');
  expect(toolNames).toContain('browser_snapshot');
});

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

test('browser_get_config returns merged config from file, env and cli', async ({ startClient }) => {
  const { client } = await startClient({
    config: {
      browser: {
        contextOptions: {
          viewport: { width: 800, height: 600 },
        },
      },
      capabilities: ['config'],
      timeouts: {
        action: 10000,
        navigation: 30000,
      },
    },
    args: ['--isolated'],
    env: {
      PLAYWRIGHT_MCP_TIMEOUT_NAVIGATION: '45000',
    },
  });

  const result = await client.callTool({
    name: 'browser_get_config',
  });

  expect(result.isError).toBeFalsy();
  const parsed = parseResponse(result);
  const config = JSON.parse(parsed.result);

  // From config file.
  expect(config.browser.contextOptions.viewport).toEqual({ width: 800, height: 600 });
  expect(config.timeouts.action).toBe(10000);

  // Env var overrides file value.
  expect(config.timeouts.navigation).toBe(45000);

  // From CLI arg (--isolated).
  expect(config.browser.isolated).toBe(true);
});
