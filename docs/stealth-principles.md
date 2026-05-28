# Stealth Principles

Internal engineering reference for the sapoto-playwright fork's anti-detection posture. Governs code review, implementation decisions, and test design for all stealth-related changes.

---

## 1. Core Philosophy

The goal is not to hide every bot signal. It is to avoid creating automation-specific side effects that stock Chrome would not create. The less the fork mutates the page's observable JS world, the more robust it is. Anti-bot systems use layered scoring across dozens of signals; no single patch decides the outcome. A clean, consistent browser surface beats a heavily patched one.

---

## 2. Design Principles

1. **Prefer native state over JS patching.**
   JS monkey-patches are always probeable through property descriptors, prototype chains, realm behavior, timing, native function shape (`toString`), and side effects. If Chrome can be launched or configured so the browser naturally exposes the correct state, that is strictly superior to a runtime patch.

2. **Prefer fewer patches.**
   Every patch adds a rare fingerprint. A *missing* signal is not automatically worse than a synthetic, stale, or internally contradictory one. When evaluating whether to add a patch, the burden of proof is on the patch.

3. **Use real Chrome capabilities.**
   Real Chrome handles TLS, HTTP/2+3 behavior, WebGL, canvas, codecs, fonts, permissions, extension machinery, and browser APIs with full fidelity. No JS shim can replicate this. Launch configuration, profile state, and Chrome flags are the preferred levers.

4. **Treat main-world JS patches as last-resort, portal-scoped functional fallbacks.**
   Shims like `window.print` interception and `window.open` redirection are operational tools for specific portal workflows, not broad stealth measures. They must be opt-in, narrowly scoped, and justified by a concrete portal gap.

5. **Maintain kill switches for every stealth feature.**
   Each feature must be independently disablable via its gate in `cdpStealthGates.ts`. This enables incremental diagnosis when a portal breaks and prevents coupling between unrelated mitigations.

6. **Measure against real Chrome baselines, not patched expectations.**
   Tests must compare against stock Chrome behavior -- descriptors, prototypes, cross-frame consistency, UA-CH headers, workers, focus, and lifecycle timing. Asserting "patched value equals expected" proves only that the patch ran, not that the result is indistinguishable from a real browser.

---

## 3. Threat Model

Anti-bot systems rarely rely on a single flag. They use layered scoring:

- **Cloudflare:** Heuristics, JS-based browser probing, ML over headers/session/browser signals, known-malicious fingerprints, and composite bot scores.
- **DataDome:** Client-side JS collects behavioral, OS/browser/GPU data and checks built-in function/attribute consistency. Device Check runs client-side automation/spoofing checkpoints. Server-side AI models score TLS fingerprints, browser fingerprints, HTTP headers, behavior, and IP reputation.
- **Akamai:** Passive detection of header signatures, bot framework markers, header order, and browser-version mismatches. Active JavaScript challenges and behavioral analysis.

### In-scope for this fork

| Category | Examples | Fork responsibility |
|---|---|---|
| Automation flags | `navigator.webdriver`, `--enable-automation`, `AutomationControlled`, `HeadlessChrome` in UA/UA-CH | Remove or suppress via launch config and CDP gates |
| Framework artifacts | Playwright globals, utility world names, binding wrappers, `sourceURL` markers, exposed function code | Eliminate or randomize |
| CDP side effects | Runtime/Console/Log domain behavior, serialization side effects, execution-context metadata, isolated world leaks, init-script timing | Gate and minimize |
| JS object consistency | Property descriptors, prototypes, own-vs-inherited properties, native `toString`, thrown errors, cross-realm differences | Ensure patches (when unavoidable) are indistinguishable from native |
| Header/browser consistency | UA, UA-CH (`sec-ch-ua-*`), Accept-Language, platform, locale, timezone, viewport, device memory, hardware concurrency | Ensure all correlated fields agree |
| Behavioral signals | Input cadence, pointer movement, focus/visibility, popup handling, user-activation | Humanized input; correct focus/visibility lifecycle |

### Out-of-scope (handled by using real Chrome)

