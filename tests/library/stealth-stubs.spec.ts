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
 * Unit tests for the CDP stealth stubs (Sapoto #1044 M3).
 *
 * Two layers under test:
 *
 *   1. buildChromeBrands() — pure helper that derives the UA Client Hint brand
 *      list from a browser version string. Validates the three-entry shape and
 *      the version-derivation logic without spinning up Chromium.
 *
 *   2. CDP_STEALTH_INIT_SCRIPT — the init script source. Evaluated inside a
 *      Node `vm` context with a hand-rolled DOM-ish stand-in (navigator, chrome,
 *      Notification, performance, setTimeout). Asserts the output-visible
 *      behavior of each stub. We deliberately do NOT assert which CDP method
 *      registered the script (per #1044 spec).
 *
 * TODO(M3 follow-up): empirical r1226 fingerprint audit against running Chromium
 * via scripts/observatory/recon/. The stubs were validated at the merge-base
 * binary (r1212) — Chromium has rolled 6 builds since, and any of these stubs
 * could be a no-op (or newly insufficient) against the current binary.
 */

import vm from 'vm';

import { test, expect } from '@playwright/test';
import { buildChromeBrands } from '../../packages/playwright-core/src/server/chromium/chromeUaBrands';
import { CDP_STEALTH_INIT_SCRIPT } from '../../packages/playwright-core/src/tools/backend/stealthInitScript';

// ------------------------------------------------------------------
// buildChromeBrands — pure helper
// ------------------------------------------------------------------

test('buildChromeBrands emits the three-entry Chromium / Google Chrome / GREASE shape', () => {
  const result = buildChromeBrands('124.0.6367.78');
  expect(result).toBeDefined();
  expect(result!.brands).toHaveLength(3);
  // Order isn't enforced here; assert by name.
  const byBrand = Object.fromEntries(result!.brands.map(b => [b.brand, b.version]));
  expect(byBrand['Chromium']).toBe('124');
  expect(byBrand['Google Chrome']).toBe('124');
  // The "GREASE" brand exists — Chromium has changed its exact string multiple
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
// CDP_STEALTH_INIT_SCRIPT — evaluate in a sandboxed VM context
// ------------------------------------------------------------------

/**
 * Build a minimal browser-shaped sandbox for the init script. The aim is just
 * enough surface that the stubs do not throw — the assertions then read the
 * resulting state.
 */
function newPageContext(opts: { languages?: string[]; notificationPermission?: 'granted' | 'default' | 'denied' } = {}) {
  // IMPORTANT: do NOT spread outer-realm intrinsics (Function, Object, WeakMap, …)
  // into the sandbox. The vm context has its own intrinsics; if we pre-populate it
  // with the outer-realm constructors, then `Function.prototype.toString` patched
  // by the script lives on the OUTER realm's prototype, while functions actually
  // created inside the sandbox use the SANDBOX realm's `Function.prototype` — so
  // the masking would silently miss. Leaving the sandbox bare lets vm wire its own
  // intrinsics, which is what real Chrome does too.
  //
  // We do, however, hand-build the browser-shaped globals the script reads.
  const sandbox: any = {
    navigatorWebdriverInitial: true,
    navigatorLanguagesInitial: opts.languages ?? ['en-US'],
    notificationPermissionInitial: opts.notificationPermission ?? 'granted',
  };
  vm.createContext(sandbox);
  // Build navigator / Notification / performance INSIDE the sandbox realm so they
  // use the sandbox's Object / Array intrinsics.
  vm.runInContext(`
    globalThis.navigator = { webdriver: globalThis.navigatorWebdriverInitial, languages: globalThis.navigatorLanguagesInitial };
    globalThis.Notification = { permission: globalThis.notificationPermissionInitial };
    globalThis.performance = { now: () => 1234, getEntriesByType: () => [] };
    globalThis.setTimeout = () => 0; // deferred-print never fires in tests
    globalThis.print = undefined;
    globalThis.window = globalThis;
    delete globalThis.navigatorWebdriverInitial;
    delete globalThis.navigatorLanguagesInitial;
    delete globalThis.notificationPermissionInitial;
  `, sandbox);
  return sandbox;
}

test('stealth init: navigator.webdriver returns false (boolean), not undefined', () => {
  const ctx = newPageContext();
  vm.runInContext(CDP_STEALTH_INIT_SCRIPT, ctx);
  expect(ctx.navigator.webdriver).toBe(false);
  expect(typeof ctx.navigator.webdriver).toBe('boolean');
});

test('stealth init: chrome.app, chrome.csi, chrome.loadTimes are installed and look native', () => {
  const ctx = newPageContext();
  vm.runInContext(CDP_STEALTH_INIT_SCRIPT, ctx);
  expect(typeof ctx.chrome).toBe('object');

  // chrome.app shape
  expect(ctx.chrome.app).toBeDefined();
  expect(ctx.chrome.app.isInstalled).toBe(false);
  expect(typeof ctx.chrome.app.getIsInstalled).toBe('function');
  expect(ctx.chrome.app.getIsInstalled()).toBe(false);
  expect(ctx.chrome.app.InstallState).toMatchObject({ NOT_INSTALLED: 'not_installed' });
  expect(ctx.chrome.app.RunningState).toMatchObject({ CANNOT_RUN: 'cannot_run' });

  // chrome.csi + chrome.loadTimes are callable and return plausible shapes
  expect(typeof ctx.chrome.csi).toBe('function');
  const csi = ctx.chrome.csi();
  expect(csi).toHaveProperty('startE');
  expect(csi).toHaveProperty('onloadT');
  expect(csi).toHaveProperty('pageT');

  expect(typeof ctx.chrome.loadTimes).toBe('function');
  const lt = ctx.chrome.loadTimes();
  expect(lt).toHaveProperty('connectionInfo', 'h2');
  expect(lt).toHaveProperty('wasFetchedViaSpdy', true);

  // Function.prototype.toString masking — native-looking signature.
  expect(ctx.chrome.app.getIsInstalled.toString()).toBe('function getIsInstalled() { [native code] }');
  expect(ctx.chrome.csi.toString()).toBe('function csi() { [native code] }');
});

test('stealth init: Function.prototype.toString masking survives Akamai bmak-style .toString.call(weirdThis)', () => {
  // Sapoto #1036: bmak does .toString.call(weirdThis) where weirdThis can be a
  // primitive. The WeakMap lookup must not crash the init — primitives just
  // fall through to the native delegate.
  const ctx = newPageContext();
  vm.runInContext(CDP_STEALTH_INIT_SCRIPT, ctx);
  // Confirm a non-object .toString.call() doesn't throw (and doesn't return
  // a masked string, since primitives can't be WeakMap keys).
  const probe = vm.runInContext(`
    (() => {
      try {
        Function.prototype.toString.call(function realFn() { return 42; });
        // Now the bmak-style call with a primitive:
        // Native Function.prototype.toString rejects non-Function this with a TypeError,
        // which is what real Chrome would do too — that's the expected error shape.
        let threwNative = false;
        try { Function.prototype.toString.call(42); } catch (e) { threwNative = (e instanceof TypeError); }
        return { ok: true, threwNative };
      } catch (e) {
        return { ok: false, err: String(e) };
      }
    })();
  `, ctx);
  expect(probe.ok).toBe(true);
  expect(probe.threwNative).toBe(true); // the error shape matches native Chrome
});

test('stealth init: navigator.languages padded to multi-entry when page exposes only one locale', () => {
  const ctx = newPageContext({ languages: ['en-US'] });
  vm.runInContext(CDP_STEALTH_INIT_SCRIPT, ctx);
  // Property is defined as a getter that returns the padded array.
  expect(Array.isArray(ctx.navigator.languages)).toBe(true);
  expect(ctx.navigator.languages.length).toBeGreaterThanOrEqual(2);
});

test('stealth init: Notification.permission flipped from granted to default', () => {
  const ctx = newPageContext({ notificationPermission: 'granted' });
  vm.runInContext(CDP_STEALTH_INIT_SCRIPT, ctx);
  expect(ctx.Notification.permission).toBe('default');
});

test('stealth init: window.print becomes a deferred handler when suppressFocus=true (C3)', () => {
  // Per Sapoto #1044: C3 (deferred print + Path D bridge) is gated on
  // suppressFocus, not on stealth. The stealth-only path leaves print alone.
  const { buildStealthInitScript } = require('../../packages/playwright-core/src/tools/backend/stealthInitScript');
  const ctx = newPageContext();
  const printBefore = ctx.print;
  vm.runInContext(buildStealthInitScript({ stealth: true, suppressFocus: true }), ctx);
  expect(ctx.print).not.toBe(printBefore);
  expect(typeof ctx.print).toBe('function');
  // Calling it must NOT throw (it should schedule a deferred check and return).
  expect(() => ctx.print()).not.toThrow();
});

test('stealth init: window.print untouched when suppressFocus=false (C3 gated off)', () => {
  // The default-options export is suppressFocus:false. C3 must NOT install.
  const ctx = newPageContext();
  const printBefore = ctx.print;
  vm.runInContext(CDP_STEALTH_INIT_SCRIPT, ctx);
  expect(ctx.print).toBe(printBefore); // unchanged
});

test('stealth init: __chromeStealth idempotency guard — second run is a no-op', () => {
  const ctx = newPageContext();
  vm.runInContext(CDP_STEALTH_INIT_SCRIPT, ctx);
  const chromeAfterFirst = ctx.chrome;
  // Mutate something so we can detect re-init.
  ctx.chrome.csi = 'sentinel';
  vm.runInContext(CDP_STEALTH_INIT_SCRIPT, ctx);
  expect(ctx.chrome).toBe(chromeAfterFirst);
  expect(ctx.chrome.csi).toBe('sentinel');
});

// ------------------------------------------------------------------
// Third-party-frame guard (Sapoto #1036)
// ------------------------------------------------------------------

test('stealth init: third-party-frame guard — script does not throw with no DOM and no navigator', () => {
  // Frames where Akamai bmak / OneTrust / Fidelity dmt run at document_start
  // have neither document.head nor document.documentElement, and may even
  // execute before `navigator` is wired up. The script must install whatever
  // pieces it CAN (chrome stubs, deferred print) without aborting on a
  // missing global. This is the regression test for Sapoto #1036.
  //
  // Post-Sapoto #1044: C3 deferred-print is gated on suppressFocus, so this
  // test builds with both stealth=true AND suppressFocus=true to cover the
  // full third-party-frame surface that pre-#1044 was always installed.
  const { buildStealthInitScript } = require('../../packages/playwright-core/src/tools/backend/stealthInitScript');
  const script = buildStealthInitScript({ stealth: true, suppressFocus: true });
  const minimal: any = {};
  vm.createContext(minimal);
  vm.runInContext(`globalThis.window = globalThis; globalThis.setTimeout = () => 0;`, minimal);
  expect(() => vm.runInContext(script, minimal)).not.toThrow();
  // Even without navigator/Notification, chrome stubs + deferred print still install.
  expect(vm.runInContext('typeof chrome', minimal)).toBe('object');
  expect(vm.runInContext('typeof chrome.app', minimal)).toBe('object');
  expect(vm.runInContext('typeof print', minimal)).toBe('function');
});
