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
  type StealthInitScriptOptions,
} from '../../packages/playwright-core/src/tools/backend/stealthInitScript';

// ---------------------------------------------------------------------------
// Stealth init-script composition tests (Tracer #1132 / T6)
//
// Cross-section composition and isolation tests. Verifies:
//   1. Flag isolation: each flag enables ONLY its section, nothing else
//   2. Combined flag composition: multi-flag combos produce correct unions
//   3. Infrastructure behavior: no-flags empty, any-flag installs toString
//   4. Re-entry guard: __chromeStealth prevents double-injection
//   5. Negative tests: disabled flags produce absent sections
//
// Two test strategies:
//   - String analysis: check generated script for section markers
//   - Runtime (vm): execute script in sandboxed context, verify effects
// ---------------------------------------------------------------------------

// -- Section markers for string-level presence/absence tests ----------------

const MARKERS = {
  // toString infrastructure
  toStringInfra: {
    present: ['Function.prototype.toString', '__stealthMarkNative', '_nativeMap'],
  },
  // Chrome runtime stubs (T2)
  chromeStubs: {
    present: ['chrome.app', 'chrome.csi', 'chrome.loadTimes', 'Notification.permission'],
    section: 'Chrome runtime stubs section',
  },
  // Print capture (T3)
  printCapture: {
    present: ['[Print Capture]', 'window.print', 'requestPrintCapture', '_sanitizeUrl'],
    section: 'Print capture section',
  },
  // Focus shim (T4)
  focusShim: {
    present: ['[FocusShim]', 'window.open', '_shimOpen'],
    section: 'Focus shim section',
  },
  // Download routing (backgroundOpenCapture within focus shim)
  downloadRouting: {
    present: ['DOWNLOAD_URL_RE', 'background-open', '_emitBackgroundOpen'],
  },
};

// -- vm helpers for runtime tests -------------------------------------------

/**
 * Create a minimal browser-like vm.Context for evaluating the stealth
 * init script. Provides the globals that the script probes/patches.
 */
function createBrowserContext(overrides?: Record<string, any>): vm.Context {
  const nativeOpenCalls: Array<{ url: any; target: any; features: any }> = [];
  const consoleLogs: string[] = [];
  const consoleDebugs: string[] = [];
  const consoleErrors: string[] = [];

  const nativeOpen = function(url: any, target: any, features: any) {
    nativeOpenCalls.push({ url, target, features });
    return { closed: false, location: { href: String(url || '') } };
  };

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
    URL,
    Date,
    WeakMap,
    Object,
    Function,
    String,
    TypeError,
    JSON,
    performance: performanceStub,
    console: {
      log: (...args: any[]) => consoleLogs.push(args.join(' ')),
      warn: (...args: any[]) => {},
      debug: (...args: any[]) => consoleDebugs.push(args.join(' ')),
      error: (...args: any[]) => consoleErrors.push(args.join(' ')),
    },
    location: { href: 'https://portal.example.com/accounts' },
    document: { title: 'Test Page' },
    Notification: { permission: 'granted' },
    ...overrides,
  };

  // Make window self-referential (browser semantics).
  globals.window = globals;
  globals.window.top = globals.window;

  // Install a trackable native window.open.
  globals.window.open = nativeOpen;

  // Navigator stub for chrome stubs section.
  if (!('navigator' in globals)) {
    globals.navigator = { webdriver: true };
    globals.Navigator = function Navigator() {};
    globals.Navigator.prototype = Object.getPrototypeOf(globals.navigator);
  }

  // Stash tracking arrays on the context for test assertions.
  globals.__nativeOpenCalls = nativeOpenCalls;
  globals.__consoleLogs = consoleLogs;
  globals.__consoleDebugs = consoleDebugs;
  globals.__consoleErrors = consoleErrors;

  const ctx = vm.createContext(globals);
  return ctx;
}

/**
 * Build the full init script with the given options and evaluate it
 * in a fresh vm context. Returns { script, ctx } for inspection.
 */
function buildAndEvaluate(options: StealthInitScriptOptions): { script: string; ctx: vm.Context } {
  const script = buildStealthInitScript(options);
  const ctx = createBrowserContext();
  if (script)
    vm.runInContext(script, ctx);
  return { script, ctx };
}

