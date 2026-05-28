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

// Regression guard for commit 463be3479: the protocol channel validator
// silently stripped humanizeInput and stealthMode across the client/server
// boundary. The pure unit tests on bezierInput would not catch this; we
// need to prove the flags actually arrive at BrowserOptions after a full
// launch — i.e. survive protocol.yml validation in both directions.
//
// PRD #1045 / Tracer A1: the wire-format `stealthMode` boolean has been
// replaced by `cdpStealth: string[]` (rehydrated to Set<CdpStealthFeature>
// at the server boundary). The legacy `stealthMode: true` boolean is
// translated by the client-side alias (`resolveCdpStealthAlias`) into the
// new shape for one release cycle, so the existing third test still passes
// unchanged; the new fourth test exercises the post-migration call shape.
//
// Approach: launch via the browserType fixture, then hop from the client
// Browser to the server-side impl via the `toImpl` fixture (the canonical
// pattern used elsewhere in tests/library, e.g. channels.spec.ts and
// slowmo.spec.ts). Once on the server side, `browser.options` is the
// authoritative BrowserOptions that crInput / crPage consume.

import { playwrightTest, expect } from '../config/browserTest';

playwrightTest.skip(({ browserName }) => browserName !== 'chromium',
    'humanizeInput + cdpStealth are Chromium-only fork options');
playwrightTest.skip(({ mode }) => mode !== 'default',
    'toImpl access requires in-process server, not available in service mode');

playwrightTest('humanizeInput flag reaches BrowserOptions via launch', async ({ browserType, toImpl }) => {
  const browser = await browserType.launch({
    // @ts-expect-error — humanizeInput is an internal fork-only option
    humanizeInput: true,
  });
  try {
    const serverBrowser = toImpl(browser);
    expect(serverBrowser.options.humanizeInput, 'humanizeInput not forwarded to BrowserOptions').toBe(true);
  } finally {
    await browser.close();
  }
});

playwrightTest('legacy stealthMode: true expands to cdpStealth Set on the server', async ({ browserType, toImpl }) => {
  // Backward-compat: callers still passing the legacy boolean get the full
  // 3-feature bundle materialized on the server side. PRD #1045 / Tracer A1.
  const browser = await browserType.launch({
    // @ts-expect-error — stealthMode is the legacy alias, kept for one release cycle
    stealthMode: true,
  });
  try {
    const serverBrowser = toImpl(browser);
    const cdpStealth = serverBrowser.options.cdpStealth;
    expect(cdpStealth, 'cdpStealth not materialized on BrowserOptions').toBeInstanceOf(Set);
    expect(cdpStealth.has('runtime-cycle'), 'runtime-cycle missing from alias expansion').toBe(true);
    expect(cdpStealth.has('log-skip'), 'log-skip missing from alias expansion').toBe(true);
    expect(cdpStealth.has('worker-runtime'), 'worker-runtime missing from alias expansion').toBe(true);
    expect(cdpStealth.size, 'unexpected extra features in alias expansion').toBe(3);
  } finally {
    await browser.close();
  }
});

playwrightTest('explicit cdpStealth array rehydrates as a typed Set on the server', async ({ browserType, toImpl }) => {
  // Post-migration call shape: the caller chose only `log-skip`. The wire
  // payload is a string[], deserialized to Set<CdpStealthFeature> server-side.
  const browser = await browserType.launch({
    // @ts-expect-error — cdpStealth is an internal fork-only option (Tracer A1)
    cdpStealth: ['log-skip'],
  });
  try {
    const serverBrowser = toImpl(browser);
    const cdpStealth = serverBrowser.options.cdpStealth;
    expect(cdpStealth, 'cdpStealth not materialized on BrowserOptions').toBeInstanceOf(Set);
    expect(cdpStealth.size, 'unexpected size after channel round-trip').toBe(1);
    expect(cdpStealth.has('log-skip'), 'log-skip lost in transit').toBe(true);
  } finally {
    await browser.close();
  }
});

