/** Shared real CLI, Git and SQLite dispatch setup [N2,V1,B3]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { main } from '../native.js';
import { loadConfig } from '../../../../../packages/config/index.js';
import {
  applyRelayMove,
  appliedSequence,
  prepareEngineMove,
} from '../../../../../packages/state/index.js';
import { scanHealthSentinel } from '../../../../../packages/sentinels/index.js';
import { heartbeatSeat } from '../../../../../packages/store/index.js';
import { machineSettingsFile } from '../../../../../packages/config/index.js';
import { submitFixture } from '../board/submit.js';
import { runFixtureGit } from '../child.js';

/** Run the actual command parser and operation pipeline against this fixture's clock. */
export async function cli(box, cwd, args, hooks = {}) {
  let out = '', err = '';
  const code = await main([...args, '--json'], { ...hooks, cwd, clock: box.clock,
    stdout: { isTTY: false, write: part => { out += part; } },
    stderr: { write: part => { err += part; } } });
  return { code, out, err, document: out.trim() ? JSON.parse(out) : null };
}

/** Close a dispatch fixture and retry transient ENOTEMPTY races while child work drains. */
async function cleanupFixture(directory, board, original) {
  try {
    store.closeBoard(board);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

/** Isolate real worktrees and shared SQLite; only the explicitly injected clock advances time. */
export async function fixture(t, { route = 'strong', family = 'off', policy = 'any', files = {}, mainRed = false } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-next-take-')));
  const root = join(directory, 'repo');
  mkdirSync(root);
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  /** Keep private Git hooks on this exact checkout's CLI, including paths containing quotes. */
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('../../../pullboard.js', import.meta.url)))} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const overrides = { PULLBOARD_HOME: join(directory, 'home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const original = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  let at = Date.parse('2026-10-25T10:00:00.000Z');
  const clock = { now: () => new Date(at) };
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH,
    GIT_AUTHOR_NAME: 'Dispatch fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Dispatch fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  /** Run only real, isolated Git with the private hook executable. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', ...(mainRed ? { affectedTests: 'node --test' } : {}), verify: { policy, family }, review: { independence: 'session' },
    lanes: { web: { owns: ['web/'] }, review: { owns: [] }, docs: { owns: ['docs/'] } } }));
  writeFileSync(join(root, 'SPEC.md'), `# Dispatch fixture\n## G\n- G1 [approved, must] Work keeps its evidence. | gate: ${mainRed ? 'test/main-red.test.js' : 'true'}\n${mainRed ? '- G2 [approved, must] Other work keeps its evidence. | gate: true\n' : ''}`);
  if (mainRed) {
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'test/main-red.test.js'), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('current main is actually red [G1]', () => assert.equal(1, 2));\n`);
  }
  writeFileSync(join(root, 'DOCTRINE.md'), '# Fixture rules\n');
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'chore: initialize dispatch fixture [G1]');
  const settings = machineSettingsFile();
  mkdirSync(join(directory, 'machine'), { recursive: true });
  writeFileSync(settings, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { runnerDispatch: 'controller' } }));
  const initialized = await cli({ clock }, root, ['init']);
  assert.equal(initialized.code, 0, initialized.out + initialized.err);
  const file = join(root, '.git/pullboard/board.sqlite');
  // @pullboard-board-file journey: share the durable board initialized by the real CLI and selected by its worktree dispatch.
  const board = openBoard(file, clock, { gitRoot: root });
  const seats = {};
  for (const [name, lane, parent, vendor] of [
    ['actor', 'web', 'fixture-A', 'Family Alpha'], ['builder', 'web', 'fixture-P', 'Family Alpha'],
    ['sibling', 'review', 'fixture-P', 'Family Beta'], ['sameFamily', 'review', 'fixture-Q', 'Family Alpha'],
    ['outside', 'review', 'fixture-R', 'Family Beta'],
  ]) {
    const path = join(directory, name);
    git(root, 'worktree', 'add', '-q', '-b', `${lane}/${name}`, path);
    const id = store.register(board, { lane, path, parent, family: vendor, route: name === 'actor' ? route : 'strong' });
    seats[name] = { id, path, lane };
    heartbeatSeat(board, id);
  }
  const config = loadConfig(root);
  const box = { root, file, board, clock, seats, config, git, advance: ms => { at += ms; } };
  /** File an ordinary runnable item; tests never prefilter a candidate list for next. */
  box.add = (title, options = {}) => {
    const wanted = options.route ?? route;
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title,
      criterion: 'The real fixture succeeds.', check: 'true', specIds: ['G1'],
      brief: `Files: ${options.lane === 'docs' ? 'docs' : 'web'}/dispatch.js\nTest: the real board selects the eligible item and retains its ownership.`, ...options,
      route: wanted === 'light' ? 'mid' : wanted });
    if (wanted === 'light') {
      // The diagnosis names the item's own files, so a disjoint brief stays disjoint from other claims' diagnoses.
      store.appendFact(board, id, { agentId: seats.builder.id, kind: 'diagnosis',
        text: `${options.brief?.match(/^Files:.*$/mu)?.[0] ?? 'Files: web/dispatch.js'}\nChange: prepare a small dispatch fixture\nTest case: native next assigns the item to an eligible seat.` });
      if (store.getItem(board, id).item_route !== 'light') store.editItem(board, id, { agentId: 'coordinator', route: 'light', reason: 'Private light dispatch fixture' });
    }
    return id;
  };
  /** Set up authentic board ownership without claiming execution of a gate. */
  box.claim = (id, seat = seats.builder) => store.claim(board, id, { agentId: seat.id, lane: seat.lane,
    leaseMs: 3_600_000, freeze: item => {
      const text = JSON.stringify({ title: item.item_title, criterion: item.item_criterion, check: item.item_check, rows: [] });
      return { text, digest: createHash('sha256').update(text).digest('hex') };
    } });
  /** Publish synthetic board state at a real reachable commit, explicitly without a gate receipt. */
  box.submit = id => {
    box.claim(id);
    const head = git(seats.builder.path, 'rev-parse', 'HEAD');
    submitFixture(board, id, { agentId: seats.builder.id, commit: head, tree: git(root, 'rev-parse', `${head}^{tree}`) });
  };
  /** Apply the real health observation through authenticated ordered replay. */
  box.scan = () => {
    const observation = scanHealthSentinel(file, { root, config, now: clock.now(), cpu: () => [] });
    if (!observation) return null;
    const move = prepareEngineMove(board, 'recordHealthFindings', [{ agentId: 'coordinator', ...observation }], { actor: 'coordinator' });
    const result = applyRelayMove(board, move, { sequence: appliedSequence(board) + 1, at: clock.now().toISOString(),
      kind: 'move', sender: { kind: 'agent', agent: 'coordinator', userId: 'fixture-user' } });
    assert.equal(result.error, undefined, JSON.stringify(result));
    return result;
  };
  t.after(() => cleanupFixture(directory, board, original));
  return box;
}
