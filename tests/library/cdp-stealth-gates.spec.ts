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

/**
 * Sapoto PRD #1045 / Tracer A3 — per-feature CDP-stealth gates.
 *
 * A1 introduced the `Set<CdpStealthFeature>` shape on BrowserOptions but kept
 * every call site guarded by the coarse `cdpStealth.size > 0` placeholder.
 * A3 decomposes that into per-subcomponent membership checks. These tests
 * exercise each gate in isolation by:
 *
 *   1. Asserting the pure-decision helpers in `cdpStealthGates.ts` return
 *      the right boolean for every combination of feature flags.
 *   2. Simulating the call site with a stub CDP client that records the
 *      `send()` calls a real CRSession would receive, then asserting the
 *      expected sequence of `Log.enable` / `Runtime.enable` / `Runtime.disable`
 *      messages.
 *
 * Three distinct subcomponents, three test cases:
 *   - log-skip                                  → Log.enable skipped iff flag set
 *   - runtime-cycle (init + frameNavigated)     → cycle fires iff flag set
 *   - worker-runtime (crServiceWorker)          → cycle fires iff flag set
 *
 * `network-skip` is intentionally absent (codex P1 review on PR #28 removed
 * Network.enable gating because it broke `page.on('request')` listeners).
 */

import { test, expect } from '@playwright/test';
import type { CdpStealthFeature } from '../../packages/playwright-core/src/server/cdpStealth';
import {
  applyWorkerStealth,
  shouldSkipLogEnable,
  shouldCycleRuntimeOnInit,
  shouldCycleRuntimeOnFrameNavigation,
  shouldCycleWorkerRuntime,
} from '../../packages/playwright-core/src/server/chromium/cdpStealthGates';

// ----------------------------------------------------------------------
// Test helpers
// ----------------------------------------------------------------------

function gates(...features: CdpStealthFeature[]): Set<CdpStealthFeature> {
  return new Set<CdpStealthFeature>(features);
}

/**
 * Minimal stub of the `client.send(method, params?)` interface that captures
 * every issued CDP call and supports the chained `.then(...)` pattern the
 * real CRSession exposes. The init / frameNavigated / serviceWorker paths
 * all rely on this surface and nothing else (no events, no `_sendMayFail`
 * except where explicitly handled), so the stub is enough to exercise the
 * gate behavior end-to-end without spinning up Chromium.
 */
type SendCall = { method: string; params?: any };
function createStubClient(): {
  calls: SendCall[];
  send: (method: string, params?: any) => Promise<any>;
  sendMayFail: (method: string, params?: any) => Promise<any>;
} {
  const calls: SendCall[] = [];
  const send = async (method: string, params?: any) => {
    calls.push({ method, params });
    return {};
  };
  const sendMayFail = async (method: string, params?: any) => {
    calls.push({ method, params });
    return undefined;
  };
  return { calls, send, sendMayFail };
}

// ----------------------------------------------------------------------
// shouldSkipLogEnable — pure-decision helper
// ----------------------------------------------------------------------

test('shouldSkipLogEnable returns true iff log-skip is in the set', () => {
  expect(shouldSkipLogEnable(gates())).toBe(false);
  expect(shouldSkipLogEnable(gates('log-skip'))).toBe(true);
  expect(shouldSkipLogEnable(gates('runtime-cycle'))).toBe(false);
  expect(shouldSkipLogEnable(gates('worker-runtime'))).toBe(false);
  expect(shouldSkipLogEnable(gates('log-skip', 'runtime-cycle', 'worker-runtime'))).toBe(true);
});

// ----------------------------------------------------------------------
// log-skip integration — stub CDP captures issued calls
// ----------------------------------------------------------------------

test('log-skip: Log.enable fires iff cdpStealth does NOT contain log-skip', async () => {
  // Simulate the crPage initializer fragment:
  //   ...(shouldSkipLogEnable(cdpStealth) ? [] : [client.send('Log.enable', {})])
  for (const features of [gates(), gates('runtime-cycle'), gates('worker-runtime')]) {
    const stub = createStubClient();
    const calls = shouldSkipLogEnable(features) ? [] : [stub.send('Log.enable', {})];
    await Promise.all(calls);
    expect(stub.calls.map(c => c.method), `features=${[...features].join(',')}`).toEqual(['Log.enable']);
  }

  for (const features of [gates('log-skip'), gates('log-skip', 'runtime-cycle', 'worker-runtime')]) {
    const stub = createStubClient();
    const calls = shouldSkipLogEnable(features) ? [] : [stub.send('Log.enable', {})];
    await Promise.all(calls);
    expect(stub.calls.map(c => c.method), `features=${[...features].join(',')}`).toEqual([]);
  }
});

