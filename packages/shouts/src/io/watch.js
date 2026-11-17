import { localDependencyIds } from '../../../items/index.js';
import { shoutMatchesAudience } from '../../../store/index.js';
/**
 * pullboard watch: follow the board's own live event stream and print one line per event [A2,N26].
 *
 * Watch is a client of API v1's live events path, never a second event reader. When the person's
 * view is up and serves this board, watch follows the view's stream. Otherwise it serves the same
 * API on a private loopback port, scoped to this one board, and follows that. Either way the board
 * file is only read: watch makes no move and writes no event.
 */
import { setTimeout as pause } from 'node:timers/promises';
import { basename } from 'node:path';
import { serveApi } from '../../../api/index.js';
import { openBoardReadOnly } from '../../../store/index.js';
import {
  headCommit,
  withGitFacts,
} from '../../../git/index.js';
import { isLane } from '../../../seats/index.js';
import { fetchLocal } from '../../../sync/index.js';
import { Refused } from '../../../kernel/index.js';

/** The kinds that carry a shout, so --to can match their addressee. */
const SHOUT_KINDS = new Set(['shout', 'shout_news', 'answer', 'pass']);

/** How long a quiet watch reuses its last read of main's head (watch.quietReads). */
const QUIET_READ_MS = 1000;

/** How long to wait before following the stream again after it drops. */
const RECONNECT_MS = 200;

/** A text-mode detail stays on one short line, whatever the record holds. */
function oneLine(value, limit = 160) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\s]+/gu, ' ').trim();
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

/**
 * Read the flags into filters, refusing a bad value before anything is followed.
 *
 * @param {Record<string, any>} values
 * @param {{ config: any, agents: { agent_id: string, agent_lane: string }[] }} board
 */
export function watchOptions(values, { config, agents }) {
  const kinds = values.kinds === undefined ? null
    : new Set(String(values.kinds).split(',').map((kind) => kind.trim()).filter(Boolean));
  if (kinds && !kinds.size) throw new Refused('USAGE', '--kinds needs event kinds separated by commas, such as --kinds shout,submit; pullboard log shows the kinds');
  let item = null;
  if (values.item !== undefined) {
    if (!/^[1-9]\d*$/u.test(String(values.item))) throw new Refused('USAGE', '--item needs an item id, such as --item 12');
    item = Number(values.item);
  }
  let to = null;
  if (values.to !== undefined) {
    const name = String(values.to);
    const agent = agents.find((entry) => entry.agent_id === name);
    if (!agent && !['all', 'person', 'coordinator'].includes(name) && !isLane(config, name)) {
      throw new Refused('USAGE', `--to needs an agent id, a lane or all, and ${name} is none of them; pullboard lanes lists the lanes and pullboard status the agents`);
    }
    to = new Set(['all', name, ...(agent?.agent_lane ? [agent.agent_lane] : [])]);
  }
  const work = values.work === undefined ? null : String(values.work);
  if (work !== null && !isLane(config, work)) throw new Refused('USAGE', `--work needs a lane, and ${work} is not one; pullboard lanes lists them`);
  const reviewWait = values['review-wait'] === undefined ? 20 : Number(values['review-wait']);
  if (values['review-wait'] !== undefined && (String(values['review-wait']).trim() === '' || !Number.isFinite(reviewWait) || reviewWait < 0)) {
    throw new Refused('USAGE', '--review-wait needs a number of minutes, such as --review-wait 20');
  }
  if (values['review-wait'] !== undefined && work === null) throw new Refused('USAGE', '--review-wait goes with --work <lane>, such as --work core --review-wait 20');
  let since = null;
  if (values.since !== undefined) {
    if (!/^\d+$/u.test(String(values.since)) || !Number.isSafeInteger(Number(values.since))) {
      throw new Refused('USAGE', '--since needs the last sequence watch printed, such as --since 120');
    }
    since = Number(values.since);
  }
  return { kinds, item, to, work, reviewWaitMs: reviewWait * 60_000, since, json: Boolean(values.json) };
}

/** Run one read against the board file, opened read-only, and close it again. */
function readBoard(file, read) {
  const db = openBoardReadOnly(file);
  try { return read(db); } finally { db.close(); }
}

/** The board's id, its registered agents and its latest event sequence, in one read. */
export function watchStart(file) {
  return readBoard(file, (db) => ({
    id: db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('board_id').meta_value,
    agents: db.prepare('SELECT agent_id, agent_lane, agent_path FROM agent').all(),
    sequence: db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id,
  }));
}

