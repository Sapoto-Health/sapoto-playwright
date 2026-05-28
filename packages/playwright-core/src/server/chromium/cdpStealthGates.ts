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

import type { CdpStealthFeature } from '../cdpStealth';

/**
 * Per-feature CDP stealth gates — Sapoto PRD #1045 / Tracer A3.
 *
 * Tracer A1 introduced the `Set<CdpStealthFeature>` shape on BrowserOptions
 * but kept the call sites guarded by a coarse non-empty membership check as
 * a placeholder. A3 decomposes that into per-subcomponent membership checks
 * so each gate can be flipped independently from the CLI / channel surface
 * (A2 / B-series).
 *
 * Each gate is a pure function over the feature Set so it can be tested in
 * isolation without standing up a real Chromium / CRSession.
 *
 *   - log-skip       → skip `Log.enable` (browser-level warnings only;
 *                      console messages come from Runtime.consoleAPICalled).
 *   - runtime-cycle  → rapid `Runtime.enable` → `Runtime.disable` cycle on
 *                      both page init and main-frame cross-document
 *                      navigation. Same flag controls BOTH sites — they
 *                      are conceptually one mitigation (keep the Runtime
 *                      domain dark to page scripts while still letting
 *                      Playwright discover executionContexts).
 *   - worker-runtime → same Runtime.enable→disable cycle applied per
 *                      service-worker target startup.
 */

/**
 * Should the page initializer skip `Log.enable`?
 *
 * When stealth gate `log-skip` is present, we do not enable the Log domain.
 * Otherwise we keep the default upstream behavior (enable it).
 */
export function shouldSkipLogEnable(cdpStealth: ReadonlySet<CdpStealthFeature>): boolean {
  return cdpStealth.has('log-skip');
}

/**
 * Should the page initializer issue the rapid Runtime.enable → Runtime.disable
 * cycle right after the initial `Runtime.enable`?
 */
export function shouldCycleRuntimeOnInit(cdpStealth: ReadonlySet<CdpStealthFeature>): boolean {
  return cdpStealth.has('runtime-cycle');
}

/**
 * Should the page initializer issue a Runtime.enable → Runtime.disable cycle
 * on a main-frame cross-document navigation? Driven by the same flag as the
 * init-time cycle — splitting them is intentionally out of scope.
 */
export function shouldCycleRuntimeOnFrameNavigation(cdpStealth: ReadonlySet<CdpStealthFeature>): boolean {
  return cdpStealth.has('runtime-cycle');
}

/**
 * Should `CRServiceWorker` issue a Runtime.enable → Runtime.disable cycle
 * on worker-target startup? This is NET-NEW wiring in A3: prior to PRD #1045
 * the worker session always issued a long-lived `Runtime.enable`, leaving
 * the strongest anti-bot fingerprint surface (console.debug Proxy trap) visible
 * to worker scripts. With this flag the worker session mirrors the page's
 * init-time cycle.
 */
export function shouldCycleWorkerRuntime(cdpStealth: ReadonlySet<CdpStealthFeature>): boolean {
  return cdpStealth.has('worker-runtime');
}

/**
 * Minimal surface of a CDP session needed by `applyWorkerStealth`. Mirrors
 * the two methods CRSession exposes (`send` + the failure-tolerant
 * `_sendMayFail`) without dragging in the full Protocol typing — keeps the
 * helper trivially testable with a stub session.
 */
export interface WorkerStealthSession {
  send(method: string, params?: any): Promise<any>;
  sendMayFail(method: string, params?: any): Promise<any>;
}

/**
 * Apply the worker-startup CDP stealth sequence on a freshly-attached
 * service-worker session. The order is load-bearing — if the worker resumes
 * (`Runtime.runIfWaitingForDebugger`) BEFORE `Runtime.disable` lands, the
 * cycle is racy and the long-lived Runtime domain is exposed to worker
 * scripts, defeating the `worker-runtime` mitigation. We therefore chain:
 *
 *     Runtime.enable
 *       → (if worker-runtime gate set) Runtime.disable
 *       → Runtime.runIfWaitingForDebugger
 *
 * Both `send`s individually swallow rejection (matching the prior
 * `.catch(e => {})` behavior at the call site) so Runtime.enable failing or
 * the session disposing mid-cycle never crashes the worker constructor.
 *
 * Both production (`CRServiceWorker`) and the A3 ordering test drive this
 * function, so the test asserts the real call sequence rather than a
 * test-local copy.
 */
export function applyWorkerStealth(
  session: WorkerStealthSession,
  cdpStealth: ReadonlySet<CdpStealthFeature>,
): Promise<void> {
  const runtimeReady = session.send('Runtime.enable', {}).then(() => {
    if (shouldCycleWorkerRuntime(cdpStealth))
      return Promise.resolve().then(() => session.sendMayFail('Runtime.disable'));
    return undefined;
  }).catch(() => {});

  return runtimeReady.then(() => {
    return session.send('Runtime.runIfWaitingForDebugger').catch(() => {});
  });
}
