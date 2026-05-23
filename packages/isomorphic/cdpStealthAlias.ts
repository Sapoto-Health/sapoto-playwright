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
 * Option-parsing-layer backward-compat aliases for Sapoto PRD #1045 / Tracer A1.
 *
 * The previous-generation API exposed a single boolean `stealthMode`. PRD #1045
 * decomposes that into a typed Set of named features. To avoid breaking PR #28's
 * existing behavior before A2 lands the CLI surface, callers that still pass
 * `stealthMode: true` (or equivalent) get translated to the canonical 3-feature
 * bundle for one release cycle.
 *
 * This lives in `packages/isomorphic/` because it must be reachable from both
 * the client-side channel shim (which cannot import `server/`) and the server-
 * side dispatcher / MCP option-parsing surfaces.
 */

/**
 * The canonical wire-format `cdpStealth` array the previous-generation
 * `stealthMode: true` boolean expands to. Kept in sync with the
 * `CdpStealthFeature` server-side type — when adding a new feature, update
 * both there and here.
 */
export const DEFAULT_CDP_STEALTH_WIRE: ReadonlyArray<string> = Object.freeze([
  'runtime-cycle',
  'log-skip',
  'worker-runtime',
]);

/**
 * Translate the legacy `stealthMode: boolean` alias into the new
 * `cdpStealth: string[]` shape, falling through to an explicit `cdpStealth`
 * when the caller has already migrated.
 *
 * Precedence:
 *   - explicit `cdpStealth` wins (caller has migrated; respect it as-is).
 *   - `stealthMode === true` (legacy) → expand to the full bundle.
 *   - `stealthMode === false` (legacy explicit opt-out) → empty array.
 *   - otherwise → undefined (no field on the wire).
 */
export function resolveCdpStealthAlias(input: { cdpStealth?: string[] | readonly string[], stealthMode?: boolean }): string[] | undefined {
  if (input.cdpStealth !== undefined)
    return [...input.cdpStealth];
  if (input.stealthMode === true)
    return [...DEFAULT_CDP_STEALTH_WIRE];
  if (input.stealthMode === false)
    return [];
  return undefined;
}