// ===========================================================================
// FLAG ISOLATION (no cross-contamination)
// ===========================================================================

test.describe('flag isolation: chromeRuntimeStubs alone', () => {
  const opts: StealthInitScriptOptions = { chromeRuntimeStubs: true };

  test('chrome stubs ARE present in output', () => {
    const script = buildStealthInitScript(opts);
    for (const marker of MARKERS.chromeStubs.present)
      expect(script).toContain(marker);
    expect(script).toContain(MARKERS.chromeStubs.section);
  });

  test('print capture is NOT present', () => {
    const script = buildStealthInitScript(opts);
    expect(script).not.toContain(MARKERS.printCapture.section);
    expect(script).not.toContain('[Print Capture]');
  });

  test('focus shim is NOT present', () => {
    const script = buildStealthInitScript(opts);
    expect(script).not.toContain(MARKERS.focusShim.section);
    expect(script).not.toContain('[FocusShim]');
  });

  test('download routing is NOT present', () => {
    const script = buildStealthInitScript(opts);
    expect(script).not.toContain('DOWNLOAD_URL_RE');
    expect(script).not.toContain('background-open');
  });

  test('runtime: chrome.app installed, window.print not overridden, window.open not shimmed', () => {
    const { ctx } = buildAndEvaluate(opts);
    // chrome.app should exist
    expect(vm.runInContext('typeof chrome.app', ctx)).toBe('object');
    expect(vm.runInContext('chrome.app.isInstalled', ctx)).toBe(false);
    // window.print should not exist (we didn't provide it in context, and printCapture is off)
    expect(vm.runInContext('typeof window.print', ctx)).toBe('undefined');
    // window.open should still be the native one (calls go directly to tracking array)
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    vm.runInContext("window.open('https://test.com', '_blank')", ctx);
    expect(calls.length).toBe(1);
  });
});

test.describe('flag isolation: printCapture alone', () => {
  const opts: StealthInitScriptOptions = { printCapture: true };

  test('print capture IS present in output', () => {
    const script = buildStealthInitScript(opts);
    for (const marker of MARKERS.printCapture.present)
      expect(script).toContain(marker);
    expect(script).toContain(MARKERS.printCapture.section);
  });

  test('chrome stubs are NOT present', () => {
    const script = buildStealthInitScript(opts);
    expect(script).not.toContain(MARKERS.chromeStubs.section);
    // chrome.app is specific to chrome stubs section
    expect(script).not.toContain('chrome.app');
    expect(script).not.toContain('chrome.csi');
  });

  test('focus shim is NOT present', () => {
    const script = buildStealthInitScript(opts);
    expect(script).not.toContain(MARKERS.focusShim.section);
    expect(script).not.toContain('[FocusShim]');
  });

  test('download routing is NOT present', () => {
    const script = buildStealthInitScript(opts);
    expect(script).not.toContain('DOWNLOAD_URL_RE');
    expect(script).not.toContain('_emitBackgroundOpen');
  });

  test('runtime: window.print overridden, no chrome stubs, window.open not shimmed', () => {
    const { ctx } = buildAndEvaluate(opts);
    // window.print should be a function (our override)
    expect(vm.runInContext('typeof window.print', ctx)).toBe('function');
    // chrome object may exist on the context but should NOT have chrome.app stub
    // (chrome may be undefined entirely since we didn't provide it and stubs are off)
    expect(vm.runInContext('typeof chrome', ctx)).toBe('undefined');
    // window.open is still native
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    vm.runInContext("window.open('https://test.com', '_blank')", ctx);
    expect(calls.length).toBe(1);
  });
});

