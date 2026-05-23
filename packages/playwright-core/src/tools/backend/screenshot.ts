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

import jpegjs from 'jpeg-js';
import { PNG } from 'pngjs';
import * as z from 'zod';
import { formatObject } from '@isomorphic/stringUtils';

import { scaleImageToSize } from '@isomorphic/imageUtils';
import { defineTabTool } from './tool';
import { optionalElementSchema } from './snapshot';

import type * as playwright from '../../..';

const screenshotSchema = optionalElementSchema.extend({
  type: z.enum(['png', 'jpeg']).default('png').describe('Image format for the screenshot. Default is png.'),
  filename: z.string().optional().describe('File name to save the screenshot to. Defaults to `page-{timestamp}.{png|jpeg}` if not specified. Prefer relative file names to stay within the output directory.'),
  fullPage: z.boolean().optional().describe('When true, takes a screenshot of the full scrollable page, instead of the currently visible viewport. Cannot be used with element screenshots.'),
});

const ocrScreenshotSchema = z.object({
  filename: z.string().optional().describe('Base filename for output. For tiled captures, files are named {filename}-tile-{n}.png'),
  tileHeight: z.number().optional().default(800).describe('Max tile height in CSS pixels. Use 0 to disable tiling. Default: 800.'),
  hideFixed: z.boolean().optional().default(false).describe('Convert position:fixed elements to absolute to prevent repetition across tiles. Default: false.'),
  style: z.string().optional().describe('CSS to inject before capture (e.g., hide decorative elements, increase contrast).'),
});

const screenshot = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_take_screenshot',
    title: 'Take a screenshot',
    description: `Take a screenshot of the current page. You can't perform actions based on the screenshot, use browser_snapshot for actions.`,
    inputSchema: screenshotSchema,
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    if (params.fullPage && params.target)
      throw new Error('fullPage cannot be used with element screenshots.');

    const fileType = params.type || 'png';
    const options: playwright.PageScreenshotOptions = {
      type: fileType,
      quality: fileType === 'png' ? undefined : 90,
      scale: 'css',
      ...tab.actionTimeoutOptions,
      ...(params.fullPage !== undefined && { fullPage: params.fullPage })
    };

    const screenshotTargetLabel = params.target ? params.element || 'element' : (params.fullPage ? 'full page' : 'viewport');
    const target = params.target ? await tab.targetLocator({ element: params.element, target: params.target }) : null;
    const data = target ? await target.locator.screenshot(options) : await tab.page.screenshot(options);

    const resolvedFile = await response.resolveClientFile({ prefix: target ? 'element' : 'page', ext: fileType, suggestedFilename: params.filename }, `Screenshot of ${screenshotTargetLabel}`);

    response.addCode(`// Screenshot ${screenshotTargetLabel} and save it as ${resolvedFile.relativeName}`);
    if (target)
      response.addCode(`await page.${target.resolved}.screenshot(${formatObject({ ...options, path: resolvedFile.relativeName })});`);
    else
      response.addCode(`await page.screenshot(${formatObject({ ...options, path: resolvedFile.relativeName })});`);

    await response.addFileResult(resolvedFile, data);
    if (!params.filename)
      await response.registerImageResult(data, fileType);
  }
});

