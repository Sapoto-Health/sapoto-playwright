/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * --------------------------------------------------------------------------
 * FocusShim C5 — window.open focus-steal shim (Sapoto #1036, refactor #1043, #1044)
 *
 * The C5 block in `packages/playwright-core/src/tools/backend/stealthInitScript.ts`
 * replaces `window.open` when `suppressFocus: true`. Behavior matrix the shim
 * must hold (per the block's header comment):
 *
 *   window.open(_self|_parent|_top)               → native passthrough
 *   window.open('')      unnamed (_blank)         → print-capture proxy
 *   window.open('')      named (e.g. helpWindow)  → native passthrough (5fe607ce4)
 *   window.open(downloadUrl, *)  same-origin      → [FocusShim] background-open marker; return null
 *   window.open(downloadUrl, *)  cross-origin     → [FocusShim] background-open marker; return null
 *   window.open(downloadUrl, *)  unparseable URL  → native passthrough (defensive)
 *   window.open(other)                            → native passthrough
 *   (any call) Electron bridge present            → native passthrough (dd3a5e86a)
 *
 * Post-#1044 the same-origin fetch()/«a download» branch is replaced by a
 * console.warn marker that Sapoto's main process catches and routes to a
 * hidden CDP target via Target.createTarget({background:true}). Cross-origin
 * download URLs now route the same way (previously fell through to native
 * with a documented focus-steal trade-off).
 *
 * Plus: with suppressFocus=false the entire C4+C5 block is omitted from the
 * script source (the IIFE only emits C4+C5 when the flag is set), so the
 * production `CDP_STEALTH_INIT_SCRIPT` constant must NOT contain the C5
 * install marker.
 *
 * Approach: this file mirrors `stealth-stubs.spec.ts` — we evaluate the script
 * source inside a Node `vm` sandbox with a hand-rolled DOM. Real Chromium would
 * require staging same-origin servers, fetch handlers, and CDP attachment per
 * scenario; the vm-context approach lets one file cover every branch by
 * controlling `window.open`, `fetch`, `document`, and `console.warn` directly.
 */

import vm from 'vm';

import { test, expect } from '@playwright/test';
import {
  buildStealthInitScript,
  CDP_STEALTH_INIT_SCRIPT,
} from '../../packages/playwright-core/src/tools/backend/stealthInitScript';

// ------------------------------------------------------------------
// Sandbox helpers
// ------------------------------------------------------------------

type NativeOpenCall = { url: any; target: any; features: any };
type FetchCall = { input: any; init: any };
type AppendChildCall = { tag: string; href: string; download: string; rel: string; clicked: boolean };

type ShimSandbox = ReturnType<typeof newShimContext>;

function newShimContext(opts: { electronBridge?: 'real' | 'truthy-but-not-fn' | 'getter-throws' | 'none'; locationOrigin?: string; locationHref?: string } = {}) {
  const sandbox: any = {
    __nativeOpenCalls: [] as NativeOpenCall[],
    __fetchCalls: [] as FetchCall[],
    __fetchResolves: [] as Array<{ resolve: (v: any) => void; reject: (e: any) => void }>,
    __appendedChildren: [] as AppendChildCall[],
    __warnings: [] as string[],
    __electronCalls: [] as any[],
    __opts: opts,
  };
  vm.createContext(sandbox);

  // vm sandboxes lack Web-platform globals by default (URL, fetch, console).
  // The shim relies on `URL` for same-origin / cross-origin classification,
  // so we MUST inject one — without it the inner try/catch falls through to
  // _nativeOpen and the fetch path never fires. Use Node's WHATWG URL via the
  // host realm; this is intrinsics-leakage in the narrow sense but it's
  // confined to a single helper that the shim only constructs (never
  // .toString-introspects), so it can't corrupt the Function.prototype.toString
  // masking the way leaking Function/Object would.
  sandbox.URL = URL;

  // Build a minimal browser-shaped realm inside the sandbox so all intrinsics
  // (Function, Object, WeakMap) belong to the sandbox realm — same constraint
  // as stealth-stubs.spec.ts (Function.prototype.toString masking would
  // otherwise miss).
  const setup = `
    globalThis.window = globalThis;
    globalThis.location = { href: ${JSON.stringify(opts.locationHref ?? 'https://example.com/portal/account')}, origin: ${JSON.stringify(opts.locationOrigin ?? 'https://example.com')} };
    globalThis.navigator = { webdriver: true, languages: ['en-US'] };
    globalThis.Notification = { permission: 'default' };
    globalThis.performance = { now: () => 1234, getEntriesByType: () => [] };
    globalThis.setTimeout = (fn) => { try { fn(); } catch (_) {} return 0; };
    globalThis.console = {
      log: () => {},
      warn: (msg) => { try { globalThis.__warnings.push(String(msg)); } catch (_) {} },
      debug: (msg) => { try { globalThis.__warnings.push(String(msg)); } catch (_) {} },
      error: () => {},
    };

    // Track every native window.open call without actually opening anything.
    function _nativeOpenStub(url, target, features) {
      globalThis.__nativeOpenCalls.push({ url, target, features });
      return { __isNative: true };
    }
    globalThis.open = _nativeOpenStub;

    // fetch returns a promise we control externally — each call gets a slot
    // in __fetchResolves so the test can decide if it OKs, errors, or 4xx's.
    globalThis.fetch = function(input, init) {
      globalThis.__fetchCalls.push({ input: String(input), init: init });
      let resolveFn, rejectFn;
      const p = new Promise(function(res, rej) { resolveFn = res; rejectFn = rej; });
      globalThis.__fetchResolves.push({ resolve: resolveFn, reject: rejectFn });
      // attach catch immediately so test code can chain .then()s
      return p;
    };

    // Build a stub <a download> element + document so the CORS-fallback branch
    // can run. The shim does: createElement('a') → set href/download/rel/style
    // → appendChild → click → setTimeout(remove). We capture the final shape.
    function _makeAnchor() {
      const a = { tag: 'a', href: '', download: '', rel: '', style: { display: '' }, clicked: false };
      a.click = function() { a.clicked = true; };
      a.remove = function() { /* noop */ };
      return a;
    }
    globalThis.document = {
      title: 'Stub Doc',
      createElement: function(tag) {
        if (tag === 'a') return _makeAnchor();
        return { tag };
      },
      body: { appendChild: function(el) { globalThis.__appendedChildren.push(el); } },
      documentElement: { appendChild: function(el) { globalThis.__appendedChildren.push(el); } },
    };
  `;
  vm.runInContext(setup, sandbox);

  if (opts.electronBridge === 'real') {
    vm.runInContext(`
      globalThis.electronAPI = {
        requestPrintCapture: function(payload) { globalThis.__electronCalls.push(payload); },
      };
    `, sandbox);
  } else if (opts.electronBridge === 'truthy-but-not-fn') {
    // Per dd3a5e86a Codex P1 fix — fingerprint MUST require a function, not
    // just truthy. A stub like { requestPrintCapture: 1 } must NOT disable
    // the shim. We assert that in the dedicated test below.
    vm.runInContext(`
      globalThis.electronAPI = { requestPrintCapture: 1 };
    `, sandbox);
  } else if (opts.electronBridge === 'getter-throws') {
    vm.runInContext(`
      Object.defineProperty(globalThis, 'electronAPI', {
        get: function() { throw new Error('hostile getter'); },
        configurable: true,
      });
    `, sandbox);
  }
  // 'none' / undefined: no electronAPI installed.

  return sandbox;
}

function installShim(ctx: ShimSandbox, suppressFocus: boolean) {
  vm.runInContext(buildStealthInitScript({ suppressFocus }), ctx);
}

function callShimOpen(ctx: ShimSandbox, url: any, target?: any, features?: any) {
  // Invoke the *current* window.open inside the sandbox (which is the shim
  // after installShim ran). Pass through arbitrary args.
  ctx.__lastArgs = { url, target, features };
  return vm.runInContext(
      `globalThis.__lastResult = globalThis.open(${JSON.stringify(url)}, ${target === undefined ? 'undefined' : JSON.stringify(target)}, ${features === undefined ? 'undefined' : JSON.stringify(features)});`
      + `globalThis.__lastResult;`,
      ctx);
}

// Drain a pending fetch by resolving or rejecting it, then let microtasks settle.
async function resolveFetch(ctx: ShimSandbox, index: number, response: { ok: boolean; status?: number } | null) {
  const slot = ctx.__fetchResolves[index];
  if (!slot) throw new Error(`No fetch slot at index ${index}`);
  if (response === null)
    slot.reject(new Error('network error'));
  else
    slot.resolve(response);
  // Let the .then/.catch chain run.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

// ------------------------------------------------------------------
// suppressFocus=false: C5 must NOT install
// ------------------------------------------------------------------

test('C5 omitted from script source when suppressFocus=false', () => {
  // The default-options export is suppressFocus:false. C4+C5 wrappers
  // are gated behind the `${suppressFocus ? ... : ''}` template literal,
  // so neither the C5 install marker nor any of the FocusShim helpers
  // should appear in the source.
  expect(CDP_STEALTH_INIT_SCRIPT).not.toContain('[FocusShim] installed');
  expect(CDP_STEALTH_INIT_SCRIPT).not.toContain('DOWNLOAD_URL_RE');
  expect(CDP_STEALTH_INIT_SCRIPT).not.toContain('_printCaptureProxy');
});

test('suppressFocus=false leaves window.open untouched (no shim runs)', () => {
  const ctx = newShimContext();
  const originalOpen = ctx.open;
  installShim(ctx, false);
  // window.open identity is preserved — no shim replaced it.
  expect(ctx.open).toBe(originalOpen);
  // And no C5 install marker was logged.
  expect(ctx.__warnings.some((w: string) => w.startsWith('[FocusShim] installed'))).toBe(false);
});

// ------------------------------------------------------------------
// suppressFocus=true: shim install signal
// ------------------------------------------------------------------

test('suppressFocus=true installs the shim and emits the install marker', () => {
  const ctx = newShimContext();
  installShim(ctx, true);
  expect(ctx.__warnings.some((w: string) => w.startsWith('[FocusShim] installed at'))).toBe(true);
  // window.open was replaced — identity differs from the stub we set.
  expect(typeof ctx.open).toBe('function');
});

// ------------------------------------------------------------------
// Sapoto #1044 regression: chrome-mode gate split (stealth=false + suppressFocus=true)
// ------------------------------------------------------------------

test('suppressFocus=true installs C5 FocusShim (chrome-mode shape post-#1137)', () => {
  // Post-#1137 the `stealth` gate is removed entirely. This test exercises
  // chrome mode (suppressFocus=true): the FocusShim install marker must
  // appear and window.open must be a shim.
  const ctx = newShimContext();
  const nativeOpen = ctx.open;
  installShim(ctx, /*suppressFocus*/ true);

  // FocusShim install marker fired.
  expect(ctx.__warnings.some((w: string) => w.startsWith('[FocusShim] installed at'))).toBe(true);

  // window.open was replaced.
  expect(ctx.open).not.toBe(nativeOpen);

  // And functionally: a download-like same-origin URL emits the
  // background-open marker (the chrome-mode download path) rather than
  // calling native window.open.
  ctx.__warnings.length = 0;
  const result = callShimOpen(ctx, 'https://example.com/portal/account/statement.pdf', '_blank');
  expect(ctx.__warnings.some((w: string) => w.startsWith('[FocusShim] background-open '))).toBe(true);
  expect(ctx.__nativeOpenCalls).toHaveLength(0);
  expect(result).toBeNull();

  // C1/C2 stealth stubs are removed by #1137 — navigator.webdriver stays
  // at whatever the browser/sandbox initially set.
  expect(vm.runInContext('navigator.webdriver', ctx)).toBe(true);
});

// ------------------------------------------------------------------
// Scenario 1 — empty URL + named target → native passthrough (5fe607ce4)
// ------------------------------------------------------------------

test('window.open("", "helpWindow") falls through to native (named-popup carve-out)', () => {
  const ctx = newShimContext();
  installShim(ctx, true);
  ctx.__warnings.length = 0;

  const result = callShimOpen(ctx, '', 'helpWindow');

  expect(ctx.__nativeOpenCalls).toHaveLength(1);
  expect(ctx.__nativeOpenCalls[0]).toMatchObject({ url: '', target: 'helpWindow' });
  // Native stub returns { __isNative: true } — confirms shim delegated.
  expect(result).toMatchObject({ __isNative: true });
  // Diagnostic marker for this branch (line 570).
  expect(ctx.__warnings.some((w: string) => w.includes('native (empty URL, named target=helpWindow)'))).toBe(true);
});

// ------------------------------------------------------------------
// Scenario 2 — empty URL + unnamed target → print-capture proxy
// ------------------------------------------------------------------

test('window.open("", "_blank") returns the print-capture proxy (synthesized popup)', () => {
  const ctx = newShimContext();
  installShim(ctx, true);
  ctx.__warnings.length = 0;

  const proxy: any = callShimOpen(ctx, '', '_blank');

  // No native call — the shim intercepted.
  expect(ctx.__nativeOpenCalls).toHaveLength(0);
  // Proxy shape: has document.write, focus, blur, print, close, closed=false.
  expect(typeof proxy.document.write).toBe('function');
  expect(typeof proxy.document.writeln).toBe('function');
  expect(typeof proxy.focus).toBe('function');
  expect(typeof proxy.print).toBe('function');
  expect(proxy.closed).toBe(false);
  expect(proxy.opener).toBeNull();
  // Diagnostic marker for this branch (line 573).
  expect(ctx.__warnings.some((w: string) => w.includes('print-capture proxy (empty URL)'))).toBe(true);
});

test('window.open("") with no target also returns the print-capture proxy', () => {
  const ctx = newShimContext();
  installShim(ctx, true);
  ctx.__warnings.length = 0;

  // Pass null target explicitly so the shim's "(target == null ? '' : ...)" coercion runs.
  const proxy: any = callShimOpen(ctx, '', null);
  expect(ctx.__nativeOpenCalls).toHaveLength(0);
  expect(typeof proxy.print).toBe('function');
});

test('print-capture proxy.print() forwards captured HTML to electronAPI when bridge present', () => {
  // Caveat: the proxy is created at window.open() call time. The electron-bridge
  // check at the top of the shim short-circuits BEFORE the proxy path, so to
  // exercise this branch we install electronAPI AFTER the shim has been
  // installed and the open() call has returned the proxy.
  const ctx = newShimContext();
  installShim(ctx, true);
  const proxy: any = callShimOpen(ctx, '', '_blank');

  // Now wire the bridge and call proxy.print().
  vm.runInContext(`
    globalThis.electronAPI = {
      requestPrintCapture: function(p) { globalThis.__electronCalls.push(p); },
    };
  `, ctx);
  proxy.document.write('<html><body>receipt</body></html>');
  proxy.print();

  expect(ctx.__electronCalls).toHaveLength(1);
  expect(ctx.__electronCalls[0]).toMatchObject({
    scope: 'synthesized-popup',
    frameSelector: null,
    capturedHtml: '<html><body>receipt</body></html>',
  });
});

// ------------------------------------------------------------------
// Scenario 3 — _self/_parent/_top → native passthrough
// ------------------------------------------------------------------

test('_self/_parent/_top targets always delegate to native (no focus-steal)', () => {
  for (const t of ['_self', '_parent', '_top', '_SELF', '_TOP']) {
    const ctx = newShimContext();
    installShim(ctx, true);
    callShimOpen(ctx, 'https://example.com/anything', t);
    expect(ctx.__nativeOpenCalls).toHaveLength(1);
    expect(ctx.__nativeOpenCalls[0].target).toBe(t);
  }
});

// ------------------------------------------------------------------
// Scenario 4 — same-origin download URL → [FocusShim] background-open marker
// ------------------------------------------------------------------
//
// Post-#1044 the fetch()-based capture path is removed. The shim emits a
// console.warn marker that Sapoto's main process catches via
// Runtime.consoleAPICalled and routes to Target.createTarget({background:true}).
// The marker text is verbatim contractually:
//
//   [FocusShim] background-open <absolute-url>
//
// Sapoto's parser slices on the literal prefix '[FocusShim] background-open '
// (note: trailing space). If you change the prefix here you MUST also change
// the BACKGROUND_OPEN_MARKER constant in src/main/downloads/backgroundOpenBridge.ts
// or the Sapoto-side handler will silently stop catching these.

test('same-origin download URL emits [FocusShim] background-open marker and returns null', () => {
  const ctx = newShimContext({ locationOrigin: 'https://example.com', locationHref: 'https://example.com/portal' });
  installShim(ctx, true);
  ctx.__warnings.length = 0;

  const result = callShimOpen(ctx, 'https://example.com/download/statement-2026.pdf', '_blank');

  // Shim returns null per spec — page sees no Window reference, no focus steal.
  expect(result).toBeNull();
  // No native open call — the focus-steal was prevented.
  expect(ctx.__nativeOpenCalls).toHaveLength(0);
  // No fetch() call — the fetch() mechanism is gone post-#1044.
  expect(ctx.__fetchCalls).toHaveLength(0);

  // Marker emitted with the absolute URL. Verbatim match on the contract
  // string — Sapoto's parser uses '[FocusShim] background-open ' (note the
  // trailing space) as a startsWith() prefix and slices the URL off the end.
  const markers = ctx.__warnings.filter((w: string) => w.startsWith('[FocusShim] background-open '));
  expect(markers).toHaveLength(1);
  expect(markers[0]).toBe('[FocusShim] background-open https://example.com/download/statement-2026.pdf');

  // Diagnostic marker (the `→ background-open url=` line, with sanitized URL).
  expect(ctx.__warnings.some((w: string) => w.includes('→ background-open url='))).toBe(true);
});

test('DOWNLOAD_PATH_RE matches a /statements/ URL even without a file extension', () => {
  const ctx = newShimContext({ locationOrigin: 'https://example.com', locationHref: 'https://example.com/portal' });
  installShim(ctx, true);

  callShimOpen(ctx, 'https://example.com/statements/2026-may', '_blank');
  expect(ctx.__warnings.some((w: string) => w.startsWith('[FocusShim] background-open '))).toBe(true);
  expect(ctx.__nativeOpenCalls).toHaveLength(0);
});

// ------------------------------------------------------------------
// Scenario 5 — cross-origin download URL also emits background-open marker
// ------------------------------------------------------------------
//
// Pre-#1044 cross-origin URLs fell through to native window.open and accepted
// one focus-steal because fetch() would CORS-block. Post-#1044 we route them
// to a hidden CDP target same as same-origin — the new target shares the
// browserContextId so cookies follow, and there's no focus steal because
// background:true. This closes the "one popup per cross-origin download"
// trade-off documented in #1043.

test('cross-origin download URL also emits background-open marker (no native call)', () => {
  const ctx = newShimContext({ locationOrigin: 'https://example.com', locationHref: 'https://example.com/portal' });
  installShim(ctx, true);
  ctx.__warnings.length = 0;

  const result = callShimOpen(ctx, 'https://cdn.other.example/download/statement.pdf', '_blank');

  expect(result).toBeNull();
  expect(ctx.__nativeOpenCalls).toHaveLength(0);
  expect(ctx.__fetchCalls).toHaveLength(0);

  const markers = ctx.__warnings.filter((w: string) => w.startsWith('[FocusShim] background-open '));
  expect(markers).toHaveLength(1);
  expect(markers[0]).toBe('[FocusShim] background-open https://cdn.other.example/download/statement.pdf');
});

test('Relative download URL is resolved to absolute before emitting marker', () => {
  // Sapoto's bridge needs absolute URLs to pass to Target.createTarget. The
  // shim resolves relative URLs against location.href so the parser doesn't
  // have to know the page origin.
  const ctx = newShimContext({ locationOrigin: 'https://example.com', locationHref: 'https://example.com/portal/account' });
  installShim(ctx, true);
  ctx.__warnings.length = 0;

  callShimOpen(ctx, '/download/statement.pdf', '_blank');

  const markers = ctx.__warnings.filter((w: string) => w.startsWith('[FocusShim] background-open '));
  expect(markers).toHaveLength(1);
  expect(markers[0]).toBe('[FocusShim] background-open https://example.com/download/statement.pdf');
});

// Codex P1 fix — the marker must preserve query strings and URL fragments
// verbatim. The previous implementation passed the URL through sanitizeUrl()
// which strips `?...#...`. That broke portals that encode statement ids or
// signed auth tokens in the query string: the bridge would see
// `/download` instead of `/download?id=123&token=abc`, then either open the
// wrong URL or get a 401. The marker carries the navigation target consumed
// by Sapoto's bridge; sanitization of sensitive params is owned by
// `src/main/redaction/` on the remote-log shipping path, not here.
test('Marker preserves query string and hash for statement-id / signed-token URLs', () => {
  const ctx = newShimContext({ locationOrigin: 'https://example.com', locationHref: 'https://example.com/portal' });
  installShim(ctx, true);
  ctx.__warnings.length = 0;

  callShimOpen(
      ctx,
      'https://example.com/download?id=123&token=abc#section',
      '_blank');

  const markers = ctx.__warnings.filter((w: string) => w.startsWith('[FocusShim] background-open '));
  expect(markers).toHaveLength(1);
  // Verbatim — query and hash must round-trip through the marker.
  expect(markers[0]).toBe('[FocusShim] background-open https://example.com/download?id=123&token=abc#section');
});

// ------------------------------------------------------------------
// Scenario 7 — non-download URL → native passthrough
// ------------------------------------------------------------------

test('non-download URL falls through to native (focus-steal accepted)', () => {
  const ctx = newShimContext();
  installShim(ctx, true);
  ctx.__warnings.length = 0;

  callShimOpen(ctx, 'https://example.com/account/settings', '_blank');

  expect(ctx.__fetchCalls).toHaveLength(0);
  expect(ctx.__nativeOpenCalls).toHaveLength(1);
  expect(ctx.__warnings.some((w: string) => w.includes('native (URL did not match download heuristic)'))).toBe(true);
});

// ------------------------------------------------------------------
// Scenario 8 — Electron bridge → bypass shim entirely (dd3a5e86a)
// ------------------------------------------------------------------

test('Electron bridge (real shape) bypasses the shim — every call hits native', () => {
  const ctx = newShimContext({ electronBridge: 'real' });
  installShim(ctx, true);
  ctx.__warnings.length = 0;

  callShimOpen(ctx, 'https://example.com/download/statement.pdf', '_blank');
  // Even download-y URL went native because Electron-mode was detected.
  expect(ctx.__fetchCalls).toHaveLength(0);
  expect(ctx.__nativeOpenCalls).toHaveLength(1);
  expect(ctx.__warnings.some((w: string) => w.includes('electron mode detected'))).toBe(true);
});

test('Electron bridge stub with non-function requestPrintCapture does NOT bypass shim', () => {
  // Per Codex P1 fix dd3a5e86a (_isSapotoElectronBridge fingerprint): the shim
  // must only delegate when requestPrintCapture is actually callable. A page
  // script that sets { requestPrintCapture: 1 } must not disable focus suppression.
  const ctx = newShimContext({ electronBridge: 'truthy-but-not-fn', locationOrigin: 'https://example.com', locationHref: 'https://example.com/portal' });
  installShim(ctx, true);
  ctx.__warnings.length = 0;

  callShimOpen(ctx, 'https://example.com/download/statement.pdf', '_blank');
  // Background-open marker emitted (shim was active despite the truthy-but-malformed bridge).
  expect(ctx.__warnings.some((w: string) => w.startsWith('[FocusShim] background-open '))).toBe(true);
  expect(ctx.__nativeOpenCalls).toHaveLength(0);
});

test('Electron bridge access via throwing getter is treated as no bridge', () => {
  // The fingerprint check wraps the read in try/catch and returns false if it
  // throws. A hostile getter therefore cannot pretend to be the bridge.
  const ctx = newShimContext({ electronBridge: 'getter-throws', locationOrigin: 'https://example.com', locationHref: 'https://example.com/portal' });
  installShim(ctx, true);
  ctx.__warnings.length = 0;

  callShimOpen(ctx, 'https://example.com/download/statement.pdf', '_blank');
  // Background-open marker emitted — the throwing getter did NOT pretend to be the bridge.
  expect(ctx.__warnings.some((w: string) => w.startsWith('[FocusShim] background-open '))).toBe(true);
  expect(ctx.__nativeOpenCalls).toHaveLength(0);
});

// ------------------------------------------------------------------
// Defensive install behavior
// ------------------------------------------------------------------

test('shim is installed non-writable so a later assignment cannot replace it', () => {
  const ctx = newShimContext();
  installShim(ctx, true);
  const shimFn = ctx.open;
  expect(typeof shimFn).toBe('function');

  // Try to overwrite — the install used defineProperty({ writable:false }),
  // so a plain assignment should be a silent no-op in sloppy mode.
  vm.runInContext(`try { globalThis.open = function tamperedOpen() { return 'tampered'; }; } catch (_) {}`, ctx);

  // Identity preserved.
  expect(ctx.open).toBe(shimFn);
});