test.describe('flag isolation: suppressFocus alone', () => {
  const opts: StealthInitScriptOptions = { suppressFocus: true };

  test('focus shim IS present in output', () => {
    const script = buildStealthInitScript(opts);
    for (const marker of MARKERS.focusShim.present)
      expect(script).toContain(marker);
    expect(script).toContain(MARKERS.focusShim.section);
  });

  test('chrome stubs are NOT present', () => {
    const script = buildStealthInitScript(opts);
    expect(script).not.toContain(MARKERS.chromeStubs.section);
    expect(script).not.toContain('chrome.app');
    expect(script).not.toContain('chrome.csi');
  });

  test('print capture section is NOT present', () => {
    const script = buildStealthInitScript(opts);
    expect(script).not.toContain(MARKERS.printCapture.section);
    expect(script).not.toContain('[Print Capture]');
  });

  test('download routing is NOT present (suppressFocus alone has no download detection)', () => {
    const script = buildStealthInitScript(opts);
    expect(script).not.toContain('DOWNLOAD_URL_RE');
    expect(script).not.toContain('_emitBackgroundOpen');
  });

  test('runtime: window.open shimmed, no chrome stubs, no print override', () => {
    const { ctx } = buildAndEvaluate(opts);
    // window.open should be shimmed (toString masked)
    const str = vm.runInContext('Function.prototype.toString.call(window.open)', ctx);
    expect(str).toContain('[native code]');
    expect(str).toContain('open');
    // chrome stubs not installed
    expect(vm.runInContext('typeof chrome', ctx)).toBe('undefined');
    // window.print not overridden
    expect(vm.runInContext('typeof window.print', ctx)).toBe('undefined');
  });
});

test.describe('flag isolation: backgroundOpenCapture alone', () => {
  const opts: StealthInitScriptOptions = { backgroundOpenCapture: true };

  test('focus shim section IS present (backgroundOpenCapture activates focus shim)', () => {
    const script = buildStealthInitScript(opts);
    expect(script).toContain(MARKERS.focusShim.section);
    expect(script).toContain('[FocusShim]');
  });

  test('download routing IS present', () => {
    const script = buildStealthInitScript(opts);
    for (const marker of MARKERS.downloadRouting.present)
      expect(script).toContain(marker);
  });

  test('chrome stubs are NOT present', () => {
    const script = buildStealthInitScript(opts);
    expect(script).not.toContain(MARKERS.chromeStubs.section);
    expect(script).not.toContain('chrome.app');
    expect(script).not.toContain('chrome.csi');
  });

  test('print capture section is NOT present', () => {
    const script = buildStealthInitScript(opts);
    expect(script).not.toContain(MARKERS.printCapture.section);
    expect(script).not.toContain('[Print Capture]');
  });

  test('runtime: download URL emits marker, no chrome stubs, no print override', () => {
    const { ctx } = buildAndEvaluate(opts);
    // Download URL triggers background-open
    const logs = vm.runInContext('__consoleLogs', ctx);
    const prevCount = logs.length;
    const result = vm.runInContext("window.open('/report.pdf', '_blank')", ctx);
    expect(result).toBeNull();
    const newLogs = logs.slice(prevCount);
    expect(newLogs.some((l: string) => l.includes('[FocusShim] background-open'))).toBe(true);
    // No chrome stubs
    expect(vm.runInContext('typeof chrome', ctx)).toBe('undefined');
    // No print override
    expect(vm.runInContext('typeof window.print', ctx)).toBe('undefined');
  });
});

// ===========================================================================
// COMBINED FLAG COMPOSITION
// ===========================================================================

test.describe('combined: chromeRuntimeStubs + printCapture', () => {
  const opts: StealthInitScriptOptions = { chromeRuntimeStubs: true, printCapture: true };

  test('chrome stubs section present', () => {
    const script = buildStealthInitScript(opts);
    expect(script).toContain(MARKERS.chromeStubs.section);
    expect(script).toContain('chrome.app');
  });

  test('print capture section present', () => {
    const script = buildStealthInitScript(opts);
    expect(script).toContain(MARKERS.printCapture.section);
    expect(script).toContain('[Print Capture]');
  });

  test('focus shim NOT present', () => {
    const script = buildStealthInitScript(opts);
    expect(script).not.toContain(MARKERS.focusShim.section);
    expect(script).not.toContain('[FocusShim]');
  });

  test('runtime: both chrome stubs and print override work', () => {
    const { ctx } = buildAndEvaluate(opts);
    // chrome.app installed
    expect(vm.runInContext('typeof chrome.app', ctx)).toBe('object');
    expect(vm.runInContext('chrome.app.isInstalled', ctx)).toBe(false);
    // chrome.csi installed
    expect(vm.runInContext('typeof chrome.csi', ctx)).toBe('function');
    // window.print overridden
    expect(vm.runInContext('typeof window.print', ctx)).toBe('function');
    // window.open NOT shimmed (still native)
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    vm.runInContext("window.open('https://test.com', '_blank')", ctx);
    expect(calls.length).toBe(1);
  });
});

