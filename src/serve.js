/**
 * `pullboard view` (N26, N27): the person's micro site. One page on this machine shows every
 * registered project: items by state, what needs the person, shouts, doctrine, agents and activity,
 * refreshing itself. Its actions run the real CLI in the project, so every rule and refusal applies
 * exactly as at a terminal.
 *
 * It listens on the loopback address only and answers nothing without the session's secret and its
 * own Host, so another site in the browser cannot reach it. It opens no outbound connection (P5).
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './board.js';
import { cockpitPage } from './cockpit.js';
import { COORDINATOR, loadConfig } from './config.js';
import { repoInfo, resolveCommit } from './git.js';
import { productSummaries } from './products.js';
import { listProjects } from './projects.js';
import { Refused } from './refused.js';
import { loadSpec } from './spec.js';

const BIN = fileURLToPath(new URL('../bin/pullboard.js', import.meta.url));
export const LOOPBACK = '127.0.0.1';

/**
 * Open a project's board, read from it, and always close it.
 *
 * @template T
 * @param {string} root
 * @param {(board: any, info: any, config: any) => T} read
 * @returns {T}
 */
function withProject(root, read) {
  const info = repoInfo(root);
  const config = loadConfig(info.root);
  const board = store.openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'));
  try {
    return read(board, info, config);
  } finally {
    store.closeBoard(board);
  }
}

/**
 * One project in the sidebar: its counts, or why it cannot be read (moved, no config).
 *
 * @param {{ root: string, name: string }} project
 * @returns {any}
 */
function summary(project) {
  try {
    return withProject(project.root, (board, info, config) => {
      const items = store.listItems(board, { all: true });
      const count = (test) => items.filter(test).length;
      const pending = loadSpec(info.root, config).rows.filter((row) => row.status === 'pending').length;
      return {
        ...project,
        ok: true,
        building: count((item) => item.item_status === 'claimed'),
        awaiting: count((item) => item.item_status === 'submitted'),
        sentBack: count((item) => item.item_status === 'open' && item.item_verdict === 'REJECT'),
        open: count((item) => item.item_status === 'open'),
        verified: count((item) => item.item_status === 'verified'),
        pending,
        holds: store.laneHolds(board).length,
      };
    });
  } catch (error) {
    return { ...project, ok: false, error: error.message };
  }
}

/**
 * Everything the page shows for one project. Given the newest shout the person has seen there,
 * it also counts every shout since, which the forty it sends cannot always show.
 *
 * @param {string} root
 * @param {{ seen?: number | null }} [options]
 * @returns {any}
 */
export function projectState(root, { seen = null } = {}) {
  return withProject(root, (board, info, config) => {
    const all = store.listItems(board, { all: true });
    const status = new Map(all.map((item) => [item.item_id, item.item_status]));
    const rows = (file) => loadSpec(info.root, { ...config, spec: file }).rows.map(({ id, status: state, tier, text, gate, serves, section }) => ({ id, status: state, tier, text, gate, serves, section }));
    const verdict = (row) => ({ decision: row.verdict_decision, reason: row.verdict_reason, note: row.verdict_note, by: row.verdict_by, at: row.verdict_at, commit: row.verdict_commit });
    const log = store.events(board);
    // When each agent last moved on the board: the log is in order, so the last write wins.
    const lastMove = new Map(log.map((event) => [event.event_by, event.event_at]));
    return {
      root: info.root,
      lanes: [COORDINATOR, ...Object.keys(config.lanes)],
      items: all.map((item) => {
        const verdicts = store.verdictsFor(board, item.item_id).map(verdict);
        const after = item.item_after ? item.item_after.split(',').map(Number) : [];
        return {
          id: item.item_id,
          title: item.item_title,
          lane: item.item_lane,
          status: item.item_status,
          route: item.item_route,
          owner: item.item_owner,
          // Who holds the review under a live lease (V15), by the board's own rule.
          reviewer: store.reviewHolder(board, item),
          reviewUntil: item.item_review_until ?? null,
          builtBy: item.item_built_by,
          verifiedBy: item.item_verified_by,
          specs: item.item_spec_ids ? item.item_spec_ids.split(',') : [],
          criterion: item.item_criterion,
          brief: item.item_brief,
          commit: item.item_commit,
          merged: item.item_merged_commit,
          blockedBy: after.filter((id) => status.get(id) !== 'verified'),
          updatedAt: item.item_updated_at,
          verdict: verdicts.at(-1) ?? null,
          verdicts,
          history: store.events(board, { itemId: item.item_id }).map((event) => ({ kind: event.event_kind, by: event.event_by, at: event.event_at })),
        };
      }),
      shouts: store.recentShouts(board, 40),
      events: log.slice(-80).reverse(),
      agents: store.listAgents(board).map((agent) => ({ ...agent, lastMoveAt: lastMove.get(agent.agent_id) ?? null })),
      holds: store.laneHolds(board),
      spec: rows(config.spec),
      practice: rows(config.practice),
      unseen: seen === null ? null : { since: seen, count: board.db.prepare('SELECT COUNT(*) AS n FROM shout WHERE shout_id > ?').get(seen).n },
      // Each product's progress, counted as pullboard status counts it (N28).
      products: productSummaries(config, loadSpec(info.root, config), all),
    };
  });
}