/** Split a live stream body into its frames, keeping a partial frame until the rest arrives. */
async function* streamFrames(body) {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of body) {
    pending = (pending + decoder.decode(chunk, { stream: true })).replace(/\r\n/gu, '\n');
    let end;
    while ((end = pending.indexOf('\n\n')) >= 0) {
      const lines = pending.slice(0, end).split('\n');
      pending = pending.slice(end + 2);
      const name = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
      const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data) yield { name, data: JSON.parse(data) };
    }
  }
}

/**
 * Open the board's live events after `after`: the running view's stream when it serves this board,
 * otherwise the private API's. Returns null when the view could not give it, so the caller falls back.
 */
async function openStream(base, key, boardId, after, signal, { signals = true } = {}) {
  const url = new URL(`/api/v1/boards/${encodeURIComponent(boardId)}/events`, base);
  // Only --work reads the changed notices (a lane's work can change with no event); every other watcher asks for events alone.
  if (!signals) url.searchParams.set('signals', 'none');
  const response = await fetchLocal(url, {
    headers: { accept: 'text/event-stream', 'x-pullboard-key': key, 'last-event-id': String(after) },
    signal, redirect: 'error',
  });
  if (response.ok && /^text\/event-stream\b/iu.test(response.headers.get('content-type') ?? '')) return response.body;
  await response.body?.cancel();
  return null;
}

/** The person's running view as a stream source: its loopback origin and its session secret. */
async function viewSource(commonDir, runningView) {
  const view = await runningView(0, null) ?? await runningView(0, commonDir);
  if (!view) return null;
  const address = new URL(view.url);
  return { name: `the view on port ${view.port}`, base: address.origin, key: address.searchParams.get('k') };
}

/**
 * The private API source: API v1 itself, on a free loopback port, serving only this board.
 * It starts on first use and stops when watch stops.
 */
function directSource({ mainRoot, config, isMain, runCommand, serveApi, refusalDocument, boardOpeners, viewPorts }) {
  let api = null;
  return {
    name: 'the board directly',
    async open() {
      api ??= await serveApi({ viewPorts, boardOpeners, port: 0, runCommand, isMain, stateDetail: 'summary', refusalDocument,
        projects: () => [{ root: mainRoot, name: config.name ?? basename(mainRoot), project: config.project ?? '', added: new Date(0).toISOString() }] });
      const address = new URL(api.url);
      return { base: address.origin, key: address.searchParams.get('k') };
    },
    async close() { if (api) await api.close(); api = null; },
  };
}

/** The short detail of one event: a shout's text, an item's title, or the record's own fields. */
function eventDetail(file, event) {
  let detail = {};
  try { detail = JSON.parse(event.event_detail ?? '{}') ?? {}; } catch { /* An unreadable detail prints as the raw text below. */ detail = { text: event.event_detail }; }
  return readBoard(file, (db) => {
    if (SHOUT_KINDS.has(event.event_kind) && detail.shout) {
      const shout = db.prepare('SELECT shout_to, shout_text FROM shout WHERE shout_id = ?').get(detail.shout);
      return { to: shout?.shout_to ?? detail.to ?? null, text: `to ${shout?.shout_to ?? detail.to}: ${shout?.shout_text ?? ''}` };
    }
    const fields = Object.entries(detail).filter(([name, value]) => name !== 'model' && value !== null && typeof value !== 'object')
      .map(([name, value]) => `${name} ${value}`).join(', ');
    if (event.item_id) {
      const title = db.prepare('SELECT item_title FROM item WHERE item_id = ?').get(event.item_id)?.item_title ?? '';
      return { to: null, text: fields ? `${title} (${fields})` : title };
    }
    return { to: null, text: fields };
  });
}

/**
 * The lane's work as watch --work sees it: the items free to claim, the submissions left waiting
 * for review past the threshold, and when either can next change with no event (a lapsing lease
 * or a submission reaching the threshold).
 */
