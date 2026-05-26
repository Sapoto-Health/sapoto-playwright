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
 * Placeholder — will be filled in by a subsequent tracer.
 */
export function buildFocusShimSection(_options: { suppressFocus?: boolean; backgroundOpenCapture?: boolean }): string {
  return '';
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
