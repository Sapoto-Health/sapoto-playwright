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

// Sapoto PRD #1045 / Tracer A4 — opaque per-page utility-world name.
//
// These are pure-logic tests against the name-generator helper. They lock
// down the shape contract (16 lowercase-hex chars, no framework-identifying
// prefix, per-call uniqueness) so that any future "tidy-up" that reintroduces
// a `__chrome_` prefix or embeds `page.guid` regresses loudly.
//
// The end-to-end assertion that the name reaches a running Chromium without
// leaking the legacy shape lives in
// tests/library/chromium/utility-world-name-leak.spec.ts — which spawns a
// real browser and inspects the captured Error.stack from a utility-world
// evaluation. That suite intentionally fails on any frame matching
// /__chrome_util_/, /__playwright_/, or /page@[0-9a-f]{32}/.

import { test, expect } from '@playwright/test';
import {
  generateUtilityWorldName,
  UTILITY_WORLD_NAME_PATTERN,
} from '../../packages/playwright-core/src/server/chromium/crUtilityWorldName';

test('generateUtilityWorldName returns a 16-char lowercase hex string', () => {
  const name = generateUtilityWorldName();
  expect(name).toMatch(UTILITY_WORLD_NAME_PATTERN);
  expect(name).toHaveLength(16);
});

test('generateUtilityWorldName never includes the legacy __chrome_ prefix', () => {
  // The legacy shape `__chrome_util_${page.guid}` is the fingerprint we are
  // closing. Any reintroduction of the prefix — even in a different suffix
  // shape — should fail this assertion.
  for (let i = 0; i < 64; i++) {
    const name = generateUtilityWorldName();
    expect(name.startsWith('__chrome_')).toBe(false);
    expect(name.startsWith('__playwright_')).toBe(false);
    expect(name).not.toMatch(/page@[0-9a-f]{32}/);
  }
});

test('generateUtilityWorldName yields a different value on each call', () => {
  // Per-page differentiation: the name is computed per CRPage construction,
  // not per-context. Two adjacent calls must not collide. We sample 256 in a
  // row — a collision would imply the helper is caching or that randomBytes
  // is misconfigured.
  const seen = new Set<string>();
  for (let i = 0; i < 256; i++)
    seen.add(generateUtilityWorldName());
  expect(seen.size).toBe(256);
});

test('UTILITY_WORLD_NAME_PATTERN rejects the legacy shape and the empty string', () => {
  // Sanity-check the regex itself so that the per-call shape assertion above
  // is not silently permissive. If someone widens the pattern (e.g. allows
  // uppercase, allows prefixes), these explicit negatives catch it.
  expect(UTILITY_WORLD_NAME_PATTERN.test('')).toBe(false);
  expect(UTILITY_WORLD_NAME_PATTERN.test('__chrome_util_page@0123456789abcdef0123456789abcdef')).toBe(false);
  expect(UTILITY_WORLD_NAME_PATTERN.test('0123456789ABCDEF')).toBe(false); // uppercase rejected
  expect(UTILITY_WORLD_NAME_PATTERN.test('0123456789abcde')).toBe(false); // 15 chars
  expect(UTILITY_WORLD_NAME_PATTERN.test('0123456789abcdef0')).toBe(false); // 17 chars
  expect(UTILITY_WORLD_NAME_PATTERN.test('0123456789abcdef')).toBe(true);
});
