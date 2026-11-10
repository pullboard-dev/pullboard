/** Immutable main facts are reused without advancing a claimant's working tree [B6,V1]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { readlinkSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { cachedMainFact } from '../../../../../packages/codemap/index.js';
import { mainFactDigest } from '../../../../../packages/codemap/index.js';
import { mainCriterionFacts } from '../../../../../packages/doctrine/index.js';
import { foreignNodeOptions } from '../../../../../packages/gate/index.js';
import { parseSpec } from '../../../../../packages/spec/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { cliClaim$claimFreezer as claimFreezer } from '../../../index.js';
import { loadConfig } from '../../../../../packages/config/index.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();

/** Preserve the runner's preload declaration for nested cache eligibility checks. */
function cacheFixture() {
  const box = e2e.project();
  if (process.env.PULLBOARD_RUNNER_PRELOAD) box.env.PULLBOARD_RUNNER_PRELOAD = process.env.PULLBOARD_RUNNER_PRELOAD;
  return box;
}

/** Bind the same canonical runtime classifier as the actual higher write orchestrator. */
const cacheEligible = () => !foreignNodeOptions(process.env.NODE_OPTIONS);

/** Open only the private fixture's derived-fact database, never its board. */
function cache(box) {
  return new DatabaseSync(join(box.repo, '.git', 'pullboard-main-facts', 'facts.sqlite'));
}

/** Register a real item through the coordinator CLI. */
function item(box, title) {
  const result = fixtureAdd(box.run, box.repo, 'web', title, '--specs', 'G1', '--json');
  assert.equal(result.code, 0, result.err || result.out);
  return String(JSON.parse(result.out).item.item_id);
}

/** Compare every working entry and its actual bytes, including ignored files; Git metadata is outside this oracle. */
function worktreeBytes(root) {
  const entries = [];
  /** Follow directories only, preserving a symlink's own value instead of reading outside the fixture. */
  function visit(path) {
    const file = path ? join(root, path) : root;
    const stat = lstatSync(file);
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) entries.push([path, 'link', mode, readlinkSync(file)]);
    else if (stat.isDirectory()) {
      entries.push([path, 'directory', mode]);
      for (const name of readdirSync(file).sort()) {
        if (!path && name === '.git') continue;
        visit(path ? `${path}/${name}` : name);
      }
    } else entries.push([path, 'file', mode, readFileSync(file)]);
  }
  visit('');
  return entries;
}

test('two real claims derive main inputs once and preserve HEAD, index and working bytes [B6,V1]', () => {
  const box = cacheFixture();
  const first = item(box, 'First cached claim');
  const second = item(box, 'Second cached claim');
  mainCriterionFacts(box.web, { cacheEligible });
  const db = cache(box);
  db.exec(`DELETE FROM facts; CREATE TABLE observed_derivations(n INTEGER NOT NULL);
    INSERT INTO observed_derivations VALUES(0);
    CREATE TRIGGER count_fact_derivation AFTER INSERT ON facts BEGIN UPDATE observed_derivations SET n=n+1; END;`);
  const tracked = join(box.web, 'AGENTS.md');
  writeFileSync(tracked, readFileSync(tracked, 'utf8') + '\nStaged work must survive a claim.\n');
  box.git(box.web, 'add', 'AGENTS.md');
  const head = box.git(box.web, 'rev-parse', 'HEAD');
  const index = box.git(box.web, 'write-tree');
  const spec = readFileSync(join(box.web, 'SPEC.md'));
  const scratch = join(box.web, 'scratch.txt');
  writeFileSync(scratch, 'untracked claim input\n');
  const bytes = worktreeBytes(box.web);
  for (const id of [first, second]) {
    const claimed = box.run(box.web, 'claim', id);
    assert.equal(claimed.code, 0, claimed.err || claimed.out);
    assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), head);
    assert.equal(box.git(box.web, 'write-tree'), index);
    assert.deepEqual(readFileSync(join(box.web, 'SPEC.md')), spec);
    assert.equal(readFileSync(scratch, 'utf8'), 'untracked claim input\n');
    assert.deepEqual(worktreeBytes(box.web), bytes);
    const released = box.run(box.web, 'release', id, '--no-next', '--reason', 'OTHER', '--note', 'Exercise the next independent claim');
    assert.equal(released.code, 0, released.err || released.out);
  }
  assert.equal(db.prepare('SELECT n FROM observed_derivations').get().n, 1);
  db.close();
});

