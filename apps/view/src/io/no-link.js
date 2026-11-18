/** The page a browser gets at a view address opened without its private link: the view's look, what to do, nothing from the board [N26]. */
import { readFileSync } from 'node:fs';

/** Where the no-link page's stylesheet is served; it holds only the view's tokens and this page's rules. */
export const NO_LINK_STYLESHEET = '/no-link.css';

/** The view's :root token block, read from main.css so the page keeps the view's fonts and colours as they change. */
const TOKENS = /^:root \{[\s\S]*?\n\}/mu.exec(readFileSync(new URL('./main.css', import.meta.url), 'utf8'))?.[0];
if (!TOKENS) throw new Error('main.css: no :root token block for the no-link page');

/** The no-link stylesheet: the tokens first, then the page's own rules. */
export const NO_LINK_CSS = TOKENS + '\n' + readFileSync(new URL('./no-link.css', import.meta.url), 'utf8');

const MARK = '<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M8 7h35a6 6 0 0 1 6 6v7H8a5 5 0 0 1-5-5v-3a5 5 0 0 1 5-5Z"/><rect class="no-link-bar" width="56" height="14" x="3" y="25" rx="5"/><path fill="currentColor" d="M8 43h35a6 6 0 0 1 6 6v8H8a5 5 0 0 1-5-5v-4a5 5 0 0 1 5-5Z"/></svg>';

/** Loopback socket addresses, and Host headers naming the view's own loopback address. */
const LOOPBACK_SOCKET = /^(?:127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3})$/u;
const LOOPBACK_HOST = /^(?:127(?:\.\d{1,3}){3}|localhost|\[::1\])(?::\d+)?$/iu;

/**
 * Whether a request comes from the board's own machine: a loopback socket address and a loopback Host header.
 *
 * @param {{ remoteAddress?: string, host?: string }} [request]
 * @returns {boolean}
 */
export function isOwnMachineRequest(request = {}) {
  return LOOPBACK_SOCKET.test(String(request.remoteAddress ?? '')) && LOOPBACK_HOST.test(String(request.host ?? ''));
}

/**
 * The no-link page: fixed words and the hosted address only, so it reveals nothing from the board. On the owner's
 * own machine it names the one action that prints the private link; anywhere else it keeps the shared-board wording.
 *
 * @param {string} hostedOrigin
 * @param {{ remoteAddress?: string, host?: string }} [request]
 * @returns {string}
 */
export function noLinkPage(hostedOrigin, request) {
  const host = new URL(hostedOrigin).host;
  const guidance = isOwnMachineRequest(request)
    ? '<p>Run <code>pullboard view</code> in a terminal on this machine to print this board\'s private link, then open it.</p>'
    : '<p>Ask the person who shared this board to send you its link.</p>';
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>This board needs its private link</title><link rel="stylesheet" href="' + NO_LINK_STYLESHEET + '">'
    + '<main class="no-link"><div class="no-link-brand">' + MARK + '<span>Pullboard</span></div>'
    + '<h1>This board needs its private link</h1>'
    + '<p>This address opens only with the private link it was shared with.</p>'
    + guidance
    + '<p class="no-link-own">To open your own boards, go to <a href="' + hostedOrigin + '">' + host + '</a>.</p>'
    + '</main></html>';
}
