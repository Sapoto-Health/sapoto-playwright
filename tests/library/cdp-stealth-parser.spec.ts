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

import { test, expect } from '@playwright/test';
import { parseCdpStealthCLI, CDP_STEALTH_CLI_FEATURES } from '../../packages/isomorphic/cdpStealthCLIParser';
import { parseCdpStealthFeatures, CDP_STEALTH_FEATURES } from '../../packages/playwright-core/src/server/cdpStealth';
import { shouldSkipLogEnable, shouldCycleRuntime, shouldCycleWorkerRuntime } from '../../packages/playwright-core/src/server/chromium/cdpStealthGates';

// ---------------------------------------------------------------------------
// CLI parser — parseCdpStealthCLI
// ---------------------------------------------------------------------------

test.describe('parseCdpStealthCLI', () => {
  test('undefined input returns undefined (flag absent)', () => {
    expect(parseCdpStealthCLI(undefined)).toBeUndefined();
  });

  test('empty string returns empty array (kill-switch)', () => {
    const result = parseCdpStealthCLI('');
    expect(result).toEqual([]);
  });

  test('"all" returns every feature', () => {
    const result = parseCdpStealthCLI('all');
    expect(result).toEqual([...CDP_STEALTH_CLI_FEATURES]);
    expect(result).toContain('runtime-cycle');
    expect(result).toContain('log-skip');
    expect(result).toContain('worker-runtime');
  });

  test('single feature: runtime-cycle', () => {
    expect(parseCdpStealthCLI('runtime-cycle')).toEqual(['runtime-cycle']);
  });

  test('single feature: log-skip', () => {
    expect(parseCdpStealthCLI('log-skip')).toEqual(['log-skip']);
  });

  test('single feature: worker-runtime', () => {
    expect(parseCdpStealthCLI('worker-runtime')).toEqual(['worker-runtime']);
  });

  test('two features combined', () => {
    const result = parseCdpStealthCLI('runtime-cycle,log-skip');
    expect(result).toEqual(['runtime-cycle', 'log-skip']);
  });

  test('handles whitespace around commas', () => {
    const result = parseCdpStealthCLI(' runtime-cycle , log-skip ');
    expect(result).toEqual(['runtime-cycle', 'log-skip']);
  });

  test('rejects unknown feature: network-skip', () => {
    expect(() => parseCdpStealthCLI('network-skip')).toThrow(
        /Invalid --cdp-stealth value: "network-skip"/
    );
  });

  test('rejects arbitrary unknown feature', () => {
    expect(() => parseCdpStealthCLI('bogus-feature')).toThrow(
        /Invalid --cdp-stealth value: "bogus-feature"/
    );
  });

  test('rejects mix of valid and invalid features', () => {
    expect(() => parseCdpStealthCLI('runtime-cycle,network-skip')).toThrow(
        /Invalid --cdp-stealth value: "network-skip"/
    );
  });

  test('feature list is exactly three members', () => {
    expect(CDP_STEALTH_CLI_FEATURES).toEqual(['runtime-cycle', 'log-skip', 'worker-runtime']);
  });
});

// ---------------------------------------------------------------------------
// Server-side parser — parseCdpStealthFeatures
// ---------------------------------------------------------------------------

test.describe('parseCdpStealthFeatures', () => {
  test('undefined input returns empty set', () => {
    const set = parseCdpStealthFeatures(undefined);
    expect(set.size).toBe(0);
  });

  test('empty array returns empty set', () => {
    const set = parseCdpStealthFeatures([]);
    expect(set.size).toBe(0);
  });

  test('all three features produce a complete set', () => {
    const set = parseCdpStealthFeatures([...CDP_STEALTH_FEATURES]);
    expect(set.size).toBe(3);
    expect(set.has('runtime-cycle')).toBe(true);
    expect(set.has('log-skip')).toBe(true);
    expect(set.has('worker-runtime')).toBe(true);
  });

  test('single feature: runtime-cycle only', () => {
    const set = parseCdpStealthFeatures(['runtime-cycle']);
    expect(set.size).toBe(1);
    expect(set.has('runtime-cycle')).toBe(true);
    expect(set.has('log-skip')).toBe(false);
    expect(set.has('worker-runtime')).toBe(false);
  });

  test('single feature: log-skip only', () => {
    const set = parseCdpStealthFeatures(['log-skip']);
    expect(set.size).toBe(1);
    expect(set.has('log-skip')).toBe(true);
    expect(set.has('runtime-cycle')).toBe(false);
    expect(set.has('worker-runtime')).toBe(false);
  });

  test('single feature: worker-runtime only', () => {
    const set = parseCdpStealthFeatures(['worker-runtime']);
    expect(set.size).toBe(1);
    expect(set.has('worker-runtime')).toBe(true);
    expect(set.has('runtime-cycle')).toBe(false);
    expect(set.has('log-skip')).toBe(false);
  });

  test('rejects unknown feature', () => {
    expect(() => parseCdpStealthFeatures(['network-skip'])).toThrow(
        /Invalid cdpStealth feature: "network-skip"/
    );
  });
});

// ---------------------------------------------------------------------------
// Gate functions — independence verification
// ---------------------------------------------------------------------------

test.describe('cdpStealthGates independence', () => {
  test('shouldSkipLogEnable only responds to log-skip', () => {
    expect(shouldSkipLogEnable(new Set(['log-skip']))).toBe(true);
    expect(shouldSkipLogEnable(new Set(['runtime-cycle']))).toBe(false);
    expect(shouldSkipLogEnable(new Set(['worker-runtime']))).toBe(false);
    expect(shouldSkipLogEnable(new Set())).toBe(false);
  });

  test('shouldCycleRuntime only responds to runtime-cycle', () => {
    expect(shouldCycleRuntime(new Set(['runtime-cycle']))).toBe(true);
    expect(shouldCycleRuntime(new Set(['log-skip']))).toBe(false);
    expect(shouldCycleRuntime(new Set(['worker-runtime']))).toBe(false);
    expect(shouldCycleRuntime(new Set())).toBe(false);
  });

  test('shouldCycleWorkerRuntime only responds to worker-runtime', () => {
    expect(shouldCycleWorkerRuntime(new Set(['worker-runtime']))).toBe(true);
    expect(shouldCycleWorkerRuntime(new Set(['runtime-cycle']))).toBe(false);
    expect(shouldCycleWorkerRuntime(new Set(['log-skip']))).toBe(false);
    expect(shouldCycleWorkerRuntime(new Set())).toBe(false);
  });

  test('all gates true when all features enabled', () => {
    const all = new Set<any>(['runtime-cycle', 'log-skip', 'worker-runtime']);
    expect(shouldSkipLogEnable(all)).toBe(true);
    expect(shouldCycleRuntime(all)).toBe(true);
    expect(shouldCycleWorkerRuntime(all)).toBe(true);
  });

  test('all gates false when empty set (kill-switch)', () => {
    const empty = new Set<any>();
    expect(shouldSkipLogEnable(empty)).toBe(false);
    expect(shouldCycleRuntime(empty)).toBe(false);
    expect(shouldCycleWorkerRuntime(empty)).toBe(false);
  });
});
