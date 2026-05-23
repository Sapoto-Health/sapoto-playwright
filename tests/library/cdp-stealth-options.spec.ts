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

// Sapoto PRD #1045 / Tracer A1 — wire-format helper for the new
// `cdpStealth: string[]` channel field. These are pure-logic tests
// against the option-parsing helper; the end-to-end round-trip from
// the client through the channel back to BrowserOptions lives in
// humanize-input-channel.spec.ts (which has been extended for #1045).

import { test, expect } from '@playwright/test';
import { CDP_STEALTH_FEATURES, defaultCdpStealthFeatures, parseCdpStealthFeatures } from '../../packages/playwright-core/src/server/cdpStealth';

test('CDP_STEALTH_FEATURES contains exactly the three valid members', () => {
  expect([...CDP_STEALTH_FEATURES].sort()).toEqual(['log-skip', 'runtime-cycle', 'worker-runtime']);
});

test('parseCdpStealthFeatures(undefined) yields an empty Set', () => {
  const parsed = parseCdpStealthFeatures(undefined);
  expect(parsed).toBeInstanceOf(Set);
  expect(parsed.size).toBe(0);
});

test('parseCdpStealthFeatures rehydrates a string[] into a typed Set', () => {
  const parsed = parseCdpStealthFeatures(['runtime-cycle', 'log-skip', 'worker-runtime']);
  expect(parsed).toBeInstanceOf(Set);
  expect(parsed.size).toBe(3);
  expect(parsed.has('runtime-cycle')).toBe(true);
  expect(parsed.has('log-skip')).toBe(true);
  expect(parsed.has('worker-runtime')).toBe(true);
});

test('parseCdpStealthFeatures rejects network-skip', () => {
  // network-skip is intentionally omitted (Codex P1 review on PR #28 removed
  // Network.enable gating because it broke page.on("request") listeners).
  // The wire-format parser must surface this as an explicit error so a
  // stale caller that still emits network-skip gets a loud failure rather
  // than silent acceptance.
  expect(() => parseCdpStealthFeatures(['network-skip']))
      .toThrow(/Invalid cdpStealth feature/);
});

test('parseCdpStealthFeatures rejects any unknown feature', () => {
  expect(() => parseCdpStealthFeatures(['runtime-cycle', 'made-up']))
      .toThrow(/Invalid cdpStealth feature/);
});

test('defaultCdpStealthFeatures returns the full "stealth: true" bundle', () => {
  // Backward-compat translation: a legacy caller that previously passed
  // `stealthMode: true` (a single boolean) should land at the same set of
  // CDP-domain mitigations after the option-parsing layer rewrites them.
  const defaults = defaultCdpStealthFeatures();
  expect(defaults).toBeInstanceOf(Set);
  expect(defaults.size).toBe(3);
  for (const feature of CDP_STEALTH_FEATURES)
    expect(defaults.has(feature)).toBe(true);
});

test('defaultCdpStealthFeatures returns a fresh Set each call', () => {
  // Each caller must own its own Set so a downstream `.delete(...)` does
  // not mutate the canonical default.
  const a = defaultCdpStealthFeatures();
  const b = defaultCdpStealthFeatures();
  expect(a).not.toBe(b);
  a.delete('log-skip');
  expect(b.has('log-skip')).toBe(true);
});
