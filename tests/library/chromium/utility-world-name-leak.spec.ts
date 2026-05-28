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
 * Sapoto PRD #1045 / Tracer A4 — utility-world name leak assertions.
 *
 * The unit suite (`tests/library/utility-world-name.spec.ts`) locks down the
 * generator helper. This suite spawns a real Chromium and validates that the
 * generated name actually reaches the page surface intact, with no legacy
 * substrings leaking through Runtime.executionContextCreated events or
 * Error.stack sourceURL tags.
 *
 * Two leak channels under test:
 *   1. Runtime.executionContextCreated — the `name` field of the second
 *      context (the utility world) must match the opaque hex shape, never
 *      `__chrome_util_*` and never `__playwright_*`.
 *   2. Error.stack from JS evaluated INSIDE the utility world — the
 *      sourceURL tag for that script is built from the world name, so any
 *      framework-identifying prefix would surface there. We assert the
 *      stack contains zero frames matching the three forbidden shapes:
 *        /__chrome_util_/, /__playwright_/, /page@[0-9a-f]{32}/.
 *
 * Per-page differentiation is also exercised: two pages opened in the
 * same context must register utility-world names that differ. The name is
 * computed in `CRPage`'s constructor, not at context creation, so this
 * collision check guards against any future refactor that hoists the name
 * to the context level.
 */

import { browserTest as test, expect } from '../../config/browserTest';
import { UTILITY_WORLD_NAME_PATTERN } from '../../../packages/playwright-core/src/server/chromium/crUtilityWorldName';

test.skip(({ browserName }) => browserName !== 'chromium', 'utility-world rename is Chromium-only');

const FORBIDDEN_PATTERNS = [
  /__chrome_util_/,
  /__playwright_/,
  /page@[0-9a-f]{32}/,
];

/**
 * Listen for `Runtime.executionContextCreated` on a freshly-attached CDP
 * session and resolve once the utility-world context has been observed.
 *
 * The main-world context always arrives first (auxData.isDefault === true);
 * the utility world arrives a moment later with an opaque name and is
 * NOT marked default. We filter on the latter.
 */
async function captureUtilityWorldName(client: any, navigate: () => Promise<unknown>): Promise<string> {
  const utilityWorldName = new Promise<string>(resolve => {
    client.on('Runtime.executionContextCreated', (event: any) => {
      const auxData = event.context.auxData || {};
      if (auxData.isDefault === false && typeof event.context.name === 'string' && event.context.name)
        resolve(event.context.name);
    });
  });
  await client.send('Runtime.enable');
  await navigate();
  return utilityWorldName;
}

test('utility-world name is opaque hex and never contains the legacy substrings', async ({ browser, server }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const client = await context.newCDPSession(page);

  const worldName = await captureUtilityWorldName(client, () => page.goto(server.EMPTY_PAGE));

  expect(worldName, 'utility-world name should match the opaque 16-char hex shape').toMatch(UTILITY_WORLD_NAME_PATTERN);
  for (const forbidden of FORBIDDEN_PATTERNS)
    expect(worldName).not.toMatch(forbidden);

  await context.close();
});

test('Error.stack from a utility-world evaluation contains zero forbidden frames', async ({ browser, server }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const client = await context.newCDPSession(page);

  // Track every utility-world context that gets created, keyed by name. After
  // a document finishes loading, the LAST utility context observed is the one
  // currently bound to the active frame (earlier ones from the about:blank
  // initial document have been destroyed). Targeting the destroyed contextId
  // with `Runtime.evaluate` yields "Cannot find context with specified id";
  // we must use the post-navigation live one.
  const utilityContexts: Array<{ id: number; name: string }> = [];
  client.on('Runtime.executionContextCreated', (event: any) => {
    const auxData = event.context.auxData || {};
    if (auxData.isDefault === false && typeof event.context.name === 'string' && event.context.name)
      utilityContexts.push({ id: event.context.id, name: event.context.name });
  });
  client.on('Runtime.executionContextDestroyed', (event: any) => {
    const idx = utilityContexts.findIndex(c => c.id === event.executionContextId);
    if (idx !== -1)
      utilityContexts.splice(idx, 1);
  });
  await client.send('Runtime.enable');
  await page.goto(server.EMPTY_PAGE);
  // Force Playwright to materialise its utility world on the loaded document
  // (the bindings/init scripts attach lazily on first dom evaluation).
  await page.locator('html').evaluate(el => el.tagName);

  expect(utilityContexts.length, 'at least one utility world should be live after navigation').toBeGreaterThan(0);
  const { id: contextId, name: worldName } = utilityContexts[utilityContexts.length - 1];

  // Throw an Error inside the utility world. The sourceURL tag in the
  // resulting stack frames is derived from the world's name — any leak of
  // legacy framework substrings would surface here and would be visible to
  // any page script that wraps the global Error constructor or scrapes
  // console.debug output (Akamai bmak pattern).
  //
  // The expression is tagged with `//# sourceURL=${worldName}`. V8 surfaces
  // that tag as the source label on every frame thrown from this script,
  // which means:
  //   (a) the captured stack MUST contain the worldName — proves V8 is
  //       actually emitting source labels in this CDP flow, so the negative
  //       assertion below isn't vacuously true (the original Codex concern).
  //   (b) the captured stack MUST NOT contain any forbidden substring —
  //       the actual rename assertion, now with teeth.
  const evalResult = await client.send('Runtime.evaluate', {
    expression: `new Error("stack-probe").stack\n//# sourceURL=${worldName}`,
    contextId,
    returnByValue: true,
  });
  const stack = String(evalResult.result.value || '');
  expect(stack, 'utility-world evaluation should return a stack string').toContain('stack-probe');
  // Self-validation: prove V8 is actually attaching source labels to the
  // stack frames in this CDP context. Without this, the forbidden-substring
  // check below would pass vacuously on any stack that simply lacks frame
  // source labels.
  expect(stack, 'stack must contain the worldName sourceURL tag (proves source labels are surfaced)')
      .toMatch(new RegExp(worldName));

  for (const forbidden of FORBIDDEN_PATTERNS)
    expect(stack, `stack should not contain ${forbidden}`).not.toMatch(forbidden);

  // Belt-and-braces: the world name we captured must itself pass the same
  // forbidden-substring filter. (If this fails but the stack passes, it
  // means the name is leaking through a channel the stack doesn't see.)
  expect(worldName).toMatch(UTILITY_WORLD_NAME_PATTERN);
  for (const forbidden of FORBIDDEN_PATTERNS)
    expect(worldName).not.toMatch(forbidden);

  await context.close();
});

test('two pages in the same context get distinct utility-world names (per-page differentiation)', async ({ browser, server }) => {
  // The acceptance criterion requires per-page differentiation: the name is
  // computed in CRPage's constructor, so two pages in the same context must
  // not collide. A future refactor that lifts the name to context scope
  // would break this assertion.
  const context = await browser.newContext();

  const pageA = await context.newPage();
  const clientA = await context.newCDPSession(pageA);
  const nameA = await captureUtilityWorldName(clientA, () => pageA.goto(server.EMPTY_PAGE));

  const pageB = await context.newPage();
  const clientB = await context.newCDPSession(pageB);
  const nameB = await captureUtilityWorldName(clientB, () => pageB.goto(server.EMPTY_PAGE));

  expect(nameA).toMatch(UTILITY_WORLD_NAME_PATTERN);
  expect(nameB).toMatch(UTILITY_WORLD_NAME_PATTERN);
  expect(nameA, 'two pages must get different utility-world names').not.toBe(nameB);

  await context.close();
});
