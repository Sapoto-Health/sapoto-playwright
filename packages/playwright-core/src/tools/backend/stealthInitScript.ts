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
 * Stealth init-script builder for the sapoto-playwright fork.
 *
 * Produces a self-invoking IIFE suitable for `BrowserContext.addInitScript`.
 * The script runs in the main world before any page script via
 * `Page.addScriptToEvaluateOnNewDocument`.
 *
 * Architecture:
 *   - Section functions are exported separately so subsequent tracers can
 *     fill them in independently without merge conflicts.
 *   - The main `buildStealthInitScript` function composes sections and wraps
 *     each in try-catch for third-party-frame resilience (Sapoto #1036).
 *   - The toString masking infrastructure (WeakMap + _markNative) is always
 *     installed when ANY flag is active, since downstream sections depend on it.
 */

export interface StealthInitScriptOptions {
  chromeRuntimeStubs?: boolean;
  printCapture?: boolean;
  suppressFocus?: boolean;
  backgroundOpenCapture?: boolean;
}

/**
 * Returns true when at least one flag requires the init script to be injected.
 */
function needsInitScript(options: StealthInitScriptOptions): boolean {
  return !!(
    options.chromeRuntimeStubs ||
    options.printCapture ||
    options.suppressFocus ||
    options.backgroundOpenCapture
  );
}

// ---------------------------------------------------------------------------
// toString masking infrastructure
// ---------------------------------------------------------------------------

/**
 * Build the toString masking infrastructure section. This includes:
 *   - `__chromeStealth` re-entry guard (prevents double-injection)
 *   - `Function.prototype.toString` WeakMap patch
 *   - `_markNative(fn)` helper exposed via `__stealthMarkNative` global
 *
 * Always installed when ANY flag is active, since section stubs need
 * `__stealthMarkNative` to mask their overrides.
 */
export function buildToStringInfrastructure(): string {
  return `
  // Re-entry guard: prevents double-injection in iframes / rapid nav.
  if ((window).__chromeStealth) return;
  (window).__chromeStealth = true;

  // Function.prototype.toString masking via WeakMap.
  // Akamai bmak calls .toString.call(weirdThis) — guard the lookup so
  // non-function this values fall through to the native delegate.
  const _toString = Function.prototype.toString;
  const _nativeMap = new WeakMap();
  function _markNative(fn, name) {
    try { _nativeMap.set(fn, 'function ' + name + '() { [native code] }'); } catch (_) {}
    return fn;
  }
  Function.prototype.toString = function() {
    try {
      if (this != null
          && (typeof this === 'object' || typeof this === 'function')
          && _nativeMap.has(this))
        return _nativeMap.get(this);
    } catch (_) { /* WeakMap rejects non-object keys — fall through */ }
    return _toString.call(this);
  };
  _markNative(Function.prototype.toString, 'toString');

  // Expose _markNative to later sections via a global handshake so each
  // section can mask its own overrides without re-defining the helper.
  (window).__stealthMarkNative = _markNative;
`;
}

// ---------------------------------------------------------------------------
// Section stubs — filled in by subsequent tracers
// ---------------------------------------------------------------------------

/**
 * Build the chrome.{app,csi,loadTimes} stubs section.
 *
 * Minimal stubs carried forward from the previous crPage.ts inline scripts.
 * A subsequent tracer will replace these with the full old-fork content
 * (chrome.app, Notification.permission, etc.).
 */
export function buildChromeStubsSection(): string {
  return `
    if (typeof window.chrome === 'undefined')
      window.chrome = {};
    if (!window.chrome.csi) {
      window.chrome.csi = function() {
        return {
          startE: Date.now(),
          onloadT: Date.now(),
          pageT: performance.now(),
          tran: 15
        };
      };
    }
    if (!window.chrome.loadTimes) {
      window.chrome.loadTimes = function() {
        return {
          commitLoadTime: Date.now() / 1000,
          connectionInfo: 'http/1.1',
          finishDocumentLoadTime: Date.now() / 1000,
          finishLoadTime: Date.now() / 1000,
          firstPaintAfterLoadTime: 0,
          firstPaintTime: Date.now() / 1000,
          navigationType: 'Other',
          npnNegotiatedProtocol: 'http/1.1',
          requestTime: Date.now() / 1000,
          startLoadTime: Date.now() / 1000,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: false,
          wasNpnNegotiated: false
        };
      };
    }
`;
}

/**
 * Build the print capture section.
 *
 * Minimal override carried forward from the previous crPage.ts inline script.
 * Overrides window.print() to dispatch a custom event that the host intercepts
 * via CDP Runtime.evaluate. A subsequent tracer will replace this with the
 * full deferred-print + Path D srcdoc-iframe bridge from the old fork.
 */
export function buildPrintCaptureSection(): string {
  return `
    const origPrint = window.print.bind(window);
    Object.defineProperty(window, 'print', {
      configurable: true,
      writable: true,
      value: function sapotoPrintCapture() {
        window.dispatchEvent(new CustomEvent('__sapotoPrintRequest'));
        // Do NOT call origPrint() — the host owns the print flow.
      }
    });
`;
}

/**
 * Build the focus shim section (window.open focus-steal suppression).
 *
 * C5 -- window.open focus-steal shim (Sapoto #1036, refactor #1043, #1044)
 *
 * Page-level window.open(url, '_blank') routes through Chromium's
 * Browser::AddNewContents -> NativeWidgetMac::Activate ->
 * [NSApp activateIgnoringOtherApps:YES], stealing focus from the user's
 * frontmost app on macOS. The shim re-routes download-y URLs through a
 * console marker that Sapoto's main process catches, synthesizes a
 * print-receipt proxy for empty-URL unnamed popups, and falls through
 * to native for everything else.
 *
 * Gating:
 *   - `suppressFocus`: install the window.open shim itself (focus-steal prevention)
 *   - `backgroundOpenCapture`: install download-URL detection + background-open markers
 *   - `printCapture`: enable the synthesized-popup print-receipt proxy for
 *     empty-URL unnamed popups (window.open('', '_blank') + document.write + print)
 *
 * Scope:
 *   - window.open(_self|_parent|_top)           -> native passthrough
 *   - window.open('') + printCapture            -> print-capture proxy (unnamed only)
 *   - window.open(downloadUrl, *) same/cross    -> background-open marker; return null
 *   - window.open(other)                        -> native passthrough
 *
 * NOTE: The `buildStealthInitScript` composition layer must be updated to pass
 * `printCapture` through to this function for the print-capture proxy to activate.
 */
export function buildFocusShimSection(options: { suppressFocus?: boolean; backgroundOpenCapture?: boolean; printCapture?: boolean }): string {
  const suppressFocus = !!options.suppressFocus;
  const backgroundOpenCapture = !!options.backgroundOpenCapture;
  const printCapture = !!options.printCapture;

  // Nothing to do if neither flag is active.
  if (!suppressFocus && !backgroundOpenCapture)
    return '';

  // Build the conditional blocks as separate strings to avoid deeply nested
  // template-literal ternaries which are hard to read and audit.
  const downloadRegexBlock = backgroundOpenCapture ? `
    // Download-URL heuristics: file extensions and path segments that strongly
    // correlate with document downloads on financial portals.
    const DOWNLOAD_URL_RE = /\\.(pdf|xlsx?|csv|docx?|zip|tsv|ofx|qfx|qif|7z|rtf)(\\?|#|$)/i;
    const DOWNLOAD_PATH_RE = /\\/(download|statement|statements|export|invoice|invoices|receipt|receipts|PDFStatement|StatementPDF|getstmt|getStmt|stmt)(?:\\/|\\.|$)/i;
` : '';

  const downloadFnBlock = backgroundOpenCapture ? `
    const _urlLooksLikeDownload = function(href) {
      if (!href) return false;
      if (DOWNLOAD_URL_RE.test(href)) return true;
      try {
        const u = new URL(href, location.href);
        if (DOWNLOAD_PATH_RE.test(u.pathname)) return true;
      } catch (_) { /* unparseable -- give up */ }
      return false;
    };

    // Emit a [FocusShim] background-open marker that Sapoto's main process
    // catches via Runtime.consoleAPICalled and routes to
    // Target.createTarget({background:true}). The hidden target renders the
    // URL naturally -- Layer 1 catches PDFs, Layer 4 catches HTML-auto-print.
    //
    // The marker carries the FULL absolute URL (not sanitized) because the
    // query/hash may carry statement IDs or signed auth tokens required for
    // the download. Sapoto's src/main/redaction/ handles remote-log sanitization
    // before shipping.
    const _emitBackgroundOpen = function(href) {
      try { console.log('[FocusShim] background-open ' + href); } catch (_) {}
    };
` : '';

  const printProxyBlock = printCapture ? `
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
                url: _sanitizeUrl(location.href),
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
` : '';

  const emptyUrlHandler = printCapture
    ? `
        try { console.debug('[FocusShim] -> print-capture proxy (empty URL)'); } catch (_) {}
        return _printCaptureProxy();
`
    : `
        try { console.debug('[FocusShim] -> native (empty URL, no print-capture)'); } catch (_) {}
        return _nativeOpen(url, target, features);
`;

  const downloadCheckBlock = backgroundOpenCapture ? `
      // Download-y URL -> emit background-open marker. Sapoto's main process
      // catches the marker and spawns a hidden CDP target via
      // Target.createTarget({background:true, browserContextId}).
      if (_urlLooksLikeDownload(u)) {
        let absoluteUrl = u;
        try {
          absoluteUrl = new URL(u, location.href).href;
        } catch (_) {
          // Unparseable URL -- fall through to native so the page sees the
          // same behavior the unshimmed browser would have produced.
          try { console.debug('[FocusShim] -> native (invalid URL)'); } catch (_) {}
          return _nativeOpen(url, target, features);
        }
        try { console.debug('[FocusShim] -> background-open url=' + _sanitizeUrl(absoluteUrl)); } catch (_) {}
        _emitBackgroundOpen(absoluteUrl);
        return null;
      }
` : '';

  return `
    const _markNative = (window).__stealthMarkNative || function(fn) { return fn; };

    // URL-redaction helper -- strip query/hash before logging. Session tokens
    // can leak via query params; redact at the source per Sapoto redaction rules.
    const _sanitizeUrl = function(href) {
      if (typeof href !== 'string') return String(href);
      if (!href) return href;
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

    // Entry marker -- fires BEFORE any other shim code so absence in logs
    // unambiguously means C5 didn't even start.
    try { console.debug('[FocusShim] C5 entry at ' + _sanitizeUrl(location.href) + ' (top=' + (window === window.top) + ')'); } catch (_) {}

${downloadRegexBlock}
    const SELF_TARGET_RE = /^(_self|_parent|_top)$/i;

${downloadFnBlock}
${printProxyBlock}
    // Capture the original window.open via getOwnPropertyDescriptor because
    // Chromium ships window.open as an accessor in some builds.
    const _origDesc = Object.getOwnPropertyDescriptor(window, 'open');
    const _nativeOpen = (function() {
      if (_origDesc && typeof _origDesc.value === 'function')
        return _origDesc.value.bind(window);
      return window.open.bind(window);
    })();

    let _electronModeNoticed = false;

    // Structural fingerprint for Sapoto's preload bridge. We require the
    // specific function we actually call (requestPrintCapture) so a stub
    // or hostile getter can't masquerade as the bridge.
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
      // focus-steal at window-creation time. The page-side shim is redundant
      // and would silently drop bytes since Layer 1 is Chrome-mode-only.
      if (_isSapotoElectronBridge()) {
        if (!_electronModeNoticed) {
          _electronModeNoticed = true;
          try { console.debug('[FocusShim] electron mode detected -- delegating to native window.open'); } catch (_) {}
        }
        return _nativeOpen(url, target, features);
      }

      // Diagnostic: log EVERY window.open call. Uses console.debug to keep
      // noisy per-call diagnostics out of the captured Supabase warn stream.
      try { console.debug('[FocusShim] window.open called url=' + (u ? _sanitizeUrl(u) : '(empty)') + ' target=' + (t || '(empty)')); } catch (_) {}

      // _self/_parent/_top navigate in current context -- never steal focus.
      if (SELF_TARGET_RE.test(t))
        return _nativeOpen(url, target, features);

      // Empty URL: only synthesize the print-receipt proxy for unnamed
      // popups (target === '_blank' or absent). Named targets like
      // window.open('', 'helpWindow') are legitimate named-popup workflows.
      if (!u) {
        if (t && t !== '_blank' && !SELF_TARGET_RE.test(t)) {
          try { console.debug('[FocusShim] -> native (empty URL, named target=' + t + ')'); } catch (_) {}
          return _nativeOpen(url, target, features);
        }
${emptyUrlHandler}
      }

${downloadCheckBlock}
      // Other URLs: native. Focus steals but this is rare in portal automation.
      try { console.debug('[FocusShim] -> native (URL did not match download heuristic)'); } catch (_) {}
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

    // Install marker -- fires only if the whole patch installed cleanly.
    try { console.debug('[FocusShim] installed at ' + _sanitizeUrl(location.href) + ' (top=' + (window === window.top) + ')'); } catch (_) {}
`;
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build the stealth init script source string for the given options.
 *
 * Returns an empty string when no flags are active. When any flag is active,
 * installs the toString masking infrastructure and conditionally includes
 * section stubs based on which flags are set. Each section is wrapped in
 * try-catch for third-party-frame resilience.
 */
export function buildStealthInitScript(options: StealthInitScriptOptions): string {
  if (!needsInitScript(options))
    return '';

  const sections: string[] = [];

  // toString infrastructure is always first — other sections depend on it.
  sections.push(buildToStringInfrastructure());

  // Chrome runtime stubs (chrome.app, chrome.csi, chrome.loadTimes, Notification).
  if (options.chromeRuntimeStubs) {
    const section = buildChromeStubsSection();
    if (section) {
      sections.push(`
  // Chrome runtime stubs section
  try {
${section}
  } catch (_) { /* Section failure must not abort remaining sections */ }`);
    }
  }

  // Print capture (deferred window.print() + Path D bridge).
  if (options.printCapture) {
    const section = buildPrintCaptureSection();
    if (section) {
      sections.push(`
  // Print capture section
  try {
${section}
  } catch (_) { /* Section failure must not abort remaining sections */ }`);
    }
  }

  // Focus shim (window.open focus-steal suppression).
  if (options.suppressFocus || options.backgroundOpenCapture) {
    const section = buildFocusShimSection({
      suppressFocus: options.suppressFocus,
      backgroundOpenCapture: options.backgroundOpenCapture,
    });
    if (section) {
      sections.push(`
  // Focus shim section
  try {
${section}
  } catch (_) { /* Section failure must not abort remaining sections */ }`);
    }
  }

  return `(() => {
${sections.join('\n')}
})();`;
}
