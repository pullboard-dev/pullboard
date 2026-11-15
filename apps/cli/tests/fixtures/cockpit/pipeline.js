/** Pipeline view fixtures: a board with one item per stage and the real-press diagnostics [N26,N38]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as store from '../../../../../packages/store/index.js';
import { submitFixture } from '../board/submit.js';
import { earlier } from './harness.js';

/** Native lifecycle writers on a private clock give each pipeline stage a known arrival. */
export function pipelineBoard(box, alpha) {
  const base = Date.now() - 60 * 60_000, commit = box.git(alpha.repo, 'rev-parse', 'HEAD'), tree = box.git(alpha.repo, 'rev-parse', 'HEAD^{tree}'), digest = 'a'.repeat(64);
  const at = (minute, move) => earlier(alpha.repo, base + minute * 60_000, move);
  at(0, board => store.register(board, { lane: 'tests', path: join(box.dir, 'pipeline-reviewer') }));
  for (const [id, minute] of [[1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 2]]) at(minute, board => store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Pipeline item ' + id + (id === 6 ? ' ' + 'Averylongword'.repeat(35) : ''), specIds: ['G1'], criterion: 'Shows the stage' }));
  const claim = (id, minute) => at(minute, board => store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 24 * 60 * 60_000, head: commit, freeze: () => ({ text: '{}', digest }) }));
  const submit = (id, minute) => at(minute, board => submitFixture(board, id, { agentId: 'web-1', commit, tree }));
  const acceptAt = (id, minute) => at(minute, board => store.verify(board, id, { agentId: 'tests-1', decision: 'ACCEPT', note: 'Private pipeline fixture', head: commit, digest, policy: 'any' }));
  claim(1, 3); submit(1, 4); acceptAt(1, 5);
  at(6, board => store.merged(board, 1, { agentId: 'coordinator', commit }));
  claim(2, 7); submit(2, 8); acceptAt(2, 9);
  claim(3, 10); submit(3, 11); claim(4, 12); claim(4, 20);
  at(20, board => store.editItem(board, 5, { agentId: 'coordinator', brief: 'Edited after the newer open item was added' }));
  return { base, arrivals: { open: [5, 0], claimed: [4, 12], submitted: [3, 11], accepted: [2, 9], merged: [1, 6] } };
}

/** Installs capture diagnostics for real Pipeline card presses and leaves the original timeout error intact. */
export async function installPipelinePressDiagnostics(chrome) {
  const setup = await chrome.stable(`(() => {
    const pipeline = document.querySelector('#pipeline');
    if (!pipeline) throw new Error('Pipeline container is missing');
    const state = { armed: false, redraws: 0, redrawsAtArm: 0, expected: null, down: null, up: null, click: null };
    const observer = new MutationObserver(records => { state.redraws += records.filter(record => record.target === pipeline && record.type === 'childList').length; });
    observer.observe(pipeline, { childList: true });
    const flush = () => { state.redraws += observer.takeRecords().filter(record => record.target === pipeline && record.type === 'childList').length; return state.redraws; };
    const describe = node => node instanceof Element ? node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\\s+/).join('.') : '') : String(node);
    const listen = kind => event => {
      if (!state.armed) return;
      const card = event.composedPath().find(node => node instanceof Element && node.classList.contains('pipeline-item')) ?? null;
      state[kind] = { target: describe(event.target), dataItem: card?.dataset.item ?? null, connected: card?.isConnected ?? false,
        viewItem: view.item, pathname: location.pathname, innerWidth, redraws: flush(), node: card };
      if (kind === 'up' && state.down) state.down.connectedAtUp = Boolean(state.down.node?.isConnected);
      if (kind === 'click' && state.down) state.click.sameNodeAsDown = state.click.node === state.down.node;
    };
    document.addEventListener('mousedown', listen('down'), true);
    document.addEventListener('mouseup', listen('up'), true);
    document.addEventListener('click', listen('click'), true);
    state.arm = card => { flush(); state.expected = { dataItem: card?.dataset.item ?? null, connected: Boolean(card?.isConnected), disabled: card?.disabled ?? null };
      state.expectedNode = card; state.down = state.up = state.click = null; state.redrawsAtArm = state.redraws; state.armed = true; return state.expected; };
    state.snapshot = () => {
      const redraws = flush();
      const clean = event => event && ({ target: event.target, dataItem: event.dataItem, connected: event.connected, connectedAtUp: event.connectedAtUp,
        disabled: event.disabled, viewItem: event.viewItem, pathname: event.pathname, innerWidth: event.innerWidth, redraws: event.redraws,
        sameNodeAsDown: event.sameNodeAsDown });
      return { expected: state.expected, down: clean(state.down), up: clean(state.up), click: clean(state.click), refresh: state.refresh ?? null, expectedNodeConnected: Boolean(state.expectedNode?.isConnected),
        downNodeConnectedNow: Boolean(state.down?.node?.isConnected), viewItem: view.item, pathname: location.pathname, innerWidth,
        // press() scrolls and settles the target after arm(); those redraws precede the native press.
        pipelineRedrawsBeforeDown: state.down ? state.down.redraws - state.redrawsAtArm : null,
        pipelineRedrawsSinceDown: state.down ? redraws - state.down.redraws : null,
        pipelineRedrawsBetweenDownAndUp: state.down && state.up ? state.up.redraws - state.down.redraws : null };
    };
    globalThis.__pipelinePressDiagnostic = state;
    return { ready: true, pathname: location.pathname, selected: view.item };
  })()`);
  assert.equal(setup.ready, true, 'the real Pipeline diagnostics are installed');
}

/** Waits for the original Pipeline selection predicate and adds real press diagnostics if its wait times out. */
export async function waitForPipelineItem(chrome, id) {
  try {
    await chrome.waitFor(`view.item === ${id}`);
  } catch (error) {
    let snapshot = 'diagnostics unavailable';
    try { snapshot = await chrome.stable('JSON.stringify(globalThis.__pipelinePressDiagnostic?.snapshot() ?? null)'); } catch { /* diagnostics are best-effort; the original wait error is rethrown below */ }
    error.message += `; Pipeline press diagnostics for #${id}: ${snapshot}`;
    throw error;
  }
}
