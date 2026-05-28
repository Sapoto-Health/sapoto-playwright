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
 * Sapoto PRD #1045 / Tracer A6 — click event-order serialization
 * (CDP-wire integration test).
 *
 * Background. Previously, `Mouse.click()` (server/input.ts) issued the
 * constituent `move` / `down` / `up` calls inside a `Promise.all`,
 * which let the `mousePressed` and `mouseReleased` CDP dispatches
 * resolve interleaved with — or even ahead of — the trailing bezier
 * `mouseMoved` dispatches emitted by `RawMouseImpl.move()`. The result
 * was a detectable event-order inversion on the CDP wire: a
 * `mousePressed` command arriving at the browser BEFORE the bezier had
 * finished sending its `mouseMoved` commands. Antibot fingerprinters
 * (Akamai bmak, PerimeterX, DataDome) inspect that ordering and flag
 * the inversion. A6 replaces the `Promise.all` with sequential
 * `await move; await down; await up`, eliminating the race.
 *
 * What this suite verifies. It spawns a real Chromium via the
 * worktree-local `playwright-core` build (NOT the shared
 * `@playwright/test` runner's playwright, which may resolve to a
 * different checkout's bundle), hooks the chromium-side
 * `CRSession.send` on the same `RawMouseImpl` instance that
 * `Mouse.click()` drives, and asserts that the captured sequence of
 * `Input.dispatchMouseEvent` types matches the serialized contract
 *   /^mouseMoved+ mousePressed mouseReleased$/
 * Any `mouseMoved` dispatched AFTER `mousePressed` indicates A6's
 * serialization regressed and the bezier path is once again racing the
 * click pair. The mechanism is the canonical CDP-wire-hook pattern
 * used elsewhere in this repo (e.g. the utility-world-name leak suite).
 *
 * Why we require playwright-core directly. The repo's @playwright/test
 * runner loads `playwright-core` via Node's module resolution, which
 * in a linked-worktree setup resolves to the main fork checkout's
 * `coreBundle.js`. That bundle is rebuilt only when `npm run build`
 * runs in the main checkout; an A6 build inside this worktree updates
 * the worktree's own `packages/playwright-core/lib/coreBundle.js` but
 * never gets loaded by the runner. By requiring
 * `packages/playwright-core/index.js` via an absolute path rooted at the
 * worktree, we bypass that and exercise the actual A6 src/build under
 * test.
 *
 * Both `humanizeInput=true` (bezier path, ~12+ mouseMoved dispatches)
 * and `humanizeInput=false` (teleport path, exactly 1 mouseMoved) are
 * covered. Both must serialize identically per A6.
 *
 * Prior-art tests for adjacent humanizeInput surface area:
 *   - tests/library/bezier-input.spec.ts        (pure-logic bezier)
 *   - tests/library/humanize-input-channel.spec.ts (channel forwarding)
 */

import * as path from 'path';
import { test, expect } from '@playwright/test';

// Resolve playwright-core from the WORKTREE's own packages/, not from
// the runner's node_modules (which may shadow it with a stale bundle
// from the linked main checkout). See module-level doc comment above
// for the full rationale.
//
// eslint-disable-next-line @typescript-eslint/no-require-imports
const localPlaywright = require(path.resolve(__dirname, '..', '..', '..', 'packages', 'playwright-core', 'index.js')) as typeof import('playwright-core');

test.skip(process.platform === 'win32', 'no behavior-specific Windows divergence; saves CI cycles');

type DispatchKind = 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'other';

/**
 * Wrap the chromium RawMouseImpl's CDP client `.send` so we capture
 * every `Input.dispatchMouseEvent` call in invocation order. The hook
 * is installed on the same CRSession instance that `Mouse.click()`
 * drives, so what we see is exactly what the production code asked the
 * browser to do; renderer-side coalescing is out of scope by design.
 *
 * We reach into RawMouseImpl via the in-process Page's `_delegate`
 * (the CRPage), then `.rawMouse._client`. This is the same access
 * path used by the utility-world-name leak suite and other server-side
 * integration tests.
 */
function hookRawMouseDispatch(page: any): { events: DispatchKind[]; restore: () => void } {
  // localPlaywright runs in-process, so `page` is the dispatcher's
  // client-side handle; we grab the server-side impl via the same
  // toImpl convention used in humanize-input-channel.spec.ts:
  //   playwright._connection.toImpl(clientObject) → serverObject
  const toImpl: (rpc: any) => any = (localPlaywright as any)._connection.toImpl;
  const impl = toImpl(page);
  const rawMouse = impl.delegate.rawMouse;
  const client = rawMouse._client;
  const originalSend = client.send.bind(client);
  const events: DispatchKind[] = [];
  client.send = function patchedSend(method: string, params?: any) {
    if (method === 'Input.dispatchMouseEvent') {
      const t = (params && params.type) as DispatchKind | undefined;
      if (t === 'mouseMoved' || t === 'mousePressed' || t === 'mouseReleased')
        events.push(t);
      else
        events.push('other');
    }
    return originalSend(method, params);
  };
  return {
    events,
    restore: () => { client.send = originalSend; },
  };
}

const CAPTURE_PAGE = `<!doctype html>
<html><body style="margin:0;padding:0">
  <div id="target" style="position:absolute;left:0;top:0;width:600px;height:400px;"></div>
</body></html>`;

async function clickAndCaptureDispatches(humanize: boolean): Promise<DispatchKind[]> {
  const browser = await (localPlaywright as any).chromium.launch({
    humanizeInput: humanize,
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(CAPTURE_PAGE);

    // Seed the cursor at a non-target position so the bezier (humanize=true)
    // has actual distance to cover. RawMouseImpl skips humanization on the
    // first move when `_lastPos` is null; this seed both sets `_lastPos`
    // and runs BEFORE the hook is installed (so the seed move's mouseMoved
    // does not pollute the captured sequence).
    await page.mouse.move(50, 50);

    const { events, restore } = hookRawMouseDispatch(page);
    try {
      await page.mouse.click(400, 300);
    } finally {
      restore();
    }
    await context.close();
    return events;
  } finally {
    await browser.close();
  }
}

/**
 * Assert the dispatch sequence matches the serialized contract:
 *   /^mouseMoved+ mousePressed mouseReleased$/
 * Equivalently: every `mouseMoved` strictly precedes the first
 * `mousePressed`; `mousePressed` strictly precedes `mouseReleased`; and
 * nothing trails the `mouseReleased`. Any deviation indicates A6's
 * serialization regressed (e.g. the old Promise.all is back).
 */
function assertSerializedDispatchOrder(events: DispatchKind[], label: string): void {
  const firstDownIdx = events.findIndex(e => e === 'mousePressed');
  const firstUpIdx = events.findIndex(e => e === 'mouseReleased');

  expect(firstDownIdx, `${label}: at least one mousePressed must be dispatched; sequence=${events.join(',')}`).toBeGreaterThanOrEqual(0);
  expect(firstUpIdx, `${label}: at least one mouseReleased must be dispatched; sequence=${events.join(',')}`).toBeGreaterThanOrEqual(0);
  expect(firstDownIdx, `${label}: mousePressed must be dispatched before mouseReleased; sequence=${events.join(',')}`).toBeLessThan(firstUpIdx);

  for (let i = 0; i < firstDownIdx; i++) {
    expect(
        events[i],
        `${label}: only mouseMoved may precede mousePressed (idx=${i}, got=${events[i]}); sequence=${events.join(',')}`,
    ).toBe('mouseMoved');
  }
  for (let i = firstDownIdx + 1; i < events.length; i++) {
    expect(
        events[i],
        `${label}: no mouseMoved may follow mousePressed (idx=${i}, got=${events[i]}); sequence=${events.join(',')}`,
    ).not.toBe('mouseMoved');
  }
  expect(events[events.length - 1], `${label}: dispatch sequence must end on mouseReleased; sequence=${events.join(',')}`).toBe('mouseReleased');
}

test('humanizeInput=true: bezier mouseMoved CDP sends all precede mousePressed', async () => {
  const events = await clickAndCaptureDispatches(true);

  // Sanity: bezier humanization should produce a multi-step move plus the
  // click pair. >=5 ensures we're testing a path with real ordering risk;
  // a teleported move would make the move-precedence check vacuously true.
  const moveCount = events.filter(e => e === 'mouseMoved').length;
  expect(moveCount, `humanizeInput=true should emit >= 5 mouseMoved dispatches (got ${moveCount}); sequence=${events.join(',')}`).toBeGreaterThanOrEqual(5);

  assertSerializedDispatchOrder(events, 'humanizeInput=true');
});

test('humanizeInput=false: mouseMoved CDP send precedes mousePressed (default path also serialized)', async () => {
  const events = await clickAndCaptureDispatches(false);

  // Non-humanized path teleports — exactly one mouseMoved for the click move.
  const moveCount = events.filter(e => e === 'mouseMoved').length;
  expect(moveCount, `humanizeInput=false should emit exactly one mouseMoved dispatch (got ${moveCount}); sequence=${events.join(',')}`).toBe(1);

  assertSerializedDispatchOrder(events, 'humanizeInput=false');
});
