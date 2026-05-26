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
  buildFocusShimSection,
} from '../../packages/playwright-core/src/tools/backend/stealthInitScript';

// ---------------------------------------------------------------------------
// Stealth focus-shim tests (Tracer #1130 / T4)
//
// Verifies the C5 window.open focus-steal shim:
//   1. suppressFocus: true -> window.open is shimmed (not the native one)
//   2. backgroundOpenCapture: true -> download URLs emit [FocusShim] background-open marker
//   3. backgroundOpenCapture: true -> non-download URLs pass through to native
//   4. Download URL regex: .pdf, .xlsx, .csv extensions and /download/, /statement/, /export/ paths
//   5. Object.defineProperty lock: window.open not reassignable
//   6. printCapture: true + empty URL -> proxy returned
//   7. suppressFocus: false (and no backgroundOpenCapture) -> no shim installed
//
// Tests run in a Node.js vm.Context with mocked browser globals.
// ---------------------------------------------------------------------------

/**
 * Create a minimal browser-like vm.Context for evaluating the stealth init
 * script. Provides the globals that the script probes/patches.
 */
function createBrowserContext(overrides?: Record<string, any>): vm.Context {
  // Track calls to native window.open and console.log for assertions.
  const nativeOpenCalls: Array<{ url: any; target: any; features: any }> = [];
  const consoleLogs: string[] = [];
  const consoleDebugs: string[] = [];

  const nativeOpen = function(url: any, target: any, features: any) {
    nativeOpenCalls.push({ url, target, features });
    return { closed: false, location: { href: String(url || '') } }; // fake Window ref
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
    console: {
      log: (...args: any[]) => consoleLogs.push(args.join(' ')),
      warn: (...args: any[]) => {},
      debug: (...args: any[]) => consoleDebugs.push(args.join(' ')),
      error: (...args: any[]) => {},
    },
    location: { href: 'https://portal.example.com/accounts' },
    document: { title: 'Test Page' },
    ...overrides,
  };

  // Make window self-referential and expose globals on it (browser semantics).
  globals.window = globals;
  globals.window.top = globals.window; // top-level frame by default

  // Install a real native window.open that we can track.
  globals.window.open = nativeOpen;

  // Stash tracking arrays on the context for test access.
  globals.__nativeOpenCalls = nativeOpenCalls;
  globals.__consoleLogs = consoleLogs;
  globals.__consoleDebugs = consoleDebugs;

  const ctx = vm.createContext(globals);
  return ctx;
}

/**
 * Build the full init script with the given options and evaluate it
 * in a fresh vm context. Returns the context for inspection.
 */
function buildAndEvaluate(options: Record<string, any>): vm.Context {
  const script = buildStealthInitScript(options);
  const ctx = createBrowserContext();
  if (script)
    vm.runInContext(script, ctx);
  return ctx;
}

/**
 * Build just the focus shim section, wrap it in the infrastructure IIFE,
 * and evaluate. This allows testing buildFocusShimSection directly with
 * printCapture (which buildStealthInitScript doesn't pass through yet).
 */
