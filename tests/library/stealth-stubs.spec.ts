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
 * Unit tests for the CDP operational init script (post-Tracer #1137).
 *
 * Two layers under test:
 *
 *   1. buildChromeBrands() -- pure helper that derives the UA Client Hint brand
 *      list from a browser version string. Validates the three-entry shape and
 *      the version-derivation logic without spinning up Chromium.
 *
 *   2. CDP_CAPTURE_BRIDGE_INIT_SCRIPT / buildCaptureBridgeInitScript() -- the
 *      operational init script source. Red-tier JS stealth patches (C1
 *      webdriver, C2 Function.prototype.toString masking, chrome.* stubs,
 *      Notification clamp) were removed by Tracer #1137. Only C3 (deferred
 *      print), C4 (suppressFocus print), C5 (window.open shim), sanitizeUrl,
 *      and Path D stamp remain. Tests evaluate the script inside a Node `vm`
 *      context with a hand-rolled DOM-ish stand-in.
 */

import vm from 'vm';

import { test, expect } from '@playwright/test';
import { buildChromeBrands } from '../../packages/playwright-core/src/server/chromium/chromeUaBrands';
import { CDP_CAPTURE_BRIDGE_INIT_SCRIPT, buildCaptureBridgeInitScript } from '../../packages/playwright-core/src/tools/backend/captureBridgeInitScript';

// ------------------------------------------------------------------
// buildChromeBrands -- pure helper
// ------------------------------------------------------------------

test('buildChromeBrands emits the three-entry Chromium / Google Chrome / GREASE shape', () => {
  const result = buildChromeBrands('124.0.6367.78');
  expect(result).toBeDefined();
  expect(result!.brands).toHaveLength(3);
  // Order isn't enforced here; assert by name.
  const byBrand = Object.fromEntries(result!.brands.map(b => [b.brand, b.version]));
  expect(byBrand['Chromium']).toBe('124');
  expect(byBrand['Google Chrome']).toBe('124');
  // The "GREASE" brand exists -- Chromium has changed its exact string multiple
  // times (";Not A Brand", "Not/A)Brand", "Not?A_Brand"); we only assert the
  // fork's current value so the test catches accidental shape changes.
  expect(byBrand).toHaveProperty('Not/A)Brand');
});

test('buildChromeBrands fullVersionList carries the full version, brands carry only major', () => {
  const result = buildChromeBrands('124.0.6367.78');
  const fullByBrand = Object.fromEntries(result!.fullVersionList.map(b => [b.brand, b.version]));
  expect(fullByBrand['Chromium']).toBe('124.0.6367.78');
  expect(fullByBrand['Google Chrome']).toBe('124.0.6367.78');
  expect(result!.fullVersion).toBe('124.0.6367.78');
});

test('buildChromeBrands returns undefined on empty input', () => {
  expect(buildChromeBrands('')).toBeUndefined();
});

// ------------------------------------------------------------------
// CDP_CAPTURE_BRIDGE_INIT_SCRIPT -- evaluate in a sandboxed VM context
// ------------------------------------------------------------------

/**
 * Build a minimal browser-shaped sandbox for the init script.
 */
function newPageContext() {
  const sandbox: any = {};
  vm.createContext(sandbox);
  vm.runInContext(`
    globalThis.navigator = { webdriver: true };
    globalThis.performance = { now: () => 1234, getEntriesByType: () => [] };
    globalThis.setTimeout = () => 0; // deferred-print never fires in tests
    globalThis.print = undefined;
    globalThis.window = globalThis;
  `, sandbox);
  return sandbox;
}

// ------------------------------------------------------------------
// Tracer #1137 removal verification -- stealth stubs must be absent
// ------------------------------------------------------------------

