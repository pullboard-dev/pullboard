/** File moves preserve frozen checks and read-only engineering history [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { checkAtCommit } from '../src/trusted-policy.js';
import { checkBaseline } from '../src/check-baseline.js';
import { itemsTouching } from '../src/why-file.js';
import { rigorReport } from '../src/rigor.js';
import { NATIVE_FLAKE_ENGINE } from '../src/flake-engine.js';
import { coChangedPaths, historicalPaths, mappedCheck, readPathMap } from '../src/path-map.js';
import { createE2eHelpers } from './e2e-helpers.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const OLD = 'web/old-check.mjs', MID = 'web/middle-check.mjs', NEW = 'web/cell/check.mjs';

/** Commit a real rename chain and its plain old-to-new map on a private primary branch. */
function movedFixture() {
  const box = e2e.project('true', undefined, { withWorktree: false });
  mkdirSync(join(box.repo, 'web/cell'), { recursive: true });
  writeFileSync(join(box.repo, OLD), 'console.log("moved-check-executed");\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: original check');
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  renameSync(join(box.repo, OLD), join(box.repo, NEW));
  writeFileSync(join(box.repo, 'path-map.json'), JSON.stringify({ [OLD]: MID, [MID]: NEW }));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: move check into cell');
  const head = box.git(box.repo, 'rev-parse', 'HEAD');
  return { ...box, base, head, command: `node ${OLD}` };
}

test('a frozen check executes the moved file without rewriting its frozen bar [C7]', () => {
  const box = movedFixture();
  const frozen = JSON.stringify({ check: box.command, policy: { commit: box.base } });
  const item = { item_id: 1, item_commit: box.head, item_claim_head: box.base, item_frozen: frozen };
  const ran = checkAtCommit(box.repo, item);
  assert.equal(ran.state, 'pass', ran.report);
  assert.equal(ran.checked, true);
  assert.match(ran.outputTail, /moved-check-executed/u);
  assert.equal(item.item_frozen, frozen);
  const invalid = { ...item, item_commit: 'f'.repeat(40) };
  assert.equal(checkAtCommit(box.repo, invalid).state, 'unverified', 'an unavailable source never earns a green alias');
});

test('co-change identities follow committed chains without duplicates or prefix guesses [C7]', () => {
  const box = movedFixture();
  const map = readPathMap(box.repo);
  assert.deepEqual(new Set(historicalPaths(map, NEW)), new Set([OLD, MID, NEW]));
  assert.deepEqual(coChangedPaths(map, OLD, [[OLD, MID, NEW, 'web/peer.js'], [NEW, 'web/peer.js'], ['web/other.js']]),
    [{ file: 'web/peer.js', count: 2 }]);
  assert.equal(mappedCheck(box.repo, `node '${OLD}' && node ./${OLD}`), `node '${NEW}' && node '${NEW}'`);
  assert.equal(mappedCheck(box.repo, `node ${OLD}.extra --test-name-pattern=${OLD} -e 'console.log("${OLD}")'`),
    `node ${OLD}.extra --test-name-pattern=${OLD} -e 'console.log("${OLD}")'`);
  assert.equal(mappedCheck(box.repo, box.command, { commit: box.base }), box.command, 'the selected historical source owns its map');
  writeFileSync(join(box.repo, 'path-map.json'), JSON.stringify({ [OLD]: 'web/uncommitted.mjs' }));
  assert.equal(mappedCheck(box.repo, box.command), `node '${NEW}'`, 'an uncommitted map cannot redirect a frozen read');
});

test('malformed, cyclic and escaping committed maps cannot partially resolve history [C7]', () => {
  const box = movedFixture();
  for (const value of ['{', 'null', '[]', JSON.stringify({ [OLD]: '../elsewhere.js' }),
    JSON.stringify({ [OLD]: '/tmp/elsewhere.js' }), JSON.stringify({ [OLD]: 'web/../elsewhere.js' }),
    JSON.stringify({ [OLD]: 'web\\\\elsewhere.js' }), JSON.stringify({ [OLD]: MID, [MID]: OLD })]) {
    writeFileSync(join(box.repo, 'path-map.json'), value);
    box.git(box.repo, 'add', 'path-map.json');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: record malformed map fixture');
    assert.throws(() => readPathMap(box.repo), error => error.code === 'NO_POLICY');
  }
});

