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
import { test, expect } from './fixtures';
import { attachSapotoDownloadProbe, createDownloadProbeCases, findFreePort } from './sapotoDownloadHelpers';

test('Sapoto raw-CDP download runtime records Chrome Browser download events', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Sapoto runtime is Chromium-specific');

  const profilesDir = testInfo.outputPath('ms-playwright');
  const downloadDir = testInfo.outputPath('raw-cdp-downloads');
  const remoteDebuggingPort = await findFreePort();
  await fs.promises.mkdir(downloadDir, { recursive: true });

  const { client } = await startClient({
    config: {
      browser: {
        sapotoRuntime: true,
        launchOptions: {
          args: [`--remote-debugging-port=${remoteDebuggingPort}`],
        },
      },
    },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.EMPTY_PAGE },
  });

  const probe = await attachSapotoDownloadProbe({
    endpointURL: `http://127.0.0.1:${remoteDebuggingPort}`,
    profilesDir,
    downloadDir,
  });
  try {
    const downloadProbeCases = createDownloadProbeCases(server);
    const results = [];
    for (const probeCase of downloadProbeCases) {
      await probeCase.prepare();
      await probe.startCase(probeCase);
      await probeCase.trigger(client);
      results.push(await probe.finishCase(probeCase));
    }

    expect(results.map(result => ({
      name: result.name,
      suggestedFilename: result.suggestedFilename,
      completed: result.completed,
      fileExists: result.fileExists,
      requiredSignals: result.requiredSignals,
    }))).toEqual(downloadProbeCases.map(probeCase => ({
      name: probeCase.name,
      suggestedFilename: probeCase.expectedFilename,
      completed: true,
      fileExists: true,
      requiredSignals: probeCase.requiredSignals,
    })));

    for (const result of results)
      expect(await fs.promises.readFile(result.filePath!, 'utf8')).toBe(result.expectedBody);
  } finally {
    await probe.close();
  }
});