test('wrong-lane and ONE_CLAIM guards refuse before invoking the real criterion provider [B2,B5,C7]', () => {
  const box = cacheFixture();
  const first = item(box, 'Held claim');
  const second = item(box, 'Refused claim');
  const agent = JSON.parse(box.run(box.web, 'whoami', '--json').out).id;
  // @pullboard-board-file journey: the real CLI subprocess persisted this project board, so the claim guards read that file
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const ctx = { info: { root: box.web, isMain: false }, config: loadConfig(box.web) };
    const provider = claimFreezer(ctx, board);
    let invocations = 0;
    /** Count actual calls into the production criterion provider, not cache publication. */
    const freeze = value => { invocations++; return provider(value); };
    const before = store.events(board);
    assert.throws(() => store.prepareClaim(board, Number(second), { agentId: agent, lane: 'api', leaseMs: 60_000, freeze }), { code: 'WRONG_LANE' });
    assert.equal(invocations, 0);
    assert.equal(existsSync(join(box.repo, '.git', 'pullboard-main-facts')), false);
    assert.deepEqual(store.events(board), before);
  } finally { store.closeBoard(board); }
  assert.equal(box.run(box.web, 'claim', first).code, 0);
  const db = cache(box); db.exec('DELETE FROM facts'); db.close();
  // @pullboard-board-file journey: the real CLI subprocess persisted this project board, so the claim guards read that file
  const held = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const ctx = { info: { root: box.web, isMain: false }, config: loadConfig(box.web) };
    const provider = claimFreezer(ctx, held);
    let invocations = 0;
    /** The earlier live claim must stop the actual provider before another derivation. */
    const freeze = value => { invocations++; return provider(value); };
    const before = store.events(held);
    assert.throws(() => store.prepareClaim(held, Number(second), { agentId: agent, lane: 'web', leaseMs: 60_000, freeze }), { code: 'ONE_CLAIM' });
    assert.equal(invocations, 0);
    const observed = cache(box);
    try { assert.equal(observed.prepare('SELECT COUNT(*) AS n FROM facts').get().n, 0); }
    finally { observed.close(); }
    assert.deepEqual(store.events(held), before);
  } finally { store.closeBoard(held); }
});

test('a busy cache falls back to an uncached derivation [B2,C7]', { timeout: 20_000 }, () => {
  // Budget: the production SQLite ten-second busy bound expires once; no scheduling-speed assertion.
  const box = e2e.project();
  cachedMainFact(box.repo, 'busy', ['same-key'], () => ({ rows: [] }), value => Array.isArray(value?.rows));
  const db = cache(box);
  let invocations = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    assert.deepEqual(cachedMainFact(box.repo, 'busy', ['same-key'], () => { invocations++; return { rows: [] }; }, value => Array.isArray(value?.rows)), { rows: [] });
    assert.equal(invocations, 1);
  } finally { db.exec('ROLLBACK'); db.close(); }
});

test('next and submit reuse immutable facts while an exact applied approval stays fresh [B6,V3,S18]', () => {
  const box = e2e.project('true');
  const id = item(box, 'Fresh applied approval');
  const original = mainCriterionFacts(box.web, { cacheEligible });
  const next = box.run(box.web, 'next', '--build');
  assert.equal(next.code, 0, next.err || next.out);
  assert.match(next.out, new RegExp(`claimed #${id}`));
  const approved = box.run(box.repo, 'spec', 'approve', 'G1', '--text', 'The page renders a heading.');
  assert.equal(approved.code, 0, approved.err || approved.out);
  const applied = box.run(box.repo, 'spec', 'apply');
  assert.equal(applied.code, 0, applied.err || applied.out);
  const shown = JSON.parse(box.run(box.repo, 'show', id, '--json').out);
  assert.equal(JSON.parse(shown.item_frozen).rows.find(row => row.id === 'G1').text, 'The page renders a heading.');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', 'fresh.html'), '<h1>Fresh</h1>\n');
  box.git(box.web, 'add', 'web/fresh.html');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): fresh page [G1]');
  const submitted = box.run(box.web, 'submit', id, '--no-next');
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  const stillImmutable = mainCriterionFacts(box.web, { cacheEligible });
  assert.equal(stillImmutable.commit, original.commit);
  assert.equal(stillImmutable.spec.rows.find(row => row.id === 'G1').text, 'The page renders.', 'live approval did not enter the committed cache');
});

