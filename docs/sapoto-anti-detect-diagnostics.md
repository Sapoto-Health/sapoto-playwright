# Sapoto anti-detect diagnostics protocol

Links:

- PRD: [#1087 Standalone Sapoto Playwright Chrome runtime](https://github.com/Sapoto-Health/automatic-document-fetcher/issues/1087)
- Tracer: [#1095 Add public anti-detect diagnostic smoke tests](https://github.com/Sapoto-Health/automatic-document-fetcher/issues/1095)
- Runtime baseline: [#1088 Build standalone Sapoto Chrome launch and profile baseline](https://github.com/Sapoto-Health/automatic-document-fetcher/issues/1088)
- Action/perception harness: [#1089 Add Sapoto-like action and perception harness](https://github.com/Sapoto-Health/automatic-document-fetcher/issues/1089)
- Strict policy: [#1094 Define strict runtime policy and portal-scoped fallbacks](https://github.com/Sapoto-Health/automatic-document-fetcher/issues/1094)

This protocol records public anti-detect diagnostics for the standalone Sapoto Chrome runtime. The diagnostics are smoke signals only. They do not prove real portal success, and they must not attempt to bypass access controls, solve CAPTCHAs, submit challenges, enter credentials, or create accounts.

## Scope

Run the diagnostics only as an explicit manual or opt-in local probe. Do not add network-dependent CI tests against public anti-detect sites.

Required public diagnostics:

- CreepJS: `https://abrahamjuliot.github.io/creepjs/`
- BrowserScan: `https://www.browserscan.net/`

Optional observation:

- Cloudflare Turnstile demo linked from the official Cloudflare Turnstile tutorials page at `https://developers.cloudflare.com/turnstile/tutorials/`. Open the demo, observe the widget/challenge state, and do not click, solve, submit, or extract tokens.

Required local regression check:

- Launch the Sapoto runtime with an explicit nonzero `--remote-debugging-port=<port>`.
- Confirm `navigator.webdriver` is not `true` on a normal HTTP page.
- Confirm the Chrome command line does not include `--remote-debugging-port=0` or `--enable-automation`.

## Setup

Use a fresh Sapoto-created persistent profile for each run unless the purpose is profile persistence analysis.

Record:

- Date and time.
- Playwright commit SHA.
- Chrome or Chromium channel and version.
- OS version.
- Runtime mode: headed or headless.
- CDP port mode: explicit nonzero port.
- Sapoto runtime policy flags enabled.
- Network context at a high level, such as office, home, VPN, proxy, or CI-like host. Do not store IP addresses unless the result already exposes them in a screenshot that is approved for retention.

## Diagnostic steps

### 1. Local explicit-CDP-port check

1. Start the Sapoto runtime with default strict settings.
2. Navigate to a local fixture page, not a public site.
3. Evaluate `navigator.webdriver`.
4. Navigate to `chrome://version`.
5. Record the command line evidence.

Expected regression result:

- `navigator.webdriver` is `false` or otherwise not `true`.
- The command line contains `--remote-debugging-port=<nonzero port>`.
- The command line does not contain `--remote-debugging-port=0`.
- The command line does not contain `--enable-automation`.

### 2. CreepJS read-only observation

1. Navigate to CreepJS.
2. Wait for the primary report to stabilize.
3. Capture a screenshot of the visible report.
4. Extract visible text if available without enabling unsafe page bridges.
5. Record any visible labels that mention WebDriver, automation, CDP, DevTools, headless, bot, phantom, selenium, Playwright, or inconsistent browser state.
6. Do not modify page state beyond normal navigation and screenshot/text observation.

### 3. BrowserScan read-only observation

1. Navigate to BrowserScan.
2. If the page has a passive start button, record whether it was clicked. Do not click any flow that asks for verification, login, downloads, clipboard, notification, payment, or account actions.
3. Capture a screenshot of the visible report.
4. Extract visible text if available without enabling unsafe page bridges.
5. Record any visible labels that mention WebDriver, automation, CDP, DevTools, headless, bot, proxy inconsistency, browser inconsistency, or risk score changes.

### 4. Optional Cloudflare Turnstile observation

1. Open the official Cloudflare Turnstile documentation page and follow its linked demo page.
2. Capture a screenshot of the initial widget or challenge state.
3. Record visible status text only.
4. Do not click the widget, solve a challenge, submit a form, extract a token, replay a token, or automate challenge behavior.

## Artifacts

Store artifacts under a run-specific directory outside committed source, for example:

```text
test-results/sapoto-anti-detect/<yyyy-mm-dd>-<short-sha>/
```

Recommended artifact names:

- `run-metadata.json`
- `local-webdriver-check.json`
- `chrome-version-command-line.txt`
- `creepjs-visible-text.txt`
- `creepjs.png`
- `browserscan-visible-text.txt`
- `browserscan.png`
- `turnstile-visible-text.txt`
- `turnstile.png`
- `observations.md`

Do not commit screenshots or raw public-site reports unless the team has reviewed them for IP addresses, location, account identifiers, or other sensitive content.

## Result template

```markdown
# Sapoto anti-detect diagnostic result

- PRD: https://github.com/Sapoto-Health/automatic-document-fetcher/issues/1087
- Tracer: https://github.com/Sapoto-Health/automatic-document-fetcher/issues/1095
- Date:
- Playwright commit:
- Chrome version:
- OS:
- Runtime mode:
- Sapoto policy flags:
- Artifact directory:

## Local explicit-CDP-port check

- navigator.webdriver:
- Explicit CDP port present:
- remote-debugging-port=0 absent:
- enable-automation absent:
- Result: PASS | FAIL | OBSERVATION

## CreepJS

- Page loaded:
- Screenshot artifact:
- Visible text artifact:
- WebDriver labels:
- CDP/DevTools labels:
- Headless labels:
- Bot/automation labels:
- Other notable labels:
- Result: OBSERVATION

## BrowserScan

- Page loaded:
- Screenshot artifact:
- Visible text artifact:
- WebDriver labels:
- CDP/DevTools labels:
- Headless labels:
- Bot/automation labels:
- Risk score or visible status:
- Other notable labels:
- Result: OBSERVATION

## Optional Turnstile

- Official docs page opened:
- Demo URL:
- Screenshot artifact:
- Visible state:
- Any click/solve/submit performed: NO
- Result: OBSERVATION

## Decision notes

- Regression suspected:
- Follow-up issue:
- Production portal inference allowed: NO
```

## Interpretation rules

- A failed local explicit-CDP-port check is a blocker for the Sapoto runtime baseline.
- A public diagnostic label is a regression signal, not proof that a portal will fail.
- A clean public diagnostic report is not proof that a portal will succeed.
- Anti-detect observations must be recorded separately from functional download, popup, or print success.
- Any proposed stealth patch needs a local fixture or probe proving the behavior it changes.
