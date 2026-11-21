/** The home page's Flow panel, read through a reader the caller injects [N26,C7]. */
import { flowPanelModel } from '../logic/panel/flow.js';
import { flowPanelHtml } from '../logic/panel/render.js';

/**
 * The Flow panel markup for the home page, or an empty string when no reader is injected or it has nothing to read.
 * Why a reader and not an import: the flow comes from the health cell, which the view must not reach; the CLI that serves the page passes flowWhy in.
 *
 * @param {(() => { items?: any[], idle?: any[] } | null) | null | undefined} readFlow - Returns the flow document flowWhy builds.
 * @returns {string}
 */
export function flowHomePanel(readFlow) {
  if (typeof readFlow !== 'function') return '';
  const doc = readFlow();
  return doc ? flowPanelHtml(flowPanelModel(doc)) : '';
}