function laneWork(file, lane, reviewWaitMs, nowMs) {
  return readBoard(file, (db) => {
    const now = new Date(nowMs).toISOString();
    const laneHeld = Boolean(db.prepare('SELECT 1 FROM hold WHERE hold_lane = ?').get(lane));
    const status = new Map(db.prepare('SELECT item_id, item_status FROM item').all().map((row) => [row.item_id, row.item_status]));
    const items = db.prepare('SELECT * FROM item WHERE item_lane = ? ORDER BY item_id').all(lane);
    const claimable = new Map();
    const waiting = new Map();
    const wakes = [];
    for (const item of items) {
      const lapsed = item.item_status === 'claimed' && (item.item_lease_until ?? '') <= now;
      if (item.item_status === 'claimed' && !lapsed && item.item_lease_until) wakes.push(Date.parse(item.item_lease_until));
      const after = localDependencyIds(item);
      if ((item.item_status === 'open' || lapsed) && !laneHeld && !item.item_hold_reason && after.every((id) => status.get(id) === 'verified')) {
        claimable.set(item.item_id, item);
      }
      if (item.item_status !== 'submitted') continue;
      const reviewed = item.item_review_by && (item.item_review_until ?? '') > now;
      if (reviewed) { wakes.push(Date.parse(item.item_review_until)); continue; }
      const submit = db.prepare("SELECT event_id, event_at FROM event WHERE item_id = ? AND event_kind = 'submit' ORDER BY event_id DESC LIMIT 1").get(item.item_id);
      if (!submit) continue;
      const due = Date.parse(submit.event_at) + reviewWaitMs;
      if (due <= nowMs) waiting.set(`${item.item_id}:${submit.event_id}`, { item, since: submit.event_at });
      else wakes.push(due);
    }
    return { claimable, waiting, wake: wakes.filter((at) => at > nowMs).sort((a, b) => a - b)[0] ?? null };
  });
}

/**
 * Follow the board's live events until the signal aborts, printing each one as it arrives.
 * A dropped stream is followed again from the last sequence handled, so nothing is missed or repeated.
 *
 * With `quietReads` on (watch.quietReads, #9843), main's head read is reused for one second; off, it is read after every event.
 *
 * @param {{ quietReads?: boolean, readHead?: Function, file: string, mainRoot: string, commonDir: string, config: any, isMain: boolean, runCommand: Function,
 *   serveApi: Function, refusalDocument: Function, options: ReturnType<typeof watchOptions>, start: ReturnType<typeof watchStart>,
 *   write: (text: string) => void, note: (text: string) => void, signal: AbortSignal, now?: () => number, runningView: Function }} watch
 */