| Category | Examples | Why out-of-scope |
|---|---|---|
| Network/TLS fingerprinting | JA3/JA4 hash, HTTP/2 settings frame, ALPN order | Real Chrome's TLS stack handles this natively |
| IP reputation | Datacenter IP ranges, residential vs. hosting, request rate | Infrastructure concern, not a browser-level patch |
| Cookie/session history | First-party cookie age, login history, referrer chains | Addressed by persistent browser profiles, not code changes |

---

## 4. CDP-Specific Risks

A page cannot directly inspect the CDP WebSocket. CDP side effects are detectable only through indirect tells -- serialization behavior, timing shifts, context metadata, and console interactions.

### 4.1 Runtime.enable and object serialization

`Runtime.enable` lets CDP clients receive runtime events and execution-context notifications. Automation frameworks need it for evaluation and console plumbing. Detection scripts can create objects with getter traps, log them via `console.log`, and observe whether CDP-side serialization triggers those getters. This is a documented signal (Castle research), though its reliability is version-sensitive -- newer Chromium versions have changed the serialization path.

**Fork implementation:** `crPage.ts` sends `Runtime.enable` optionally followed by `Runtime.disable`; the cycle repeats after non-initial navigations. `cdpStealthGates.ts` gates this as `runtime-cycle`.

**Tradeoff:** Leaving Runtime enabled improves Playwright correctness and diagnostics but exposes serialization/event side effects. Cycling it reduces the exposure window but introduces timing races and remains observable during the enabled interval.

### 4.2 Console and Log domain side effects

Detection scripts can emit `console` calls with crafted objects and measure whether automation-side observers cause extra property access, serialization, or timing shifts compared to a browser with no CDP client attached.

**Fork implementation:** `crPage.ts` can skip `Log.enable`. `captureBridgeInitScript.ts` uses console markers for print capture and background-open capture.

**Rule:** Do not use `console` as an automation bridge unless it is portal-scoped and operationally necessary. Console markers are page-visible behavior; anti-bot JS can observe them.

### 4.3 Execution contexts and isolated worlds

Playwright creates utility worlds to run internal code in isolation from page scripts. CDP emits execution-context metadata including world names. While a normal web page cannot enumerate CDP execution contexts directly, attached debuggers, diagnostic pages, and browser-integrated anti-abuse code may observe context metadata. Additionally, implementation errors can leak bindings or globals from the utility world into the main world.

**Fork implementation:** Utility world names are randomized in `crPage.ts`. The world is created and an empty `Page.addScriptToEvaluateOnNewDocument` references the world name in the same file.

**Rule:** Avoid recognizable framework names. Keep utility-world behavior stable across pages, frames, workers, and popups. Randomization removes a label but can create its own pattern if the generation is predictable or anomalous (e.g., unusual character sets, fixed lengths).

### 4.4 Init scripts

`Page.addScriptToEvaluateOnNewDocument` runs scripts before page code executes. This is powerful and risky: it changes startup ordering and can create main-world mutations observable by vendor JS that runs immediately.

**Fork implementation:** The MCP context layer (`packages/playwright-core/src/tools/backend/context.ts`) injects the capture bridge init script. Chromium evaluates init scripts with `runImmediately` in `crPage.ts`.

**Rule:** Init scripts must be minimal and deterministic. They should not mutate built-in prototypes unless there is no alternative. When they must, the result must be validated against real Chrome in same-origin iframes, popups, and reloads.

### 4.5 Bindings and globals

Playwright's binding machinery can leak through installed globals, marker properties, wrapper functions, and function source text. Known detection vectors include `__playwright__binding__` and `__pwInitScripts`.

**Fork implementation:** Tests in `tests/library/stealth-stubs.spec.ts` check for these globals. The binding machinery in `browserContext.ts` and `page.ts` remains a general risk surface.

**Rule:** Avoid page-exposed bindings on stealth-critical paths. If a bridge between automation and the page is required, prefer isolated, host-owned, narrow bridges. Test `Object.keys(window)` enumeration and `for...in` iteration for unexpected properties.

### 4.6 CDP emulation full-replace semantics

