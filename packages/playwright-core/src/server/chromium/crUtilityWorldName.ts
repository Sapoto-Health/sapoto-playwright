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
 * Per-page utility-world name generator — Sapoto PRD #1045 / Tracer A4.
 *
 * The previous shape concatenated a literal framework prefix with
 * `page.guid` and leaked two distinct detection-grade fingerprints
 * into any surface that exposed the world name
 * (Runtime.executionContextCreated events, Error.stack sourceURL tags):
 *
 *   1. The literal framework prefix — real Chrome has no built-in
 *      execution context whose name starts with that prefix. Anti-bot
 *      stack scrapers (Akamai bmak, DataDome) treat such prefixes as a
 *      framework tell.
 *   2. The embedded `SdkObject.guid` shape `page@<32-hex>` — Playwright's
 *      internal object-id format. Any frame containing that substring in
 *      a thrown stack identifies the page as automation-driven regardless
 *      of every other stealth posture.
 *
 * The replacement is a 16-char lowercase-hex token (8 bytes from
 * `crypto.randomBytes`), generated fresh per page. The format is
 * plausible-looking opaque garbage that resembles Chrome's own
 * `Runtime.UniqueDebuggerId` shape; the per-page differentiation
 * prevents cross-page correlation by name.
 *
 * This rename is always-on. It is not gated by the `cdpStealth` feature
 * set (A1 territory) because the leak exists regardless of CDP-domain
 * posture — any page that throws an exception inside the utility world
 * surfaces the name through `Error.stack`.
 */

import crypto from 'crypto';

/**
 * Generate a fresh opaque world name. Each invocation returns a distinct
 * 16-character lowercase-hex string. The shape is deliberately devoid of
 * any framework-identifying prefix.
 */
export function generateUtilityWorldName(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Matches the opaque world-name shape produced by
 * `generateUtilityWorldName()`. Exported so tests in both the unit suite
 * and the integration suite can share the same definition without
 * re-deriving the regex.
 */
export const UTILITY_WORLD_NAME_PATTERN = /^[0-9a-f]{16}$/;