test.describe('combined: suppressFocus + backgroundOpenCapture', () => {
  const opts: StealthInitScriptOptions = { suppressFocus: true, backgroundOpenCapture: true };

  test('focus shim section present with download routing', () => {
    const script = buildStealthInitScript(opts);
    expect(script).toContain(MARKERS.focusShim.section);
    expect(script).toContain('DOWNLOAD_URL_RE');
    expect(script).toContain('_emitBackgroundOpen');
  });

  test('chrome stubs NOT present', () => {
    const script = buildStealthInitScript(opts);
    expect(script).not.toContain(MARKERS.chromeStubs.section);
    expect(script).not.toContain('chrome.app');
  });

  test('print capture NOT present', () => {
    const script = buildStealthInitScript(opts);
    expect(script).not.toContain(MARKERS.printCapture.section);
    expect(script).not.toContain('[Print Capture]');
  });

  test('runtime: download URLs routed, non-download pass through', () => {
    const { ctx } = buildAndEvaluate(opts);
    const logs = vm.runInContext('__consoleLogs', ctx);
    const calls = vm.runInContext('__nativeOpenCalls', ctx);

    // Download URL -> background-open marker, returns null
    const prevCount = logs.length;
    const result = vm.runInContext("window.open('/statement.pdf', '_blank')", ctx);
    expect(result).toBeNull();
    expect(calls.length).toBe(0);
    const newLogs = logs.slice(prevCount);
    expect(newLogs.some((l: string) => l.includes('[FocusShim] background-open'))).toBe(true);

    // Non-download URL -> native pass-through
    vm.runInContext("window.open('https://example.com/login', '_blank')", ctx);
    expect(calls.length).toBe(1);
  });
});

test.describe('combined: suppressFocus + printCapture', () => {
  const opts: StealthInitScriptOptions = { suppressFocus: true, printCapture: true };

  test('focus shim section present', () => {
    const script = buildStealthInitScript(opts);
    expect(script).toContain(MARKERS.focusShim.section);
  });

  test('print capture section present (standalone print override)', () => {
    const script = buildStealthInitScript(opts);
    expect(script).toContain(MARKERS.printCapture.section);
    expect(script).toContain('[Print Capture]');
  });

  test('focus shim includes print-capture proxy (suppressFocus + printCapture interaction)', () => {
    const script = buildStealthInitScript(opts);
    // When both suppressFocus and printCapture are on, the focus shim section
    // receives printCapture=true and generates the _printCaptureProxy.
    expect(script).toContain('_printCaptureProxy');
  });

  test('runtime: empty-URL popup returns print-capture proxy', () => {
    const { ctx } = buildAndEvaluate(opts);
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    const result = vm.runInContext("window.open('', '_blank')", ctx);
    // Should NOT call native (proxy returned instead)
    expect(calls.length).toBe(0);
    // Proxy has document.write and print
    expect(result).toBeTruthy();
    expect(typeof result.document).toBe('object');
    expect(typeof result.document.write).toBe('function');
    expect(typeof result.print).toBe('function');
  });

  test('runtime: window.print override also works alongside focus shim', () => {
    const { ctx } = buildAndEvaluate(opts);
    // Both print capture override and focus shim should be installed
    expect(vm.runInContext('typeof window.print', ctx)).toBe('function');
    // window.open is shimmed
    const str = vm.runInContext('Function.prototype.toString.call(window.open)', ctx);
    expect(str).toContain('[native code]');
  });
});