// ----------------------------------------------------------------------
// runtime-cycle (init + frameNavigated) — stub CDP captures issued calls
// ----------------------------------------------------------------------

test('runtime-cycle on init: Runtime.enable always fires; Runtime.disable cycle fires iff flag set', async () => {
  // Simulate the crPage initializer fragment:
  //   client.send('Runtime.enable', {}).then(() => {
  //     if (shouldCycleRuntimeOnInit(cdpStealth))
  //       return Promise.resolve().then(() => client._sendMayFail('Runtime.disable'));
  //   });

  // Case 1: flag absent — Runtime.enable only, no disable.
  for (const features of [gates(), gates('log-skip'), gates('worker-runtime')]) {
    const stub = createStubClient();
    await stub.send('Runtime.enable', {}).then(async () => {
      if (shouldCycleRuntimeOnInit(features))
        await Promise.resolve().then(() => stub.sendMayFail('Runtime.disable'));
    });
    expect(stub.calls.map(c => c.method), `features=${[...features].join(',')}`).toEqual(['Runtime.enable']);
  }

  // Case 2: flag present — Runtime.enable then Runtime.disable cycle.
  for (const features of [gates('runtime-cycle'), gates('runtime-cycle', 'log-skip', 'worker-runtime')]) {
    const stub = createStubClient();
    await stub.send('Runtime.enable', {}).then(async () => {
      if (shouldCycleRuntimeOnInit(features))
        await Promise.resolve().then(() => stub.sendMayFail('Runtime.disable'));
    });
    expect(stub.calls.map(c => c.method), `features=${[...features].join(',')}`).toEqual([
      'Runtime.enable',
      'Runtime.disable',
    ]);
  }
});

test('runtime-cycle on frameNavigated: cycle fires only when flag set AND navigation is non-initial', async () => {
  // Simulate the crPage frameNavigated fragment:
  //   if (shouldCycleRuntimeOnFrameNavigation(cdpStealth) && !initial) {
  //     _onExecutionContextsCleared();
  //     client.send('Runtime.enable', {}).then(() =>
  //       Promise.resolve().then(() => client._sendMayFail('Runtime.disable'))
  //     ).catch(() => {});
  //   }

  // Case 1: flag absent — no Runtime calls regardless of `initial`.
  for (const features of [gates(), gates('log-skip'), gates('worker-runtime')]) {
    for (const initial of [false, true]) {
      const stub = createStubClient();
      if (shouldCycleRuntimeOnFrameNavigation(features) && !initial)
        await stub.send('Runtime.enable', {}).then(() => stub.sendMayFail('Runtime.disable')).catch(() => {});
      expect(stub.calls.map(c => c.method), `features=${[...features].join(',')} initial=${initial}`).toEqual([]);
    }
  }

  // Case 2: flag present, initial=true — also no calls (only fires on non-initial).
  {
    const stub = createStubClient();
    const features = gates('runtime-cycle');
    const initial = true;
    if (shouldCycleRuntimeOnFrameNavigation(features) && !initial)
      await stub.send('Runtime.enable', {}).then(() => stub.sendMayFail('Runtime.disable')).catch(() => {});
    expect(stub.calls.map(c => c.method)).toEqual([]);
  }

  // Case 3: flag present, initial=false — full Runtime.enable → Runtime.disable cycle.
  {
    const stub = createStubClient();
    const features = gates('runtime-cycle');
    const initial = false;
    if (shouldCycleRuntimeOnFrameNavigation(features) && !initial)
      await stub.send('Runtime.enable', {}).then(() => stub.sendMayFail('Runtime.disable')).catch(() => {});
    expect(stub.calls.map(c => c.method)).toEqual(['Runtime.enable', 'Runtime.disable']);
  }
});

// ----------------------------------------------------------------------
// worker-runtime — net-new wiring in crServiceWorker.ts
// ----------------------------------------------------------------------

