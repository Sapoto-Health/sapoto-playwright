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

test('connectOverCDP forwards CDP stealth features to Chromium browser options', async ({ browserType, browserName, toImpl }, testInfo) => {
  test.skip(browserName !== 'chromium', 'CDP attach is Chromium-only');

  const port = 9339 + testInfo.workerIndex;
  const browserServer = await browserType.launch({
    args: ['--remote-debugging-port=' + port],
  });
  try {
    const cdpBrowser = await browserType.connectOverCDP({
      endpointURL: `http://127.0.0.1:${port}/`,
      cdpStealth: ['runtime-cycle', 'log-skip', 'worker-runtime'],
    } as any);

    const cdpStealth = toImpl(cdpBrowser).options.cdpStealth;
    expect(cdpStealth).toBeInstanceOf(Set);
    expect([...cdpStealth].sort()).toEqual(['log-skip', 'runtime-cycle', 'worker-runtime']);
    await cdpBrowser.close();
  } finally {
    await browserServer.close().catch(() => {});
  }
});
