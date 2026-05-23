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
 * CDP stealth feature set — Sapoto PRD #1045 / Tracer A1.
 *
 * The previous-generation API exposed a single boolean `stealthMode` that
 * gated three distinct CDP-domain mitigations as a bundle. PRD #1045
 * decomposes that into a set of named features so each can be toggled
 * independently in A2/A3.
 *
 *   - 'runtime-cycle'  — rapid Runtime.enable → Runtime.disable cycle, used
 *                        to keep the long-lived Runtime domain (`console.debug`
 *                        Proxy trap) dark to page scripts while still letting
 *                        Playwright discover executionContexts at attach time
 *                        and on cross-document navigation.
 *   - 'log-skip'       — skip Log.enable. Log only surfaces browser-level
 *                        warnings (deprecation notices, network errors);
 *                        console messages come from Runtime.consoleAPICalled.
 *                        Removing Log shrinks the CDP surface anti-bot
 *                        fingerprinters watch for, with no functional impact.
 *   - 'worker-runtime' — same Runtime.enable→disable cycle, applied per
 *                        worker target.
 *
 * `network-skip` is INTENTIONALLY omitted from the valid set. Codex P1
 * review on PR #28 deliberately removed Network.enable gating because it
 * broke `page.on('request')` listeners; readd would silently regress that
 * surface. Wire-format values that include `network-skip` are rejected at
 * the channel boundary.
 */
export type CdpStealthFeature = 'runtime-cycle' | 'log-skip' | 'worker-runtime';

export const CDP_STEALTH_FEATURES: readonly CdpStealthFeature[] = [
  'runtime-cycle',
  'log-skip',
  'worker-runtime',
];

const CDP_STEALTH_FEATURE_SET: ReadonlySet<string> = new Set<string>(CDP_STEALTH_FEATURES);

/**
 * Build the canonical Set<CdpStealthFeature> the previous-generation
 * `stealthMode: true` boolean expanded to. Use this from the option-parsing
 * layer to translate legacy `stealthMode: true` into the new shape for one
 * release cycle.
 */
export function defaultCdpStealthFeatures(): Set<CdpStealthFeature> {
  return new Set<CdpStealthFeature>(CDP_STEALTH_FEATURES);
}

/**
 * Parse a wire-format `string[]` (e.g. from `BrowserTypeLaunchParams.cdpStealth`)
 * into a typed `Set<CdpStealthFeature>`. Unknown values throw — in particular,
 * `network-skip` (which Codex P1 review removed in PR #28) is rejected.
 *
 * Pass `undefined` to get an empty Set, the "no stealth" default.
 */
export function parseCdpStealthFeatures(values: readonly string[] | undefined): Set<CdpStealthFeature> {
  const set = new Set<CdpStealthFeature>();
  if (!values)
    return set;
  for (const raw of values) {
    if (!CDP_STEALTH_FEATURE_SET.has(raw))
      throw new Error(`Invalid cdpStealth feature: ${JSON.stringify(raw)}. Allowed values: ${CDP_STEALTH_FEATURES.map(v => JSON.stringify(v)).join(', ')}`);
    set.add(raw as CdpStealthFeature);
  }
  return set;
}
