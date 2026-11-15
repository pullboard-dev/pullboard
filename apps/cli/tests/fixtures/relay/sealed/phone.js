/** The phone-sized Chrome that opens a sealed board; kept apart so sealed tests that never open a browser reach no Chrome launcher [H5,C7]. */
import { readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { startChrome } from '../browser.js';
import { stableChrome } from '../../cockpit/stable.js';

/**
 * Open that board on a fresh phone-sized Chrome and return the page's own timing once it has painted the current
 * board. holdStateMs is a test-only delay on the phone's current-state read, which holds the first paint (#953).
 */
export async function openOnPhone(t, { box, link, heldPage, currentMarker }, { holdStateMs = 0 } = {}) {
  const loadBefore = loadavg()[0];
  const chrome = await stableChrome(await startChrome());
  t.after(() => chrome.close());
  await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: String.raw`
    window.__phoneTiming = { firstBoardPaint: null, objectRequests: 0, loopbackReads: 0, historyHeld: false };
    window.__holdStateMs = ${holdStateMs};
    window.__releaseOlderHistory = null;
    const originalFetch = window.fetch;
    window.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (['http://127.0.0.1:4890', 'http://localhost:4890'].includes(url.origin)) {
        __phoneTiming.loopbackReads++; throw new TypeError('No local view in this private phone fixture');
      }
      if (/\/api\/v2\/boards\/[^/]+\/objects\//u.test(url.pathname)) __phoneTiming.objectRequests++;
      if (window.__holdStateMs && /\/api\/v2\/boards\/[^/]+\/state$/u.test(url.pathname)) {
        const held = window.__holdStateMs; window.__holdStateMs = 0;
        await new Promise(resolveHold => setTimeout(resolveHold, held));
      }
      if (url.pathname.endsWith('/objects/${heldPage}') && !window.__olderHistoryAllowed) {
        __phoneTiming.historyHeld = true;
        await new Promise(resolveHistory => { window.__releaseOlderHistory = resolveHistory; });
      }
      return originalFetch(input, options);
    };
    let queued = false;
    let opened = false;
    new MutationObserver(() => {
      const tab = document.querySelector('[data-tab="items"]');
      if (!opened && tab && typeof data === 'object' && data?.project) { opened = true; tab.click(); } // a person opens Items before the list is drawn, since pages open on the Dashboard.
      const node = document.querySelector('#chain');
      if (queued || !node?.textContent.includes('${currentMarker}') || !node.getBoundingClientRect().height) return;
      queued = true;
      requestAnimationFrame(() => { __phoneTiming.firstBoardPaint = performance.now(); });
    }).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  ` });
  await chrome.send('Network.setCookie', {
    name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  });
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + readFileSync(box.keyFile, 'utf8').trim());
  // Budget: the owner's explicit first-readable-board bar is three seconds, independent of historical streaming.
  // The product bar is the page's own firstBoardPaint < 3000 ms; this wait only has to outlast a loaded runner (#953).
  try {
    await chrome.waitFor('Number.isFinite(window.__phoneTiming?.firstBoardPaint) && typeof transport !== "undefined" && !!transport?.historyProgress', 120_000, 'bounded current board paints before all history'); // budget: generous hang ceiling for a starved harness to observe the paint under gate load (a 30 s wait expired with the page painted at 646 ms); the frozen #903 3000ms bar is asserted on the page-measured firstBoardPaint.
  } catch (error) {
    // Record what the page itself reached, so a miss reads as a page measurement rather than a runner timeout (#953).
    const page = await chrome.stable(`({ ...window.__phoneTiming, sinceNavigationMs: performance.now(), readyState: document.readyState,
      transport: typeof transport, historyProgress: typeof transport?.historyProgress, chain: Boolean(document.querySelector('#chain')), tabs: [...document.querySelectorAll('[data-tab]')].map(b => b.dataset.tab + ':' + b.getAttribute('aria-selected')).join(), chainText: (document.querySelector('#chain')?.textContent ?? '').slice(0, 160), chainHeight: document.querySelector('#chain')?.getBoundingClientRect().height, hasMarker: document.body.textContent.includes('${currentMarker}'), loading: document.body?.classList.contains('loading') })`).catch(() => null);
    t.diagnostic(JSON.stringify({ phonePageAtTimeout: page }));
    error.message += '; the page reached ' + JSON.stringify(page);
    throw error;
  }
  const first = await chrome.stable(`({ ...__phoneTiming, phone: document.documentElement.dataset.relayDevice, progress: transport.historyProgress('${link.board}') })`);
  return { chrome, first: { ...first, loadBefore } };
}