test('a check baseline resolves paths at its selected main and retains the recorded command [C7]', () => {
  const box = movedFixture();
  const captured = checkBaseline(box.repo, box.command);
  assert.equal(captured.result, 'green', JSON.stringify(captured));
  assert.equal(captured.command, box.command);
  assert.equal(captured.main, box.head);
  assert.equal(checkBaseline(box.repo, box.command, { main: box.base }).result, 'green', 'the old source keeps its old path');
});

test('why on an old name includes work landed at the new name [C7]', () => {
  const box = e2e.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.landing = { publish: 'separate' };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure private history landing');
  /** Run one public board move and retain its real result. */
  const json = (cwd, ...args) => {
    const result = box.run(cwd, ...args, '--json');
    assert.equal(result.code, 0, result.err || result.out);
    return JSON.parse(result.out);
  };
  /** Build, independently check and land an actual fixture item before querying its trailer. */
  const land = (id, file, content) => {
    json(box.repo, 'add', 'web', `Path history ${id}`, '--specs', 'G1', '--criterion', 'the named file exists', '--check', `test -f ${file}`);
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    json(box.web, 'claim', String(id));
    assert.equal(e2e.commitFile(box, box.web, file, content, 'feat(web): preserve moved history [G1]').status, 0);
    const submitted = json(box.web, 'submit', String(id));
    box.git(box.repo, 'switch', '-q', '--detach', submitted.commit);
    try { json(box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'The named fixture file exists at the submitted source.'); }
    finally { box.git(box.repo, 'switch', '-q', 'main'); }
    assert.deepEqual(json(box.repo, 'land').landed, [id]);
  };
  land(1, OLD, 'console.log("before-move");\n');
  mkdirSync(join(box.repo, 'web/cell'), { recursive: true });
  renameSync(join(box.repo, OLD), join(box.repo, NEW));
  writeFileSync(join(box.repo, 'path-map.json'), JSON.stringify({ [OLD]: MID, [MID]: NEW }));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: move history into cell');
  land(2, NEW, 'console.log("after-move");\n');
  assert.deepEqual(itemsTouching(box.repo, { file: OLD, line: null }), [1, 2]);
  assert.deepEqual(itemsTouching(box.repo, { file: NEW, line: null }), [1, 2]);
});

test('flake and Rigor read projections join moved names while original SQLite events stay unchanged [C7]', () => {
  const box = movedFixture();
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    const actor = store.register(board, { lane: 'web', path: join(box.dir, 'observation-seat') });
    /** Synthetic receipt metadata tests identity projection without claiming a native flake. */
    const receipt = green => ({ green, sha256: (green ? 'a' : 'b').repeat(64), bytes: 1,
      artifact: `flake-evidence/fixture/${green ? 'paired' : 'original'}.log`, profileSha256: null });
    for (const [index, file] of [OLD, NEW].entries()) {
      store.recordFlakeObservation(board, { agentId: actor, lane: 'web', observation: {
        id: `path-map-synthetic-${index}`, file, name: 'synthetic path identity fixture', head: box.head,
        tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}'), main: box.head,
        kind: 'check', classification: 'flake', reason: 'Synthetic ledger metadata; no flake execution is claimed.',
        commandSha256: 'c'.repeat(64), at: new Date().toISOString(), diagnosticMs: 1,
        load: { average: [0, 0, 0], cpus: 1, freeMB: 100 }, original: receipt(false), paired: receipt(true), mainReceipt: null } });
    }
    const before = store.events(board);
    const projected = store.flakeLedger(board, { root: box.repo });
    assert.equal(projected.length, 1);
    assert.equal(projected[0].file, NEW);
    assert.equal(projected[0].count, 2);
    assert.deepEqual(projected[0].observations.map(value => value.file), [OLD, NEW]);
    const history = before.filter(event => event.event_kind === 'flake-observation');
    assert.ok(history.every(event => JSON.parse(event.event_detail).engine === NATIVE_FLAKE_ENGINE));
    const causes = rigorReport(history, { person: 'person', root: box.repo }).causes;
    assert.equal(causes.length, 1);
    assert.equal(causes[0].key, `test:${NEW}::synthetic path identity fixture`);
    assert.equal(causes[0].occurrences, 2);
    assert.deepEqual(store.events(board), before, 'queries never rewrite source observations or their authority');
  } finally { store.closeBoard(board); }
});