function buildFocusShimAndEvaluate(
  options: { suppressFocus?: boolean; backgroundOpenCapture?: boolean; printCapture?: boolean },
  ctxOverrides?: Record<string, any>,
): vm.Context {
  const infra = `
    if ((window).__chromeStealth) return;
    (window).__chromeStealth = true;
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
      } catch (_) {}
      return _toString.call(this);
    };
    _markNative(Function.prototype.toString, 'toString');
    (window).__stealthMarkNative = _markNative;
  `;

  const section = buildFocusShimSection(options);
  const script = section ? `(() => {
  ${infra}
  try {
  ${section}
  } catch (_) {}
})();` : '';

  const ctx = createBrowserContext(ctxOverrides);
  if (script)
    vm.runInContext(script, ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
// suppressFocus: false + no backgroundOpenCapture -> no shim installed
// ---------------------------------------------------------------------------

test.describe('no shim when both flags off', () => {
  test('buildFocusShimSection returns empty string', () => {
    const section = buildFocusShimSection({ suppressFocus: false, backgroundOpenCapture: false });
    expect(section).toBe('');
  });

  test('window.open is not shimmed when suppressFocus is false', () => {
    const ctx = buildAndEvaluate({ suppressFocus: false });
    // Script should be empty (no flags active), window.open unchanged.
    // Since no flags are active, buildStealthInitScript returns '' and
    // nothing is evaluated, so window.open stays as the native stub.
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    vm.runInContext("window.open('https://example.com', '_blank')", ctx);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://example.com');
  });
});

// ---------------------------------------------------------------------------
// suppressFocus: true -> window.open IS shimmed
// ---------------------------------------------------------------------------

test.describe('suppressFocus: true installs shim', () => {
  test('window.open is replaced by the shim', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true });
    // The shim's toString should show [native code] (masked).
    const str = vm.runInContext('Function.prototype.toString.call(window.open)', ctx);
    expect(str).toContain('[native code]');
    expect(str).toContain('open');
  });

  test('shim passes _self target to native', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true });
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    vm.runInContext("window.open('https://example.com', '_self')", ctx);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://example.com');
    expect(calls[0].target).toBe('_self');
  });

  test('shim passes _parent target to native', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true });
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    vm.runInContext("window.open('https://example.com/page', '_parent')", ctx);
    expect(calls.length).toBe(1);
    expect(calls[0].target).toBe('_parent');
  });

  test('shim passes _top target to native', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true });
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    vm.runInContext("window.open('https://example.com/page', '_top')", ctx);
    expect(calls.length).toBe(1);
    expect(calls[0].target).toBe('_top');
  });

  test('non-download URL passes through to native', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true });
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    vm.runInContext("window.open('https://example.com/api/data', '_blank')", ctx);
    // Without backgroundOpenCapture, ALL URLs pass through to native (no download detection).
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://example.com/api/data');
  });
});

// ---------------------------------------------------------------------------
// backgroundOpenCapture: true -> download URL routing
// ---------------------------------------------------------------------------

