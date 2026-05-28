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
 * CLI-surface parser for the `--cdp-stealth=<comma-list>` flag introduced by
 * Sapoto PRD #1045 / Tracer A2.
 *
 * This file lives in `packages/isomorphic/` because it must be reachable
 * from the MCP CLI option parser without dragging the server-side import
 * chain into a unit test. Mirrors the placement of `cdpStealthAlias.ts`
 * (which handles the programmatic `stealthMode: true` alias from A1).
 *
 * Domain semantics are intentionally redundant with
 * `packages/playwright-core/src/server/cdpStealth.ts`:
 *
 *   - The server-side `parseCdpStealthFeatures(values: string[])` is the
 *     post-validator authority. It rehydrates the wire payload to a typed
 *     `Set<CdpStealthFeature>` and throws on unknown values (including
 *     `network-skip`).
 *
 *   - This file is the pre-validator CLI surface. It accepts the textual
 *     comma-list form, expands the `all` sentinel, and produces the same
 *     wire-format `string[]` that the post-validator expects.
 *
 * Both ends reject `network-skip` for the same reason (Codex P1 review on
 * PR #28 removed Network.enable gating because it broke `page.on('request')`
 * listeners), so a stale invocation script gets a loud failure at the CLI
 * layer instead of a silent no-op deeper in.
 *
 * Keep the canonical feature list in sync with
 * `CDP_STEALTH_FEATURES` on the server side. The duplication is deliberate
 * — this file is part of the isomorphic leaf set and must not import from
 * server/.
 */

/**
 * The canonical feature set the `--cdp-stealth=all` sentinel expands to.
 * Mirrors `server/cdpStealth.ts:CDP_STEALTH_FEATURES`.
 */
export const CDP_STEALTH_CLI_FEATURES: ReadonlyArray<string> = Object.freeze([
  'runtime-cycle',
  'log-skip',
  'worker-runtime',
]);

const CDP_STEALTH_CLI_FEATURE_SET: ReadonlySet<string> = new Set<string>(CDP_STEALTH_CLI_FEATURES);

/**
 * Parse the textual `--cdp-stealth=<comma-list>` argument into the wire
 * payload (`string[]`).
 *
 * Three semantic forms:
 *   - `undefined`  → flag never passed; returns `undefined` so the
 *                    option-merge pickDefined() pass lets env/config-file
 *                    values flow through.
 *   - `""`         → flag passed with an empty value; returns `[]` so the
 *                    CLI invocation can deterministically opt out of all
 *                    stealth features even when env/config-file would
 *                    enable them.
 *   - `"all"`      → expands to the full 3-feature bundle (the textual
 *                    counterpart of the legacy `stealthMode: true`).
 *   - `"a,b,..."`  → comma-separated list of features. Whitespace around
 *                    each entry is trimmed; unknown values throw with a
 *                    pointer back to the bad token.
 *
 * `network-skip` is rejected via the unknown-value branch on purpose.
 */
export function parseCdpStealthCLI(value: string | undefined): string[] | undefined {
  if (value === undefined)
    return undefined;
  if (value === '')
    return [];
  if (value === 'all')
    return [...CDP_STEALTH_CLI_FEATURES];
  const parts = value.split(',').map(v => v.trim()).filter(v => v.length > 0);
  if (parts.length === 0)
    return [];
  for (const part of parts) {
    if (!CDP_STEALTH_CLI_FEATURE_SET.has(part)) {
      const allowed = CDP_STEALTH_CLI_FEATURES.map(v => JSON.stringify(v)).join(', ');
      throw new Error(`Invalid --cdp-stealth value: ${JSON.stringify(part)}. Allowed: ${allowed}, "all", or empty.`);
    }
  }
  return parts;
}