export async function followBoard({ file, mainRoot, commonDir, config, isMain, runCommand, serveApi, refusalDocument, boardOpeners, viewPorts, options, start, write, note, signal, runningView, now = Date.now, quietReads = false, readHead = headCommit }) {
  if (typeof runningView !== 'function') throw new TypeError('watch requires the caller-owned runningView operation');
  let cursor = options.since ?? start.sequence;
  const direct = directSource({ mainRoot, config, isMain, runCommand, serveApi, refusalDocument, boardOpeners, viewPorts });
  /** Print one record as a plain line or as one JSON object, immediately. */
  const print = (record) => {
    if (options.json) write(JSON.stringify({ version: 1, ...record }) + '\n');
    else write(`${record.sequence} ${record.kind} ${record.item === null ? '-' : '#' + record.item} ${record.actor ?? '-'} ${oneLine(record.detail)}`.trimEnd() + '\n');
  };
  /** Whether an event passes the --kinds, --item and --to filters. */
  const wanted = (event, to) => (!options.kinds || options.kinds.has(event.event_kind))
    && (options.item === null || event.item_id === options.item)
    && (!options.to || (options.seatDefault && !SHOUT_KINDS.has(event.event_kind))
      || (SHOUT_KINDS.has(event.event_kind) && readBoard(file, (db) => shoutMatchesAudience(db, to, options.to))));

  let work = null;
  let mainHead = null;
  let headReadAt = null;
  let wakeTimer = null;
  /** Recheck the lane's work and main, printing what changed; quiet the first time, when it sets the baseline. */
  const checkWork = async () => {
    if (options.work === null || signal.aborted) return;
    clearTimeout(wakeTimer);
    const current = laneWork(file, options.work, options.reviewWaitMs, now());
    const reuse = quietReads && headReadAt !== null && now() - headReadAt < QUIET_READ_MS;
    const head = reuse ? mainHead : await withGitFacts(() => readHead(mainRoot));
    if (!reuse) headReadAt = now();
    if (work) {
      for (const [id, item] of current.claimable) {
        if (!work.claimable.has(id) && (options.item === null || id === options.item)) {
          print({ sequence: cursor, kind: 'claimable', item: id, actor: null, detail: `${options.work}: ${item.item_title}`, notice: true });
        }
      }
      for (const [key, { item, since }] of current.waiting) {
        if (!work.waiting.has(key) && (options.item === null || item.item_id === options.item)) {
          print({ sequence: cursor, kind: 'review-wait', item: item.item_id, actor: item.item_built_by ?? null,
            detail: `${options.work}: ${item.item_title}, waiting for review since ${since}`, since, notice: true });
        }
      }
      if (head !== mainHead && options.item === null) {
        print({ sequence: cursor, kind: 'main', item: null, actor: null, detail: `main moved to ${head ?? 'no commit'}`, commit: head, notice: true });
      }
    }
    work = current;
    mainHead = head;
    if (current.wake !== null) {
      wakeTimer = setTimeout(() => { queue = queue.then(checkWork).catch(fail); }, Math.min(2_147_483_647, Math.max(1, current.wake - now() + 5)));
    }
  };
  let failure = null;
  /** Keep the first failure and stop following. */
  const fail = (error) => { failure ??= error; stopped.abort(); };
  const stopped = new AbortController();
  const both = AbortSignal.any([signal, stopped.signal]);
  // Work checks and printed events share one queue, so their lines never interleave out of order.
  let queue = Promise.resolve();

  let source = null;
  try {
    await checkWork();
    while (!both.aborted) {
      let body = null;
      const view = await viewSource(commonDir, runningView).catch(() => null);
      if (view) body = await openStream(view.base, view.key, start.id, cursor, both, { signals: options.work !== null }).catch((error) => { if (both.aborted) throw error; return null; });
      const name = body ? view.name : direct.name;
      if (!body) {
        const own = await direct.open();
        body = await openStream(own.base, own.key, start.id, cursor, both, { signals: options.work !== null });
        if (!body) throw new Refused('BOARD_UNAVAILABLE', 'this board\'s own event stream did not open; run pullboard doctor, then pullboard watch again');
      }
      if (name !== source) note(`watch: following ${name} after sequence ${cursor}`);
      source = name;
      try {
        for await (const frame of streamFrames(body)) {
          if (frame.name === 'error') throw new Refused(frame.data.error?.code ?? 'BOARD_UNAVAILABLE', frame.data.error?.message ?? 'the live stream stopped; run pullboard watch again');
          const event = frame.data.event;
          if (!event) continue;
          queue = queue.then(async () => {
            if (event.event_kind !== 'changed' && Number.isSafeInteger(event.event_id) && event.event_id > cursor) {
              const detail = eventDetail(file, event);
              if (wanted(event, detail.to)) {
                print({ sequence: event.event_id, kind: event.event_kind, item: event.item_id ?? null, actor: event.event_by ?? null,
                  detail: detail.text, at: event.event_at, ...(detail.to ? { to: detail.to } : {}) });
              }
              cursor = event.event_id;
            }
            await checkWork();
          }).catch(fail);
          await queue;
          if (both.aborted) break;
        }
      } catch (error) {
        if (both.aborted) break;
        if (error instanceof Refused) throw error;
        // A dropped connection is followed again below, from the last sequence handled.
      }
      if (!both.aborted) {
        note(`watch: the stream dropped after sequence ${cursor}; following again`);
        source = null;
        await pause(RECONNECT_MS, undefined, { signal: both }).catch(() => {});
      }
    }
  } catch (error) {
    if (!both.aborted) throw error;
  } finally {
    stopped.abort();
    clearTimeout(wakeTimer);
    await queue.catch(() => {});
    await direct.close();
  }
  if (failure) throw failure;
  return 0;
}

/**
 * Run pullboard watch for one checkout until Ctrl-C (SIGINT or SIGTERM), or until `io.signal` aborts.
 * Each line is its own document, so --json never adds an end-of-command envelope.
 */
export async function watchCommand({ quietReads = false, io, values, words, ctx, primaryCheckoutRoot, runCommand, runningView, refusalDocument, boardOpeners, viewPorts }) {
  const { info, config, file, allowSchemaUpgrade: isMain } = ctx;
  const mainRoot = primaryCheckoutRoot(info) ?? info.root;
  if (words.some((word) => word !== undefined)) throw new Refused('USAGE', 'pullboard watch takes flags only, such as pullboard watch --to core; run pullboard help watch');
  const start = watchStart(file);
  const options = watchOptions(values, { config, agents: start.agents });
  // The person's main-checkout stream remains the board-wide observer; a joined seat follows its own audience.
  const seat = info.root !== mainRoot && start.agents.find((agent) => agent.agent_path === info.root);
  if (seat && values.to === undefined) {
    options.to = new Set(['all', seat.agent_id, seat.agent_lane]);
    options.seatDefault = true;
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  io.signal?.addEventListener('abort', stop, { once: true });
  if (io.signal?.aborted) stop();
  io.jsonMode?.(false);
  try {
    return await followBoard({ file, mainRoot, commonDir: info.commonDir, config, isMain, runCommand, serveApi, refusalDocument, boardOpeners, viewPorts, options, start, runningView, quietReads,
      write: (text) => io.stdout.write(text), note: (text) => io.stderr.write(text + '\n'), signal: abort.signal });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    io.signal?.removeEventListener('abort', stop);
  }
}