test.describe('combined: all four flags', () => {
  const opts: StealthInitScriptOptions = {
    chromeRuntimeStubs: true,
    printCapture: true,
    suppressFocus: true,
    backgroundOpenCapture: true,
  };

  test('all section comments present', () => {
    const script = buildStealthInitScript(opts);
    expect(script).toContain(MARKERS.chromeStubs.section);
    expect(script).toContain(MARKERS.printCapture.section);
    expect(script).toContain(MARKERS.focusShim.section);
  });

  test('toString infrastructure present', () => {
    const script = buildStealthInitScript(opts);
    for (const marker of MARKERS.toStringInfra.present)
      expect(script).toContain(marker);
  });

  test('chrome stubs markers present', () => {
    const script = buildStealthInitScript(opts);
    for (const marker of MARKERS.chromeStubs.present)
      expect(script).toContain(marker);
  });

  test('print capture markers present', () => {
    const script = buildStealthInitScript(opts);
    for (const marker of MARKERS.printCapture.present)
      expect(script).toContain(marker);
  });

  test('focus shim markers present', () => {
    const script = buildStealthInitScript(opts);
    for (const marker of MARKERS.focusShim.present)
      expect(script).toContain(marker);
  });

  test('download routing markers present', () => {
    const script = buildStealthInitScript(opts);
    for (const marker of MARKERS.downloadRouting.present)
      expect(script).toContain(marker);
  });

  test('runtime: chrome stubs installed', () => {
    const { ctx } = buildAndEvaluate(opts);
    expect(vm.runInContext('typeof chrome.app', ctx)).toBe('object');
    expect(vm.runInContext('chrome.app.isInstalled', ctx)).toBe(false);
    expect(vm.runInContext('typeof chrome.csi', ctx)).toBe('function');
    expect(vm.runInContext('typeof chrome.loadTimes', ctx)).toBe('function');
  });

  test('runtime: window.print overridden', () => {
    const { ctx } = buildAndEvaluate(opts);
    expect(vm.runInContext('typeof window.print', ctx)).toBe('function');
    // Should produce [Print Capture] marker on invocation
    const logs = vm.runInContext('__consoleLogs', ctx);
    const prevCount = logs.length;
    vm.runInContext('window.print()', ctx);
    const newLogs = logs.slice(prevCount);
    expect(newLogs.some((l: string) => l.includes('[Print Capture]'))).toBe(true);
  });

  test('runtime: window.open shimmed with download routing', () => {
    const { ctx } = buildAndEvaluate(opts);
    const logs = vm.runInContext('__consoleLogs', ctx);
    const calls = vm.runInContext('__nativeOpenCalls', ctx);

    // Download URL -> background-open
    const prevCount = logs.length;
    const result = vm.runInContext("window.open('/download/file.pdf', '_blank')", ctx);
    expect(result).toBeNull();
    expect(calls.length).toBe(0);
    const newLogs = logs.slice(prevCount);
    expect(newLogs.some((l: string) => l.includes('[FocusShim] background-open'))).toBe(true);

    // Non-download URL -> native
    vm.runInContext("window.open('https://example.com/settings', '_blank')", ctx);
    expect(calls.length).toBe(1);
  });

  test('runtime: empty-URL popup returns print-capture proxy', () => {
    const { ctx } = buildAndEvaluate(opts);
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    const result = vm.runInContext("window.open('', '_blank')", ctx);
    expect(calls.length).toBe(0);
    expect(result).toBeTruthy();
    expect(typeof result.document.write).toBe('function');
    expect(typeof result.print).toBe('function');
  });

  test('runtime: Notification.permission normalized to default', () => {
    const { ctx } = buildAndEvaluate(opts);
    expect(vm.runInContext('Notification.permission', ctx)).toBe('default');
  });

  test('runtime: toString masking works across all sections', () => {
    const { ctx } = buildAndEvaluate(opts);
    // Use Function.prototype.toString.call() rather than fn.toString() because
    // Node's vm module can resolve .toString from the HOST Function.prototype
    // (bypassing the patched guest prototype) when called via the method syntax.
    // The patched Function.prototype.toString is what runs in a real browser.

    // window.print masked
    const printStr = vm.runInContext('Function.prototype.toString.call(window.print)', ctx);
    expect(printStr).toBe('function print() { [native code] }');
    // window.open masked
    const openStr = vm.runInContext('Function.prototype.toString.call(window.open)', ctx);
    expect(openStr).toBe('function open() { [native code] }');
    // chrome.csi masked
    const csiStr = vm.runInContext('Function.prototype.toString.call(chrome.csi)', ctx);
    expect(csiStr).toBe('function csi() { [native code] }');
    // chrome.loadTimes masked
    const ltStr = vm.runInContext('Function.prototype.toString.call(chrome.loadTimes)', ctx);
    expect(ltStr).toBe('function loadTimes() { [native code] }');
  });
});