CDP overrides like `Emulation.setUserAgentOverride` replace metadata as a whole, not partially. A small mismatch between the overridden UA string and the browser's actual capabilities creates cross-layer contradictions that scoring systems can detect.

**Fork implementation:** UA-CH brand lists are built in `chromeUaBrands.ts` and applied in `crPage.ts`.

**Rule:** Only override when all correlated fields can be kept consistent: UA string, `sec-ch-ua`, `navigator.userAgentData`, platform, architecture, bitness, mobile flag, locale, and `Accept-Language`.

### 4.7 Workers and service workers

Workers have separate runtime contexts. If stealth patches only cover the main page context, worker-side probes will return unpatched values, creating a detectable inconsistency. Runtime enable/disable behavior also applies to worker targets.

**Fork implementation:** Worker handling in `crPage.ts`; service worker stealth logic in `crServiceWorker.ts`.

**Rule:** Page, worker, service worker, iframe, and popup surfaces must not contradict each other on any probed value.

---

## 5. Risk Classification

Changes to the fork are classified by their detection risk profile:

| Risk | Category | Description | Examples | Guidance |
|---|---|---|---|---|
| **Green** | Launch-level | Removal or suppression of automation-exposed state via Chrome launch flags and configuration, where the result matches real Chrome behavior | `chromiumSwitches.ts`: removing `--enable-automation`, `AutomationControlled` | Preferred approach. Low detection risk when the resulting browser state is indistinguishable from stock Chrome. |
| **Yellow** | CDP-level | Changes to CDP domain behavior: gating, cycling, or suppressing CDP commands and their side effects | Runtime cycling, Log.enable skip, UA-CH override via `crPage.ts` and `cdpStealthGates.ts` | Acceptable with caution. Must be version-tested against target Chromium builds. Side effects may shift between Chrome releases. |
| **Red** | JS-level | Main-world monkey-patches that modify built-in prototypes, constructors, or globals | `window.print` shim, `window.open` shim in `captureBridgeInitScript.ts`. Red-tier patches previously included `Function.prototype.toString` override, `navigator.webdriver` getter, and `chrome` object stubs — all removed by the stealth redo (see `docs/stealth-redo-decisions.md`). | Last resort only. Must be opt-in, narrowly scoped, and justified by a documented portal-specific gap. Each patch is a new fingerprint surface. |

---

## 6. Implementation Checklist

Use this checklist during code review and when adding new stealth features:

- [ ] Use real, headed Chrome. Avoid headless-specific UA, UA-CH, and missing `Accept-Language`.
- [ ] Remove or suppress Playwright globals and recognizable utility world names.
- [ ] Avoid `Runtime.enable` as a long-lived default where feasible. If cycling, test both timing correctness and detection exposure.
- [ ] Do not use `console`/`Log` bridges for functional automation control unless portal-scoped and necessary.
- [ ] Keep init scripts minimal. Do not mutate built-in prototypes by default.
- [ ] Do not patch `Function.prototype.toString` unless there is no alternative and the patch is gated.
- [ ] Prefer Chrome launch configuration and profile state over JS runtime patches.
- [ ] Treat UA-CH as correlated metadata. Never override individual fields in isolation; ensure UA string, `sec-ch-ua-*`, `navigator.userAgentData`, platform, and `Accept-Language` all agree.
- [ ] Keep workers, iframes, popups, and the main frame consistent on all probed values.
- [ ] Add a kill switch (gate in `cdpStealthGates.ts`) for every new stealth feature.
- [ ] Add real-Chrome baseline tests covering descriptors, prototypes, cross-realm behavior, console interactions, Runtime domain behavior, and UA-CH consistency.
- [ ] Do not treat passing CreepJS or BrowserScan as proof of portal success. Use them as smoke signals only.

---

## 7. Testing Philosophy

### What tests must prove

Stealth tests must demonstrate that the fork's browser surface is **indistinguishable from stock Chrome**, not merely that patches applied their intended values. The distinction matters: a patch can successfully set `navigator.webdriver` to `false` while simultaneously creating a detectable `configurable: false` descriptor that stock Chrome would never produce.

### Baseline comparison methodology

Every stealth-related test should:

