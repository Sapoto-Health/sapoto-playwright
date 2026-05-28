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

// Sapoto PRD #1045 / Tracer A2 — decomposed CLI flag surface for the fork's
// MCP server. The previous-generation surface was a single boolean
// `--stealth` / `--no-stealth`. PRD #1045 replaces that with five distinct
// flags that map 1:1 to `BrowserOptions` fields wired by A1:
//
//   --cdp-stealth=<list>           → BrowserOptions.cdpStealth (Set<feature>)
//   --print-capture                → BrowserOptions.printCapture (boolean)
//   --focus-emulation={on|off}     → BrowserOptions.focusEmulation
//
// `--stealth` and `--no-stealth` are retained for one release cycle as
// aliases for `--cdp-stealth=all` and `--cdp-stealth=` respectively.
//
// These tests pin the CLI option-parsing layer ONLY. End-to-end runtime
// behavior (CDP-domain gating, init-script injection) lives behind A3 / A5
// and is tested separately. Two surfaces are covered:
//
//   1. parseCdpStealthCLI — pure parser for the --cdp-stealth comma-list
//      (and the `all` sentinel + empty-string semantics). Lives in
//      `packages/isomorphic/` so the option-parsing layer can reach it
//      without dragging the server-side import chain into a unit test.
//
//   2. resolveCLIConfigForMCP — the integrated CLI option translator. We
//      assert that the parsed shape lands on `config.browser.launchOptions`
//      in the fields A1's channel validator forwards verbatim to
//      `BrowserOptions` (cdpStealth, printCapture,
//      focusEmulation). Validator allow-list confirmed in
//      packages/playwright-core/src/protocol/validator.ts (BrowserType
//      launch / launchPersistentContext schemas).

import { Command } from 'commander';
import { test, expect } from '@playwright/test';

import { parseCdpStealthCLI } from '../../packages/isomorphic/cdpStealthCLIParser';
import { tools } from '../../packages/playwright-core/lib/coreBundle';

const { resolveCLIConfigForMCP, decorateMCPCommand } = tools as typeof tools & {
  decorateMCPCommand: (command: Command) => void,
};

// Empty env to isolate from the host (mirrors tests/mcp/config-resolve.spec.ts).
const emptyEnv = {};

// ---------------------------------------------------------------------------
// parseCdpStealthCLI — pure parser for the --cdp-stealth comma-list argument
// ---------------------------------------------------------------------------

test('parseCdpStealthCLI splits a comma list into the wire-format string array', () => {
  expect(parseCdpStealthCLI('runtime-cycle,log-skip')).toEqual(['runtime-cycle', 'log-skip']);
});

test('parseCdpStealthCLI expands the "all" sentinel to the canonical 3-feature bundle', () => {
  expect(parseCdpStealthCLI('all')!.slice().sort()).toEqual(['log-skip', 'runtime-cycle', 'worker-runtime']);
});

test('parseCdpStealthCLI returns an empty array for an empty string ("--cdp-stealth=" with no value)', () => {
  // Empty string is the CLI form for "decompose the bundle to zero features"
  // (the structured opposite of `--cdp-stealth=all`). Distinguished from
  // "flag never passed" — that case is undefined; this case is the empty
  // array, which still flows into the wire payload.
  expect(parseCdpStealthCLI('')).toEqual([]);
});

test('parseCdpStealthCLI returns undefined for undefined input (flag never passed)', () => {
  expect(parseCdpStealthCLI(undefined)).toBeUndefined();
});

test('parseCdpStealthCLI rejects network-skip with a clear error', () => {
  // network-skip is intentionally absent from the canonical feature set
  // (Codex P1 review on PR #28 removed Network.enable gating because it
  // broke page.on("request") listeners). Surfacing it as a CLI value must
  // fail loudly so a stale invocation script doesn't silently no-op.
  expect(() => parseCdpStealthCLI('network-skip'))
      .toThrow(/Invalid --cdp-stealth value.*network-skip/);
});

test('parseCdpStealthCLI rejects an unknown feature with a clear error', () => {
  expect(() => parseCdpStealthCLI('runtime-cycle,made-up'))
      .toThrow(/Invalid --cdp-stealth value.*made-up/);
});

test('parseCdpStealthCLI trims whitespace around comma-separated entries', () => {
  // Users routinely write `--cdp-stealth="runtime-cycle, log-skip"` in shells
  // where the quoted argument preserves the space; the parser should not
  // reject that as `Invalid --cdp-stealth value: " log-skip"`.
  expect(parseCdpStealthCLI('runtime-cycle, log-skip')).toEqual(['runtime-cycle', 'log-skip']);
});

// ---------------------------------------------------------------------------
// resolveCLIConfigForMCP — the new CLI options must land on launchOptions in
// the shape A1's channel validator forwards to BrowserOptions.
// ---------------------------------------------------------------------------

test('resolveCLIConfigForMCP translates --cdp-stealth=runtime-cycle,log-skip into a 2-member launchOptions.cdpStealth array', async () => {
  const config = await resolveCLIConfigForMCP({ cdpStealth: ['runtime-cycle', 'log-skip'] }, emptyEnv);
  expect(config.browser.launchOptions.cdpStealth).toEqual(['runtime-cycle', 'log-skip']);
});