test('absent, declining and failed eligibility providers never persist runtime-dependent inputs [B6,V1]', () => {
  const box = e2e.project();
  mainCriterionFacts(box.web, { cacheEligible });
  const db = cache(box);
  db.exec('DELETE FROM facts');
  for (const options of [{}, { cacheEligible: () => false }, { cacheEligible: () => { throw new Error('unknown runtime'); } }]) {
    const value = mainCriterionFacts(box.web, options);
    assert.ok(value.spec.rows.length > 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM facts').get().n, 0);
  }
  mainCriterionFacts(box.web, { cacheEligible });
  assert.equal(db.prepare('SELECT count(*) AS n FROM facts').get().n, 1);
  db.close();
});

test('foreign Git selectors cannot redirect main bytes or the private cache repository [B6,V1]', () => {
  const box = e2e.project();
  const foreign = e2e.project();
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = join(foreign.repo, '.git');
  try {
    const result = cachedMainFact(box.repo, 'root-bound', 'foreign-selector', () => ({ bound: true }), value => value?.bound === true);
    assert.deepEqual(result, { bound: true });
    assert.ok(existsSync(join(box.repo, '.git', 'pullboard-main-facts', 'facts.sqlite')));
    const db = cache(box);
    const key = mainFactDigest(JSON.stringify([1, 'root-bound', 'foreign-selector']));
    assert.ok(db.prepare('SELECT key FROM facts WHERE key=?').get(key));
    db.close();
    const facts = mainCriterionFacts(box.web, { cacheEligible });
    assert.ok(facts);
    assert.equal(facts.commit, box.git(box.repo, 'rev-parse', 'HEAD'));
    assert.deepEqual(facts.spec.rows, parseSpec(readFileSync(join(box.repo, 'SPEC.md'), 'utf8')).rows);
    box.git(box.repo, 'config', 'pullboard.trunk', 'refs/heads/main');
    box.git(box.repo, 'checkout', '--detach');
    const retained = mainCriterionFacts(box.web, { cacheEligible });
    assert.equal(retained.commit, facts.commit, 'a retained trunk is resolved in the requested repository too');
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
});

test('committed source whitespace preserves exact doctrine bytes and spec line positions [B6,V1]', () => {
  const box = e2e.project();
  const original = mainCriterionFacts(box.web, { cacheEligible });
  const spec = join(box.repo, original.specName);
  const doctrine = join(box.repo, original.doctrine.name);
  const specSource = '\n\n' + readFileSync(spec, 'utf8') + '\n';
  const doctrineSource = '\n\n' + readFileSync(doctrine, 'utf8') + '\n\n';
  writeFileSync(spec, specSource);
  writeFileSync(doctrine, doctrineSource);
  box.git(box.repo, 'add', original.specName, original.doctrine.name);
  box.git(box.repo, 'commit', '-q', '-m', 'docs: preserve source whitespace [G1]');
  const facts = mainCriterionFacts(box.web, { cacheEligible });
  assert.deepEqual(facts.spec.rows, parseSpec(specSource).rows);
  assert.equal(facts.doctrine.repo.source, doctrineSource);
});

test('immutable facts invalidate on main advance and never share mutable parsed rows [B6,V1]', () => {
  const box = e2e.project();
  const original = mainCriterionFacts(box.web, { cacheEligible });
  original.spec.rows.length = 0;
  assert.ok(mainCriterionFacts(box.web, { cacheEligible }).spec.rows.length > 0);
  const spec = join(box.repo, 'SPEC.md');
  writeFileSync(spec, readFileSync(spec, 'utf8') + '\n- G99 [approved, must] Newly accepted row. | gate: test\n');
  box.git(box.repo, 'add', 'SPEC.md');
  box.git(box.repo, 'commit', '-q', '-m', 'docs: advance cached main [G1]');
  const advanced = mainCriterionFacts(box.web, { cacheEligible });
  assert.notEqual(advanced.commit, original.commit);
  assert.ok(advanced.spec.rows.some(row => row.id === 'G99'));
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), original.commit);
});

