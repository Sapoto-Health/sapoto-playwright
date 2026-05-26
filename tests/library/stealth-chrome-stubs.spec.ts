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

import vm from 'vm';
import { test, expect } from '@playwright/test';
import {
  buildStealthInitScript,
  buildChromeStubsSection,
  buildToStringInfrastructure,
} from '../../packages/playwright-core/src/tools/backend/stealthInitScript';

// ---------------------------------------------------------------------------
// Stealth chrome runtime stubs tests (Tracer #1128)
//
// Verifies the chrome.{app,csi,loadTimes} + Notification.permission stubs
// ported from the old fork. Tests run in a Node.js vm.Context with mocked
// browser globals so the generated IIFE can execute without a real browser.
// ---------------------------------------------------------------------------

/**
 * Create a minimal browser-like vm.Context for evaluating the stealth
 * init script. Provides the globals that the script probes/patches.
 */
function createBrowserContext(overrides?: Record<string, any>): vm.Context {
  // Minimal performance stub.
  const performanceStub = {
    now: () => 42.0,
    getEntriesByType: (type: string) => {
      if (type === 'navigation') {
        return [{
          responseStart: 1000,
          domContentLoadedEventEnd: 2000,
          loadEventEnd: 3000,
          responseEnd: 1500,
          fetchStart: 500,
        }];
      }
      return [];
    },
  };

  const globals: Record<string, any> = {
    window: {} as any,
    Date,
    WeakMap,
    Object,
    Function,
    TypeError,
    performance: performanceStub,
    console: { log: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    location: { href: 'https://example.com/' },
    ...overrides,
  };

  // Make window self-referential and expose globals on it (browser semantics).
  globals.window = globals;

  // Notification — default to a stub where permission is 'granted' so the
  // normalizer has something to fix.
  if (!('Notification' in globals)) {
    globals.Notification = { permission: 'granted' };
  }

  // Navigator with webdriver (not tested here but needed for script to not crash).
  if (!('navigator' in globals)) {
    globals.navigator = { webdriver: true };
    globals.Navigator = function Navigator() {};
    globals.Navigator.prototype = Object.getPrototypeOf(globals.navigator);
  }

  const ctx = vm.createContext(globals);
  return ctx;
}

/**
 * Build the full init script with chromeRuntimeStubs enabled and evaluate
 * it in a fresh vm context. Returns the context for inspection.
 */
function buildAndEvaluate(options?: Record<string, any>): vm.Context {
  const script = buildStealthInitScript({
    chromeRuntimeStubs: true,
    ...options,
  });
  const ctx = createBrowserContext();
  vm.runInContext(script, ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
// chrome.app stubs
// ---------------------------------------------------------------------------

test.describe('chrome.app stubs', () => {
  test('chrome.app.isInstalled returns false', () => {
    const ctx = buildAndEvaluate();
    expect(vm.runInContext('chrome.app.isInstalled', ctx)).toBe(false);
  });

  test('chrome.app.getIsInstalled() returns false', () => {
    const ctx = buildAndEvaluate();
    expect(vm.runInContext('chrome.app.getIsInstalled()', ctx)).toBe(false);
  });

  test('chrome.app.getDetails() returns null', () => {
    const ctx = buildAndEvaluate();
    expect(vm.runInContext('chrome.app.getDetails()', ctx)).toBeNull();
  });

  test('chrome.app.InstallState has expected enum values', () => {
    const ctx = buildAndEvaluate();
    const state = vm.runInContext('chrome.app.InstallState', ctx);
    expect(state).toEqual({
      DISABLED: 'disabled',
      INSTALLED: 'installed',
      NOT_INSTALLED: 'not_installed',
    });
  });

  test('chrome.app.RunningState has expected enum values', () => {
    const ctx = buildAndEvaluate();
    const state = vm.runInContext('chrome.app.RunningState', ctx);
    expect(state).toEqual({
      CANNOT_RUN: 'cannot_run',
      READY_TO_RUN: 'ready_to_run',
      RUNNING: 'running',
    });
  });

  test('chrome.app.runningState() returns CANNOT_RUN', () => {
    const ctx = buildAndEvaluate();
    expect(vm.runInContext('chrome.app.runningState()', ctx)).toBe('cannot_run');
  });

  test('chrome.app is not writable (defineProperty makes it frozen)', () => {
    const ctx = buildAndEvaluate();
    // Attempting to overwrite chrome.app should not change it (writable: false).
    vm.runInContext(`
      try { chrome.app = 'overwritten'; } catch (_) {}
    `, ctx);
    expect(vm.runInContext('typeof chrome.app', ctx)).toBe('object');
    expect(vm.runInContext('chrome.app.isInstalled', ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// chrome.csi() stub
// ---------------------------------------------------------------------------

test.describe('chrome.csi() stub', () => {
  test('returns object with pageT, startE, onloadT, tran', () => {
    const ctx = buildAndEvaluate();
    const result = vm.runInContext('chrome.csi()', ctx);
    expect(result).toHaveProperty('pageT');
    expect(result).toHaveProperty('startE');
    expect(result).toHaveProperty('onloadT');
    expect(result).toHaveProperty('tran');
    expect(result.tran).toBe(15);
  });

  test('pageT uses performance.now()', () => {
    const ctx = buildAndEvaluate();
    const result = vm.runInContext('chrome.csi()', ctx);
    // Our mock returns 42.0 from performance.now().
    expect(result.pageT).toBe(42.0);
  });
});

// ---------------------------------------------------------------------------
// chrome.loadTimes() stub
// ---------------------------------------------------------------------------

test.describe('chrome.loadTimes() stub', () => {
  test('returns object with h2 protocol', () => {
    const ctx = buildAndEvaluate();
    const result = vm.runInContext('chrome.loadTimes()', ctx);
    expect(result.connectionInfo).toBe('h2');
    expect(result.npnNegotiatedProtocol).toBe('h2');
  });

  test('wasFetchedViaSpdy is true', () => {
    const ctx = buildAndEvaluate();
    const result = vm.runInContext('chrome.loadTimes()', ctx);
    expect(result.wasFetchedViaSpdy).toBe(true);
  });

  test('wasNpnNegotiated is true', () => {
    const ctx = buildAndEvaluate();
    const result = vm.runInContext('chrome.loadTimes()', ctx);
    expect(result.wasNpnNegotiated).toBe(true);
  });

  test('timing values are sourced from Performance API navigation entries', () => {
    const ctx = buildAndEvaluate();
    const result = vm.runInContext('chrome.loadTimes()', ctx);
    // Our mock nav entry has responseStart=1000, so commitLoadTime should be 1.0.
    expect(result.commitLoadTime).toBe(1.0);
    // fetchStart=500, so requestTime and startLoadTime should be 0.5.
    expect(result.requestTime).toBe(0.5);
    expect(result.startLoadTime).toBe(0.5);
    // domContentLoadedEventEnd=2000 -> 2.0
    expect(result.finishDocumentLoadTime).toBe(2.0);
    // loadEventEnd=3000 -> 3.0
    expect(result.finishLoadTime).toBe(3.0);
    // responseEnd=1500 -> 1.5
    expect(result.firstPaintTime).toBe(1.5);
  });

  test('returns complete set of properties', () => {
    const ctx = buildAndEvaluate();
    const result = vm.runInContext('chrome.loadTimes()', ctx);
    const expectedKeys = [
      'commitLoadTime', 'connectionInfo', 'finishDocumentLoadTime',
      'finishLoadTime', 'firstPaintAfterLoadTime', 'firstPaintTime',
      'navigationType', 'npnNegotiatedProtocol', 'requestTime',
      'startLoadTime', 'wasAlternateProtocolAvailable', 'wasFetchedViaSpdy',
      'wasNpnNegotiated',
    ];
    for (const key of expectedKeys)
      expect(result).toHaveProperty(key);
  });
});

// ---------------------------------------------------------------------------
// Notification.permission normalization
// ---------------------------------------------------------------------------

test.describe('Notification.permission normalization', () => {
  test('normalizes granted to default', () => {
    const ctx = buildAndEvaluate();
    expect(vm.runInContext('Notification.permission', ctx)).toBe('default');
  });

  test('leaves denied/default unchanged', () => {
    // If Notification.permission is already 'denied', it should NOT be touched.
    const script = buildStealthInitScript({ chromeRuntimeStubs: true });
    const ctx = createBrowserContext({ Notification: { permission: 'denied' } });
    vm.runInContext(script, ctx);
    expect(vm.runInContext('Notification.permission', ctx)).toBe('denied');
  });
});

// ---------------------------------------------------------------------------
// toString masking — all stubs return [native code]
// ---------------------------------------------------------------------------

test.describe('toString masking for chrome stubs', () => {
  // NOTE: Function.prototype.toString is patched INSIDE the vm context.
  // We must call .toString() from within the context so the patched version
  // is used, not Node's native Function.prototype.toString.

  test('chrome.csi.toString() contains [native code]', () => {
    const ctx = buildAndEvaluate();
    const str = vm.runInContext('Function.prototype.toString.call(chrome.csi)', ctx);
    expect(str).toContain('[native code]');
    expect(str).toContain('csi');
  });

  test('chrome.loadTimes.toString() contains [native code]', () => {
    const ctx = buildAndEvaluate();
    const str = vm.runInContext('Function.prototype.toString.call(chrome.loadTimes)', ctx);
    expect(str).toContain('[native code]');
    expect(str).toContain('loadTimes');
  });

  test('chrome.app.getIsInstalled.toString() contains [native code]', () => {
    const ctx = buildAndEvaluate();
    const str = vm.runInContext('Function.prototype.toString.call(chrome.app.getIsInstalled)', ctx);
    expect(str).toContain('[native code]');
    expect(str).toContain('getIsInstalled');
  });

  test('chrome.app.getDetails.toString() contains [native code]', () => {
    const ctx = buildAndEvaluate();
    const str = vm.runInContext('Function.prototype.toString.call(chrome.app.getDetails)', ctx);
    expect(str).toContain('[native code]');
    expect(str).toContain('getDetails');
  });

  test('chrome.app.installState.toString() contains [native code]', () => {
    const ctx = buildAndEvaluate();
    const str = vm.runInContext('Function.prototype.toString.call(chrome.app.installState)', ctx);
    expect(str).toContain('[native code]');
    expect(str).toContain('installState');
  });

  test('chrome.app.runningState.toString() contains [native code]', () => {
    const ctx = buildAndEvaluate();
    const str = vm.runInContext('Function.prototype.toString.call(chrome.app.runningState)', ctx);
    expect(str).toContain('[native code]');
    expect(str).toContain('runningState');
  });
});

// ---------------------------------------------------------------------------
// chromeRuntimeStubs: false -> none of these are installed
// ---------------------------------------------------------------------------

test.describe('chromeRuntimeStubs: false does not install stubs', () => {
  test('chrome object is not created', () => {
    const script = buildStealthInitScript({
      chromeRuntimeStubs: false,
      printCapture: true, // need at least one flag so script is non-empty
    });
    const ctx = createBrowserContext();
    // Remove any pre-existing chrome from the context.
    vm.runInContext('delete window.chrome', ctx);
    vm.runInContext(script, ctx);
    // chrome should remain undefined since chromeRuntimeStubs is false.
    expect(vm.runInContext('typeof chrome', ctx)).toBe('undefined');
  });

  test('Notification.permission remains granted when stubs disabled', () => {
    const script = buildStealthInitScript({
      chromeRuntimeStubs: false,
      printCapture: true,
    });
    const ctx = createBrowserContext({ Notification: { permission: 'granted' } });
    vm.runInContext(script, ctx);
    expect(vm.runInContext('Notification.permission', ctx)).toBe('granted');
  });
});

// ---------------------------------------------------------------------------
// buildChromeStubsSection — static string analysis
// ---------------------------------------------------------------------------

test.describe('buildChromeStubsSection static analysis', () => {
  test('output contains chrome.app stub', () => {
    const section = buildChromeStubsSection();
    expect(section).toContain('chrome.app');
    expect(section).toContain('isInstalled: false');
    expect(section).toContain('InstallState');
    expect(section).toContain('RunningState');
  });

  test('output contains chrome.csi stub with _markNative', () => {
    const section = buildChromeStubsSection();
    expect(section).toContain('chrome');
    expect(section).toContain('.csi');
    expect(section).toContain('_markNative');
  });

  test('output contains chrome.loadTimes with h2 protocol', () => {
    const section = buildChromeStubsSection();
    expect(section).toContain('.loadTimes');
    expect(section).toContain("connectionInfo: 'h2'");
    expect(section).toContain("npnNegotiatedProtocol: 'h2'");
    expect(section).toContain('wasFetchedViaSpdy: true');
    expect(section).toContain('wasNpnNegotiated: true');
  });

  test('output contains Notification.permission normalization', () => {
    const section = buildChromeStubsSection();
    expect(section).toContain('Notification');
    expect(section).toContain("'default'");
  });

  test('output references performance.getEntriesByType for loadTimes', () => {
    const section = buildChromeStubsSection();
    expect(section).toContain("performance.getEntriesByType('navigation')");
  });
});
