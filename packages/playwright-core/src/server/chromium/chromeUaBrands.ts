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
 * CDP Stealth: pure helper that derives Chrome's UA Client Hint brand list
 * from the running browser's version string.
 *
 * Extracted from crPage.ts so that unit tests can import it without
 * transitively pulling in dom.ts (which uses `declare readonly` class
 * fields — a TS syntax babel-jest's parser does not handle).
 *
 * Real Chrome emits three brands: "Chromium", "Google Chrome", and a
 * rotating "Not/A)Brand" (a.k.a. the "GREASE" brand). Tests of this
 * function should cover the version derivation and the three-entry
 * shape — not the exact GREASE string (which Chromium has changed
 * multiple times: ";Not A Brand", "Not/A)Brand", "Not?A_Brand").
 */

import type { Protocol } from './protocol';

export function buildChromeBrands(fullVersion: string): {
  brands: Protocol.Emulation.UserAgentBrandVersion[];
  fullVersionList: Protocol.Emulation.UserAgentBrandVersion[];
  fullVersion: string;
} | undefined {
  const majorVersion = fullVersion.split('.')[0];
  if (!majorVersion)
    return undefined;
  return {
    brands: [
      { brand: 'Chromium', version: majorVersion },
      { brand: 'Google Chrome', version: majorVersion },
      { brand: 'Not/A)Brand', version: '99' },
    ],
    fullVersionList: [
      { brand: 'Chromium', version: fullVersion },
      { brand: 'Google Chrome', version: fullVersion },
      { brand: 'Not/A)Brand', version: '99.0.0.0' },
    ],
    fullVersion,
  };
}
