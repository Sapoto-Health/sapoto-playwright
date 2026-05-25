# Sapoto manual portal smoke protocol

Links:

- PRD: [#1087 Standalone Sapoto Playwright Chrome runtime](https://github.com/Sapoto-Health/automatic-document-fetcher/issues/1087)
- Tracer: [#1096 Create manual portal smoke protocol for standalone runtime](https://github.com/Sapoto-Health/automatic-document-fetcher/issues/1096)
- Runtime baseline: [#1088 Build standalone Sapoto Chrome launch and profile baseline](https://github.com/Sapoto-Health/automatic-document-fetcher/issues/1088)
- Action/perception harness: [#1089 Add Sapoto-like action and perception harness](https://github.com/Sapoto-Health/automatic-document-fetcher/issues/1089)
- Download runtime: [#1090 Build raw-CDP Chrome download runtime](https://github.com/Sapoto-Health/automatic-document-fetcher/issues/1090)
- Fetch fallback: [#1091 Add scoped Fetch body capture fallback](https://github.com/Sapoto-Health/automatic-document-fetcher/issues/1091)
- Print/viewer capture: [#1092 Add host-owned print and viewer PDF capture](https://github.com/Sapoto-Health/automatic-document-fetcher/issues/1092)
- Popup/background-open fallback: [#1093 Handle popup and background-open paths with host-owned fallbacks](https://github.com/Sapoto-Health/automatic-document-fetcher/issues/1093)
- Strict policy: [#1094 Define strict runtime policy and portal-scoped fallbacks](https://github.com/Sapoto-Health/automatic-document-fetcher/issues/1094)
- Anti-detect diagnostics: [#1095 Add public anti-detect diagnostic smoke tests](https://github.com/Sapoto-Health/automatic-document-fetcher/issues/1095)

This protocol is for later human-in-the-loop validation against real financial portals. It is a checklist and result template, not an automated portal scraper. Results must avoid credentials, account numbers, patient/member data, document contents, and screenshots containing sensitive content.

## Scope

Sample these portal document patterns when a portal naturally provides them:

- Direct PDF navigation.
- Attachment download.
- Blob or XHR-backed download.
- Popup document or background-open document.
- Print page, print dialog path, or embedded viewer page.

Record functional success separately from anti-detect observations. A document capture can succeed while anti-detect observations remain concerning, and a clean anti-detect observation does not prove document capture coverage.

## Pre-run checklist

- [ ] Tester has authorization to access the portal and account.
- [ ] Test account contains no production-sensitive content, or sensitive content can be redacted before any artifact is retained.
- [ ] Browser profile is Sapoto-created and not the tester's daily Chrome profile.
- [ ] Runtime uses an explicit nonzero CDP port.
- [ ] Strict runtime policy is the starting mode.
- [ ] Portal-scoped fallback flags are enabled only after a strict-mode attempt records the gap.
- [ ] Artifact directory is local and access-controlled.
- [ ] Raw credentials, cookies, tokens, account identifiers, and document contents will not be pasted into this result.

## Capability fields

For each pattern, record whether these capabilities were required:

- Browser events: Chrome `Browser.downloadWillBegin` and `Browser.downloadProgress`, with filesystem confirmation.
- Fetch body capture: scoped fallback for HTTP-backed document bodies.
- Target events: popup/background-open observation through CDP Target events.
- Isolated-world bridge: portal-scoped bridge that avoids main-world page visibility where possible.
- Main-world bridge: last-resort portal-scoped shim visible to page scripts.
- Console marker bridge: last-resort portal-scoped marker path.
- Auto-print capture: portal-scoped print fallback, not the default path.
- Manual intervention: human click, MFA, account selection, or other non-automated step.

## Pattern checklist

### Direct PDF navigation

- [ ] Portal exposes a link or button that navigates the current tab directly to a PDF.
- [ ] Sapoto action path can reach the control.
- [ ] Capture succeeded.
- [ ] Browser events used.
- [ ] Fetch body capture used.
- [ ] Viewer or PDF plugin behavior observed.
- [ ] Sensitive PDF contents excluded from retained artifacts.

### Attachment download

- [ ] Portal returns `Content-Disposition: attachment` or equivalent browser download behavior.
- [ ] Capture succeeded.
- [ ] Suggested filename recorded if non-sensitive.
- [ ] Browser events used.
- [ ] Filesystem confirmation used.
- [ ] Fetch body capture used.
- [ ] Sensitive downloaded file deleted or stored only in approved secure location.

### Blob or XHR-backed download

- [ ] Portal builds the document from XHR, fetch, blob URL, data URL, or client-side object URL.
- [ ] Capture succeeded.
- [ ] Browser events used.
- [ ] Fetch body capture used.
- [ ] Isolated-world bridge used.
- [ ] Main-world bridge used.
- [ ] The minimum required fallback was identified.

### Popup document

- [ ] Portal opens a document in a new tab, popup, or background target.
- [ ] Capture succeeded.
- [ ] Target events used.
- [ ] Host-owned planned open used.
- [ ] Isolated-world bridge used.
- [ ] Main-world bridge used.
- [ ] Popup blocker or user gesture requirement observed.

### Print or viewer page

- [ ] Portal shows a print page, browser PDF viewer, embedded viewer, or print dialog path.
- [ ] Explicit `Page.printToPDF` capture succeeded.
- [ ] Auto-print capture used.
- [ ] Console marker bridge used.
- [ ] Browser events used.
- [ ] Sensitive viewer content excluded from retained artifacts.

## Result template

```markdown
# Sapoto portal smoke result

- PRD: https://github.com/Sapoto-Health/automatic-document-fetcher/issues/1087
- Tracer: https://github.com/Sapoto-Health/automatic-document-fetcher/issues/1096
- Related tracers:
  - Runtime/profile #1088:
  - Actions #1089:
  - Downloads #1090:
  - Fetch fallback #1091:
  - Print/viewer #1092:
  - Popup/background-open #1093:
  - Strict policy #1094:
  - Anti-detect #1095:
- Date:
- Tester:
- Portal alias:
- Portal URL class: login | document list | statement | claim | other
- Playwright commit:
- Chrome version:
- OS:
- Runtime mode:
- Profile type: fresh | persisted
- Artifact directory:

## Sensitive-data handling

- Credentials stored in result: NO
- Cookies/tokens stored in result: NO
- Raw account identifiers stored in result: NO
- Raw document contents stored in result: NO
- Screenshots reviewed/redacted:
- Downloaded files deleted or secured:

## Runtime policy

- Strict mode attempted first:
- Enabled fallback flags:
- Reason each fallback was enabled:
- `navigator.webdriver` observation:
- Visible WebDriver labels:
- Visible CDP/DevTools labels:
- Visible headless labels:
- Visible bot/automation labels:
- Anti-detect result: PASS | FAIL | OBSERVATION

## Functional matrix

| Pattern | Present | Captured | Browser events | Fetch | Target | Isolated bridge | Main bridge | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Direct PDF |  |  |  |  |  |  |  |  |
| Attachment |  |  |  |  |  |  |  |  |
| Blob/XHR |  |  |  |  |  |  |  |  |
| Popup |  |  |  |  |  |  |  |  |
| Print/viewer |  |  |  |  |  |  |  |  |

## Fallback findings

- Browser events sufficient for:
- Fetch body capture required for:
- Target events required for:
- Isolated-world bridge required for:
- Main-world bridge required for:
- Console marker bridge required for:
- Auto-print capture required for:
- Manual intervention required for:

## Failures and follow-up

- Functional failures:
- Anti-detect concerns:
- New local fixture needed:
- New tracer issue:
- Portal-specific configuration needed:
```

## Interpretation rules

- Start strict, then enable the narrowest portal-scoped fallback that can explain the failure.
- Record the first capability that made the flow work. Do not keep enabling fallbacks after success unless the run is explicitly comparing fallback behavior.
- Do not retain raw portal content to prove success. Prefer metadata such as non-sensitive filename shape, MIME type, byte length, PDF header/EOF confirmation, and redacted screenshots.
- Keep portal observations out of deterministic CI. Promote only reduced local fixtures into automated tests.
- Link every follow-up to the PRD and the closest tracer issue so future patch decisions stay evidence-backed.