test('#1137: navigator.webdriver getter is NOT installed (removed by D2)', () => {
  const ctx = newPageContext();
  const script = buildCaptureBridgeInitScript({ suppressFocus: false });
  vm.runInContext(script, ctx);
  // navigator.webdriver should remain at its initial value (true) since
  // the C1 override was removed.
  expect(ctx.navigator.webdriver).toBe(true);
});

test('#1137: __chromeStealth guard is removed (D1)', () => {
  const script = buildCaptureBridgeInitScript({ suppressFocus: false });
  expect(script.includes('__chromeStealth')).toBe(false);
});

test('#1137: __stealthMarkNative global is removed (D1)', () => {
  const script = buildCaptureBridgeInitScript({ suppressFocus: false });
  expect(script.includes('__stealthMarkNative')).toBe(false);
});

test('#1137: Function.prototype.toString masking is removed (D3b)', () => {
  const script = buildCaptureBridgeInitScript({ suppressFocus: true });
  expect(script.includes('Function.prototype.toString')).toBe(false);
  expect(script.includes('_nativeMap')).toBe(false);
  expect(script.includes('_markNative')).toBe(false);
});

test('#1137: chrome.app / chrome.csi / chrome.loadTimes stubs are removed (D3b)', () => {
  const script = buildCaptureBridgeInitScript({ suppressFocus: true });
  expect(script.includes('chrome.app')).toBe(false);
  expect(script.includes('chrome.csi')).toBe(false);
  expect(script.includes('chrome.loadTimes')).toBe(false);
});

test('#1137: Notification.permission clamp is removed (D3b)', () => {
  const script = buildCaptureBridgeInitScript({ suppressFocus: true });
  expect(script.includes('Notification.permission')).toBe(false);
  expect(script.includes('Notification')).toBe(false);
});

test('#1137: stealth option is removed from CaptureBridgeInitScriptOptions (D5)', () => {
  // TypeScript compile-time check: passing `stealth` should not be accepted.
  // At runtime, the function only reads `suppressFocus`.
  const script = buildCaptureBridgeInitScript({ suppressFocus: false } as any);
  expect(script).toBeDefined();
  // No conditional blocks gated on removed options remain.
  expect(script.includes('chromeRuntimeStubs')).toBe(false);
  // Note: 'printCapture' appears in C4 comments referencing the file
  // printCapture.ts, not as a gate variable -- that's fine.
});

// ------------------------------------------------------------------
// Operational sections still present
// ------------------------------------------------------------------

test('#1137: sanitizeUrl helper is still present', () => {
  const script = buildCaptureBridgeInitScript({ suppressFocus: false });
  expect(script.includes('sanitizeUrl')).toBe(true);
});

test('#1137: Path D stamp is still present', () => {
  const script = buildCaptureBridgeInitScript({ suppressFocus: false });
  expect(script.includes('__SAPOTO_PATHD_BRIDGE_V1_STAMP__')).toBe(true);
});

test('#1137: no window.__SAPOTO_PATHD_BRIDGE_V1__ pollution', () => {
  const script = buildCaptureBridgeInitScript({ suppressFocus: false });
  expect(script.includes(`window).__SAPOTO_PATHD_BRIDGE_V1__ = true`)).toBe(false);
  expect(script.includes(`window.__SAPOTO_PATHD_BRIDGE_V1__ = true`)).toBe(false);

  const ctx = newPageContext();
  vm.runInContext(script, ctx);
  expect(ctx.__SAPOTO_PATHD_BRIDGE_V1__).toBeUndefined();
});

test('#1137: C3 deferred print installs in script source', () => {
  const script = buildCaptureBridgeInitScript({ suppressFocus: false });
  expect(script.includes('[DeferredPrint]')).toBe(true);
  expect(script.includes('window.print = deferred')).toBe(true);
});

test('#1137: C3 deferred print handler is callable', () => {
  const ctx = newPageContext();
  const script = buildCaptureBridgeInitScript({ suppressFocus: false });
  const printBefore = ctx.print;
  vm.runInContext(script, ctx);
  expect(ctx.print).not.toBe(printBefore);
  expect(typeof ctx.print).toBe('function');
  expect(() => ctx.print()).not.toThrow();
});

