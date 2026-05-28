# sapoto-playwright

Fork of [microsoft/playwright](https://github.com/microsoft/playwright) maintained by Sapoto. The fork adds stealth and anti-detection capabilities for automating headed Chrome against financial portals protected by anti-bot systems (Cloudflare, DataDome, Akamai, etc.).

**Governing document: [`docs/stealth-principles.md`](docs/stealth-principles.md)** — read before any stealth-related work.

## Fork Architecture

```
upstream/main (microsoft/playwright)
     │
     └──► origin/main (Sapoto fork — 29 commits ahead)
              │
              ├── Launch-level stealth (Green)
              │     chromiumSwitches.ts — flag removal
              │     crUtilityWorldName.ts — randomized world names
              │
              ├── CDP-level stealth (Yellow)
              │     cdpStealthGates.ts — per-feature kill switches
              │     crPage.ts — Runtime cycling, Log skip, UA-CH
              │     crServiceWorker.ts — worker stealth
              │     chromeUaBrands.ts — UA-CH brand builder
              │
              ├── JS-level patches (Red — last resort)
              │     stealthInitScript.ts — 740 LOC, gated sections
              │
              ├── MCP extensions
              │     context.ts — stealth injection + focus shim
              │     config.ts / program.ts — CLI flags
              │     pdf.ts, screenshot.ts, pmAutofillPreflight.ts
              │
              └── Input humanization
                    bezierInput.ts — Bézier mouse paths
                    crInput.ts — sequential click events
```

### Stealth Risk Tiers (from stealth-principles.md §5)

| Tier | What | Rule |
|------|------|------|
| **Green** — Launch-level | Chrome flags, switches, profile config | Preferred. Must match stock Chrome behavior. |
| **Yellow** — CDP-level | Runtime cycling, Log skip, UA-CH override, gate changes | Caution. Version-test against target Chromium. |
| **Red** — JS patches | `stealthInitScript.ts`, any main-world mutation | Last resort. Must be gated, portal-scoped, and justified. |

**When adding or modifying stealth features, classify the change by tier and follow the corresponding guidance in `docs/stealth-principles.md`.**

## Monorepo Packages

| Package | npm name | Purpose |
|---------|----------|---------|
| `playwright-core` | `playwright-core` | Browser automation engine: client, server, dispatchers, protocol |
| `playwright` | `playwright` | Test runner + browser automation (public package) |
| `playwright-test` | `@playwright/test` | Test runner entry point |
| `playwright-client` | `@playwright/client` | Standalone client package |
| `protocol` | *(internal)* | RPC protocol definitions (`protocol.yml` → generated `channels.d.ts`) |

### Browser Packages

`playwright-chromium`, `playwright-firefox`, `playwright-webkit` — per-browser distributions.
`playwright-browser-chromium`, `playwright-browser-firefox`, `playwright-browser-webkit` — binary packages.

### Tooling Packages

| Package | Purpose |
|---------|---------|
| `html-reporter` | HTML test report viewer |
| `trace-viewer` | Trace viewer UI |
| `recorder` | Test recorder |
| `web` | Shared web UI components |
| `injected` | Scripts injected into browser pages |

### Component Testing

`playwright-ct-core`, `playwright-ct-react`, `playwright-ct-vue`

### Key Directories

| Directory | Purpose |
|-----------|---------|
| `tests/` | All test suites (page, library, playwright-test, mcp, components, etc.) |
| `docs/src/` | API documentation — **source of truth** for public TypeScript types |
| `docs/src/api/` | Per-class API reference (`class-page.md`, `class-locator.md`, etc.) |
| `docs/stealth-principles.md` | Anti-detection design principles (Sapoto fork) |
| `utils/` | Build scripts, code generation, linting, doc tools |
| `browser_patches/` | Browser engine patches |

## Sapoto-Specific Key Files

| File | Role |
|------|------|
| `packages/playwright-core/src/server/chromium/cdpStealthGates.ts` | Per-feature kill switches (runtime-cycle, log-skip, ua-brands, webdriver-delete, etc.) |
| `packages/playwright-core/src/server/chromium/crPage.ts` | CDP orchestration: Runtime enable/disable, Log skip, UA-CH, utility world |
| `packages/playwright-core/src/server/chromium/crServiceWorker.ts` | Worker stealth gates |
| `packages/playwright-core/src/server/chromium/chromiumSwitches.ts` | Launch flag removal |
| `packages/playwright-core/src/server/chromium/chromeUaBrands.ts` | UA-CH brand list builder |
| `packages/playwright-core/src/server/chromium/crUtilityWorldName.ts` | Opaque 16-char hex world names |
| `packages/playwright-core/src/tools/backend/stealthInitScript.ts` | Main-world JS patches (gated sections) |
| `packages/playwright-core/src/tools/backend/context.ts` | MCP context: stealth injection, focus shim, background-open |
| `packages/playwright-core/src/server/cdpStealth.ts` | CDP stealth coordination module |
| `packages/isomorphic/cdpStealthCLIParser.ts` | CLI flag parsing for `--cdp-stealth` |
| `packages/isomorphic/cdpStealthAlias.ts` | Gate alias resolution |
| `packages/playwright-core/src/server/chromium/bezierInput.ts` | Humanized Bézier mouse paths |
| `packages/playwright-core/src/tools/backend/pmAutofillPreflight.ts` | Password manager autofill preflight |

## Build

```bash
npm run build       # Full build
npm run watch       # Watch mode (recommended during development)
```

Assume watch is running and code is up to date. Generated files (types, channels, validators) are produced by watch automatically.

## Lint and type check

```bash
npm run flint
```

Runs all lint checks in parallel: eslint, tsc, doclint, check-deps, generate_channels, generate_types, lint-tests, test-types, lint-packages, code-snippet linting.

**Always run `flint` before committing.** Do not use `tsc --noEmit` or individual lint commands separately.

## Test Commands

| Command | Scope |
|---------|-------|
| `npm run ctest <filter>` | Chromium only library tests — **use during development** |
| `npm run test <filter> -- --project=<chromium,firefox,webkit>` | All library / per project |
| `npm run ttest <filter>` | Test runner (`tests/playwright-test/`) |
| `npm run ctest-mcp <filter>` | Chromium only MCP tools (`tests/mcp/`) |
| `npm run test-mcp <filter> -- --project=<chromium,firefox,webkit>` | MCP tools (`tests/mcp/`) |


### Filtering

```bash
npm run ctest tests/page/locator-click.spec.ts         # Specific file
npm run ctest tests/page/locator-click.spec.ts:12      # Specific location
npm run ctest -- --grep "should click"                 # By test name
npm run ctest-mcp snapshot                             # By file name part
```

### Test Directories and Fixtures

| Directory | Import | Key Fixtures | What to Test |
|-----------|--------|--------------|--------------|
| `tests/page/` | `import { test, expect } from './pageTest'` | `page`, `server`, `browserName` | User interactions: click, fill, navigate, locators, assertions |
| `tests/library/` | `import { browserTest, expect } from '../config/browserTest'` | `browser`, `context`, `browserType` | Browser/context lifecycle, cookies, permissions, browser-specific features |
| `tests/playwright-test/` | `import { test, expect } from './playwright-test-fixtures'` | test runner fixtures | Test runner: reporters, config, annotations, retries |
| `tests/mcp/` | `import { test, expect } from './fixtures'` | `client`, `server` | MCP tools via `client.callTool()` |

**Decision rule**: Does the test need `browser`/`browserType`/`context` → `tests/library/`. Just needs `page` + `server` → `tests/page/`.

### Stealth Tests (Sapoto)

| Test file | What it validates |
|-----------|-------------------|
| `tests/library/cdp-stealth-gates.spec.ts` | Gate enable/disable behavior, per-feature isolation |
| `tests/library/cdp-stealth-options.spec.ts` | CLI option parsing and propagation |
| `tests/library/stealth-stubs.spec.ts` | No Playwright globals leaked, stub correctness |
| `tests/library/utility-world-name.spec.ts` | World name randomization, no framework name leak |
| `tests/library/utility-world-name-leak.spec.ts` | Cross-frame world name isolation |
| `tests/library/focus-shim-c5.spec.ts` | FocusShim regression (18 scenarios) |
| `tests/library/srcdoc-print-bridge.spec.ts` | Print bridge via srcdoc iframe |
| `tests/library/bezier-input.spec.ts` | Humanized mouse path generation |
| `tests/library/humanize-input-channel.spec.ts` | Input humanization channel propagation |
| `tests/library/mcp-cli-flag-surface.spec.ts` | CLI flag surface for `--cdp-stealth` |
| `tests/mcp/pm-autofill-preflight.spec.ts` | Password manager autofill detection |

**Stealth test philosophy (from `docs/stealth-principles.md` §7):** Tests must prove the fork is indistinguishable from stock Chrome, not merely that patches applied their values. Always test cross-surface consistency (main frame, iframe, popup, worker).

## DEPS System

Import boundaries are enforced via `DEPS.list` files (52+ across the repo), checked by `npm run flint`.

**Key rule**: Client code NEVER imports server code. Server code NEVER imports client code. Communication is only through the protocol.
When creating or moving files, update the relevant `DEPS.list` to declare allowed imports. Files marked `"strict"` can only import what is explicitly listed.

## Coding Convention

For exported classes:
- `private _method()` — only used within the class itself
- `_method()` (no `private`) — used by other code in the same file, but not outside the file
- `method()` (public) — used in other files

Non-exported classes have no naming convention; they are internal implementation details.

## Commit Convention

Before committing, run `npm run flint` and fix errors.

Semantic commit messages: `label(scope): description`

Labels: `fix`, `feat`, `chore`, `docs`, `test`, `devops`

```bash
git checkout -b fix-39562
# ... make changes ...
git add <changed-files>
git commit -m "$(cat <<'EOF'
fix(proxy): handle SOCKS proxy authentication

Fixes: https://github.com/microsoft/playwright/issues/39562
EOF
)"
# **Never `git push` without an explicit instruction to push.**
git push origin fix-39562
gh pr create --repo Sapoto-Health/sapoto-playwright --head fix-39562 \
  --title "fix(proxy): handle SOCKS proxy authentication" \
  --body "$(cat <<'EOF'
## Summary
- <describe the change very! briefly>

Fixes https://github.com/microsoft/playwright/issues/39562
EOF
)"
```

Never add Co-Authored-By agents in commit message.
Never add "Generated with" in commit message.
Never add test plan to PR description. Keep PR description short — a few bullet points at most.
Branch naming for issue fixes: `fix-<issue-number>`

**Never amend commits.** Always create a new commit for follow-up changes, even when iterating on an open PR. Amending rewrites history and forces a force-push, losing the incremental review trail. Only amend if the user explicitly says so.

**Never `git push` without an explicit instruction to push.** Applies even when a PR is already open for the branch — additional commits are immediately visible to reviewers. Commit locally, report what was committed, and wait. Only push when the user's message contains "push", "upload", "create PR", "ship it", or equivalent.

**PRs always target `Sapoto-Health/sapoto-playwright`** — always pass `--repo Sapoto-Health/sapoto-playwright` to `gh pr create`. The fork has both `origin` (Sapoto) and `upstream` (microsoft) remotes; omitting `--repo` may target the wrong repository.

## Stealth Development Rules

1. **Read `docs/stealth-principles.md` before any stealth work.** It is the governing document.
2. **Classify every change by risk tier** (Green/Yellow/Red). State the tier in the commit message scope, e.g., `feat(stealth-green): ...`, `fix(stealth-red): ...`.
3. **Every new stealth feature must have a gate** in `cdpStealthGates.ts`. No ungated stealth code.
4. **Burden of proof is on the patch.** A new JS-level (Red) patch must document: what portal breaks without it, why a Green or Yellow approach won't work, and what detection surface the patch creates.
5. **No `Function.prototype.toString` patches** unless all alternatives are exhausted and the patch is gated.
6. **No console bridges** for automation control except portal-scoped operational needs.
7. **Cross-surface consistency is mandatory.** A change to main-frame behavior must also cover iframes, popups, workers, and service workers where applicable.
8. **UA-CH is correlated metadata.** Never override a single field; ensure UA string, `sec-ch-ua-*`, `navigator.userAgentData`, platform, `Accept-Language`, and locale all agree.
9. **Tests compare against stock Chrome**, not hardcoded expected values. See §7 of the principles doc.

## Development Guides

Detailed guides for common development tasks:

- **[Architecture: Client, Server, and Dispatchers](.claude/skills/playwright-dev/library.md)** — package layout, protocol layer, ChannelOwner/SdkObject/Dispatcher base classes, DEPS rules, end-to-end RPC flow, object lifecycle
- **[Adding and Modifying APIs](.claude/skills/playwright-dev/api.md)** — 6-step process: define docs → implement client → define protocol → implement dispatcher → implement server → write tests
- **[MCP Tools and CLI Commands](.claude/skills/playwright-dev/tools.md)** — `defineTool()`/`defineTabTool()`, tool capabilities, CLI `declareCommand()`, config options, testing with MCP fixtures
- **[Vendoring Dependencies](.claude/skills/playwright-dev/vendor.md)** — bundle architecture, esbuild setup, typed wrappers, adding deps to existing bundles
- **[Stealth Principles](docs/stealth-principles.md)** — anti-detection design principles, threat model, CDP risks, risk classification, implementation checklist, testing philosophy
