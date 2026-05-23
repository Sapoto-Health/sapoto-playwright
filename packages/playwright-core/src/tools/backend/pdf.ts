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
    await tab.page.evaluate(() => window.print());
    response.addTextResult('Print triggered on current page. The system will capture it as a PDF automatically.');
    response.addCode(`await page.evaluate(() => window.print());`);
  },
});

export default [
  pdf,
  triggerPrint,
];