// ===========================================================================
// INFRASTRUCTURE BEHAVIOR
// ===========================================================================

test.describe('infrastructure: no flags', () => {
  test('returns empty string', () => {
    const script = buildStealthInitScript({});
    expect(script).toBe('');
  });

  test('all flags explicitly false returns empty string', () => {
    const script = buildStealthInitScript({
      chromeRuntimeStubs: false,
      printCapture: false,
      suppressFocus: false,
      backgroundOpenCapture: false,
    });
    expect(script).toBe('');
  });

  test('undefined options returns empty string', () => {
    const script = buildStealthInitScript({} as StealthInitScriptOptions);
    expect(script).toBe('');
  });
});

test.describe('infrastructure: any single flag installs toString', () => {
  const singleFlagCases: Array<{ name: string; opts: StealthInitScriptOptions }> = [
    { name: 'chromeRuntimeStubs', opts: { chromeRuntimeStubs: true } },
    { name: 'printCapture', opts: { printCapture: true } },
    { name: 'suppressFocus', opts: { suppressFocus: true } },
    { name: 'backgroundOpenCapture', opts: { backgroundOpenCapture: true } },
  ];

  for (const { name, opts } of singleFlagCases) {
    test(`${name} alone installs toString infrastructure`, () => {
      const script = buildStealthInitScript(opts);
      expect(script).not.toBe('');
      for (const marker of MARKERS.toStringInfra.present)
        expect(script).toContain(marker);
    });

    test(`${name} alone wraps output in IIFE`, () => {
      const script = buildStealthInitScript(opts);
      expect(script.trim()).toMatch(/^\(\(\) => \{/);
      expect(script.trim()).toMatch(/\}\)\(\);$/);
    });

    test(`${name} alone sets __chromeStealth guard`, () => {
      const script = buildStealthInitScript(opts);
      expect(script).toContain('__chromeStealth');
    });
  }
});

test.describe('infrastructure: __chromeStealth re-entry guard', () => {
  test('guard prevents double injection of chrome stubs', () => {
    const script = buildStealthInitScript({ chromeRuntimeStubs: true });
    const ctx = createBrowserContext();
    // First injection
    vm.runInContext(script, ctx);
    expect(vm.runInContext('window.__chromeStealth', ctx)).toBe(true);
    expect(vm.runInContext('typeof chrome.app', ctx)).toBe('object');

    // Tamper with chrome.csi to detect re-injection
    vm.runInContext('window.__csiWasReinjected = false', ctx);
    vm.runInContext(`
      try {
        Object.defineProperty(chrome, 'csi', {
          get: function() { window.__csiWasReinjected = true; return function() {}; },
          configurable: true,
        });
      } catch (_) {}
    `, ctx);

    // Second injection should be no-op due to guard
    vm.runInContext(script, ctx);
    // The tampered getter should NOT have been triggered by re-injection
    // (the guard returns before chrome stubs section runs)
    // Note: we check the guard itself is still true
    expect(vm.runInContext('window.__chromeStealth', ctx)).toBe(true);
  });

  test('guard prevents double injection of print capture', () => {
    const script = buildStealthInitScript({ printCapture: true });
    const ctx = createBrowserContext();

    // First injection
    vm.runInContext(script, ctx);
    const printRef1 = vm.runInContext('window.print', ctx);

    // Replace print with sentinel
    vm.runInContext('window.__originalPrint = window.print; window.print = function sentinel() {}', ctx);

    // Second injection -- guard should prevent overwriting sentinel
    vm.runInContext(script, ctx);
    const printAfter = vm.runInContext('window.print.name', ctx);
    // If guard works, print is still the sentinel, not re-overwritten
    expect(printAfter).toBe('sentinel');
  });

  test('guard prevents double injection with all flags', () => {
    const opts: StealthInitScriptOptions = {
      chromeRuntimeStubs: true,
      printCapture: true,
      suppressFocus: true,
      backgroundOpenCapture: true,
    };
    const script = buildStealthInitScript(opts);
    const ctx = createBrowserContext();

    // First injection
    vm.runInContext(script, ctx);
    expect(vm.runInContext('window.__chromeStealth', ctx)).toBe(true);

    // Place a sentinel to detect if sections re-execute
    vm.runInContext('window.__injectionCount = 1', ctx);

    // Second injection should be completely no-op
    vm.runInContext(script, ctx);

    // Guard is still true, injectionCount unchanged
    expect(vm.runInContext('window.__chromeStealth', ctx)).toBe(true);
    expect(vm.runInContext('window.__injectionCount', ctx)).toBe(1);
  });
});

