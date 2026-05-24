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

import * as z from 'zod';
import { formatObject } from '@isomorphic/stringUtils';

import { defineTabTool } from './tool';

const pdfSchema = z.object({
  filename: z.string().optional().describe('File name to save the pdf to. Defaults to `page-{timestamp}.pdf` if not specified. Prefer relative file names to stay within the output directory.'),
});

const pdf = defineTabTool({
  capability: 'pdf',

  schema: {
    name: 'browser_pdf_save',
    title: 'Save as PDF',
    description: 'Save page as PDF',
    inputSchema: pdfSchema,
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const data = await tab.page.pdf();
    const result = await response.resolveClientFile({ prefix: 'page', ext: 'pdf', suggestedFilename: params.filename }, 'Page as pdf');
    await response.addFileResult(result, data);
    response.addCode(`await page.pdf(${formatObject({ path: result.relativeName })});`);
  },
});

// Path D — issue #1006. This tool invokes window.print() inside the page so the
// Sapoto stealth init script's C3/C4 deferred-print bridge (see
// stealthInitScript.ts) can intercept and route the print event to the Electron
// host via window.electronAPI.requestPrintCapture. The PDF is captured
// asynchronously on the main-process side (printCaptureHandler.ts); this tool
// only fires the in-page event and returns immediately. This is intentionally
// NOT page.pdf() — that would produce a Chromium print-to-PDF snapshot and miss
// the per-portal CSS / iframe scoping the Electron handler applies. Callers that
// just want a raw page.pdf() should use browser_pdf_save.
const triggerPrint = defineTabTool({
  capability: 'pdf',

  schema: {
    name: 'browser_trigger_print',
    title: 'Trigger print on current page',
    description: 'Calls window.print() on the current page. The Electron shell intercepts the print call and captures it as a PDF automatically. Use this instead of keyboard shortcuts when the page needs to be printed.',
    inputSchema: z.object({}),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    // Probe for the Electron-side bridge BEFORE calling window.print(): the bridge
    // (window.electronAPI.requestPrintCapture) is what intercepts the print event
    // and produces a PDF in the Electron host. Without it, window.print() either
    // pops the native OS dialog (chrome-direct, no stealth init script wired) or
    // no-ops in headless. The chrome-direct path can ALSO be served by the C4
    // stealthInitScript `[Print Capture]` marker route, but that path is wired
    // outside the page (Sapoto's printCapture.ts main-process listener) and we
    // can't detect it from here. So we report two states honestly: Electron
    // bridge present (capture is guaranteed) vs not (capture path is
    // out-of-band; result depends on whether the host wired it).
    const hasElectronBridge = await tab.page.evaluate(() => {
      const api = (window as unknown as { electronAPI?: { requestPrintCapture?: unknown } }).electronAPI;
      return typeof api?.requestPrintCapture === 'function';
    }).catch(() => false);
    await tab.page.evaluate(() => window.print());
    const message = hasElectronBridge
      ? 'Print triggered on current page. Electron bridge detected (window.electronAPI.requestPrintCapture) — the host will capture this as a PDF.'
      : 'Print triggered on current page. No Electron bridge was detected in-page; PDF capture depends on an out-of-band listener (e.g. Sapoto stealth init script + main-process printCapture handler). If neither is wired the native print dialog may appear or the call may no-op.';
    response.addTextResult(message);
    response.addCode(`await page.evaluate(() => window.print());`);
  },
});

export default [
  pdf,
  triggerPrint,
];