test('resolveCLIConfigForMCP translates --cdp-stealth=all into the full 3-member launchOptions.cdpStealth array', async () => {
  const config = await resolveCLIConfigForMCP({
    cdpStealth: ['runtime-cycle', 'log-skip', 'worker-runtime'],
  }, emptyEnv);
  expect([...(config.browser.launchOptions.cdpStealth ?? [])].sort())
      .toEqual(['log-skip', 'runtime-cycle', 'worker-runtime']);
});

test('resolveCLIConfigForMCP translates an empty --cdp-stealth list into an empty launchOptions.cdpStealth array', async () => {
  // The explicit-empty case must be distinguishable from the never-passed
  // case so a CLI invocation can deterministically opt out of all stealth
  // features even when env/config-file defaults would have enabled them.
  const config = await resolveCLIConfigForMCP({ cdpStealth: [] }, emptyEnv);
  expect(config.browser.launchOptions.cdpStealth).toEqual([]);
});

test('resolveCLIConfigForMCP omits launchOptions.cdpStealth entirely when the flag is not passed', async () => {
  // pickDefined() drops undefined during merge, letting env/config-file
  // values survive. If we leaked an empty array here the CLI would silently
  // stomp every config-file `cdpStealth` to "none".
  const config = await resolveCLIConfigForMCP({}, emptyEnv);
  expect(config.browser.launchOptions.cdpStealth).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Boolean flags — --print-capture, --focus-emulation
// ---------------------------------------------------------------------------

test('resolveCLIConfigForMCP defaults --print-capture to off (undefined)', async () => {
  // Per A2 spec: printCapture defaults to OFF. We emit undefined so env /
  // config-file values can flow through merge; the server-side coercion to
  // boolean (`!!options.printCapture`) yields false at runtime.
  const config = await resolveCLIConfigForMCP({}, emptyEnv);
  expect(config.browser.launchOptions.printCapture).toBeUndefined();
});

test('resolveCLIConfigForMCP threads --print-capture onto launchOptions.printCapture=true', async () => {
  const config = await resolveCLIConfigForMCP({ printCapture: true }, emptyEnv);
  expect(config.browser.launchOptions.printCapture).toBe(true);
});

test('resolveCLIConfigForMCP threads --focus-emulation=on onto launchOptions.focusEmulation=true', async () => {
  const config = await resolveCLIConfigForMCP({ focusEmulation: true }, emptyEnv);
  expect(config.browser.launchOptions.focusEmulation).toBe(true);
});

test('resolveCLIConfigForMCP threads --focus-emulation=off onto launchOptions.focusEmulation=false', async () => {
  const config = await resolveCLIConfigForMCP({ focusEmulation: false }, emptyEnv);
  expect(config.browser.launchOptions.focusEmulation).toBe(false);
});

// ---------------------------------------------------------------------------
// Legacy aliases — --stealth / --no-stealth still expand to the new shape for
// one release cycle. The alias is handled inside the option translator so the
// CLI surface and any programmatic caller end up at the same wire payload.
// ---------------------------------------------------------------------------

test('resolveCLIConfigForMCP: legacy --stealth alias materializes as the full 3-member launchOptions.cdpStealth', async () => {
  const config = await resolveCLIConfigForMCP({ stealth: true }, emptyEnv);
  expect([...(config.browser.launchOptions.cdpStealth ?? [])].sort())
      .toEqual(['log-skip', 'runtime-cycle', 'worker-runtime']);
});

test('resolveCLIConfigForMCP: legacy --no-stealth alias materializes as an empty launchOptions.cdpStealth', async () => {
  const config = await resolveCLIConfigForMCP({ stealth: false }, emptyEnv);
  expect(config.browser.launchOptions.cdpStealth).toEqual([]);
});

test('resolveCLIConfigForMCP: explicit cdpStealth wins over legacy stealth (caller has migrated)', async () => {
  // Mirrors resolveCdpStealthAlias() precedence in
  // @isomorphic/cdpStealthAlias: explicit cdpStealth wins over stealth: bool.
  const config = await resolveCLIConfigForMCP({ stealth: true, cdpStealth: ['log-skip'] }, emptyEnv);
  expect(config.browser.launchOptions.cdpStealth).toEqual(['log-skip']);
});

// ---------------------------------------------------------------------------
// Commander-layer rejection — addresses Codex spec concern that the pure
// parser proof above does not cover the actual CLI registration path. The
// 20 tests above pin parseCdpStealthCLI and resolveCLIConfigForMCP with
// already-normalized option objects; this one constructs commander via
// decorateMCPCommand and parses a real argv, so a regression that detached
// parseCdpStealthCLI from the --cdp-stealth flag (e.g., a stray refactor
// that dropped the parser binding) would surface here.
// ---------------------------------------------------------------------------

test('decorateMCPCommand: commander rejects --cdp-stealth=network-skip at parse time', async () => {
  const cmd = new Command();
  // exitOverride() turns commander's default `process.exit(1)` into a thrown
  // CommanderError, letting expect().rejects observe the failure instead of
  // killing the worker. The thrown shape is { code, message, exitCode }.
  cmd.exitOverride();
  decorateMCPCommand(cmd);

  // Commander invokes the option-argument parser during argv parsing (before
  // .action runs), so parseCdpStealthCLI's `Invalid --cdp-stealth value:
  // "network-skip"` Error surfaces synchronously and parseAsync rejects with
  // it. The message must include the offending value so a user pasting a
  // stale invocation sees what to remove, not just "invalid option".
  await expect(cmd.parseAsync(['node', 'mcp', '--cdp-stealth=network-skip']))
      .rejects.toThrow(/network-skip/);
});
