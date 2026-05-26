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
 * Unit tests for buildChromeBrands — the pure helper that derives Chrome's
 * UA Client Hint brand list from the running browser's version string.
 *
 * Validates the three-entry shape (Chromium, Google Chrome, GREASE brand)
 * and the version derivation logic without spinning up Chromium.
 */

import { test, expect } from '@playwright/test';
import { buildChromeBrands } from '../../packages/playwright-core/src/server/chromium/chromeUaBrands';

// ---------------------------------------------------------------------------
// buildChromeBrands — pure helper
// ---------------------------------------------------------------------------

test('buildChromeBrands emits the three-entry Chromium / Google Chrome / GREASE shape', () => {
  const result = buildChromeBrands('124.0.6367.78');
  expect(result).toBeDefined();
  expect(result!.brands).toHaveLength(3);
  // Order isn't enforced here; assert by name.
  const byBrand = Object.fromEntries(result!.brands.map(b => [b.brand, b.version]));
  expect(byBrand['Chromium']).toBe('124');
  expect(byBrand['Google Chrome']).toBe('124');
  // The "GREASE" brand exists — Chromium has changed its exact string multiple
  // times (";Not A Brand", "Not/A)Brand", "Not?A_Brand"); we only assert the
  // fork's current value so the test catches accidental shape changes.
  expect(byBrand).toHaveProperty('Not/A)Brand');
});

test('buildChromeBrands fullVersionList carries the full version, brands carry only major', () => {
  const result = buildChromeBrands('124.0.6367.78');
  const fullByBrand = Object.fromEntries(result!.fullVersionList.map(b => [b.brand, b.version]));
  expect(fullByBrand['Chromium']).toBe('124.0.6367.78');
  expect(fullByBrand['Google Chrome']).toBe('124.0.6367.78');
  expect(result!.fullVersion).toBe('124.0.6367.78');
});

test('buildChromeBrands returns undefined on empty input', () => {
  expect(buildChromeBrands('')).toBeUndefined();
});

test('buildChromeBrands handles single-digit major version', () => {
  const result = buildChromeBrands('9.0.0.0');
  expect(result).toBeDefined();
  const byBrand = Object.fromEntries(result!.brands.map(b => [b.brand, b.version]));
  expect(byBrand['Chromium']).toBe('9');
  expect(byBrand['Google Chrome']).toBe('9');
});

test('buildChromeBrands handles three-digit major version', () => {
  const result = buildChromeBrands('136.0.7103.49');
  expect(result).toBeDefined();
  const byBrand = Object.fromEntries(result!.brands.map(b => [b.brand, b.version]));
  expect(byBrand['Chromium']).toBe('136');
  expect(byBrand['Google Chrome']).toBe('136');
  expect(result!.fullVersion).toBe('136.0.7103.49');
});
