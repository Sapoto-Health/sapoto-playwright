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
 *   C1: navigator.webdriver → false (Navigator.prototype, masked native)
 *        Real Chrome returns `false` when automation is not active. Returning
 *        `undefined` is detectable: `typeof navigator.webdriver === "undefined"`
 *        vs the expected `"boolean"`. PRD #1045 / A5: getter lives on
 *        Navigator.prototype (mirroring real Chrome), is _markNative'd so
 *        `.toString()` reads as `function webdriver() { [native code] }`,
 *        and sits BELOW the _markNative definition inside the C2 try block.
 *
 *   C2: Function.prototype.toString masking + optional chrome.{app,csi,loadTimes}
 *        + Notification.permission. Akamai bmak, OneTrust, and several portal
 *        scripts read these. Missing or anomalous values are a strong automation
 *        tell. Function.prototype.toString is patched (via a WeakMap that survives
 *        the `.toString.call(weirdThis)` pattern bmak uses) so each stub returns
 *        a native-looking signature. PRD #1045 / A5: the chrome.* + Notification
 *        sub-stubs are gated on `chromeRuntimeStubs`; the toString patch and the
 *        `__stealthMarkNative` cross-section helper always install. The
 *        navigator.languages length-1 clamp was REMOVED — real Chrome's value
 *        passes through unchanged.
 *
 *   C3: Deferred window.print() + Path D srcdoc-iframe bridge (Sapoto #1006)
 *        Synchronous early-script window.print() calls would otherwise raise a
 *        blocking native print dialog before the embedder's real override
 *        installs at dom-ready. The deferred handler waits up to 2 s for the
 *        real override; if none arrives AND we're in an iframe (preload runs
 *        only in the top frame for Electron embedders), walk up to 8 parent
 *        windows to find `window.electronAPI.requestPrintCapture` and route
 *        a scope='iframe' payload there with a precise frameSelector. Otherwise
 *        the call is silently suppressed (better than a blocking dialog).
 *
 *   C4: suppressFocus-mode print + Path D mirror (Sapoto #1006)
 *        Gated on `suppressFocus && printCapture`. Replaces the deferred hook
 *        with a fast-path intercept that logs and re-runs the bridge walk for
 *        iframe scopes. PRD #1045 / A5: callers that own print capture
 *        out-of-band can disable C3 + C4 together via `printCapture: false`.
 *
 *   C5: window.open focus-steal shim (Sapoto #1036, refactor #1043)
 *        Gated on `suppressFocus`. Page-level window.open(url, '_blank') routes
 *        through Chromium's Browser::AddNewContents → NativeWidgetMac::Activate
 *        → [NSApp activateIgnoringOtherApps:YES], stealing focus from the
 *        user's frontmost app on macOS. The shim re-routes download-y URLs
 *        through a same-origin fetch() (captured by Layer 1 CDP Fetch.enable),
 *        synthesizes a print-receipt proxy for empty-URL unnamed popups, and
 *        falls back to <a download>.click() when fetch fails CORS / returns
 *        non-OK. Cross-origin URLs and named-target empty popups fall through
 *        to native (focus-steal accepted for that one popup).
 *
 * THIRD-PARTY-FRAME GUARD (Sapoto #1036): in frames where neither document.head
 * nor document.documentElement exists yet (Akamai bmak, Clicktale, OneTrust,
 * Fidelity dmt analytics), naive appendChild calls throw at document_start. We
 * (a) never touch documentElement here, (b) guard the Function.prototype.toString
 * WeakMap lookup so a `.toString.call(weirdThis)` from bmak can't crash the init,
 * (c) wrap each section in its own try/catch so a failure in one (e.g. C5 install
 * crashes on a hardened sandbox) cannot abort the remaining sections.
 *
 * TODO(M3 follow-up): empirical r1226 fingerprint audit. Each stub here was
 * validated against the merge-base Chromium binary (r1212). Chromium has rolled
 * 6 builds since (r1212 → r1226). Some stubs may have become no-ops as the
 * underlying browser surface shifted; some new detection vectors may exist.
 * Run scripts/observatory/recon/ against Chase / BofA / Citi / CapOne / Fidelity
 * to validate end-to-end and prune dead stubs.
 */

export type StealthInitScriptOptions = {
  /**
   * When true, install the fingerprint-defeating stealth stubs (C1: webdriver,
   * C2: Function.prototype.toString masking + optional chrome.{app,csi,loadTimes}
   * + Notification sub-stubs). Sapoto's chrome mode passes `--no-stealth`
   * (stealth=false) because chrome's real identity must not be shadowed by
   * the stubs — but FocusShim/Path D still need to install in that mode. So
   * gating C1/C2 must be independent of gating C3/C4/C5.
   *
   * The C3 deferred-print hook (Path D srcdoc-iframe bridge) is gated on
   * `suppressFocus` as well — only Sapoto's externalBrowser mode wants it.
   * Plain Playwright callers with stealth=true, suppressFocus=false get just
   * C1/C2.
   */
  stealth: boolean;
  /**
   * When true, install the deferred window.print() + Path D srcdoc-iframe
   * bridge (C3), the suppressFocus-mode print override (C4), and the
   * window.open focus-steal shim (C5). Sapoto plumbs this via
   * `config.suppressFocus` (CLI flag `--suppress-focus` or env var
   * PLAYWRIGHT_MCP_SUPPRESS_FOCUS). Defaults to false.
   */
  suppressFocus: boolean;
  /**
   * PRD #1045 / Tracer A5: when false, skip BOTH print-override blocks (C3
   * deferred and C4 suppressFocus-mode fast-path). Useful for callers that
   * own print-capture out-of-band (e.g. a CDP-level Page.printToPDF flow).
   * Defaults to true so existing behavior is preserved.
   */
  printCapture?: boolean;
  /**
   * PRD #1045 / Tracer A5: when false, skip the chrome.{app,csi,loadTimes}
   * and Notification.permission sub-stubs inside C2. The Function.prototype.
   * toString masking and the `__stealthMarkNative` cross-section helper are
   * always installed (C4/C5 depend on the helper). Defaults to true so
   * existing behavior is preserved.
   */
  chromeRuntimeStubs?: boolean;
};

/**
 * Build the stealth init script source string for the given options. Returned
 * value is a self-invoking IIFE suitable for `BrowserContext.addInitScript`.
 *
 * The Sapoto build step at scripts/prepare-mcp-assets.js greps the compiled
 * fork output for the `__SAPOTO_PATHD_BRIDGE_V1_STAMP__` literal. If absent,
 * the build fails — guarding against stale fork rebases that would silently
 * regress iframe print capture (Path D / issue #1006).
 *
 * PRD #1045 / Tracer A5: the previous-generation stamp installed
 * `window.__SAPOTO_PATHD_BRIDGE_V1__ = true` which polluted the global
 * namespace (one more page-detectable tell). The grep target is now a
 * no-op `void` expression — the literal is preserved verbatim in the
 * compiled output for the build-time grep, but nothing is written to
 * `window`. Coordinate any rename with `scripts/prepare-mcp-assets.js`
 * (parallel tracer B6).
 */
export function buildStealthInitScript(options: StealthInitScriptOptions): string {
  const stealth = !!options.stealth;
  const suppressFocus = !!options.suppressFocus;
  // A5: new flags default to true so existing callers (and the legacy
  // CDP_STEALTH_INIT_SCRIPT export) preserve today's behavior unchanged.
  const printCapture = options.printCapture !== false;
  const chromeRuntimeStubs = options.chromeRuntimeStubs !== false;
  return `(() => {
  if ((window).__chromeStealth) return;
  (window).__chromeStealth = true;

  // Path D (Sapoto #1006) backward-compat detection stamp. The Sapoto build
  // step greps the compiled fork output for this exact literal. Do NOT
  // rename without coordinating with scripts/prepare-mcp-assets.js (B6).
  // No window pollution: a bare expression statement keeps the literal in
  // the compiled bundle without leaking onto a global.
  void '__SAPOTO_PATHD_BRIDGE_V1_STAMP__';

  // Helper: redact query string + hash from URL before logging/shipping.
  // window.location.href can carry session tokens in the query string. Per
  // Sapoto's .claude/rules/redaction.md, agent I/O must redact at the source.
  const sanitizeUrl = function(href) {
    if (typeof href !== 'string') return String(href);
    if (!href) return href; // preserve empty-URL case for printCaptureProxy semantics
    try {
      const u = new URL(href, location.href);
      u.search = '';
      u.hash = '';
      return u.toString();
    } catch (_) {
      const cut = href.search(/[?#]/);
      return cut === -1 ? href : href.slice(0, cut);
    }
  };

  ${stealth ? `
  // ============================================================
  // C2 — Function.prototype.toString masking + __stealthMarkNative handshake
  // ============================================================
  // PRD #1045 / A5: the toString patch + _markNative helper are ALWAYS
  // installed inside the stealth gate (the cross-section handshake C4/C5
  // depend on lives here). Only the chrome.{app,csi,loadTimes} + Notification
  // sub-stubs are additionally gated on \`chromeRuntimeStubs\`.
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
        if (this != null
            && (typeof this === 'object' || typeof this === 'function')
            && _nativeMap.has(this))
          return _nativeMap.get(this);
      } catch (_) { /* WeakMap rejects non-object keys — fall through */ }
      return _toString.call(this);
    };
    _markNative(Function.prototype.toString, 'toString');
    // Expose _markNative to later sections via a closure-captured global so the
    // C1/C4/C5 blocks can mask their own overrides without re-defining the helper.
    (window).__stealthMarkNative = _markNative;

    // ============================================================
    // C1 — navigator.webdriver = false (on Navigator.prototype, masked native)
    // ============================================================
    // PRD #1045 / A5: moved BELOW _markNative so the getter's .toString() can
    // be masked. Real Chrome exposes \`webdriver\` as a getter on
    // Navigator.prototype (not the instance), so we mirror that placement.
    // Test sandboxes that ship navigator as a plain object (no Navigator
    // constructor) fall back to defining on the prototype chain we can reach;
    // the previous instance-only definition is preserved as a last-resort.
    try {
      // Extract the getter from an object-literal accessor so its .name is
      // \`get webdriver\` (Chrome shape) rather than \`webdriver\` (function-expression
      // shape). This matches real Chrome and B5 (src/main/utils/chromeStealthStubs.ts)
      // for \`Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver').get.name\`.
      // The _markNative label uses the same 'get webdriver' string so the masked
      // .toString() returns \`function get webdriver() { [native code] }\`.
      const webdriverGetter = _markNative(
        Object.getOwnPropertyDescriptor({ get webdriver() { return false; } }, 'webdriver').get,
        'get webdriver'
      );
      const desc = { get: webdriverGetter, configurable: true };
      let installed = false;
      try {
        if (typeof Navigator !== 'undefined' && Navigator && Navigator.prototype) {
          Object.defineProperty(Navigator.prototype, 'webdriver', desc);
          installed = true;
          // Ensure no instance-level shadow remains from the underlying browser.
          try { delete navigator.webdriver; } catch (_) {}
        }
      } catch (_) { /* fall through to navigator.prototype probe */ }
      if (!installed) {
        try {
          const proto = Object.getPrototypeOf(navigator);
          if (proto && proto !== Object.prototype) {
            Object.defineProperty(proto, 'webdriver', desc);
            installed = true;
            try { delete navigator.webdriver; } catch (_) {}
          }
        } catch (_) {}
      }
      if (!installed) {
        // Last resort (test sandbox where navigator's proto is Object.prototype):
        // define on the instance so navigator.webdriver still reads as false.
        try { Object.defineProperty(navigator, 'webdriver', desc); } catch (_) {}
      }
    } catch (_) { /* navigator may be locked down by another shim */ }

    ${chromeRuntimeStubs ? `
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

    // PRD #1045 / A5: navigator.languages length-1 clamp REMOVED. Real Chrome
    // reports the user's configured locale list — rewriting it to ['en-US','en']
    // was itself a fingerprint when the underlying OS exposed a single locale.

    // Notification.permission — when launched with --no-default-browser-check etc.,
    // this can stick at 'granted' which differs from a clean user profile.
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true });
      } catch (_) {}
    }
    ` : ''}
  } catch (e) {
    // Per Sapoto #1036, any C2 failure must NOT abort the rest of the init.
    // Swallow and continue so C3+ still install.
  }
  ` : ''}

  ${stealth && printCapture ? `
  // ============================================================
  // C3 — Deferred window.print() + Path D srcdoc-iframe bridge (#1006)
  // ============================================================
  // PRD #1045 / A5: additionally gated on \`printCapture\`. Callers that own
  // print capture out-of-band (e.g. a CDP Page.printToPDF flow) can opt out.
  try {
    const DEFERRED_TIMEOUT_MS = 2000;
    const deferred = function() {
      try { console.log('[DeferredPrint] window.print() called — deferring for ' + DEFERRED_TIMEOUT_MS + 'ms at ' + sanitizeUrl(window.location.href)); } catch (_) {}
      setTimeout(() => {
        if (window.print !== deferred) {
          // Embedder's real override arrived — delegate to it.
          try { console.log('[DeferredPrint] Electron override arrived — delegating window.print()'); } catch (_) {}
          try { window.print(); } catch (_) {}
          return;
        }
        // No top-frame Electron override arrived. This happens in iframe
        // contexts (e.g. about:srcdoc) where preload runs only in the top
        // frame. Walk up to 8 parents looking for electronAPI, then send a
        // scope='iframe' bridge call. Per Path D (Sapoto #1006).
        // DeferredPrint intentionally uses console.warn (unlike FocusShim's
        // console.debug) because this is a rare, actionable iframe-fallback
        // event we want surfaced in Supabase app_logs for ops triage —
        // console.log/debug are filtered out by the remote shipper.
        try { console.warn('[DeferredPrint] no main-frame override at ' + sanitizeUrl(window.location.href)); } catch (_) {}
        let w = window;
        for (let hops = 0; hops < 8 && w; hops += 1) {
          try {
            const api = (w).electronAPI;
            if (api && typeof api.requestPrintCapture === 'function') {
              // PRE-FILTER (#1006 follow-up): the main-process regex
              // (FRAME_SELECTOR_RE in src/main/handlers/printCaptureHandler.ts)
              // accepts ids matching /^[A-Za-z0-9_\\-]+$/ and data attribute
              // values matching /^[A-Za-z0-9_\\-:.]+$/ ONLY. CSS.escape() emits
              // backslash escapes for ids that start with a digit or contain
              // special chars — those would fail validation and drop to the
              // broad iframe[srcdoc] fallback (bad for multi-srcdoc portals).
              // Skip the selector when the id can't be emitted safely.
              let frameSelector = null;
              try {
                const SAFE_ID = /^[A-Za-z][A-Za-z0-9_\\-]*$/;
                const SAFE_DATA_VALUE = /^[A-Za-z0-9_\\-:.]+$/;
                const el = window.frameElement;
                if (el) {
                  if (el.id && SAFE_ID.test(el.id)) {
                    frameSelector = 'iframe#' + el.id;
                  } else if (el.id) {
                    try { console.warn('[DeferredPrint] iframe id needs CSS.escape (' + JSON.stringify(el.id) + ') — checking data-print-id fallback'); } catch (_) {}
                  }
                  if (!frameSelector) {
                    const dataPrintId = el.getAttribute('data-print-id');
                    if (dataPrintId) {
                      if (SAFE_DATA_VALUE.test(dataPrintId)) {
                        frameSelector = 'iframe[data-print-id="' + dataPrintId + '"]';
                      } else {
                        try { console.warn('[DeferredPrint] iframe data-print-id needs escaping (' + JSON.stringify(dataPrintId) + ') — falling back to iframe[srcdoc]'); } catch (_) {}
                      }
                    }
                  }
                }
              } catch (_) { /* cross-origin frameElement read — fall back to null */ }

              api.requestPrintCapture({
                url: sanitizeUrl(window.location.href),
                title: document.title,
                timestamp: Date.now(),
                scope: window === window.top ? 'top' : 'iframe',
                frameSelector,
              });
              return;
            }
          } catch (_) {
            // Cross-origin access on w.electronAPI threw. Stop the bridge walk.
            break;
          }
          // w === w.parent at the top frame. Comparison itself can throw
          // cross-origin in some engines (per adversarial review), so wrap it.
          try {
            if (w === w.parent) break;
            w = w.parent;
          } catch (_) {
            break;
          }
        }
        try { console.error('[DeferredPrint] bridge unreachable at ' + sanitizeUrl(window.location.href)); } catch (_) {}
      }, DEFERRED_TIMEOUT_MS);
    };
    window.print = deferred;
  } catch (_) {}
  ` : ''}

  ${suppressFocus && printCapture ? `
  // ============================================================
  // C4 — suppressFocus-mode window.print() + Path D mirror (#1006)
  // ============================================================
  // PRD #1045 / A5: additionally gated on \`printCapture\`. C4 is the
  // suppressFocus-mode fast-path counterpart to C3 — both share the same
  // opt-out so callers that own print capture out-of-band see neither block.
  //
  // Sapoto's externalBrowser mode sets suppressFocus=true. In that mode this
  // override REPLACES the C3 deferred hook above. Top-frame prints are caught
  // by printCapture.ts via the console marker; iframe prints need the explicit
  // electronAPI bridge so the main process can scope the insertCSS rule to the
  // iframe element. Mirror the C3 bridge-walk logic here.
  try {
    const _markNative = (window).__stealthMarkNative || function(fn) { return fn; };
    let _lastPrintTime = 0;
    window.print = _markNative(function print() {
      const _now = Date.now();
      if (_now - _lastPrintTime < 1000) return;
      _lastPrintTime = _now;
      try { console.log('[Print Capture] window.print() intercepted at ' + sanitizeUrl(window.location.href)); } catch (_) {}

      let w = window;
      for (let hops = 0; hops < 8 && w; hops += 1) {
        try {
          const api = (w).electronAPI;
          if (api && typeof api.requestPrintCapture === 'function') {
            let frameSelector = null;
            try {
              const SAFE_ID = /^[A-Za-z][A-Za-z0-9_\\-]*$/;
              const SAFE_DATA_VALUE = /^[A-Za-z0-9_\\-:.]+$/;
              const el = window.frameElement;
              if (el) {
                if (el.id && SAFE_ID.test(el.id)) {
                  frameSelector = 'iframe#' + el.id;
                } else if (el.id) {
                  try { console.warn('[Print Capture] iframe id needs CSS.escape (' + JSON.stringify(el.id) + ') — checking data-print-id fallback'); } catch (_) {}
                }
                if (!frameSelector) {
                  const dataPrintId = el.getAttribute('data-print-id');
                  if (dataPrintId) {
                    if (SAFE_DATA_VALUE.test(dataPrintId)) {
                      frameSelector = 'iframe[data-print-id="' + dataPrintId + '"]';
                    } else {
                      try { console.warn('[Print Capture] iframe data-print-id needs escaping (' + JSON.stringify(dataPrintId) + ') — falling back to iframe[srcdoc]'); } catch (_) {}
                    }
                  }
                }
              }
            } catch (_) { /* cross-origin frameElement read — fall back to null */ }

            api.requestPrintCapture({
              url: sanitizeUrl(window.location.href),
              title: document.title,
              timestamp: Date.now(),
              scope: window === window.top ? 'top' : 'iframe',
              frameSelector,
            });
            return;
          }
        } catch (_) {
          break;
        }
        try {
          if (w === w.parent) break;
          w = w.parent;
        } catch (_) {
          break;
        }
      }
      // Top-frame prints without electronAPI fall through silently —
      // printCapture.ts's console marker above already fired and is the
      // primary signal in suppressFocus mode.
      if (window !== window.top) {
        try { console.error('[Print Capture] bridge unreachable at ' + sanitizeUrl(window.location.href)); } catch (_) {}
      }
    }, 'print');
  } catch (_) {}
  ` : ''}

  ${suppressFocus ? `
  // ============================================================
  // C5 — window.open focus-steal shim (Sapoto #1036, refactor #1043, #1044)
  // ============================================================
  // Page-level window.open(url, '_blank') (or any non-_self target) routes
  // through Chromium's Browser::AddNewContents → NativeWidgetMac::Activate →
  // [NSApp activateIgnoringOtherApps:YES], stealing focus from the user's
  // frontmost app on macOS. Source-of-truth: docs/research/chromium-window-
  // open-focus-steal.md.
  //
  // The shim handles focus-steal suppression only. Download capture is
  // decoupled: we emit a [FocusShim] background-open <url> marker that
  // Sapoto's main process catches via Runtime.consoleAPICalled and uses to
  // spawn a hidden CDP target via Target.createTarget with background:true.
  // The hidden target renders the URL naturally — Layer 1 (Fetch.enable)
  // catches PDF bytes, Layer 4 (printCapture) catches HTML-auto-print, and
  // Layer 2 catches in-tab downloads. No focus steal because background:true.
  //
  // This replaces the pre-#1044 fetch() mechanism: fetch() worked for URLs
  // that serve PDF bytes directly, but Netflix-style /invoice/print/<id>
  // endpoints return HTML that auto-calls window.print() — fetch() retrieved
  // the HTML silently and Layer 1 (which only handles PDF) produced nothing.
  // Routing to a real hidden target lets the existing layer stack do its job.
  //
  // Scope:
  //   - window.open(_self|_parent|_top)          → native passthrough
  //   - window.open('')                           → print-capture proxy (unnamed only)
  //   - window.open(downloadUrl, *) same-origin   → background-open marker; return null
  //   - window.open(downloadUrl, *) cross-origin  → background-open marker; return null
  //   - window.open(other)                        → native passthrough
  try {
    const _markNative = (window).__stealthMarkNative || function(fn) { return fn; };

    // Entry marker — fires BEFORE any other shim code, so the absence of
    // this line in app_logs unambiguously means C5 didn't even start.
    try { console.debug('[FocusShim] C4 entry at ' + sanitizeUrl(location.href) + ' (top=' + (window === window.top) + ')'); } catch (_) {}

    const DOWNLOAD_URL_RE = /\\.(pdf|xlsx?|csv|docx?|zip|tsv|ofx|qfx|qif|7z|rtf)(\\?|#|$)/i;
    const DOWNLOAD_PATH_RE = /\\/(download|statement|statements|export|invoice|invoices|receipt|receipts|PDFStatement|StatementPDF|getstmt|getStmt|stmt)(?:\\/|\\.|$)/i;
    const SELF_TARGET_RE = /^(_self|_parent|_top)$/i;

    // Install marker — fires only if the whole patch installed cleanly.
    try { console.debug('[FocusShim] installed at ' + sanitizeUrl(location.href) + ' (top=' + (window === window.top) + ')'); } catch (_) {}

    const _urlLooksLikeDownload = function(href) {
      if (!href) return false;
      if (DOWNLOAD_URL_RE.test(href)) return true;
      try {
        const u = new URL(href, location.href);
        if (DOWNLOAD_PATH_RE.test(u.pathname)) return true;
      } catch (_) { /* unparseable — give up */ }
      return false;
    };

    // Emit a marker that Sapoto's main process catches via
    // Runtime.consoleAPICalled and routes to Target.createTarget({background:true}).
    // The hidden target renders the URL — Layer 1 catches PDFs, Layer 4 catches
    // HTML-auto-print. Lifecycle (attach, 30s timeout, close-on-capture) is
    // owned by the Sapoto-side backgroundOpenBridge.ts.
    //
    // The marker carries the navigation target consumed by Sapoto's bridge.
    // sanitizeUrl() would strip query/hash that may carry the statement id or
    // signed auth token — emitting /download for /download?id=123&token=abc
    // would make the bridge open the wrong URL or 401. Emit the full absolute
    // URL here; existing src/main/redaction/ handles remote-log sanitization
    // for any sensitive params before shipping.
    const _emitBackgroundOpen = function(href) {
      try { console.debug('[FocusShim] background-open ' + href); } catch (_) {}
    };

    const _printCaptureProxy = function() {
      let _capturedHtml = '';
      return {
        document: {
          write: function(html) { _capturedHtml += String(html); },
          writeln: function(html) { _capturedHtml += String(html) + '\\n'; },
          close: function() { /* noop */ },
          open: function() { _capturedHtml = ''; },
          title: '',
        },
        focus: function() { /* noop */ },
        blur: function() { /* noop */ },
        print: function() {
          try { console.debug('[FocusShim] synthesized-popup print() suppressed; captured chars=' + _capturedHtml.length); } catch (_) {}
          try {
            const api = (window).electronAPI;
            if (api && typeof api.requestPrintCapture === 'function') {
              api.requestPrintCapture({
                url: sanitizeUrl(location.href),
                title: document.title || 'synthesized popup',
                timestamp: Date.now(),
                scope: 'synthesized-popup',
                capturedHtml: _capturedHtml,
                frameSelector: null,
              });
            }
          } catch (_) { /* ignore */ }
        },
        close: function() { /* noop */ },
        closed: false,
        location: { href: '', toString: function() { return ''; } },
        opener: null,
      };
    };

    // Build the wrapper. Capture the original via getOwnPropertyDescriptor
    // because Chromium ships window.open as an accessor in some builds.
    const _origDesc = Object.getOwnPropertyDescriptor(window, 'open');
    const _nativeOpen = (function() {
      if (_origDesc && typeof _origDesc.value === 'function')
        return _origDesc.value.bind(window);
      return window.open.bind(window);
    })();

    let _electronModeNoticed = false;

    // Structural fingerprint for Sapoto's preload bridge. Bare
    // \`typeof window.electronAPI !== 'undefined'\` is too loose — any page
    // script that sets that global (intentionally or accidentally) would
    // disable the focus-suppression / download-interception path in Chrome
    // mode. We require the specific function we actually call
    // (requestPrintCapture) so a stub like { requestPrintCapture: 1 } or
    // a hostile getter that throws can't masquerade as the bridge.
    const _isSapotoElectronBridge = function() {
      try {
        const api = (window).electronAPI;
        return !!api && typeof api === 'object' && typeof api.requestPrintCapture === 'function';
      } catch (_) {
        return false;
      }
    };

    const _shimOpen = _markNative(function open(url, target, features) {
      const u = (url == null ? '' : String(url));
      const t = (target == null ? '' : String(target));

      // Electron mode: setWindowOpenHandler in main process already neutralizes
      // focus-steal at window-creation time (forces show:false, focusable:false,
      // skipTaskbar:true). The page-side shim is redundant here and would
      // silently drop bytes via fetch-and-forget since Layer 1 is Chrome-mode-only.
      // Detection: Sapoto's preload exposes electronAPI.requestPrintCapture
      // (a function). We fingerprint that exact shape rather than testing
      // \`typeof electronAPI !== 'undefined'\` so a page-defined global can't
      // disable the shim.
      if (_isSapotoElectronBridge()) {
        if (!_electronModeNoticed) {
          _electronModeNoticed = true;
          try { console.debug('[FocusShim] electron mode detected — delegating to native window.open'); } catch (_) {}
        }
        return _nativeOpen(url, target, features);
      }

      // Diagnostic: log EVERY window.open call so we can see in production
      // logs what targets/URLs the page is using. Uses console.debug to keep
      // noisy per-call diagnostics out of the captured Supabase warn stream.
      try { console.debug('[FocusShim] window.open called url=' + (u ? sanitizeUrl(u) : '(empty)') + ' target=' + (t || '(empty)')); } catch (_) {}

      // _self/_parent/_top navigate in current context — never steal focus.
      if (SELF_TARGET_RE.test(t))
        return _nativeOpen(url, target, features);

      // Empty URL: only synthesize the print-receipt proxy for unnamed
      // popups (target === '_blank' or absent). Named targets like
      // window.open('', 'helpWindow') are legitimate named-popup workflows
      // (multi-window apps, help popups, OAuth named popups) — delegate to
      // native so the page gets a real Window reference.
      if (!u) {
        if (t && t !== '_blank' && !SELF_TARGET_RE.test(t)) {
          try { console.debug('[FocusShim] → native (empty URL, named target=' + t + ')'); } catch (_) {}
          return _nativeOpen(url, target, features);
        }
        try { console.debug('[FocusShim] → print-capture proxy (empty URL)'); } catch (_) {}
        return _printCaptureProxy();
      }

      // Download-y URL → emit background-open marker. Sapoto's main process
      // catches the marker and spawns a hidden CDP target via
      // Target.createTarget({background:true, browserContextId}) — the new
      // target renders the URL naturally with full cookie context (shared
      // browserContextId), so Layer 1 catches PDF bytes via Fetch.enable and
      // Layer 4 catches HTML-auto-print via its console marker. Both
      // same-origin and cross-origin URLs route the same way now: spawning
      // a hidden target is the right primitive regardless of origin, and it
      // closes the pre-#1044 "accepted focus-steal for one cross-origin
      // popup" trade-off.
      if (_urlLooksLikeDownload(u)) {
        let absoluteUrl = u;
        try {
          absoluteUrl = new URL(u, location.href).href;
        } catch (_) {
          // Unparseable URL — bridge would reject it anyway. Fall through to
          // native so the page sees the same behavior the unshimmed browser
          // would have produced (focus-steal, but at least correct semantics).
          try { console.debug('[FocusShim] → native (invalid URL)'); } catch (_) {}
          return _nativeOpen(url, target, features);
        }
        try { console.debug('[FocusShim] → background-open url=' + sanitizeUrl(absoluteUrl)); } catch (_) {}
        _emitBackgroundOpen(absoluteUrl);
        return null;
      }

      // Other URLs: native. Focus steals but this is rare in portal automation.
      try { console.debug('[FocusShim] → native (URL did not match download heuristic)'); } catch (_) {}
      return _nativeOpen(url, target, features);
    }, 'open');

    // Install with Object.defineProperty(writable:false, configurable:false)
    // so subsequent assignments (or Fidelity-style late wrap attempts) fail
    // silently in sloppy mode / throw in strict mode, but cannot replace ours.
    try {
      Object.defineProperty(window, 'open', {
        value: _shimOpen,
        writable: false,
        configurable: false,
        enumerable: true,
      });
    } catch (_) {
      // Fallback: plain assignment. Some hardened browsers may reject
      // configurable:false on built-ins; we accept the override risk.
      try { console.debug('[FocusShim] defineProperty failed, falling back to assignment'); } catch (_) {}
      try { (window).open = _shimOpen; } catch (_) { /* really stuck */ }
    }
  } catch (e) {
    // Diagnostic-only catch. If C5 throws on any frame, log enough to
    // identify the failure without spamming the page with uncaught
    // exceptions. C1/C2/C3/C4 above already ran outside this try.
    try {
      const msg = (e && e.message) ? String(e.message) : String(e);
      const stack = (e && e.stack) ? String(e.stack).split('\\n').slice(0, 5).join(' / ') : '(no stack)';
      try { console.debug('[FocusShim] install crashed: ' + msg + ' | stack=' + stack + ' | at ' + sanitizeUrl(location.href)); } catch (_) {}
    } catch (_) { /* logger itself threw — give up silently */ }
  }
  ` : ''}
})();`;
}

/**
 * Default-options stealth init script — `stealth: true, suppressFocus: false`.
 * Preserved as a named export so existing unit tests in
 * `tests/library/stealth-stubs.spec.ts` (and any consumers that import the
 * constant directly) keep working without passing options. This is the
 * "stealth stubs only, no FocusShim" form.
 */
export const CDP_STEALTH_INIT_SCRIPT = buildStealthInitScript({ stealth: true, suppressFocus: false });