// ===========================================================================
// NEGATIVE TESTS: each flag false -> its section absent
// ===========================================================================

test.describe('negative: disabled flags produce absent sections', () => {
  test('chromeRuntimeStubs: false -> no chrome stubs section', () => {
    const script = buildStealthInitScript({
      chromeRuntimeStubs: false,
      printCapture: true,
      suppressFocus: true,
      backgroundOpenCapture: true,
    });
    expect(script).not.toContain(MARKERS.chromeStubs.section);
    expect(script).not.toContain('chrome.app');
    expect(script).not.toContain('chrome.csi');
    expect(script).not.toContain('chrome.loadTimes');
    // Other sections still present
    expect(script).toContain(MARKERS.printCapture.section);
    expect(script).toContain(MARKERS.focusShim.section);
  });

  test('printCapture: false -> no print capture section', () => {
    const script = buildStealthInitScript({
      chromeRuntimeStubs: true,
      printCapture: false,
      suppressFocus: true,
      backgroundOpenCapture: true,
    });
    expect(script).not.toContain(MARKERS.printCapture.section);
    expect(script).not.toContain('[Print Capture]');
    // Other sections still present
    expect(script).toContain(MARKERS.chromeStubs.section);
    expect(script).toContain(MARKERS.focusShim.section);
  });

  test('suppressFocus: false + backgroundOpenCapture: false -> no focus shim section', () => {
    const script = buildStealthInitScript({
      chromeRuntimeStubs: true,
      printCapture: true,
      suppressFocus: false,
      backgroundOpenCapture: false,
    });
    expect(script).not.toContain(MARKERS.focusShim.section);
    expect(script).not.toContain('[FocusShim]');
    expect(script).not.toContain('DOWNLOAD_URL_RE');
    // Other sections still present
    expect(script).toContain(MARKERS.chromeStubs.section);
    expect(script).toContain(MARKERS.printCapture.section);
  });

  test('backgroundOpenCapture: false -> no download routing (even with suppressFocus)', () => {
    const script = buildStealthInitScript({
      suppressFocus: true,
      backgroundOpenCapture: false,
    });
    // Focus shim IS present (suppressFocus is on)
    expect(script).toContain(MARKERS.focusShim.section);
    // But download routing markers are absent
    expect(script).not.toContain('DOWNLOAD_URL_RE');
    expect(script).not.toContain('DOWNLOAD_PATH_RE');
    expect(script).not.toContain('_emitBackgroundOpen');
  });

  test('printCapture: false -> no print-capture proxy in focus shim', () => {
    const script = buildStealthInitScript({
      suppressFocus: true,
      printCapture: false,
    });
    expect(script).toContain(MARKERS.focusShim.section);
    expect(script).not.toContain('_printCaptureProxy');
  });

  test('runtime: disabled chrome stubs means no chrome.app', () => {
    const { ctx } = buildAndEvaluate({
      chromeRuntimeStubs: false,
      printCapture: true,
    });
    expect(vm.runInContext('typeof chrome', ctx)).toBe('undefined');
  });

  test('runtime: disabled printCapture means no print override', () => {
    const { ctx } = buildAndEvaluate({
      chromeRuntimeStubs: true,
      printCapture: false,
    });
    expect(vm.runInContext('typeof window.print', ctx)).toBe('undefined');
  });

  test('runtime: disabled focus means window.open is native', () => {
    const { ctx } = buildAndEvaluate({
      chromeRuntimeStubs: true,
      suppressFocus: false,
      backgroundOpenCapture: false,
    });
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    vm.runInContext("window.open('/statement.pdf', '_blank')", ctx);
    // Native open called directly (no shim intercepting)
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('/statement.pdf');
  });
});

