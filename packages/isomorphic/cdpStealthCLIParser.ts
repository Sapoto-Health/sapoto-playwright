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

export const CDP_STEALTH_CLI_FEATURES: ReadonlyArray<string> = Object.freeze([
  'runtime-cycle',
  'log-skip',
  'worker-runtime',
]);

const CDP_STEALTH_CLI_FEATURE_SET: ReadonlySet<string> = new Set<string>(CDP_STEALTH_CLI_FEATURES);

export function parseCdpStealthCLI(value: string | undefined): string[] | undefined {
  if (value === undefined)
    return undefined;
  if (value === '')
    return [];
  if (value === 'all')
    return [...CDP_STEALTH_CLI_FEATURES];
  const parts = value.split(',').map(v => v.trim()).filter(Boolean);
  for (const part of parts) {
    if (!CDP_STEALTH_CLI_FEATURE_SET.has(part)) {
      const allowed = CDP_STEALTH_CLI_FEATURES.map(v => JSON.stringify(v)).join(', ');
      throw new Error(`Invalid --cdp-stealth value: ${JSON.stringify(part)}. Allowed: ${allowed}, "all", or empty.`);
    }
  }
  return parts;
}
