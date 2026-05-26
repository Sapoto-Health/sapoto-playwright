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

import { playwrightTest as test, expect } from '../config/browserTest';

// Helper: launch a Chromium debug server, connect with given cdpStealth options,
// and return the resolved internal cdpStealth Set.
async function connectAndReadStealth(
  browserType: any,
  toImpl: (rpc: any) => any,
  port: number,
  cdpStealth: string[] | undefined,
): Promise<{ cdpStealth: Set<string>; close: () => Promise<void> }> {
  const browserServer = await browserType.launch({
    args: ['--remote-debugging-port=' + port],
  });
  let cdpBrowser: any;
  try {
    const connectOpts: any = { endpointURL: `http://127.0.0.1:${port}/` };
    if (cdpStealth !== undefined)
      connectOpts.cdpStealth = cdpStealth;
    cdpBrowser = await browserType.connectOverCDP(connectOpts);
    const stealthSet: Set<string> = toImpl(cdpBrowser).options.cdpStealth;
    return {
      cdpStealth: stealthSet,
      close: async () => {
        await cdpBrowser?.close().catch(() => {});
        await browserServer.close().catch(() => {});
      },
    };
  } catch (e) {
    await cdpBrowser?.close().catch(() => {});
    await browserServer.close().catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Existing: all three features forwarded
// ---------------------------------------------------------------------------

test('connectOverCDP forwards CDP stealth features to Chromium browser options', async ({ browserType, browserName, toImpl }, testInfo) => {
  test.skip(browserName !== 'chromium', 'CDP attach is Chromium-only');

  const port = 9339 + testInfo.workerIndex;
  const { cdpStealth, close } = await connectAndReadStealth(
      browserType, toImpl, port,
      ['runtime-cycle', 'log-skip', 'worker-runtime'],
  );
  try {
    expect(cdpStealth).toBeInstanceOf(Set);
    expect([...cdpStealth].sort()).toEqual(['log-skip', 'runtime-cycle', 'worker-runtime']);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Individual subfeature isolation — enable ONE, verify the other two are absent
// ---------------------------------------------------------------------------

test('connectOverCDP with only runtime-cycle excludes log-skip and worker-runtime', async ({ browserType, browserName, toImpl }, testInfo) => {
  test.skip(browserName !== 'chromium', 'CDP attach is Chromium-only');

  const port = 9339 + testInfo.workerIndex;
  const { cdpStealth, close } = await connectAndReadStealth(
      browserType, toImpl, port, ['runtime-cycle'],
  );
  try {
    expect(cdpStealth).toBeInstanceOf(Set);
    expect(cdpStealth.has('runtime-cycle')).toBe(true);
    expect(cdpStealth.has('log-skip')).toBe(false);
    expect(cdpStealth.has('worker-runtime')).toBe(false);
  } finally {
    await close();
  }
});

test('connectOverCDP with only log-skip excludes runtime-cycle and worker-runtime', async ({ browserType, browserName, toImpl }, testInfo) => {
  test.skip(browserName !== 'chromium', 'CDP attach is Chromium-only');

  const port = 9339 + testInfo.workerIndex;
  const { cdpStealth, close } = await connectAndReadStealth(
      browserType, toImpl, port, ['log-skip'],
  );
  try {
    expect(cdpStealth).toBeInstanceOf(Set);
    expect(cdpStealth.has('log-skip')).toBe(true);
    expect(cdpStealth.has('runtime-cycle')).toBe(false);
    expect(cdpStealth.has('worker-runtime')).toBe(false);
  } finally {
    await close();
  }
});

test('connectOverCDP with only worker-runtime excludes runtime-cycle and log-skip', async ({ browserType, browserName, toImpl }, testInfo) => {
  test.skip(browserName !== 'chromium', 'CDP attach is Chromium-only');

  const port = 9339 + testInfo.workerIndex;
  const { cdpStealth, close } = await connectAndReadStealth(
      browserType, toImpl, port, ['worker-runtime'],
  );
  try {
    expect(cdpStealth).toBeInstanceOf(Set);
    expect(cdpStealth.has('worker-runtime')).toBe(true);
    expect(cdpStealth.has('runtime-cycle')).toBe(false);
    expect(cdpStealth.has('log-skip')).toBe(false);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Kill-switch: empty array → no stealth features
// ---------------------------------------------------------------------------

test('connectOverCDP with empty cdpStealth array applies no features (kill-switch)', async ({ browserType, browserName, toImpl }, testInfo) => {
  test.skip(browserName !== 'chromium', 'CDP attach is Chromium-only');

  const port = 9339 + testInfo.workerIndex;
  const { cdpStealth, close } = await connectAndReadStealth(
      browserType, toImpl, port, [],
  );
  try {
    expect(cdpStealth).toBeInstanceOf(Set);
    expect(cdpStealth.size).toBe(0);
  } finally {
    await close();
  }
});