test('damaged facts rebuild, derivation errors propagate once, and identities stay separate [B6,V1]', () => {
  const box = e2e.project();
  let count = 0;
  /** Count real cache misses without changing the derived value's authority. */
  function derive() { count++; return { rows: ['actual'] }; }
  /** Accept only the caller's closed record shape. */
  function valid(value) { return Array.isArray(value?.rows) && value.rows.every(row => typeof row === 'string'); }
  cachedMainFact(box.repo, 'test', ['commit-a', 'parser-a'], derive, valid);
  const copy = cachedMainFact(box.repo, 'test', ['commit-a', 'parser-a'], derive, valid);
  copy.rows.push('caller mutation');
  assert.deepEqual(cachedMainFact(box.repo, 'test', ['commit-a', 'parser-a'], derive, valid), { rows: ['actual'] });
  assert.equal(count, 1);
  const db = cache(box);
  db.exec("UPDATE facts SET body='malformed'");
  db.close();
  cachedMainFact(box.repo, 'test', ['commit-a', 'parser-a'], derive, valid);
  assert.equal(count, 2);
  cachedMainFact(box.repo, 'test', ['commit-a', 'parser-b'], derive, valid);
  assert.equal(count, 3);
  let failures = 0;
  assert.throws(() => cachedMainFact(box.repo, 'test', 'red', () => { failures++; throw new Error('real refusal'); }, valid), /real refusal/u);
  assert.equal(failures, 1);
});