/** The most lines one code reference shows (B23). */
export const CODE_LINES = 60;
/** The largest file a code reference reads, in bytes. */
const CODE_BYTES = 2_000_000;

/**
 * The lines a shout's path:lines@commit reference names, as they were at that commit (B23). Git
 * alone reads them, from the commit's own tree: never the working tree, never a path outside the
 * repo, never a revision that is not a plain SHA, never lines past the file's end, and never more
 * than CODE_LINES lines. A path cannot hold a space, so the words written just before a reference
 * may be the start of one: when they and the path make a file the commit holds, the reference may
 * mean that file, and it is refused rather than opened as a different one.
 *
 * @param {string} root
 * @param {{ path: string, from: number, to: number, commit: string, before?: string }} ref
 * @returns {{ path: string, commit: string, from: number, to: number, lines: string[], more: boolean }}
 */
export function codeAt(root, { path, from, to, commit, before = '' }) {
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Refused('BAD_REF', `name the commit by its SHA, 7 to 40 hex digits (saw "${commit}")`);
  if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(path) || path.split('/').some((part) => part === '.' || part === '..')) {
    throw new Refused('BAD_REF', `name a file inside the repo by its path from the top, such as src/serve.js (saw "${path}")`);
  }
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to >= from)) throw new Refused('BAD_REF', 'name the lines as 12, or 12-30');
  const full = resolveCommit(root, commit);
  if (!full) throw new Refused('NO_COMMIT', `no commit ${commit} in this repo`);
  const object = `${full}:${path}`;
  const type = spawnSync('git', ['cat-file', '-t', object], { cwd: root, encoding: 'utf8' });
  if (type.status !== 0 || type.stdout.trim() !== 'blob') throw new Refused('NO_FILE', `no file ${path} at ${commit}`);
  const words = String(before).split(' ').filter(Boolean).slice(-4);
  for (let k = 1; k <= words.length; k += 1) {
    const longer = `${words.slice(-k).join(' ')} ${path}`;
    if (spawnSync('git', ['cat-file', '-e', `${full}:${longer}`], { cwd: root }).status === 0) {
      throw new Refused('AMBIGUOUS', `the words before it may make it "${longer}", a path with a space, which a reference cannot name`);
    }
  }
  const size = Number(spawnSync('git', ['cat-file', '-s', object], { cwd: root, encoding: 'utf8' }).stdout);
  if (!(size <= CODE_BYTES)) throw new Refused('TOO_LARGE', `${path} is over ${CODE_BYTES / 1_000_000} MB, too large to show`);
  const lines = spawnSync('git', ['cat-file', 'blob', object], { cwd: root, encoding: 'utf8', maxBuffer: CODE_BYTES + 1 }).stdout.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (to > lines.length) throw new Refused('NO_LINES', `${path} has ${lines.length} lines at ${commit}`);
  const last = Math.min(to, from + CODE_LINES - 1);
  return { path, commit: full, from, to: last, lines: lines.slice(from - 1, last), more: last < to };
}

/**
 * The CLI command an action from the page stands for, or null for one it does not offer.
 *
 * @param {string} command
 * @param {any} args
 * @returns {string[] | null}
 */
