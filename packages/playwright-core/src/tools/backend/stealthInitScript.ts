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
 * CDP stealth init script — runs in every new document (main world) before any
 * page script via `BrowserContext.addInitScript`.
 *
 * Sections are numbered so the third-party-frame guard (issue Sapoto #1036) can
 * grep them; the function is one consolidated block so a single addInitScript
 * call covers all sub-stubs.
 *
 *   C1: navigator.webdriver → false
 *        Real Chrome returns `false` when automation is not active. Returning
 *        `undefined` is detectable: `typeof navigator.webdriver === "undefined"`
 *        vs the expected `"boolean"`.
 *
 *   C2: chrome.{app,csi,loadTimes} + navigator.languages + Notification.permission
 *        Akamai bmak, OneTrust, and several portal scripts read these. Missing or
 *        anomalous values are a strong automation tell. Function.prototype.toString
 *        is patched (via a WeakMap that survives the `.toString.call(weirdThis)`
 *        pattern bmak uses) so each stub returns a native-looking signature.
 *
 *   C3: Deferred window.print()
 *        Synchronous early-script window.print() calls would otherwise raise a
 *        blocking native print dialog before the embedder's real override
 *        installs at dom-ready. The deferred handler waits up to 2 s for the
 *        real override; if none arrives, the call is silently suppressed
 *        (better than a blocking dialog).
 *
 * THIRD-PARTY-FRAME GUARD (Sapoto #1036): in frames where neither document.head
 * nor document.documentElement exists yet (Akamai bmak, Clicktale, OneTrust,
 * Fidelity dmt analytics), naive appendChild calls throw at document_start. We
 * (a) never touch documentElement here, (b) guard the Function.prototype.toString
 * WeakMap lookup so a `.toString.call(weirdThis)` from bmak can't crash the init.
 *
 * TODO(M3 follow-up): empirical r1226 fingerprint audit. Each stub here was
 * validated against the merge-base Chromium binary (r1212). Chromium has rolled
 * 6 builds since (r1212 → r1226). Some stubs may have become no-ops as the
 * underlying browser surface shifted; some new detection vectors may exist.
 * Run scripts/observatory/recon/ against Chase / BofA / Citi / CapOne / Fidelity
 * to validate end-to-end and prune dead stubs.
 */
export const CDP_STEALTH_INIT_SCRIPT = `(() => {
  if ((window).__chromeStealth) return;
  (window).__chromeStealth = true;

  // ============================================================
  // C1 — navigator.webdriver = false (not undefined)
  // ============================================================
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
  } catch (_) { /* navigator may be locked down by another shim */ }

  // ============================================================
  // C2 — Function.prototype.toString masking + chrome stubs
  // ============================================================
  try {
    const _toString = Function.prototype.toString;
    const _nativeMap = new WeakMap();
    function _markNative(fn, name) {
      try { _nativeMap.set(fn, 'function ' + name + '() { [native code] }'); } catch (_) {}
      return fn;
    }
    Function.prototype.toString = function() {
      // Sapoto #1036: Akamai bmak calls .toString.call(weirdThis) where weirdThis
      // is not always a function. Guard the WeakMap lookup so the native delegate
      // still throws the exact shape Chrome would (TypeError on non-Function this).
      try {
        if (_nativeMap.has(this)) return _nativeMap.get(this);
      } catch (_) { /* WeakMap rejects non-object keys — fall through */ }
      return _toString.call(this);
    };
    _markNative(Function.prototype.toString, 'toString');

    // chrome.app stub — pages probe chrome.app.isInstalled to detect real Chrome.
    if (typeof chrome === 'undefined') (window).chrome = {};
    if (!(chrome).app) {
      const InstallState = { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' };
      const RunningState = { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' };
      const app = {
        isInstalled: false,
        getIsInstalled: _markNative(function getIsInstalled() { return false; }, 'getIsInstalled'),
        getDetails: _markNative(function getDetails() { return null; }, 'getDetails'),
        installState: _markNative(function installState(cb) { if (cb) cb(InstallState.NOT_INSTALLED); }, 'installState'),
        runningState: _markNative(function runningState() { return RunningState.CANNOT_RUN; }, 'runningState'),
        InstallState,
        RunningState,
      };
      try {
        Object.defineProperty(chrome, 'app', { value: app, writable: false, configurable: false, enumerable: true });
      } catch (_) {}
    }

    // chrome.csi stub
    if (!(chrome).csi) {
      (chrome).csi = _markNative(function csi() {
        return { startE: Date.now(), onloadT: Date.now(), pageT: performance.now(), tran: 15 };
      }, 'csi');
    }

    // chrome.loadTimes stub
    if (!(chrome).loadTimes) {
      (chrome).loadTimes = _markNative(function loadTimes() {
        const nav = performance.getEntriesByType('navigation')[0] || {};
        return {
          commitLoadTime: (nav.responseStart || Date.now()) / 1000,
          connectionInfo: 'h2',
          finishDocumentLoadTime: (nav.domContentLoadedEventEnd || Date.now()) / 1000,
          finishLoadTime: (nav.loadEventEnd || Date.now()) / 1000,
          firstPaintAfterLoadTime: 0,
          firstPaintTime: (nav.responseEnd || Date.now()) / 1000,
          navigationType: 'Other',
          npnNegotiatedProtocol: 'h2',
          requestTime: (nav.fetchStart || Date.now()) / 1000,
          startLoadTime: (nav.fetchStart || Date.now()) / 1000,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
        };
      }, 'loadTimes');
    }

    // navigator.languages — Chrome ships with at least two entries.
    if (navigator.languages && navigator.languages.length === 1) {
      try {
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
      } catch (_) {}
    }

    // Notification.permission — when launched with --no-default-browser-check etc.,
    // this can stick at 'granted' which differs from a clean user profile.
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true });
      } catch (_) {}
    }
  } catch (e) {
    // Per Sapoto #1036, any C2 failure must NOT abort the rest of the init.
    // Swallow and continue so C3 still installs.
  }

  // ============================================================
  // C3 — Deferred window.print()
  // ============================================================
  try {
    const DEFERRED_TIMEOUT_MS = 2000;
    const deferred = function() {
      setTimeout(() => {
        if (window.print !== deferred) {
          // Embedder's real override arrived — delegate to it.
          try { window.print(); } catch (_) {}
        }
        // else: silently suppress. The alternative was a blocking native dialog.
      }, DEFERRED_TIMEOUT_MS);
    };
    window.print = deferred;
  } catch (_) {}
})();`;