test('two fresh processes racing for one immutable fact perform one actual derivation [B6,V1]', async () => {
  const box = e2e.project();
  const counter = join(box.repo, '.git', 'derive-counter');
  const ready = join(box.repo, '.git', 'ready-');
  const module = new URL('../../../../../packages/codemap/index.js', import.meta.url).href;
  const source = `import { cachedMainFact } from ${JSON.stringify(module)};
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
    const [root, counter, ready, me, peer] = process.argv.slice(1);
    writeFileSync(ready + me, 'ready');
    const until = Date.now() + 10000;
    while (!existsSync(ready + peer)) {
      if (Date.now() > until) throw new Error('peer did not start');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    const value = cachedMainFact(root, 'race', 'same-commit', () => {
      appendFileSync(counter, 'derived\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      return { actual: true };
    }, value => value?.actual === true);
    if (!value.actual) throw new Error('invalid result');`;
  /** Run an actual independent process and preserve any error rather than hiding it behind a count. */
  function child(me, peer) {
    return new Promise((resolve, reject) => {
      const worker = spawn(process.execPath, ['--input-type=module', '-e', source, box.repo, counter, ready, me, peer],
        { cwd: box.repo, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      worker.stdout.on('data', bytes => { output += bytes; });
      worker.stderr.on('data', bytes => { output += bytes; });
      worker.once('error', reject);
      worker.once('close', (code, signal) => {
        if (code === 0 && !signal) resolve();
        else reject(new Error(`fact worker ${code}/${signal}: ${output}`));
      });
    });
  }
  await Promise.all([child('a', 'b'), child('b', 'a')]);
  assert.equal(readFileSync(counter, 'utf8'), 'derived\n');
});

test.after(e2e.cleanup);


test('cache evicts old commits transactionally and reclaims its configured size [B6,C7]', () => {
  const box = e2e.project();
  const previousBytes = process.env.PULLBOARD_MAIN_FACTS_MAX_BYTES;
  const previousRecent = process.env.PULLBOARD_MAIN_FACTS_RECENT_COMMITS;
  process.env.PULLBOARD_MAIN_FACTS_MAX_BYTES = '65536';
  process.env.PULLBOARD_MAIN_FACTS_RECENT_COMMITS = '2';
  try {
    const value = n => ({ payload: String(n).repeat(12000) });
    for (let n = 0; n < 8; n++) cachedMainFact(box.repo, 'bounded', [`commit-${n}`], () => value(n), result => typeof result?.payload === 'string');
    const db = cache(box);
    try {
      const groups = db.prepare('SELECT DISTINCT commit_id FROM facts ORDER BY commit_id').all().map(row => row.commit_id);
      assert.ok(groups.length <= 2, JSON.stringify(groups));
      assert.ok(groups.includes('commit-7'), JSON.stringify(groups));
      assert.ok(db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size <= 65536);
    } finally { db.close(); }
  } finally {
    if (previousBytes === undefined) delete process.env.PULLBOARD_MAIN_FACTS_MAX_BYTES; else process.env.PULLBOARD_MAIN_FACTS_MAX_BYTES = previousBytes;
    if (previousRecent === undefined) delete process.env.PULLBOARD_MAIN_FACTS_RECENT_COMMITS; else process.env.PULLBOARD_MAIN_FACTS_RECENT_COMMITS = previousRecent;
  }
});

test('legacy oversized cache is reclaimed and a smaller limit never changes derived values [B6,C7]', () => {
  const box = e2e.project();
  const directory = join(box.repo, '.git', 'pullboard-main-facts');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'facts.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec('CREATE TABLE facts(key TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL)');
  legacy.prepare('INSERT INTO facts VALUES (?,?,?)').run('old', 'x'.repeat(150000), 'old');
  legacy.close();
  chmodSync(file, 0o600);
  const prior = process.env.PULLBOARD_MAIN_FACTS_MAX_BYTES;
  process.env.PULLBOARD_MAIN_FACTS_MAX_BYTES = '65536';
  try {
    assert.deepEqual(cachedMainFact(box.repo, 'legacy', ['new'], () => ({ actual: true }), value => value?.actual === true), { actual: true });
    const db = cache(box);
    try {
      assert.ok(db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size <= 65536);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM facts WHERE key='old'").get().n, 0);
    } finally { db.close(); }
  } finally {
    if (prior === undefined) delete process.env.PULLBOARD_MAIN_FACTS_MAX_BYTES; else process.env.PULLBOARD_MAIN_FACTS_MAX_BYTES = prior;
  }
});

test('current main retains all namespace facts while older commits rotate [B6,C7]', () => {
  const box = e2e.project();
  const current = box.git(box.repo, 'rev-parse', 'HEAD');
  box.git(box.repo, 'config', 'pullboard.trunk', 'refs/heads/main');
  box.git(box.repo, 'checkout', '--detach');
  const prior = process.env.PULLBOARD_MAIN_FACTS_RECENT_COMMITS;
  process.env.PULLBOARD_MAIN_FACTS_RECENT_COMMITS = '1';
  try {
    const derive = () => ({ value: true }), valid = result => result?.value === true;
    cachedMainFact(box.repo, 'criterion', [current, 'tool'], derive, valid);
    cachedMainFact(box.repo, 'affected', { commit: current, tool: 'tool' }, derive, valid);
    for (let n = 0; n < 4; n++) cachedMainFact(box.repo, 'criterion', [`older-${n}`], derive, valid);
    const db = cache(box);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM facts WHERE commit_id=?').get(current).n, 2);
      assert.equal(db.prepare('SELECT COUNT(DISTINCT commit_id) AS n FROM facts').get().n, 2);
    } finally { db.close(); }
  } finally {
    if (prior === undefined) delete process.env.PULLBOARD_MAIN_FACTS_RECENT_COMMITS; else process.env.PULLBOARD_MAIN_FACTS_RECENT_COMMITS = prior;
  }
});

test('a non-private cache is skipped without changing the computed result [B6,C7]', () => {
  const box = e2e.project();
  const directory = join(box.repo, '.git', 'pullboard-main-facts');
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  chmodSync(directory, 0o755);
  let calls = 0;
  const value = cachedMainFact(box.repo, 'private', ['commit'], () => { calls++; return { actual: true }; }, result => result?.actual === true);
  assert.deepEqual(value, { actual: true });
  assert.equal(calls, 1);
  assert.equal(existsSync(join(directory, 'facts.sqlite')), false);
});
