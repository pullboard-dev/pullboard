/**
 * The hosted page's one star line [N26] (#727): "Like Pullboard? A GitHub star helps.", linking to the GitHub
 * repository. Why so quiet: the person asked for a star only from people who use the relay and never to be
 * annoying, so the line is one sentence under the board, shown only on pullboard.dev to a signed-in person with a
 * linked board, and gone for good on that device once dismissed. The local view, the CLI and MCP never carry it.
 */
import { readFileSync } from 'node:fs';

import { starHtml } from "../logic/render/star.js";
export { STAR_TEXT, STAR_KEY } from "../logic/render/star.js";

/**
 * The repository's web address, read from package.json's repository field so the link never goes stale.
 *
 * @returns {string}
 */
export function starRepository() {
  const manifest = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), 'utf8'));
  const url = String(manifest.repository?.url || manifest.repository || '');
  return url.replace(/^git\+/u, '').replace(/\.git$/u, '');
}

/** Read the repository at the server boundary before rendering the unchanged star line. */
export function starMarkup() { return starHtml(starRepository()); }
