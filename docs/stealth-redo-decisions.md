# Stealth Redo Decisions

Tracking decisions made during the first-principles stealth redo review.

## Decision 1: Remove `__chromeStealth` idempotency guard

**Status:** Approved
**Action:** Remove lines 152-153 of `stealthInitScript.ts` (`if (window).__chromeStealth) return;` and `(window).__chromeStealth = true;`)
**Reasoning:** Playwright's `addInitScript` guarantees single-execution per new document. The guard protects against double-execution that doesn't happen in practice. ADF commit `1cfb1bc2` already removed its own `__chromeStealth` stub, confirming double-injection is no longer a concern. The named enumerable global on `window` is trivially detectable by any anti-bot script (`'__chromeStealth' in window`). Cost of keeping it far exceeds the value.

## Decision 2: Remove `__stealthMarkNative` global

**Status:** Approved
**Action:** Remove `(window).__stealthMarkNative = _markNative;` and all reads of it. Hoist `let _markNative` to the top of the IIFE before conditional blocks so C2/C4/C5 share it via closure. If C2 is disabled (`chromeRuntimeStubs=false`), `_markNative` stays `undefined` and later sections skip masking — correct behavior.
**Reasoning:** Same class of problem as `__chromeStealth` — named, enumerable, string-keyed global on `window`, trivially detectable. The global handshake only exists because template-literal conditional compilation puts C2 and C4/C5 in separate `try` blocks. A shared closure variable eliminates the need.

## Decision 3: Drop C1 (`navigator.webdriver` JS patch) and revert `chromiumSwitches.ts`

**Status:** Approved
**Action:** (a) Remove the `AutomationControlled` addition from `chromiumSwitches.ts` — revert to upstream. Sapoto never hits the `launch()` path; this file is dead code for Sapoto's flow. (b) Remove C1 section from `stealthInitScript.ts` (the `navigator.webdriver` getter patch).
**Reasoning:** Sapoto always connects via `connectOverCDP` to a Chrome it launched itself. ADF's `chromeManager/effects.ts:78` passes `--disable-features=AutomationControlled` at the actual Chrome spawn. The fork's `chromiumSwitches.ts` change is unreachable. The C1 JS patch is strictly worse than the launch flag — it replaces a native data property (`value: false`) with a getter (`get: fn`), creating a net-new fingerprint detectable via `Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver').get !== undefined`.

## Decision 4: Drop `chrome.app`, `chrome.csi`, `chrome.loadTimes` stubs

**Status:** Approved
**Action:** Remove the `chrome.app`, `chrome.csi()`, and `chrome.loadTimes()` stub sections from `stealthInitScript.ts` (C2 sub-sections). This also eliminates the `chromeRuntimeStubs` gate since these were the only things it controlled (besides `Notification.permission`).
**Reasoning:** All three APIs are removed from real Chrome: `chrome.csi` and `chrome.loadTimes` in Chrome 117, `chrome.app` in Chrome 128. Target portals run Chrome 128+. The stubs *add back* APIs that real Chrome no longer has — `typeof chrome.csi === 'function'` returns `true` under Sapoto but `false` for real users. Per stealth principle #2 ("prefer fewer patches"), absence is the correct undetectable state. The stubs also had internal issues: `chrome.csi().startE` used `Date.now()` instead of `performance.timing.navigationStart`, and `chrome.loadTimes()` hardcoded `connectionInfo: 'h2'`.

## Decision 5: Drop `Notification.permission` clamp from the fork

**Status:** Approved
**Action:** Remove the `Notification.permission` clamp from `stealthInitScript.ts`. This also removes the last item gated by `chromeRuntimeStubs`, so that gate can be removed entirely.
**Reasoning:** ADF already handles this in its own `chromeStealthStubs.ts` (line 123-131) with a more complete implementation that also wraps `navigator.permissions.query` for cross-check consistency. The fork's simpler clamp is redundant and misses the cross-check vector. Sapoto owns the Chrome profile — permission state is ADF's responsibility, not the fork's.

## Decision 6: Drop C2 (`Function.prototype.toString` masking)

**Status:** Approved
**Action:** Remove the `Function.prototype.toString` WeakMap wrapper and `_markNative` helper from `stealthInitScript.ts`.
**Reasoning:** The toString patch is itself a known anti-bot detection target — it's the signature technique of `puppeteer-extra-plugin-stealth`, and anti-bot systems (Castle, DataDome, Akamai) actively look for it via cross-realm bypass, timing side-channels, and function identity checks. With decisions 3-5 removing `navigator.webdriver`, `chrome.app/csi/loadTimes`, and `Notification.permission`, the original need for toString masking is gone. The only remaining consumers are C4 (`window.print`) and C5 (`window.open`), both operational shims — no anti-bot system checks these for toString fidelity. The cure (a high-profile detection target) is worse than the disease (source code visible on two functions nobody inspects).

## Decision 8: Skip UA-CH brand override in `connectOverCDP` path

**Status:** Approved
**Action:** Gate `_updateUserAgentBrands()` so it does NOT fire when connected via CDP to an externally-launched Chrome. Real Chrome already has correct native UA-CH brands — the override replaces them with a computed version that has a hardcoded stale GREASE brand (`Not/A)Brand`, only correct for Chrome 113-115), introducing inconsistency where none existed.
**Reasoning:** Per principle #1 ("prefer native state over JS patching"), real Chrome's native UA-CH brands are already correct and internally consistent. The `buildChromeBrands()` override was needed for the `launch()` path where Playwright's bundled Chromium might have missing/mismatched UA-CH metadata. In the `connectOverCDP` path (Sapoto's only production flow), the override makes things worse — it replaces Chrome 136's correct GREASE rotation with a hardcoded value from Chrome 113-115. The fix is to not touch what's already correct.

## Decision 9: Drop list reporter `printFailuresInline` removal

**Status:** Approved
**Action:** Revert the list reporter changes — restore `printFailuresInline` option to match upstream. Files: `packages/playwright/src/reporters/list.ts`, `packages/playwright/types/test.d.ts`, `utils/generate_types/overrides-test.d.ts`, `docs/src/test-reporters-js.md`.
**Reasoning:** This is a merge conflict artifact from a prior rebase — the fork resolved a conflict by deleting the feature. It has zero Sapoto value (Sapoto uses Vitest, not Playwright's test runner). It causes rebase conflicts every time upstream touches the list reporter. No functional or stealth purpose.

## Decision 7: Fix C5 `window.open` descriptor to `configurable: true, writable: false`

**Status:** Approved
**Action:** Change `Object.defineProperty(window, 'open', { value: _shimOpen, writable: false, configurable: false, enumerable: true })` to `{ value: _shimOpen, writable: false, configurable: true, enumerable: true }`.
**Reasoning:** `writable: false` blocks the real threat — portal late-wraps via plain assignment (`window.open = myWrapper`). `configurable: true` matches stock Chrome's descriptor shape, eliminating the fingerprint where `Object.getOwnPropertyDescriptor(window, 'open').configurable === false` reveals the shim. The only thing gained by `configurable: false` was blocking `Object.defineProperty`-based overwrites, which portals don't use (that's framework/anti-bot code — and if they "fix" our shim back to native, that's fine).
