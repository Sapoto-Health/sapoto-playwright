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

/**
 * MCP tool: browser_wait_for_pm_autofill
 *
 * Wraps the PM autofill preflight ladder so the LoginAgent can call it as a
 * single tool invocation.  Returns a structured result describing which rung
 * succeeded (or why it gave up).
 */

import * as z from 'zod';
import { defineTabTool } from './tool';
import { runPmAutofillPreflight } from './pmAutofillPreflight';

const waitForPmAutofill = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_wait_for_pm_autofill',
    title: 'Wait for password manager autofill',
    description: [
      'Runs a three-rung preflight ladder that waits for a password manager to',
      'autofill the current login form.',
      'Rung 1 (baseline): polls up to budgetMs.baseline ms without any intervention.',
      'Rung 2 (refresh):  reloads the page and polls again.',
      'Rung 3 (focus-click): clicks the username field to trigger PM injection.',
      'Returns filled/empty/no-form plus which technique worked.',
    ].join(' '),
    inputSchema: z.object({
      usernameSelector: z.string().optional().describe(
          'CSS selector for the username field (used in rung 3 focus-click). ' +
        'Omit to skip rung 3.'
      ),
      baselineBudgetMs: z.number().optional().describe(
          'Milliseconds to poll before any intervention (default 5000).'
      ),
      refreshBudgetMs: z.number().optional().describe(
          'Milliseconds to poll after page reload (default 5000).'
      ),
      focusClickBudgetMs: z.number().optional().describe(
          'Milliseconds to poll after username focus-click (default 3000).'
      ),
    }),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    const budgetMs = {
      baseline: params.baselineBudgetMs ?? 5000,
      refresh: params.refreshBudgetMs ?? 5000,
      focusClick: params.focusClickBudgetMs ?? 3000,
      noFormWait: 3000,
    };

    const result = await runPmAutofillPreflight({
      page: tab.page,
      usernameSelector: params.usernameSelector,
      budgetMs,
    });

    if (result.status === 'filled') {
      response.addTextResult(
          `PM autofill detected via "${result.technique}". ` +
        `username=${result.hasUsername}, password=${result.hasPassword}.`
      );
    } else if (result.status === 'empty') {
      response.addTextResult(
          `PM autofill not detected after all rungs (${result.triedTechniques.join(', ')}). ` +
        `Proceed to fill credentials manually.`
      );
    } else {
      response.addTextResult(
          `No password field found on page — skipped PM autofill ladder.`
      );
    }

    response.setIncludeSnapshot();
  },
});

export default [waitForPmAutofill];
