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

import { Option as ProgramOption } from 'commander';
import { parseCdpStealthCLI } from '@isomorphic/cdpStealthCLIParser';
import * as mcpServer from '../utils/mcp/server';
import { commaSeparatedList, dotenvFileLoader, enumParser, headerParser, numberParser, resolutionParser, resolveCLIConfigForMCP, semicolonSeparatedList } from './config';
import { setupExitWatchdog } from './watchdog';
import { createBrowserWithInfo } from './browserFactory';
import { BrowserBackend } from '../backend/browserBackend';
import { filteredTools } from '../backend/tools';
import { testDebug } from './log';
import { packageJSON } from '../../package';

import type { Command } from 'commander';
import type { ClientInfo } from '../utils/mcp/server';
import type * as playwright from '../../..';

const version = packageJSON.version;

export function decorateMCPCommand(command: Command) {
  command
      .option('--allowed-hosts <hosts...>', 'comma-separated list of hosts this server is allowed to serve from. Defaults to the host the server is bound to. Pass \'*\' to disable the host check.', commaSeparatedList)
      .option('--allowed-origins <origins>', 'semicolon-separated list of TRUSTED origins to allow the browser to request. Default is to allow all.\nImportant: *does not* serve as a security boundary and *does not* affect redirects. ', semicolonSeparatedList)
      .option('--allowed-tools <tools>', 'comma-separated list of tool names to expose. If specified, only these tools are visible.', commaSeparatedList)
      .option('--allow-unrestricted-file-access', 'allow access to files outside of the workspace roots. Also allows unrestricted access to file:// URLs. By default access to file system is restricted to workspace root directories (or cwd if no roots are configured) only, and navigation to file:// URLs is blocked.')
      .option('--blocked-origins <origins>', 'semicolon-separated list of origins to block the browser from requesting. Blocklist is evaluated before allowlist. If used without the allowlist, requests not matching the blocklist are still allowed.\nImportant: *does not* serve as a security boundary and *does not* affect redirects.', semicolonSeparatedList)
      .option('--block-service-workers', 'block service workers')
      .option('--browser <browser>', 'browser or chrome channel to use, possible values: chrome, firefox, webkit, msedge.')
      .option('--caps <caps>', 'comma-separated list of additional capabilities to enable, possible values: vision, pdf, devtools.', commaSeparatedList)
      .option('--cdp-endpoint <endpoint>', 'CDP endpoint to connect to.')
      .option('--cdp-header <headers...>', 'CDP headers to send with the connect request, multiple can be specified.', headerParser)
      .option('--cdp-timeout <timeout>', 'timeout in milliseconds for connecting to CDP endpoint, defaults to 30000ms', numberParser)
      .option('--codegen <lang>', 'specify the language to use for code generation, possible values: "typescript", "none". Default is "typescript".', enumParser.bind(null, '--codegen', ['none', 'typescript']))
      .option('--config <path>', 'path to the configuration file.')
      .option('--console-level <level>', 'level of console messages to return: "error", "warning", "info", "debug". Each level includes the messages of more severe levels.', enumParser.bind(null, '--console-level', ['error', 'warning', 'info', 'debug']))
      .option('--device <device>', 'device to emulate, for example: "iPhone 15"')
      .option('--disable-downloads', 'disable Playwright download handling (capture stack owns downloads exclusively)')
      .option('--executable-path <path>', 'path to the browser executable.')
      .option('--extension', 'Connect to a running browser instance (Edge/Chrome only). Requires the "Playwright Extension" to be installed.')
      .option('--endpoint <endpoint>', 'Bound browser endpoint to connect to.')
      .option('--filter-internal-urls', 'filter out internal Electron tabs (file://, data:, chrome-extension://, localhost) from the tab list')
      .option('--grant-permissions <permissions...>', 'List of permissions to grant to the browser context, for example "geolocation", "clipboard-read", "clipboard-write".', commaSeparatedList)
      .option('--headless', 'run browser in headless mode, headed by default')
      .option('--host <host>', 'host to bind server to. Default is localhost. Use 0.0.0.0 to bind to all interfaces.')
      .option('--humanize-input <mode>', 'enable humanized input dispatch (bezier-curve mouse paths). Can be "on" or "off". Default is "off".', enumParser.bind(null, '--humanize-input', ['on', 'off']))
      .option('--ignore-https-errors', 'ignore https errors')
      .option('--init-page <path...>', 'path to TypeScript file to evaluate on Playwright page object')
      .option('--init-script <path...>', 'path to JavaScript file to add as an initialization script. The script will be evaluated in every page before any of the page\'s scripts. Can be specified multiple times.')
      .option('--isolated', 'keep the browser profile in memory, do not save it to disk.')
      .option('--image-responses <mode>', 'whether to send image responses to the client. Can be "allow" or "omit", Defaults to "allow".', enumParser.bind(null, '--image-responses', ['allow', 'omit']))
      .option('--keep-browser-alive', 'do not close the browser when the last tab closes. Currently a no-op against upstream (which no longer auto-closes), preserved for CLI compat with downstream embedders that manage browser lifecycle externally (e.g., Sapoto Electron/Chrome embedding) and pass this flag.')
      .option('--no-sandbox', 'disable the sandbox for all process types that are normally sandboxed.')
      .option('--output-dir <path>', 'path to the directory for output files.')
      .option('--output-mode <mode>', 'whether to save snapshots, console messages, network logs to a file or to the standard output. Can be "file" or "stdout". Default is "stdout".', enumParser.bind(null, '--output-mode', ['file', 'stdout']))
      .option('--port <port>', 'port to listen on for SSE transport.')
      .option('--proxy-bypass <bypass>', 'comma-separated domains to bypass proxy, for example ".com,chromium.org,.domain.com"')
      .option('--proxy-server <proxy>', 'specify proxy server, for example "http://myproxy:3128" or "socks5://myproxy:8080"')
      .option('--remote-header <headers...>', 'headers to send with the remote endpoint connect request, multiple can be specified.', headerParser)
      .option('--sandbox', 'enable the sandbox for all process types that are normally not sandboxed.')
      .option('--save-session', 'Whether to save the Playwright MCP session into the output directory.')
      .option('--secrets <path>', 'path to a file containing secrets in the dotenv format', dotenvFileLoader)
      .option('--shared-browser-context', 'reuse the same browser context between all connected HTTP clients.')
      .option('--snapshot-mode <mode>', 'when taking snapshots for responses, specifies the mode to use. Can be "full" or "none". Default is "full".')
      .option('--storage-state <path>', 'path to the storage state file for isolated sessions.')
      .option('--suppress-focus', 'suppress focus-stealing: skip bringToFront during tab selection (paired stealth init script is applied separately)')
      // PRD #1045 / Tracer A2 — decomposed CDP-stealth flag surface. See
      // packages/isomorphic/cdpStealthCLIParser.ts for the per-feature
      // rationale and the rejection of `network-skip`.
      .option('--cdp-stealth <list>', 'comma-separated list of CDP-stealth features to enable. Allowed values: "runtime-cycle", "log-skip", "worker-runtime", "all" (= all three), or empty (= none). Replaces the legacy --stealth/--no-stealth boolean; those remain as one-cycle aliases for "all" / empty.', parseCdpStealthCLI)
      .option('--print-capture', 'enable the deferred window.print override and the matching console-marker bridge (Path D). Default: off.')
      .option('--focus-emulation <mode>', 'gate Emulation.setFocusEmulationEnabled(true). Can be "on" or "off". Default is "on".', enumParser.bind(null, '--focus-emulation', ['on', 'off']))
      // PRD #1045 / Tracer A2 — legacy boolean alias kept for one release
      // cycle. We declare both `--stealth` and `--no-stealth` as separate
      // options (not commander's `--no-X` convention, which would block
      // direct registration of the positive form) and reconcile them in
      // the .action normalization step below.
      //
      // Three input states (commander folds both flags onto `options.stealth`
      // because they're declared as a positive `--stealth` + a `--no-stealth`
      // pair; commander uses `--no-<X>` as the negation of <X>, so the parsed
      // shape is the single tri-state field below, not a separate `noStealth`):
      //   - --stealth passed       → options.stealth === true   (force-on)
      //   - --no-stealth passed    → options.stealth === false  (force-off)
      //   - neither passed         → options.stealth === undefined (no override)
      //
      // resolveStealthAlias() expands the boolean into a cdpStealth wire
      // payload. `--cdp-stealth=...` takes precedence over both aliases.
      .option('--stealth', '[deprecated] alias for --cdp-stealth=all. Kept for one release cycle. The stealth bundle minimizes the CDP-domain footprint and pairs with the init script that masks navigator.webdriver, chrome.app/csi/loadTimes, UA brand hints, and Notification.permission to evade bot detection (DataDome, Akamai, Cloudflare Turnstile).')
      .option('--no-stealth', '[deprecated] alias for --cdp-stealth= (no features). Kept for one release cycle.')
      .option('--test-id-attribute <attribute>', 'specify the attribute to use for test ids, defaults to "data-testid"')
      .option('--timeout-action <timeout>', 'specify action timeout in milliseconds, defaults to 5000ms', numberParser)
      .option('--timeout-download <timeout>', 'specify download completion timeout in milliseconds, defaults to 30000ms', numberParser)
      .option('--timeout-navigation <timeout>', 'specify navigation timeout in milliseconds, defaults to 60000ms', numberParser)
      .option('--user-agent <ua string>', 'specify user agent string')
      .option('--user-data-dir <path>', 'path to the user data directory. If not specified, a temporary directory will be created.')
      .option('--viewport-size <size>', 'specify browser viewport size in pixels, for example "1280x720"', resolutionParser.bind(null, '--viewport-size'))
      .addOption(new ProgramOption('--vision', 'Legacy option, use --caps=vision instead').hideHelp())
      .action(async options => {

        // normalize the --no-sandbox option: sandbox = true => nothing was passed, sandbox = false => --no-sandbox was passed.
        options.sandbox = options.sandbox === true ? undefined : false;

        // normalize --humanize-input=on|off: 'on' => true, 'off' => false, undefined => undefined.
        // Leaving the undefined case undefined lets env/config-file values flow through; the
        // previous shape collapsed it to `false`, silently stomping an env/config `true`.
        options.humanizeInput = options.humanizeInput === undefined ? undefined : ((options.humanizeInput as unknown as string) === 'on');

        // PRD #1045 / Tracer A2 — normalize the legacy --stealth / --no-stealth
        // boolean aliases. Both flags are declared above and commander folds
        // them onto the single `options.stealth` tri-state (its `--no-<X>`
        // convention is the negation of `--<X>`), so the parser reports three
        // input states cleanly:
        //   - options.stealth === true  → user passed `--stealth` (explicit on).
        //                                 resolveStealthAlias() expands this
        //                                 to the full 3-feature bundle.
        //   - options.stealth === false → user passed `--no-stealth` (explicit
        //                                 off). resolveStealthAlias() expands
        //                                 this to `cdpStealth: []`.
        //   - options.stealth === undefined → neither passed. No emit; env /
        //                                 config-file values flow through merge.
        // No normalization needed — commander already produces the right shape.

        // normalize --focus-emulation enum to boolean.
        // Same pattern as --humanize-input above: emit only when defined so
        // env / config-file defaults survive merge. PRD #1045 / Tracer A2.
        options.focusEmulation = options.focusEmulation === undefined ? undefined : ((options.focusEmulation as unknown as string) === 'on');

        setupExitWatchdog();

        if (options.vision) {
          // eslint-disable-next-line no-console
          console.error('The --vision option is deprecated, use --caps=vision instead');
          options.caps = 'vision';
        }

        if (options.caps?.includes('tracing'))
          options.caps.push('devtools');

        const config = await resolveCLIConfigForMCP(options);
        const tools = filteredTools(config);
        const useSharedBrowser = config.sharedBrowserContext || config.browser.isolated;
        let sharedBrowserPromise: Promise<playwright.Browser> | undefined;
        let clientCount = 0;
        const clientNameCounters = new Map<string, number>();

        const factory: mcpServer.ServerBackendFactory = {
          name: 'Playwright',
          nameInConfig: 'playwright',
          version,
          toolSchemas: tools.map(tool => tool.schema),
          create: async (clientInfo: ClientInfo) => {
            if (useSharedBrowser && !sharedBrowserPromise) {
              sharedBrowserPromise = (async () => {
                const { browser, canBind } = await createBrowserWithInfo(config, clientInfo, options);
                if (canBind)
                  await browser.bind(clientInfo.clientName, { workspaceDir: clientInfo.cwd });
                return browser;
              })().catch(error => {
                sharedBrowserPromise = undefined;
                throw error;
              });
            }
            clientCount++;
            const { browser, canBind } = sharedBrowserPromise ? { browser: await sharedBrowserPromise, canBind: false } : await createBrowserWithInfo(config, clientInfo, options);
            if (canBind) {
              const count = (clientNameCounters.get(clientInfo.clientName) ?? 0) + 1;
              clientNameCounters.set(clientInfo.clientName, count);
              const sessionName = count > 1 ? `${clientInfo.clientName} (${count})` : clientInfo.clientName;
              await browser.bind(sessionName, { workspaceDir: clientInfo.cwd });
            }
            const browserContext = config.browser.isolated ? await browser.newContext(config.browser.contextOptions) : browser.contexts()[0];
            return new BrowserBackend(config, browserContext, tools);
          },
          disposed: async backend => {
            clientCount--;
            if (sharedBrowserPromise && clientCount > 0)
              return;

            testDebug('close browser');
            sharedBrowserPromise = undefined;
            const browserContext = (backend as BrowserBackend).browserContext;
            await browserContext.close().catch(() => { });
            await browserContext.browser()!.close().catch(() => { });
          }
        };
        await mcpServer.start(factory, config.server);
      });
}
