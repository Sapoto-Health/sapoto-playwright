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
 *        Gated on `suppressFocus`. Replaces the deferred hook with a fast-path
 *        intercept that logs and re-runs the bridge walk for iframe scopes.
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
   * C2: chrome.{app,csi,loadTimes} + navigator.languages + Notification, and
   * Function.prototype.toString masking). Sapoto's chrome mode passes
   * `--no-stealth` (stealth=false) because chrome's real identity must not be
   * shadowed by the stubs — but FocusShim/Path D still need to install in
   * that mode. So gating C1/C2 must be independent of gating C3/C4/C5.
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
};

/**
 * Build the stealth init script source string for the given options. Returned
 * value is a self-invoking IIFE suitable for `BrowserContext.addInitScript`.
 *
 * The Sapoto build step at scripts/prepare-mcp-assets.js greps the compiled
 * fork output for the `__SAPOTO_PATHD_BRIDGE_V1__` constant. If absent, the
 * build fails — guarding against stale fork rebases that would silently
 * regress iframe print capture (Path D / issue #1006).
 */
export function buildStealthInitScript(options: StealthInitScriptOptions): string {
  const stealth = !!options.stealth;
  const suppressFocus = !!options.suppressFocus;
  return `(() => {
  if ((window).__chromeStealth) return;
  (window).__chromeStealth = true;

  // Path D (Sapoto #1006) backward-compat detection stamp. The Sapoto build
  // step greps the compiled fork output for this exact constant. Do NOT
  // rename without coordinating with the Sapoto side.
  if (!(window).__SAPOTO_PATHD_BRIDGE_V1__)
    (window).__SAPOTO_PATHD_BRIDGE_V1__ = true;

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
        if (this != null
            && (typeof this === 'object' || typeof this === 'function')
            && _nativeMap.has(this))
          return _nativeMap.get(this);
      } catch (_) { /* WeakMap rejects non-object keys — fall through */ }
      return _toString.call(this);
    };
    _markNative(Function.prototype.toString, 'toString');
    // Expose _markNative to later sections via a closure-captured global so the
    // C4/C5 blocks can mask their own overrides without re-defining the helper.
    (window).__stealthMarkNative = _markNative;

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
    // Swallow and continue so C3+ still install.
  }
  ` : ''}

  ${suppressFocus ? `
  // ============================================================
  // C3 — Deferred window.print() + Path D srcdoc-iframe bridge (#1006)
  // ============================================================
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
        // Use console.warn so the message reaches Supabase app_logs —
        // console.log is filtered out by the remote shipper.
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

  ${suppressFocus ? `
  // ============================================================
  // C4 — suppressFocus-mode window.print() + Path D mirror (#1006)
  // ============================================================
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

  // ============================================================
  // C5 — window.open focus-steal shim (Sapoto #1036, refactor #1043)
  // ============================================================
  // Page-level window.open(url, '_blank') (or any non-_self target) routes
  // through Chromium's Browser::AddNewContents → NativeWidgetMac::Activate →
  // [NSApp activateIgnoringOtherApps:YES], stealing focus from the user's
  // frontmost app on macOS. Source-of-truth: docs/research/chromium-window-
  // open-focus-steal.md.
  //
  // The shim handles focus-steal suppression only. Download capture is
  // decoupled: the same-origin fetch issued for download-y URLs is caught
  // by Sapoto's Layer 1 CDP Fetch.enable interception, so no bytes flow
  // through this script.
  //
  // Scope:
  //   - window.open(_self|_parent|_top)         → native passthrough
  //   - window.open('')                          → print-capture proxy (unnamed only)
  //   - window.open(downloadUrl, *) same-origin  → fetch(); return null
  //   - window.open(downloadUrl, *) cross-origin → native passthrough
  //   - window.open(other)                       → native passthrough
  try {
    const _markNative = (window).__stealthMarkNative || function(fn) { return fn; };

    // Entry marker — fires BEFORE any other shim code, so the absence of
    // this line in app_logs unambiguously means C5 didn't even start.
    try { console.warn('[FocusShim] C4 entry at ' + sanitizeUrl(location.href) + ' (top=' + (window === window.top) + ')'); } catch (_) {}

    const DOWNLOAD_URL_RE = /\\.(pdf|xlsx?|csv|docx?|zip|tsv|ofx|qfx|qif|7z|rtf)(\\?|#|$)/i;
    const DOWNLOAD_PATH_RE = /\\/(download|statement|statements|export|invoice|invoices|receipt|receipts|PDFStatement|StatementPDF|getstmt|getStmt|stmt)(?:\\/|\\.|$)/i;
    const SELF_TARGET_RE = /^(_self|_parent|_top)$/i;

    // Install marker — fires only if the whole patch installed cleanly.
    try { console.warn('[FocusShim] installed at ' + sanitizeUrl(location.href) + ' (top=' + (window === window.top) + ')'); } catch (_) {}

    const _urlLooksLikeDownload = function(href) {
      if (!href) return false;
      if (DOWNLOAD_URL_RE.test(href)) return true;
      try {
        const u = new URL(href, location.href);
        if (DOWNLOAD_PATH_RE.test(u.pathname)) return true;
      } catch (_) { /* unparseable — give up */ }
      return false;
    };

    const _fetchAndForget = function(href) {
      fetch(href, { credentials: 'include' }).then(function(resp) {
        // fetch() only rejects on network errors — HTTP 4xx/5xx resolve
        // normally with resp.ok === false. Some portals gate downloads on
        // Sec-Fetch-Mode: navigate (window.open / <a download>) versus
        // Sec-Fetch-Mode: cors (fetch), so fetch can return 401/403 while
        // a real navigation would have succeeded. Re-throw on non-OK so
        // the unified .catch() below synthesizes the <a download> fallback.
        if (!resp || !resp.ok) {
          const status = resp ? resp.status : 'no-response';
          throw new Error('HTTP ' + status);
        }
        // Layer 1's CDP Fetch.enable has already captured the bytes by the
        // time the response resolves here. We don't need to read resp.body.
        return resp;
      }).catch(function(err) {
        const msg = (err && err.message) ? err.message : String(err);
        try { console.warn('[FocusShim] fetch unsuccessful: ' + msg + ' — falling back to <a download>'); } catch (_) {}
        // Same-origin pre-check can mask a 302 to a cross-origin signed CDN
        // (common bank-portal pattern). fetch() defaults to mode:'cors' and
        // blocks on missing CORS headers; <a download>.click() goes through
        // Chromium's URL handler which doesn't apply CORS to downloads, so
        // the redirect is followed and Content-Disposition triggers a real
        // download. This restores the pre-refactor Layer 2 capture path.
        try {
          const a = document.createElement('a');
          a.href = href;
          a.download = '';
          a.rel = 'noopener noreferrer';
          a.style.display = 'none';
          (document.body || document.documentElement).appendChild(a);
          a.click();
          setTimeout(function() {
            try { a.remove(); } catch (_) {}
          }, 0);
        } catch (fallbackErr) {
          const fmsg = (fallbackErr && fallbackErr.message) ? fallbackErr.message : String(fallbackErr);
          try { console.warn('[FocusShim] <a download> fallback also failed: ' + fmsg); } catch (_) {}
        }
      });
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
          try { console.warn('[FocusShim] synthesized-popup print() suppressed; captured chars=' + _capturedHtml.length); } catch (_) {}
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
          try { console.warn('[FocusShim] electron mode detected — delegating to native window.open'); } catch (_) {}
        }
        return _nativeOpen(url, target, features);
      }

      // Diagnostic: log EVERY window.open call so we can see in production
      // logs what targets/URLs the page is using. Use warn (captured).
      try { console.warn('[FocusShim] window.open called url=' + (u ? sanitizeUrl(u) : '(empty)') + ' target=' + (t || '(empty)')); } catch (_) {}

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
          try { console.warn('[FocusShim] → native (empty URL, named target=' + t + ')'); } catch (_) {}
          return _nativeOpen(url, target, features);
        }
        try { console.warn('[FocusShim] → print-capture proxy (empty URL)'); } catch (_) {}
        return _printCaptureProxy();
      }

      // Download-y URL → same-origin fetch caught by Layer 1's CDP
      // Fetch.enable. Cross-origin falls through to native (CORS would
      // block the fetch anyway; focus-steal accepted for that one popup).
      if (_urlLooksLikeDownload(u)) {
        try {
          if (new URL(u, location.href).origin !== location.origin) {
            try { console.warn('[FocusShim] → native (cross-origin download URL)'); } catch (_) {}
            return _nativeOpen(url, target, features);
          }
        } catch (_) {
          try { console.warn('[FocusShim] → native (invalid URL)'); } catch (_) {}
          return _nativeOpen(url, target, features);
        }
        try { console.warn('[FocusShim] → fetch url=' + sanitizeUrl(u)); } catch (_) {}
        _fetchAndForget(u);
        return null;
      }

      // Other URLs: native. Focus steals but this is rare in portal automation.
      try { console.warn('[FocusShim] → native (URL did not match download heuristic)'); } catch (_) {}
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
      try { console.warn('[FocusShim] defineProperty failed, falling back to assignment'); } catch (_) {}
      try { (window).open = _shimOpen; } catch (_) { /* really stuck */ }
    }
  } catch (e) {
    // Diagnostic-only catch. If C5 throws on any frame, log enough to
    // identify the failure without spamming the page with uncaught
    // exceptions. C1/C2/C3/C4 above already ran outside this try.
    try {
      const msg = (e && e.message) ? String(e.message) : String(e);
      const stack = (e && e.stack) ? String(e.stack).split('\\n').slice(0, 5).join(' / ') : '(no stack)';
      try { console.warn('[FocusShim] install crashed: ' + msg + ' | stack=' + stack + ' | at ' + sanitizeUrl(location.href)); } catch (_) {}
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