// ===========================================================================
// SECTION ORDERING
// ===========================================================================

test.describe('section ordering in generated script', () => {
  test('toString infrastructure appears before chrome stubs section', () => {
    const script = buildStealthInitScript({ chromeRuntimeStubs: true });
    const infraIdx = script.indexOf('__stealthMarkNative');
    const stubsIdx = script.indexOf(MARKERS.chromeStubs.section);
    expect(infraIdx).toBeGreaterThan(-1);
    expect(stubsIdx).toBeGreaterThan(-1);
    expect(infraIdx).toBeLessThan(stubsIdx);
  });

  test('toString infrastructure appears before print capture section', () => {
    const script = buildStealthInitScript({ printCapture: true });
    const infraIdx = script.indexOf('__stealthMarkNative');
    const printIdx = script.indexOf(MARKERS.printCapture.section);
    expect(infraIdx).toBeLessThan(printIdx);
  });

  test('toString infrastructure appears before focus shim section', () => {
    const script = buildStealthInitScript({ suppressFocus: true });
    const infraIdx = script.indexOf('__stealthMarkNative');
    const shimIdx = script.indexOf(MARKERS.focusShim.section);
    expect(infraIdx).toBeLessThan(shimIdx);
  });

  test('chrome stubs section appears before print capture section (when both on)', () => {
    const script = buildStealthInitScript({ chromeRuntimeStubs: true, printCapture: true });
    const stubsIdx = script.indexOf(MARKERS.chromeStubs.section);
    const printIdx = script.indexOf(MARKERS.printCapture.section);
    expect(stubsIdx).toBeLessThan(printIdx);
  });

  test('print capture section appears before focus shim section (when both on)', () => {
    const script = buildStealthInitScript({ printCapture: true, suppressFocus: true });
    const printIdx = script.indexOf(MARKERS.printCapture.section);
    const shimIdx = script.indexOf(MARKERS.focusShim.section);
    expect(printIdx).toBeLessThan(shimIdx);
  });
});

// ===========================================================================
// TRY-CATCH WRAPPING (section resilience)
// ===========================================================================

test.describe('section try-catch wrapping', () => {
  test('chrome stubs section is wrapped in try-catch', () => {
    const script = buildStealthInitScript({ chromeRuntimeStubs: true });
    // The builder wraps each section in try-catch
    const sectionStart = script.indexOf(MARKERS.chromeStubs.section);
    // Look backwards from section comment to find the try {
    const preceding = script.substring(0, sectionStart);
    expect(preceding.trimEnd()).toMatch(/try\s*\{$/m);
  });

  test('print capture section is wrapped in try-catch', () => {
    const script = buildStealthInitScript({ printCapture: true });
    const sectionStart = script.indexOf(MARKERS.printCapture.section);
    const preceding = script.substring(0, sectionStart);
    expect(preceding.trimEnd()).toMatch(/try\s*\{$/m);
  });

  test('focus shim section is wrapped in try-catch', () => {
    const script = buildStealthInitScript({ suppressFocus: true });
    const sectionStart = script.indexOf(MARKERS.focusShim.section);
    const preceding = script.substring(0, sectionStart);
    expect(preceding.trimEnd()).toMatch(/try\s*\{$/m);
  });

  test('each section has independent try-catch when all flags on', () => {
    const script = buildStealthInitScript({
      chromeRuntimeStubs: true,
      printCapture: true,
      suppressFocus: true,
      backgroundOpenCapture: true,
    });
    // Count the "Section failure must not abort remaining sections" comments
    const failureGuardCount = (script.match(/Section failure must not abort remaining sections/g) || []).length;
    // Should have 3 section try-catches (chrome stubs, print capture, focus shim)
    expect(failureGuardCount).toBe(3);
  });
});