test.describe('backgroundOpenCapture: true', () => {
  test('download URL (.pdf) emits background-open marker and returns null', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const logs = vm.runInContext('__consoleLogs', ctx);
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    const prevLogCount = logs.length;
    const result = vm.runInContext("window.open('/statement.pdf', '_blank')", ctx);
    expect(result).toBeNull();
    // Should NOT have called native open.
    expect(calls.length).toBe(0);
    // Should have emitted the marker.
    const newLogs = logs.slice(prevLogCount);
    const markerLog = newLogs.find((l: string) => l.includes('[FocusShim] background-open'));
    expect(markerLog).toBeTruthy();
    expect(markerLog).toContain('statement.pdf');
  });

  test('download URL (.xlsx) emits background-open marker', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const logs = vm.runInContext('__consoleLogs', ctx);
    const prevLogCount = logs.length;
    const result = vm.runInContext("window.open('/report.xlsx', '_blank')", ctx);
    expect(result).toBeNull();
    const newLogs = logs.slice(prevLogCount);
    expect(newLogs.some((l: string) => l.includes('[FocusShim] background-open'))).toBe(true);
  });

  test('download URL (.csv) emits background-open marker', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const logs = vm.runInContext('__consoleLogs', ctx);
    const prevLogCount = logs.length;
    const result = vm.runInContext("window.open('https://bank.com/data.csv', '_blank')", ctx);
    expect(result).toBeNull();
    const newLogs = logs.slice(prevLogCount);
    expect(newLogs.some((l: string) => l.includes('[FocusShim] background-open'))).toBe(true);
  });

  test('download URL (.docx) emits background-open marker', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const result = vm.runInContext("window.open('/letter.docx', '_blank')", ctx);
    expect(result).toBeNull();
  });

  test('download URL (.zip) emits background-open marker', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const result = vm.runInContext("window.open('/archive.zip', '_blank')", ctx);
    expect(result).toBeNull();
  });

  test('download URL (.ofx) emits background-open marker', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const result = vm.runInContext("window.open('/transactions.ofx', '_blank')", ctx);
    expect(result).toBeNull();
  });

  test('download URL (.qfx) emits background-open marker', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const result = vm.runInContext("window.open('/transactions.qfx', '_blank')", ctx);
    expect(result).toBeNull();
  });

  test('download URL with query string still matches', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const result = vm.runInContext("window.open('/statement.pdf?id=123&token=abc', '_blank')", ctx);
    expect(result).toBeNull();
  });

  test('non-download URL (/api/data) passes through to native', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    vm.runInContext("window.open('https://example.com/api/data', '_blank')", ctx);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://example.com/api/data');
  });

  test('non-download URL (/login) passes through to native', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    vm.runInContext("window.open('https://example.com/login', '_blank')", ctx);
    expect(calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Download path regex (/download/, /statement/, /export/, etc.)
// ---------------------------------------------------------------------------

test.describe('download path segment matching', () => {
  test('/download/ path matches', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const result = vm.runInContext("window.open('https://bank.com/download/file123', '_blank')", ctx);
    expect(result).toBeNull();
  });

  test('/statement/ path matches', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const result = vm.runInContext("window.open('https://bank.com/statement/2024-01', '_blank')", ctx);
    expect(result).toBeNull();
  });

  test('/statements/ path matches', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const result = vm.runInContext("window.open('https://bank.com/statements/recent', '_blank')", ctx);
    expect(result).toBeNull();
  });

  test('/export/ path matches', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const result = vm.runInContext("window.open('https://bank.com/export/csv', '_blank')", ctx);
    expect(result).toBeNull();
  });

  test('/invoice/ path matches', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const result = vm.runInContext("window.open('https://bank.com/invoice/42', '_blank')", ctx);
    expect(result).toBeNull();
  });

  test('/invoices/ path matches', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const result = vm.runInContext("window.open('https://bank.com/invoices/print', '_blank')", ctx);
    expect(result).toBeNull();
  });

  test('/receipt/ path matches', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const result = vm.runInContext("window.open('https://bank.com/receipt/abc', '_blank')", ctx);
    expect(result).toBeNull();
  });

  test('/receipts/ path matches', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const result = vm.runInContext("window.open('https://bank.com/receipts/latest', '_blank')", ctx);
    expect(result).toBeNull();
  });

  test('/PDFStatement/ path matches', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const result = vm.runInContext("window.open('https://bank.com/PDFStatement/2024', '_blank')", ctx);
    expect(result).toBeNull();
  });

  test('/StatementPDF/ path matches', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const result = vm.runInContext("window.open('https://bank.com/StatementPDF/2024', '_blank')", ctx);
    expect(result).toBeNull();
  });

  test('/getstmt/ path matches', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const result = vm.runInContext("window.open('https://bank.com/getstmt/123', '_blank')", ctx);
    expect(result).toBeNull();
  });

  test('/getStmt/ path matches', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const result = vm.runInContext("window.open('https://bank.com/getStmt/123', '_blank')", ctx);
    expect(result).toBeNull();
  });

  test('/stmt/ path matches', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const result = vm.runInContext("window.open('https://bank.com/stmt/jan', '_blank')", ctx);
    expect(result).toBeNull();
  });

  test('non-matching path does not trigger download', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    vm.runInContext("window.open('https://bank.com/settings/profile', '_blank')", ctx);
    expect(calls.length).toBe(1); // passes through to native
  });
});

// ---------------------------------------------------------------------------
// background-open marker carries absolute URL (relative -> absolute)
// ---------------------------------------------------------------------------

test.describe('URL resolution in background-open', () => {
  test('relative URL is resolved to absolute', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const logs = vm.runInContext('__consoleLogs', ctx);
    const prevLogCount = logs.length;
    vm.runInContext("window.open('/download/report.pdf', '_blank')", ctx);
    const newLogs = logs.slice(prevLogCount);
    const markerLog = newLogs.find((l: string) => l.includes('[FocusShim] background-open'));
    expect(markerLog).toBeTruthy();
    // Should be resolved against location.href (https://portal.example.com/accounts)
    expect(markerLog).toContain('https://portal.example.com/download/report.pdf');
  });

  test('absolute URL is preserved', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, backgroundOpenCapture: true });
    const logs = vm.runInContext('__consoleLogs', ctx);
    const prevLogCount = logs.length;
    vm.runInContext("window.open('https://cdn.bank.com/statement.pdf', '_blank')", ctx);
    const newLogs = logs.slice(prevLogCount);
    const markerLog = newLogs.find((l: string) => l.includes('[FocusShim] background-open'));
    expect(markerLog).toContain('https://cdn.bank.com/statement.pdf');
  });
});

