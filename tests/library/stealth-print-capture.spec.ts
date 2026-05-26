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

import { test, expect } from '@playwright/test';
import {
  buildPrintCaptureSection,
  buildStealthInitScript,
} from '../../packages/playwright-core/src/tools/backend/stealthInitScript';

// ---------------------------------------------------------------------------
// Stealth init-script builder: print capture section (Tracer #1129)
//
// Tests verify the generated JavaScript string has the right shape and
// semantics without requiring a browser or MCP server. Pure unit tests.
// ---------------------------------------------------------------------------

test.describe('buildPrintCaptureSection', () => {
  test('returns non-empty string', () => {
    const section = buildPrintCaptureSection();
    expect(section.trim().length).toBeGreaterThan(0);
  });

  test('emits [Print Capture] console marker', () => {
    const section = buildPrintCaptureSection();
    expect(section).toContain('[Print Capture] window.print() intercepted at');
  });

  test('uses __stealthMarkNative to mask the override', () => {
    const section = buildPrintCaptureSection();
    // Must reference __stealthMarkNative from the global handshake.
    expect(section).toContain('__stealthMarkNative');
    // Must call _markNative(function print() ..., 'print') so
    // window.print.toString() returns "function print() { [native code] }".
    expect(section).toContain("_markNative(function print()");
    expect(section).toContain("}, 'print')");
  });

  test('walks up to 8 parent frames for electronAPI bridge', () => {
    const section = buildPrintCaptureSection();
    // Must have the bridge walk loop with max 8 hops.
    expect(section).toContain('hops < 8');
    expect(section).toContain('electronAPI');
    expect(section).toContain('requestPrintCapture');
  });

  test('computes frameSelector with SAFE_ID and SAFE_DATA_VALUE regex', () => {
    const section = buildPrintCaptureSection();
    // SAFE_ID regex for CSS-safe iframe id targeting.
    expect(section).toContain('SAFE_ID');
    expect(section).toMatch(/\^[^$]+\$.*SAFE_ID|SAFE_ID.*\^[^$]+\$/);
    // SAFE_DATA_VALUE regex for data-print-id attribute.
    expect(section).toContain('SAFE_DATA_VALUE');
    // frameSelector computation using iframe# prefix.
    expect(section).toContain("'iframe#'");
    // data-print-id fallback.
    expect(section).toContain('data-print-id');
    expect(section).toContain("'iframe[data-print-id=\"'");
  });

  test('does NOT contain setTimeout (no deferred wait)', () => {
    const section = buildPrintCaptureSection();
    expect(section).not.toContain('setTimeout');
    expect(section).not.toContain('DEFERRED_TIMEOUT_MS');
    expect(section).not.toContain('DeferredPrint');
  });

  test('includes debounce guard (1-second collapse)', () => {
    const section = buildPrintCaptureSection();
    expect(section).toContain('_lastPrintTime');
    expect(section).toContain('< 1000');
  });

  test('includes URL sanitization helper', () => {
    const section = buildPrintCaptureSection();
    expect(section).toContain('_sanitizeUrl');
    // The helper strips query/hash.
    expect(section).toContain('u.search');
    expect(section).toContain('u.hash');
  });

  test('bridge payload includes scope and frameSelector fields', () => {
    const section = buildPrintCaptureSection();
    // The requestPrintCapture call includes the expected payload shape.
    expect(section).toContain("scope: window === window.top ? 'top' : 'iframe'");
    expect(section).toContain('frameSelector');
    expect(section).toContain('timestamp: Date.now()');
  });
});

test.describe('buildStealthInitScript with printCapture', () => {
  test('printCapture: true includes print capture section', () => {
    const script = buildStealthInitScript({ printCapture: true });
    expect(script).toContain('[Print Capture] window.print() intercepted at');
    expect(script).toContain('electronAPI');
    expect(script).toContain('requestPrintCapture');
  });

  test('printCapture: true wraps section in try-catch for resilience', () => {
    const script = buildStealthInitScript({ printCapture: true });
    // The composer wraps each section in try-catch.
    expect(script).toContain('Print capture section');
    expect(script).toContain('try {');
    expect(script).toContain('Section failure must not abort remaining sections');
  });

  test('printCapture: true output contains native masking for window.print', () => {
    const script = buildStealthInitScript({ printCapture: true });
    // window.print.toString() should return native shape because _markNative is used.
    expect(script).toContain("_markNative(function print()");
    expect(script).toContain("}, 'print')");
  });

  test('printCapture: false (or omitted) does NOT include print override', () => {
    // Explicitly false.
    const scriptFalse = buildStealthInitScript({
      printCapture: false,
      chromeRuntimeStubs: true, // need at least one flag so script is non-empty
    });
    expect(scriptFalse).not.toContain('[Print Capture] window.print() intercepted at');
    expect(scriptFalse).not.toContain('requestPrintCapture');
  });

  test('no flags returns empty string (no print override)', () => {
    const script = buildStealthInitScript({});
    expect(script).toBe('');
  });

  test('printCapture: true output has NO setTimeout', () => {
    const script = buildStealthInitScript({ printCapture: true });
    expect(script).not.toContain('setTimeout');
    expect(script).not.toContain('DEFERRED_TIMEOUT_MS');
  });

  test('printCapture combined with chromeRuntimeStubs includes both sections', () => {
    const script = buildStealthInitScript({
      printCapture: true,
      chromeRuntimeStubs: true,
    });
    // Print capture section present.
    expect(script).toContain('[Print Capture] window.print() intercepted at');
    // Chrome stubs section present.
    expect(script).toContain('chrome.csi');
    expect(script).toContain('chrome.loadTimes');
    // Both wrapped in try-catch.
    expect(script).toContain('Print capture section');
    expect(script).toContain('Chrome runtime stubs section');
  });

  test('printCapture includes IIFE wrapper', () => {
    const script = buildStealthInitScript({ printCapture: true });
    expect(script.trim()).toMatch(/^\(\(\) => \{/);
    expect(script.trim()).toMatch(/\}\)\(\);$/);
  });

  test('printCapture includes toString infrastructure (re-entry guard + WeakMap)', () => {
    const script = buildStealthInitScript({ printCapture: true });
    // Re-entry guard.
    expect(script).toContain('__chromeStealth');
    // WeakMap-based toString masking.
    expect(script).toContain('_nativeMap');
    expect(script).toContain('WeakMap');
    // __stealthMarkNative global handshake.
    expect(script).toContain('__stealthMarkNative');
  });
});