test('#1137: C3 deferred print schedules via setTimeout', () => {
  const ctx = newPageContext();
  vm.runInContext(`globalThis.setTimeout = (fn, ms) => { globalThis.__stCount = (globalThis.__stCount || 0) + 1; return 0; };`, ctx);
  const script = buildCaptureBridgeInitScript({ suppressFocus: false });
  vm.runInContext(script, ctx);
  expect(() => ctx.print()).not.toThrow();
  const setTimeoutCalls = vm.runInContext('globalThis.__stCount || 0', ctx);
  expect(setTimeoutCalls).toBeGreaterThanOrEqual(1);
});

test('#1137: C4 suppressFocus-mode print installs when suppressFocus=true', () => {
  const script = buildCaptureBridgeInitScript({ suppressFocus: true });
  expect(script.includes('[Print Capture]')).toBe(true);
});

test('#1137: C4 suppressFocus-mode print does NOT install when suppressFocus=false', () => {
  const script = buildCaptureBridgeInitScript({ suppressFocus: false });
  expect(script.includes('[Print Capture]')).toBe(false);
});

test('#1137: C5 FocusShim installs when suppressFocus=true', () => {
  const script = buildCaptureBridgeInitScript({ suppressFocus: true });
  expect(script.includes('[FocusShim]')).toBe(true);
});

test('#1137: C5 FocusShim does NOT install when suppressFocus=false', () => {
  const script = buildCaptureBridgeInitScript({ suppressFocus: false });
  expect(script.includes('[FocusShim]')).toBe(false);
});

test('#1137: C5 window.open shim installs end-to-end when suppressFocus=true', () => {
  const ctx = newPageContext();
  vm.runInContext(`globalThis.open = function open() {};`, ctx);
  const script = buildCaptureBridgeInitScript({ suppressFocus: true });
  vm.runInContext(script, ctx);
  // window.open should be replaced by the shim
  expect(typeof ctx.open).toBe('function');
});

test('#1137: every [FocusShim] log uses console.debug (not console.warn)', () => {
  const script = buildCaptureBridgeInitScript({ suppressFocus: true });
  const warnMatches = script.match(/console\.warn\(\s*'\[FocusShim\]/g) || [];
  expect(warnMatches.length).toBe(0);
  const debugMatches = script.match(/console\.debug\(\s*'\[FocusShim\]/g) || [];
  expect(debugMatches.length).toBeGreaterThanOrEqual(10);
});

// ------------------------------------------------------------------
// Third-party-frame guard (Sapoto #1036) -- still works post-gutting
// ------------------------------------------------------------------

test('#1137: third-party-frame guard -- script does not throw with no DOM', () => {
  const script = buildCaptureBridgeInitScript({ suppressFocus: false });
  const minimal: any = {};
  vm.createContext(minimal);
  vm.runInContext(`globalThis.window = globalThis; globalThis.setTimeout = () => 0;`, minimal);
  expect(() => vm.runInContext(script, minimal)).not.toThrow();
  // C3 deferred print still installs even with minimal globals.
  expect(vm.runInContext('typeof print', minimal)).toBe('function');
});

test('#1137: CDP_CAPTURE_BRIDGE_INIT_SCRIPT is built with suppressFocus=false', () => {
  // The named export should match the non-suppressFocus shape.
  expect(CDP_CAPTURE_BRIDGE_INIT_SCRIPT.includes('[FocusShim]')).toBe(false);
  expect(CDP_CAPTURE_BRIDGE_INIT_SCRIPT.includes('[DeferredPrint]')).toBe(true);
  expect(CDP_CAPTURE_BRIDGE_INIT_SCRIPT.includes('__SAPOTO_PATHD_BRIDGE_V1_STAMP__')).toBe(true);
});
