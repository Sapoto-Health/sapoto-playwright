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

import type * as playwright from '../../..';

export type ToolCapability =
  'config' |
  'core' |
  'core-navigation' |
  'core-tabs' |
  'core-input' |
  'core-install' |
  'network' |
  'pdf' |
  'storage' |
  'testing' |
  'vision' |
  'devtools';

export type Config = {
  /**
   * The browser to use.
   */
  browser?: {
    /**
     * The type of browser to use.
     */
    browserName?: 'chromium' | 'firefox' | 'webkit';

    /**
     * Keep the browser profile in memory, do not save it to disk.
     */
    isolated?: boolean;

    /**
     * Path to a user data directory for browser profile persistence.
     * Temporary directory is created by default.
     */
    userDataDir?: string;

    /**
     * Launch options passed to
     * @see https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
     *
     * This is useful for settings options like `channel`, `headless`, `executablePath`, etc.
     */
    launchOptions?: playwright.LaunchOptions;

    /**
     * Context options for the browser context.
     *
     * This is useful for settings options like `viewport`.
     */
    contextOptions?: playwright.BrowserContextOptions;

    /**
     * Chrome DevTools Protocol endpoint to connect to an existing browser instance in case of Chromium family browsers.
     */
    cdpEndpoint?: string;

    /**
     * CDP headers to send with the connect request.
     */
    cdpHeaders?: Record<string, string>;

    /**
     * Timeout in milliseconds for connecting to CDP endpoint. Defaults to 30000 (30 seconds). Pass 0 to disable timeout.
     */
    cdpTimeout?: number;

    /**
     * Remote endpoint to connect to an existing Playwright server.
     */
    remoteEndpoint?: string;

    /**
     * Headers to send with the remote endpoint connect request.
     */
    remoteHeaders?: Record<string, string>;

    /**
     * Paths to TypeScript files to add as initialization scripts for Playwright page.
     */
    initPage?: string[];

    /**
     * Paths to JavaScript files to add as initialization scripts.
     * The scripts will be evaluated in every page before any of the page's scripts.
     */
    initScript?: string[];
  },

  /**
   * Connect to a running browser instance (Edge/Chrome only). If specified, `browser`
   * config is ignored.
   * Requires the "Playwright Extension" to be installed.
   */
  extension?: boolean;

  server?: {
    /**
     * The port to listen on for SSE or MCP transport.
     */
    port?: number;

    /**
     * The host to bind the server to. Default is localhost. Use 0.0.0.0 to bind to all interfaces.
     */
    host?: string;

    /**
     * The hosts this server is allowed to serve from. Defaults to the host server is bound to.
     * This is not for CORS, but rather for the DNS rebinding protection.
     */
    allowedHosts?: string[];
  },

  /**
   * List of enabled tool capabilities. Possible values:
   *   - 'core': Core browser automation features.
   *   - 'pdf': PDF generation and manipulation.
   *   - 'vision': Coordinate-based interactions.
   *   - 'devtools': Developer tools features.
   */
  capabilities?: ToolCapability[];

  /**
   * Whether to save the Playwright session into the output directory.
   */
  saveSession?: boolean;

  /**
   * Reuse the same browser context between all connected HTTP clients.
   */
  sharedBrowserContext?: boolean;

  /**
   * Secrets are used to replace matching plain text in the tool responses to prevent the LLM
   * from accidentally getting sensitive data. It is a convenience and not a security feature,
   * make sure to always examine information coming in and from the tool on the client.
   */
  secrets?: Record<string, string>;

  /**
   * The directory to save output files.
   */
  outputDir?: string;

  console?: {
    /**
     * The level of console messages to return. Each level includes the messages of more severe levels. Defaults to "info".
     */
    level?: 'error' | 'warning' | 'info' | 'debug';
  },

  network?: {
    /**
     * List of origins to allow the browser to request. Default is to allow all. Origins matching both `allowedOrigins` and `blockedOrigins` will be blocked.
     *
     * Supported formats:
     * - Full origin: `https://example.com:8080` - matches only that origin
     * - Wildcard port: `http://localhost:*` - matches any port on localhost with http protocol
     */
    allowedOrigins?: string[];

    /**
     * List of origins to block the browser to request. Origins matching both `allowedOrigins` and `blockedOrigins` will be blocked.
     *
     * Supported formats:
     * - Full origin: `https://example.com:8080` - matches only that origin
     * - Wildcard port: `http://localhost:*` - matches any port on localhost with http protocol
     */
    blockedOrigins?: string[];
  };

  /**
   * Specify the attribute to use for test ids, defaults to "data-testid".
   */
  testIdAttribute?: string;

  timeouts?: {
    /*
     * Configures default action timeout: https://playwright.dev/docs/api/class-page#page-set-default-timeout. Defaults to 5000ms.
     */
    action?: number;

    /*
     * Configures default navigation timeout: https://playwright.dev/docs/api/class-page#page-set-default-navigation-timeout. Defaults to 60000ms.
     */
    navigation?: number;

    /**
     * Configures default expect timeout: https://playwright.dev/docs/test-timeouts#expect-timeout. Defaults to 5000ms.
     */
    expect?: number;

    /*
     * Configures download completion timeout in waitForCompletion. Defaults to 30000ms.
     */
    download?: number;
  };

  /**
   * Whether to send image responses to the client. Can be "allow", "omit", or "auto". Defaults to "auto", which sends images if the client can display them.
   */
  imageResponses?: 'allow' | 'omit';

  snapshot?: {
    /**
     * When taking snapshots for responses, specifies the mode to use.
     */
    mode?: 'full' | 'none';
  };

  /**
   * allowUnrestrictedFileAccess acts as a guardrail to prevent the LLM from accidentally
   * wandering outside its intended workspace. It is a convenience defense to catch unintended
   * file access, not a secure boundary; a deliberate attempt to reach other directories can be
   * easily worked around, so always rely on client-level permissions for true security.
   */
  allowUnrestrictedFileAccess?: boolean;

  /**
   * Specify the language to use for code generation.
   */
  codegen?: 'typescript' | 'none';

  /**
   * Filter out internal Electron application tabs (file://, data:, chrome-extension://,
   * localhost, 127.0.0.1) from the tab list so agents never see them.
   */
  filterInternalUrls?: boolean;

  /**
   * If specified, only expose tools whose names are in this list.
   * Applied after capability filtering.
   */
  allowedTools?: string[];

  /**
   * When true, suppress focus-stealing behaviors at the MCP level. Currently
   * this skips bringToFront() during tab selection so that agent-driven tab
   * switches do not raise the browser window on macOS. The complementary
   * page-side `window.focus`/select-dropdown shims live with the stealth
   * init script and are gated separately.
   */
  suppressFocus?: boolean;

  /**
   * When true, skip Playwright's page.on('download') registration so the
   * embedder's capture stack is the sole owner of downloads. Use when an
   * external CDP Fetch pipeline already handles download capture and
   * Playwright's saveAs() would create split ownership.
   */
  disableDownloads?: boolean;

  /**
   * When true, do not close the browser when the last tab closes.
   *
   * Currently a no-op against this upstream snapshot: the
   * `closeBrowserContext()`-on-last-tab path that this flag historically
   * gated has been removed upstream, so the default behavior is already
   * "keep alive." The field is preserved so downstream embedders (e.g.,
   * Sapoto, whose four agent runners pass `--keep-browser-alive` because
   * they manage the browser lifecycle from Electron) do not crash the MCP
   * child at commander argv parsing.
   */
  keepBrowserAlive?: boolean;

  /**
   * @deprecated Sapoto PRD #1045 / Tracer A2 — single-boolean alias kept for
   * one release cycle. The new surface is the decomposed flag set below
   * (`cdpStealth`, `printCapture`, `chromeRuntimeStubs`, `focusEmulation`).
   *
   *   - `stealth: true`  → equivalent to `cdpStealth: ['runtime-cycle',
   *                        'log-skip', 'worker-runtime']`. The `--stealth`
   *                        CLI flag and `PLAYWRIGHT_MCP_STEALTH=1` env var
   *                        still work through this alias.
   *   - `stealth: false` → equivalent to `cdpStealth: []`. The `--no-stealth`
   *                        CLI flag and `PLAYWRIGHT_MCP_STEALTH=0` env var
   *                        still work through this alias.
   *
   * Explicit `cdpStealth` always wins over `stealth` when both are set
   * (mirrors resolveCdpStealthAlias() precedence).
   */
  stealth?: boolean;

  /**
   * Sapoto PRD #1045 / Tracer A2 — decomposed CDP-stealth feature set. Each
   * entry maps to one specific CDP-domain mitigation that was previously
   * bundled inside the legacy `stealth: true` boolean:
   *
   *   - 'runtime-cycle'  — rapid Runtime.enable→disable cycle around context
   *                        discovery (keeps the long-lived Runtime domain
   *                        dark to page scripts after attach).
   *   - 'log-skip'       — skip Log.enable entirely.
   *   - 'worker-runtime' — apply the runtime-cycle pattern to worker targets.
   *
   * `network-skip` is intentionally NOT a valid entry — Codex P1 review on
   * PR #28 removed Network.enable gating because it broke
   * `page.on('request')` listeners. Pass it and the CLI parser throws.
   */
  cdpStealth?: string[];

  /**
   * Sapoto PRD #1045 / Tracer A2 — gates Path D `window.print` override and
   * the matching console marker bridge. Default: off (the previous-generation
   * `stealth: true` enabled it unconditionally; A2 splits it out because
   * it has measurable cost on print-heavy pages even when stealth is on).
   * A3 / A5 read this off `BrowserOptions.printCapture`.
   */
  printCapture?: boolean;

  /**
   * Sapoto PRD #1045 / Tracer A2 — gates the
   * chrome.app/chrome.csi/chrome.loadTimes/Notification.permission stubs
   * injected by `CDP_STEALTH_INIT_SCRIPT`. Default: on. Pass
   * `chromeRuntimeStubs: false` (or `--chrome-runtime-stubs=off`) to skip
   * the stubs while keeping other stealth behaviors active.
   */
  chromeRuntimeStubs?: boolean;

  /**
   * Sapoto PRD #1045 / Tracer A2 — gates the
   * `Emulation.setFocusEmulationEnabled(true)` call A1's BrowserOptions
   * routes through. Default: on. Pass `focusEmulation: false` (or
   * `--focus-emulation=off`) to fall back to OS-level focus handling.
   */
  focusEmulation?: boolean;
};
