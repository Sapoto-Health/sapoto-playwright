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
import { attachSapotoFetchCaptureProbe, createFetchCaptureLimitationCases, createFetchCaptureProbeCases, findFreePort } from './sapotoFetchCaptureHelpers';

test('Sapoto scoped Fetch body capture records HTTP-backed fallback bytes without replacing Browser downloads', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Sapoto runtime is Chromium-specific');

  const downloadDir = testInfo.outputPath('fetch-capture-downloads');
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
      sapotoRuntimePolicy: {
        fetchBodyCapture: true,
      },
    },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.EMPTY_PAGE },
  });

  const probe = await attachSapotoFetchCaptureProbe({
    endpointURL: `http://127.0.0.1:${remoteDebuggingPort}`,
    downloadDir,
  });
  try {
    const cases = createFetchCaptureProbeCases(server);
    const results = [];
    for (const probeCase of cases) {
      await probeCase.prepare();
      await probe.startCase(probeCase);
      await probeCase.trigger(client);
      results.push(await probe.finishCase(probeCase));
    }

    expect(results.map(result => ({
      name: result.name,
      enabledPatterns: result.enabledPatterns,
      expectedCapture: result.expectedCapture,
      capturedBodies: result.capturedBodies.map(capture => ({
        url: capture.url,
        method: capture.method,
        status: capture.status,
        body: capture.body,
      })),
      suggestedFilename: result.suggestedFilename,
      completed: result.completed,
      fileExists: result.fileExists,
      downloadedBody: result.downloadedBody,
    }))).toEqual(cases.map(probeCase => ({
      name: probeCase.name,
      enabledPatterns: probeCase.capturePatterns,
      expectedCapture: probeCase.expectedCapture,
      capturedBodies: probeCase.expectedCapture ? [probeCase.expectedCapture] : [],
      suggestedFilename: probeCase.expectedFilename,
      completed: true,
      fileExists: true,
      downloadedBody: probeCase.expectedDownloadedBody,
    })));
  } finally {
    await probe.close();
  }
});

test('Sapoto Fetch body capture probe documents non-HTTP and page-target service worker gaps', async ({ startClient, mcpBrowser, server }, testInfo) => {
  test.skip(!['chrome', 'chromium', 'msedge'].includes(mcpBrowser!), 'Sapoto runtime is Chromium-specific');

  const downloadDir = testInfo.outputPath('fetch-capture-limitations');
  const remoteDebuggingPort = await findFreePort();
  await fs.promises.mkdir(downloadDir, { recursive: true });

  const { client } = await startClient({
    config: {
      browser: {
        sapotoRuntime: true,
        contextOptions: {
          serviceWorkers: 'allow',
        },
        launchOptions: {
          args: [`--remote-debugging-port=${remoteDebuggingPort}`],
        },
      },
      sapotoRuntimePolicy: {
        fetchBodyCapture: true,
      },
    },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.EMPTY_PAGE },
  });

  const probe = await attachSapotoFetchCaptureProbe({
    endpointURL: `http://127.0.0.1:${remoteDebuggingPort}`,
    downloadDir,
  });
  try {
    const cases = createFetchCaptureLimitationCases(server);
    const results = [];
    for (const probeCase of cases) {
      await probeCase.prepare();
      await probe.startCase(probeCase);
      await probeCase.trigger(client);
      results.push(await probe.finishCase(probeCase));
    }

    expect(results.map(result => ({
      name: result.name,
      limitation: result.limitation,
      enabledPatterns: result.enabledPatterns,
      capturedBodies: result.capturedBodies,
      suggestedFilename: result.suggestedFilename,
      completed: result.completed,
      fileExists: result.fileExists,
      downloadedBody: result.downloadedBody,
    }))).toEqual(cases.map(probeCase => ({
      name: probeCase.name,
      limitation: probeCase.limitation,
      enabledPatterns: probeCase.capturePatterns,
      capturedBodies: [],
      suggestedFilename: probeCase.expectedFilename,
      completed: true,
      fileExists: true,
      downloadedBody: probeCase.expectedDownloadedBody,
    })));
  } finally {
    await probe.close();
  }
});