const ocrScreenshot = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_take_ocr_friendly_screenshot',
    title: 'Take OCR-optimized screenshot',
    description: `Take high-fidelity screenshots optimized for OCR/text extraction. Uses device pixel ratio, PNG format, no downscaling. Full pages are captured as tiles to preserve text quality.`,
    inputSchema: ocrScreenshotSchema,
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const tileHeight = params.tileHeight ?? 800;

    // Build CSS style string
    const styles: string[] = [];
    if (params.style)
      styles.push(params.style);
    const style = styles.length ? styles.join('\n') : undefined;

    // hideFixed: neutralize fixed/sticky elements before capture so they don't
    // repeat across tiles. Done via DOM mutation rather than a single-rule CSS
    // injection: the earlier `* { position: fixed !important; position: absolute !important; }`
    // shape promoted EVERY element to position:absolute (later declaration wins
    // at equal specificity), collapsing normal-flow layout. Walking the tree
    // and toggling only elements whose computed position is `fixed`/`sticky`
    // leaves the rest of the layout untouched. Restored after the capture so
    // the page is left as we found it.
    let restoreHideFixed: (() => Promise<void>) | undefined;
    if (params.hideFixed) {
      await tab.page.evaluate(() => {
        const marked: HTMLElement[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
          const cs = getComputedStyle(el);
          if (cs.position === 'fixed' || cs.position === 'sticky') {
            const prev = el.style.getPropertyValue('position');
            const prevPriority = el.style.getPropertyPriority('position');
            (el as HTMLElement & { __pwPrevPos?: { v: string; p: string } }).__pwPrevPos = { v: prev, p: prevPriority };
            el.style.setProperty('position', 'static', 'important');
            marked.push(el);
          }
        }
        (window as Window & { __pwHideFixedMarked?: HTMLElement[] }).__pwHideFixedMarked = marked;
      });
      restoreHideFixed = async () => {
        await tab.page.evaluate(() => {
          const marked = (window as Window & { __pwHideFixedMarked?: HTMLElement[] }).__pwHideFixedMarked ?? [];
          for (const el of marked) {
            const prev = (el as HTMLElement & { __pwPrevPos?: { v: string; p: string } }).__pwPrevPos;
            if (prev && prev.v)
              el.style.setProperty('position', prev.v, prev.p || '');
            else
              el.style.removeProperty('position');
            delete (el as HTMLElement & { __pwPrevPos?: { v: string; p: string } }).__pwPrevPos;
          }
          delete (window as Window & { __pwHideFixedMarked?: HTMLElement[] }).__pwHideFixedMarked;
        }).catch(() => {});
      };
    }

    // Base screenshot options for OCR optimization
    const baseOptions: playwright.PageScreenshotOptions = {
      type: 'png',
      scale: 'device',
      animations: 'disabled',
      caret: 'hide',
      style,
      ...tab.actionTimeoutOptions,
    };

    try {
      // Get page dimensions for tiling decision
      const dimensions = await tab.page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      }));

      const { scrollWidth, scrollHeight } = dimensions;

      // If tiling is disabled or page fits in single tile
      if (tileHeight === 0 || scrollHeight <= tileHeight) {
        const data = await tab.page.screenshot({ ...baseOptions, fullPage: true });
        const resolvedFile = await response.resolveClientFile({ prefix: 'ocr-page', ext: 'png', suggestedFilename: params.filename }, 'OCR screenshot of full page');
        response.addCode(`// OCR screenshot of full page, saved as ${resolvedFile.relativeName}`);
        response.addCode(`await page.screenshot(${formatObject({ ...baseOptions, fullPage: true, path: resolvedFile.relativeName })});`);
        await response.addFileResult(resolvedFile, data);
        // NOTE: upstream's scaleImageToFitMessage may downscale very large captures
        // (>1568px linear / >1.15MP). For OCR fidelity the on-disk artifact above is
        // authoritative; the embedded attachment is best-effort.
        if (!params.filename)
          await response.registerImageResult(data, 'png');
        return;
      }

      // Tiled capture for tall pages
      const numTiles = Math.ceil(scrollHeight / tileHeight);

      for (let i = 0; i < numTiles; i++) {
        const y = i * tileHeight;
        const height = Math.min(tileHeight, scrollHeight - y);
        const clip = { x: 0, y, width: scrollWidth, height };

        const tileSuggested = params.filename
          ? params.filename.replace(/\.png$/i, '') + `-tile-${i + 1}.png`
          : undefined;

        const data = await tab.page.screenshot({ ...baseOptions, fullPage: true, clip });
        const resolvedFile = await response.resolveClientFile({ prefix: 'ocr-page', ext: 'png', suggestedFilename: tileSuggested }, `OCR screenshot tile ${i + 1}/${numTiles}`);
        await response.addFileResult(resolvedFile, data);
        if (!params.filename)
          await response.registerImageResult(data, 'png');
      }

      response.addCode(`// OCR screenshot of full page in ${numTiles} tiles`);
      response.addTextResult(`Captured ${numTiles} tiles (${scrollWidth}x${scrollHeight}px total, ${tileHeight}px per tile)`);
    } finally {
      if (restoreHideFixed)
        await restoreHideFixed();
    }
  }
});

export function scaleImageToFitMessage(buffer: Buffer, imageType: 'png' | 'jpeg'): Buffer {
  // https://docs.claude.com/en/docs/build-with-claude/vision#evaluate-image-size
  // Not more than 1.15 megapixel, linear size not more than 1568.

  const image = imageType === 'png' ? PNG.sync.read(buffer) : jpegjs.decode(buffer, { maxMemoryUsageInMB: 512 });
  const pixels = image.width * image.height;

  const shrink = Math.min(1568 / image.width, 1568 / image.height, Math.sqrt(1.15 * 1024 * 1024 / pixels));
  if (shrink > 1)
    return buffer;

  const width = image.width * shrink | 0;
  const height = image.height * shrink | 0;
  const scaledImage = scaleImageToSize(image, { width, height });
  // eslint-disable-next-line no-restricted-syntax
  return imageType === 'png' ? PNG.sync.write(scaledImage as any) : jpegjs.encode(scaledImage, 80).data;
}

export default [
  screenshot,
  ocrScreenshot,
];
