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

import type { CdpStealthFeature } from '../cdpStealth';

export function shouldSkipLogEnable(cdpStealth: ReadonlySet<CdpStealthFeature>): boolean {
  return cdpStealth.has('log-skip');
}

export function shouldCycleRuntime(cdpStealth: ReadonlySet<CdpStealthFeature>): boolean {
  return cdpStealth.has('runtime-cycle');
}

export function shouldCycleWorkerRuntime(cdpStealth: ReadonlySet<CdpStealthFeature>): boolean {
  return cdpStealth.has('worker-runtime');
}

export interface WorkerStealthSession {
  send(method: string, params?: any): Promise<any>;
  sendMayFail(method: string, params?: any): Promise<any>;
}

export function applyWorkerStealth(session: WorkerStealthSession, cdpStealth: ReadonlySet<CdpStealthFeature>): Promise<void> {
  const runtimeReady = session.send('Runtime.enable', {}).then(() => {
    if (shouldCycleWorkerRuntime(cdpStealth))
      return session.sendMayFail('Runtime.disable');
    return undefined;
  }).catch(() => {});

  return runtimeReady.then(() => session.send('Runtime.runIfWaitingForDebugger').catch(() => {}));
}