test('worker-runtime: applyWorkerStealth issues Runtime.enable always; Runtime.disable iff flag set; runIfWaitingForDebugger ALWAYS last', async () => {
  // This test drives the real production helper (`applyWorkerStealth` exported
  // from cdpStealthGates.ts) — the same function `CRServiceWorker` calls — so
  // the assertion proves the production call sequence, not a test-local copy.
  //
  // Critical ordering: `Runtime.runIfWaitingForDebugger` MUST land AFTER
  // `Runtime.disable` (when the cycle is on). If it fires first the worker
  // resumes before the disable, exposing the long-lived Runtime domain to
  // worker scripts and defeating the entire mitigation.

  // Case 1: flag absent — Runtime.enable + runIfWaitingForDebugger, NO Runtime.disable.
  for (const features of [gates(), gates('log-skip'), gates('runtime-cycle')]) {
    const stub = createStubClient();
    await applyWorkerStealth(stub, features);
    expect(stub.calls.map(c => c.method), `features=${[...features].join(',')}`).toEqual([
      'Runtime.enable',
      'Runtime.runIfWaitingForDebugger',
    ]);
  }

  // Case 2: flag present — Runtime.enable, Runtime.disable cycle, then runIfWaitingForDebugger LAST.
  for (const features of [gates('worker-runtime'), gates('worker-runtime', 'log-skip', 'runtime-cycle')]) {
    const stub = createStubClient();
    await applyWorkerStealth(stub, features);
    const methods = stub.calls.map(c => c.method);
    expect(methods, `features=${[...features].join(',')}`).toEqual([
      'Runtime.enable',
      'Runtime.disable',
      'Runtime.runIfWaitingForDebugger',
    ]);
    // Explicit ordering invariant: runIfWaitingForDebugger AFTER Runtime.disable.
    expect(
        methods.indexOf('Runtime.runIfWaitingForDebugger'),
        `runIfWaitingForDebugger must follow Runtime.disable (features=${[...features].join(',')})`,
    ).toBeGreaterThan(methods.indexOf('Runtime.disable'));
  }
});

// Spec concern 2 (PRD #1045 A3 codex follow-up): existing tests cover each gate
// alone plus the all-flags bundle. The `log-skip` + `worker-runtime` pair
// (without `runtime-cycle`) was the only combination not exercised; without it
// we cannot empirically rule out cross-gate coupling between log-skip and the
// worker-runtime cycle. Asserts gate independence via the production helper.
test('log-skip + worker-runtime (no runtime-cycle): gates compose independently — worker cycle still fires, page init is unaffected', async () => {
  const features = gates('log-skip', 'worker-runtime');

  // Decision helpers: each gate reports its own membership without contamination.
  expect(shouldSkipLogEnable(features)).toBe(true);
  expect(shouldCycleRuntimeOnInit(features)).toBe(false);
  expect(shouldCycleRuntimeOnFrameNavigation(features)).toBe(false);
  expect(shouldCycleWorkerRuntime(features)).toBe(true);

  // Worker path: applyWorkerStealth runs the full cycle ending with runIfWaitingForDebugger.
  const stub = createStubClient();
  await applyWorkerStealth(stub, features);
  const methods = stub.calls.map(c => c.method);
  expect(methods).toEqual(['Runtime.enable', 'Runtime.disable', 'Runtime.runIfWaitingForDebugger']);
  expect(methods.indexOf('Runtime.runIfWaitingForDebugger'))
      .toBeGreaterThan(methods.indexOf('Runtime.disable'));

  // Page init path: log-skip suppresses Log.enable, runtime-cycle absent so no Runtime.disable.
  const pageStub = createStubClient();
  const initCalls = shouldSkipLogEnable(features) ? [] : [pageStub.send('Log.enable', {})];
  initCalls.push(pageStub.send('Runtime.enable', {}).then(async () => {
    if (shouldCycleRuntimeOnInit(features))
      await Promise.resolve().then(() => pageStub.sendMayFail('Runtime.disable'));
  }));
  await Promise.all(initCalls);
  expect(pageStub.calls.map(c => c.method)).toEqual(['Runtime.enable']);
});

// ----------------------------------------------------------------------
// Cross-helper sanity: each gate independent of the others
// ----------------------------------------------------------------------

test('gates are independent: flipping one does not change the verdict of the others', () => {
  // log-skip alone
  expect(shouldSkipLogEnable(gates('log-skip'))).toBe(true);
  expect(shouldCycleRuntimeOnInit(gates('log-skip'))).toBe(false);
  expect(shouldCycleRuntimeOnFrameNavigation(gates('log-skip'))).toBe(false);
  expect(shouldCycleWorkerRuntime(gates('log-skip'))).toBe(false);

  // runtime-cycle alone (drives BOTH crPage sites)
  expect(shouldSkipLogEnable(gates('runtime-cycle'))).toBe(false);
  expect(shouldCycleRuntimeOnInit(gates('runtime-cycle'))).toBe(true);
  expect(shouldCycleRuntimeOnFrameNavigation(gates('runtime-cycle'))).toBe(true);
  expect(shouldCycleWorkerRuntime(gates('runtime-cycle'))).toBe(false);

  // worker-runtime alone
  expect(shouldSkipLogEnable(gates('worker-runtime'))).toBe(false);
  expect(shouldCycleRuntimeOnInit(gates('worker-runtime'))).toBe(false);
  expect(shouldCycleRuntimeOnFrameNavigation(gates('worker-runtime'))).toBe(false);
  expect(shouldCycleWorkerRuntime(gates('worker-runtime'))).toBe(true);
});