playwrightTest('neither flag is set when omitted (default)', async ({ browserType, toImpl }) => {
  const browser = await browserType.launch();
  try {
    const serverBrowser = toImpl(browser);
    expect(serverBrowser.options.humanizeInput, 'humanizeInput leaked when not requested').toBeFalsy();
    // PRD #1045 / Tracer A1: cdpStealth is always a Set; default is empty.
    expect(serverBrowser.options.cdpStealth, 'cdpStealth not materialized on BrowserOptions').toBeInstanceOf(Set);
    expect(serverBrowser.options.cdpStealth.size, 'cdpStealth leaked when not requested').toBe(0);
    // PRD #1045 / Tracer A1: the decomposed booleans default to false.
    expect(serverBrowser.options.printCapture, 'printCapture leaked when not requested').toBe(false);
    expect(serverBrowser.options.focusEmulation, 'focusEmulation leaked when not requested').toBe(false);
  } finally {
    await browser.close();
  }
});

// PRD #1045 / Tracer A1 — Codex P1 follow-up: the launchServer path runs its
// own validator pass against BrowserTypeLaunchParams. Because that schema no
// longer declares `stealthMode` (A1 replaced it with `cdpStealth`), `tObject`
// silently dropped the legacy boolean before the alias could expand it. These
// tests pin the now-wired `resolveCdpStealthAlias` call inside
// BrowserServerLauncherImpl.launchServer. We reach the server-side browser via
// the test-only `_preLaunchedBrowserForTest` hook on the returned BrowserServer.
playwrightTest('launchServer expands legacy stealthMode: true to cdpStealth Set', async ({ browserType }) => {
  const server = await browserType.launchServer({
    // @ts-expect-error — stealthMode is the legacy alias, kept for one release cycle
    stealthMode: true,
  });
  try {
    const serverBrowser = (server as any)._preLaunchedBrowserForTest;
    expect(serverBrowser, '_preLaunchedBrowserForTest hook missing from BrowserServer').toBeTruthy();
    const cdpStealth = serverBrowser.options.cdpStealth;
    expect(cdpStealth, 'cdpStealth not materialized on launchServer BrowserOptions').toBeInstanceOf(Set);
    expect(cdpStealth.has('runtime-cycle'), 'runtime-cycle missing from launchServer alias expansion').toBe(true);
    expect(cdpStealth.has('log-skip'), 'log-skip missing from launchServer alias expansion').toBe(true);
    expect(cdpStealth.has('worker-runtime'), 'worker-runtime missing from launchServer alias expansion').toBe(true);
    expect(cdpStealth.size, 'unexpected extra features in launchServer alias expansion').toBe(3);
  } finally {
    await server.close();
  }
});

playwrightTest('launchServer with legacy stealthMode: false yields empty cdpStealth', async ({ browserType }) => {
  const server = await browserType.launchServer({
    // @ts-expect-error — stealthMode is the legacy alias, kept for one release cycle
    stealthMode: false,
  });
  try {
    const serverBrowser = (server as any)._preLaunchedBrowserForTest;
    const cdpStealth = serverBrowser.options.cdpStealth;
    expect(cdpStealth, 'cdpStealth not materialized on launchServer BrowserOptions').toBeInstanceOf(Set);
    expect(cdpStealth.size, 'stealthMode: false should produce empty cdpStealth').toBe(0);
  } finally {
    await server.close();
  }
});

playwrightTest('launchServer preserves explicit cdpStealth (alias is a no-op)', async ({ browserType }) => {
  const server = await browserType.launchServer({
    // @ts-expect-error — cdpStealth is an internal fork-only option (Tracer A1)
    cdpStealth: ['log-skip'],
  });
  try {
    const serverBrowser = (server as any)._preLaunchedBrowserForTest;
    const cdpStealth = serverBrowser.options.cdpStealth;
    expect(cdpStealth, 'cdpStealth not materialized on launchServer BrowserOptions').toBeInstanceOf(Set);
    expect(cdpStealth.size, 'explicit cdpStealth size lost through launchServer').toBe(1);
    expect(cdpStealth.has('log-skip'), 'explicit log-skip lost through launchServer').toBe(true);
  } finally {
    await server.close();
  }
});