1. **Define the stock Chrome baseline.** What does an unmodified Chrome instance return for the probed property, API, or behavior?
2. **Assert equivalence, not equality to a hardcoded value.** The test should fail if the fork diverges from the baseline, even if the divergence looks "correct" in isolation.
3. **Cover cross-surface consistency.** A property probed in the main frame, an iframe, a popup, a web worker, and a service worker must return the same result (or the same result stock Chrome would return in each context).

### What to test

| Surface | Test targets |
|---|---|
| Property descriptors | `Object.getOwnPropertyDescriptor` for patched properties; verify `configurable`, `enumerable`, `writable`, `get`/`set` match stock Chrome |
| Prototype chains | `__proto__` traversal, `instanceof` checks, `constructor` identity for patched objects |
| Native function shape | `Function.prototype.toString.call(fn)` for any shimmed function; must return `"function X() { [native code] }"` |
| Cross-realm behavior | Same-origin iframe, `window.open` popup, and worker contexts must agree with the main frame |
| UA-CH consistency | `navigator.userAgent`, `navigator.userAgentData.brands`, `sec-ch-ua` header, and `Accept-Language` must form a coherent, valid Chrome identity |
| Console/Runtime side effects | Crafted getter objects logged via `console.log` must not trigger extra access when CDP domains are gated off |
| Global enumeration | `Object.keys(window)`, `for (let k in window)`, and `Object.getOwnPropertyNames(window)` must not reveal framework-specific properties |
| Init-script timing | Page-visible `performance.now()` or `Date.now()` gaps at document start must not be anomalous compared to stock Chrome |

### Anti-patterns in stealth tests

- **Asserting patched value equals expected literal.** This proves the patch ran, not that the result is undetectable.
- **Testing only the main frame.** Cross-surface inconsistency is a primary detection vector.
- **Relying on third-party scanner scores.** CreepJS, BrowserScan, and similar tools test a subset of signals. Passing them does not prove portal-level stealth. They are useful as smoke tests, not acceptance criteria.

---

## Key Files

| File | Role |
|---|---|
| `packages/playwright-core/src/server/chromium/cdpStealthGates.ts` | Per-feature kill switches (runtime-cycle, log-skip, ua-ch-override, etc.) |
| `packages/playwright-core/src/server/chromium/crPage.ts` | CDP command orchestration: Runtime enable/disable, Log.enable skip, UA-CH application, utility world creation |
| `packages/playwright-core/src/server/chromium/crServiceWorker.ts` | Service worker stealth logic |
| `packages/playwright-core/src/server/chromium/chromiumSwitches.ts` | Launch flag removal (AutomationControlled, enable-automation) |
| `packages/playwright-core/src/server/chromium/chromeUaBrands.ts` | UA-CH brand list construction |
| `packages/playwright-core/src/tools/backend/captureBridgeInitScript.ts` | Operational capture bridge: `window.print` shim (print capture), `window.open` shim (background-open capture), focus shim. Red-tier stealth patches (webdriver getter, chrome stubs, `Function.prototype.toString`) were removed by the stealth redo. |
| `packages/playwright-core/src/tools/backend/context.ts` | MCP context layer; injects capture bridge init script |
| `packages/playwright-core/src/server/cdpStealth.ts` | CDP stealth coordination |
| `packages/playwright-core/src/server/page.ts` | Binding machinery (global leak risk surface) |
| `packages/playwright-core/src/server/browserContext.ts` | Context-level binding installation |
| `packages/isomorphic/cdpStealthCLIParser.ts` | CLI flag parsing for `--cdp-stealth` and boolean gates |
| `packages/isomorphic/cdpStealthAlias.ts` | Stealth gate alias resolution |
| `docs/stealth-redo-decisions.md` | Decision record for the stealth redo: rationale for removing Red-tier patches (C1-C6), dropping `chromeRuntimeStubs`, and other first-principles cleanup |
| `tests/library/cdp-stealth-gates.spec.ts` | Gate behavior tests |
| `tests/library/cdp-stealth-options.spec.ts` | CLI option parsing tests |
| `tests/library/stealth-stubs.spec.ts` | Global leak and stub correctness tests |
