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

// TODO(M4): re-wire to the Path D srcdoc-iframe print capture bridge when that ports in.
// For now this is functionally equivalent to browser_pdf_save: it serialises the
// current page via page.pdf() (Chromium print-to-PDF) and surfaces the buffer as a
// downloadable artefact. The downstream consumer (DiscoveryAgent path-D handler)
// expects a real window.print() event so the Electron-side capture handler can
// intercept the srcdoc-iframe print event; that bridge ports separately in M4.
const triggerPrint = defineTabTool({
  capability: 'pdf',

  schema: {
    name: 'browser_trigger_print',
    title: 'Trigger print on current page',
    description: 'Captures the current page as a PDF. Use this when a page has no downloadable PDF and you need to save the rendered content.',
    inputSchema: z.object({}),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    const data = await tab.page.pdf();
    const result = await response.resolveClientFile({ prefix: 'print', ext: 'pdf', suggestedFilename: undefined }, 'Print capture');
    await response.addFileResult(result, data);
    response.addCode(`await page.pdf(${formatObject({ path: result.relativeName })});`);
  },
});

export default [
  pdf,
  triggerPrint,
];