export function actionArgs(command, args = {}) {
  const text = (value) => String(value ?? '').trim();
  if (command === 'add') {
    return ['add', text(args.lane), text(args.title), ...(text(args.criterion) ? ['--criterion', text(args.criterion)] : []), ...(text(args.specs) ? ['--specs', text(args.specs)] : []), ...(text(args.brief) ? ['--brief', text(args.brief)] : [])];
  }
  if (command === 'shout') return ['shout', text(args.to), text(args.text)];
  if (command === 'hold') return ['hold', text(args.lane), '--reason', text(args.reason)];
  if (command === 'release') return ['hold', text(args.lane), '--off'];
  return null;
}

/**
 * Run the CLI in a folder, as the person would at a terminal there.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number | null, out: string, err: string }>}
 */
function runCli(cwd, args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, out, err });
    });
  });
}

/**
 * Serve the view until stopped.
 *
 * @param {{ port?: number, secret?: string }} [options]
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export function serveView({ port = 0, secret = randomBytes(18).toString('base64url') } = {}) {
  const key = Buffer.from(secret);
  let bound = 0;
  const reply = (res, code, type, body) => {
    res.writeHead(code, {
      'content-type': type,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(body);
  };
  const json = (res, code, value) => reply(res, code, 'application/json; charset=utf-8', JSON.stringify(value));
  const server = createServer(async (req, res) => {
    // A request line no URL parser accepts cannot carry the secret, so it gets the same 403, and it
    // must not be able to stop the server.
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${LOOPBACK}`);
    } catch {
      return json(res, 403, { error: 'this view needs its own address and secret: open the link pullboard view printed' });
    }
    const given = Buffer.from(String(req.headers['x-pullboard-key'] ?? url.searchParams.get('k') ?? ''));
    const isOwnHost = req.headers.host === `${LOOPBACK}:${bound}` || req.headers.host === `localhost:${bound}`;
    if (!isOwnHost || given.length !== key.length || !timingSafeEqual(given, key)) return json(res, 403, { error: 'this view needs its own address and secret: open the link pullboard view printed' });
    try {
      if (req.method === 'GET' && url.pathname === '/') return reply(res, 200, 'text/html; charset=utf-8', cockpitPage());
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const projects = listProjects().map(summary);
        const root = url.searchParams.get('root');
        const known = projects.find((project) => project.root === root && project.ok);
        const seen = /^\d+$/.test(url.searchParams.get('seen') ?? '') ? Number(url.searchParams.get('seen')) : null;
        return json(res, 200, { projects, project: known ? projectState(known.root, { seen }) : null });
      }
      if (req.method === 'GET' && url.pathname === '/api/code') {
        const root = url.searchParams.get('root');
        if (!listProjects().some((project) => project.root === root)) return json(res, 400, { error: 'not a project on this machine' });
        const ref = /^([^:@]+):(\d+)(?:-(\d+))?@([^@]+)$/.exec(url.searchParams.get('ref') ?? '');
        if (!ref) return json(res, 400, { error: 'a code reference reads path:lines@commit, such as src/serve.js:12-30@be4356b' });
        try {
          const before = (url.searchParams.get('before') ?? '').slice(-200);
          return json(res, 200, codeAt(root, { path: ref[1], from: Number(ref[2]), to: Number(ref[3] ?? ref[2]), commit: ref[4], before }));
        } catch (error) {
          if (error instanceof Refused) return json(res, 400, { error: error.message });
          throw error;
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/act' && String(req.headers['content-type']).startsWith('application/json')) {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 100_000) return json(res, 413, { error: 'too large' });
        }
        const { root, command, args } = JSON.parse(raw || '{}');
        const argv = actionArgs(command, args);
        if (!argv) return json(res, 400, { error: `no action "${command}"` });
        // An action runs only inside a project this machine already knows; agents start boards.
        if (!listProjects().some((project) => project.root === root)) return json(res, 400, { error: 'not a project on this machine' });
        return json(res, 200, { command: `pullboard ${argv.join(' ')}`, ...(await runCli(root, argv)) });
      }
      return json(res, 404, { error: 'no such page' });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  });
  return new Promise((ready, fail) => {
    server.once('error', fail);
    server.listen(port, LOOPBACK, () => {
      bound = /** @type {any} */ (server.address()).port;
      ready({
        url: `http://${LOOPBACK}:${bound}/?k=${secret}`,
        port: bound,
        close: () => new Promise((closed) => server.close(() => closed())),
      });
    });
  });
}