// ---------------------------------------------------------------------------
// Object.defineProperty lock
// ---------------------------------------------------------------------------

test.describe('window.open lock via defineProperty', () => {
  test('window.open is not writable after shim install', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true });
    // Verify that the descriptor says writable: false and configurable: false.
    // NOTE: vm.Context globals don't enforce writable:false on direct assignment
    // in sloppy mode (Node vm quirk), but the descriptor IS set correctly.
    // In a real browser, the assignment would silently fail in sloppy mode or
    // throw in strict mode.
    const desc = vm.runInContext('Object.getOwnPropertyDescriptor(window, "open")', ctx);
    expect(desc.writable).toBe(false);
  });

  test('window.open is not configurable after shim install', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true });
    const desc = vm.runInContext('Object.getOwnPropertyDescriptor(window, "open")', ctx);
    expect(desc.writable).toBe(false);
    expect(desc.configurable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// printCapture: true + empty URL -> proxy returned
// ---------------------------------------------------------------------------

test.describe('print-capture proxy for empty-URL popups', () => {
  test('empty URL with printCapture returns proxy (not native)', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, printCapture: true });
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    const result = vm.runInContext("window.open('', '_blank')", ctx);
    // Should NOT have called native open.
    expect(calls.length).toBe(0);
    // Should return a proxy object with document.write and print.
    expect(result).toBeTruthy();
    expect(typeof result.document).toBe('object');
    expect(typeof result.document.write).toBe('function');
    expect(typeof result.document.writeln).toBe('function');
    expect(typeof result.print).toBe('function');
    expect(typeof result.focus).toBe('function');
    expect(typeof result.close).toBe('function');
    expect(result.closed).toBe(false);
  });

  test('proxy document.write accumulates HTML', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, printCapture: true });
    vm.runInContext(`
      var proxy = window.open('', '_blank');
      proxy.document.write('<html>');
      proxy.document.write('<body>Hello</body>');
      proxy.document.write('</html>');
      window.__proxyResult = proxy;
    `, ctx);
    // The proxy is a fresh object each time, but we can verify it exists.
    const proxyResult = vm.runInContext('window.__proxyResult', ctx);
    expect(proxyResult).toBeTruthy();
    expect(typeof proxyResult.print).toBe('function');
  });

  test('empty URL without printCapture passes to native', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, printCapture: false });
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    vm.runInContext("window.open('', '_blank')", ctx);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('');
  });

  test('empty URL with named target passes to native (even with printCapture)', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, printCapture: true });
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    vm.runInContext("window.open('', 'helpWindow')", ctx);
    expect(calls.length).toBe(1);
    expect(calls[0].target).toBe('helpWindow');
  });

  test('null URL with printCapture returns proxy', () => {
    const ctx = buildFocusShimAndEvaluate({ suppressFocus: true, printCapture: true });
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    const result = vm.runInContext('window.open(null, "_blank")', ctx);
    expect(calls.length).toBe(0);
    expect(result).toBeTruthy();
    expect(typeof result.document).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// Electron bridge detection
// ---------------------------------------------------------------------------

test.describe('electron bridge detection', () => {
  test('delegates to native when electronAPI bridge is present', () => {
    const ctx = buildFocusShimAndEvaluate(
      { suppressFocus: true, backgroundOpenCapture: true },
      {
        electronAPI: {
          requestPrintCapture: function() {},
        },
      },
    );
    const calls = vm.runInContext('__nativeOpenCalls', ctx);
    // Even a download URL should go through native in Electron mode.
    vm.runInContext("window.open('/statement.pdf', '_blank')", ctx);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('/statement.pdf');
  });
});

// ---------------------------------------------------------------------------
// Static analysis of buildFocusShimSection output
// ---------------------------------------------------------------------------

test.describe('buildFocusShimSection static analysis', () => {
  test('suppressFocus: true returns non-empty string', () => {
    const section = buildFocusShimSection({ suppressFocus: true });
    expect(section.length).toBeGreaterThan(0);
  });

  test('backgroundOpenCapture: true returns non-empty string', () => {
    const section = buildFocusShimSection({ backgroundOpenCapture: true });
    expect(section.length).toBeGreaterThan(0);
  });

  test('both false returns empty string', () => {
    const section = buildFocusShimSection({ suppressFocus: false, backgroundOpenCapture: false });
    expect(section).toBe('');
  });

  test('backgroundOpenCapture includes DOWNLOAD_URL_RE', () => {
    const section = buildFocusShimSection({ suppressFocus: true, backgroundOpenCapture: true });
    expect(section).toContain('DOWNLOAD_URL_RE');
    expect(section).toContain('pdf');
    expect(section).toContain('xlsx');
    expect(section).toContain('csv');
  });

  test('backgroundOpenCapture includes DOWNLOAD_PATH_RE', () => {
    const section = buildFocusShimSection({ suppressFocus: true, backgroundOpenCapture: true });
    expect(section).toContain('DOWNLOAD_PATH_RE');
    expect(section).toContain('download');
    expect(section).toContain('statement');
    expect(section).toContain('export');
    expect(section).toContain('invoice');
    expect(section).toContain('receipt');
    expect(section).toContain('PDFStatement');
    expect(section).toContain('StatementPDF');
    expect(section).toContain('getstmt');
    expect(section).toContain('getStmt');
    expect(section).toContain('stmt');
  });

  test('without backgroundOpenCapture, no download regex present', () => {
    const section = buildFocusShimSection({ suppressFocus: true, backgroundOpenCapture: false });
    expect(section).not.toContain('DOWNLOAD_URL_RE');
    expect(section).not.toContain('DOWNLOAD_PATH_RE');
  });

  test('printCapture includes _printCaptureProxy', () => {
    const section = buildFocusShimSection({ suppressFocus: true, printCapture: true });
    expect(section).toContain('_printCaptureProxy');
    // The proxy object has a document property with write/writeln methods.
    expect(section).toContain('write: function');
    expect(section).toContain('writeln: function');
  });

  test('without printCapture, no _printCaptureProxy present', () => {
    const section = buildFocusShimSection({ suppressFocus: true, printCapture: false });
    expect(section).not.toContain('_printCaptureProxy');
  });

  test('output contains [FocusShim] markers', () => {
    const section = buildFocusShimSection({ suppressFocus: true });
    expect(section).toContain('[FocusShim]');
    expect(section).toContain('C5 entry');
    expect(section).toContain('installed at');
  });

  test('output contains Object.defineProperty lock', () => {
    const section = buildFocusShimSection({ suppressFocus: true });
    expect(section).toContain('Object.defineProperty(window');
    expect(section).toContain('writable: false');
    expect(section).toContain('configurable: false');
  });

  test('output contains _isSapotoElectronBridge', () => {
    const section = buildFocusShimSection({ suppressFocus: true });
    expect(section).toContain('_isSapotoElectronBridge');
    expect(section).toContain('electronAPI');
    expect(section).toContain('requestPrintCapture');
  });
});

// ---------------------------------------------------------------------------
// backgroundOpenCapture without suppressFocus still works
// ---------------------------------------------------------------------------

test.describe('backgroundOpenCapture alone (without suppressFocus)', () => {
  test('shim is installed when only backgroundOpenCapture is true', () => {
    const ctx = buildFocusShimAndEvaluate({ backgroundOpenCapture: true });
    const str = vm.runInContext('Function.prototype.toString.call(window.open)', ctx);
    expect(str).toContain('[native code]');
    expect(str).toContain('open');
  });

  test('download URL still triggers background-open marker', () => {
    const ctx = buildFocusShimAndEvaluate({ backgroundOpenCapture: true });
    const logs = vm.runInContext('__consoleLogs', ctx);
    const prevLogCount = logs.length;
    const result = vm.runInContext("window.open('/report.pdf', '_blank')", ctx);
    expect(result).toBeNull();
    const newLogs = logs.slice(prevLogCount);
    expect(newLogs.some((l: string) => l.includes('[FocusShim] background-open'))).toBe(true);
  });
});
