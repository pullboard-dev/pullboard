import { flakeLedger as nativeFlakeLedger } from '../../../../packages/flakes/index.js';
import { recordFlakeObservation as nativeRecordFlakeObservation } from '../../../../packages/flakes/index.js';
/** File moves preserve frozen checks and read-only engineering history [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { checkAtCommit } from '../../../runner/index.js';
import { checkBaseline } from '../../../../packages/gate/index.js';
import { itemsTouching } from '../../../../packages/commits/index.js';
import { rigorReport } from '../../../../packages/store/index.js';
import { NATIVE_FLAKE_ENGINE } from '../../../../packages/state/light.js';
import {
  coChangedPaths,
  historicalPaths,
  mappedCheck,
  readPathMap,
} from '../../../../packages/codemap/index.js';
import {
  prepareCauseProof,
  runCheckAt,
} from '../../../../packages/rigor/index.js';
import { parseProcessCensus } from '../../../../packages/kernel/light.js';
import { proveCauseCheck } from '../../../../packages/rigor/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';

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

test('native check, submit and independent verification execute the old frozen path after a move [C7]', async () => {
  const box = movedFixture();
  const web = join(box.dir, 'path-map-builder');
  box.git(box.repo, 'worktree', 'add', '-q', web, '-b', 'web/path-map-builder');
  /** A successful public command supplies each observed board result. */
  const json = async (cwd, ...args) => {
    const result = await box.runLocal(cwd, ...args, '--json');
    assert.equal(result.code, 0, result.err || result.out);
    return JSON.parse(result.out);
  };
  await json(web, 'join', 'web');
  await json(box.repo, 'add', 'web', 'Mapped frozen command', '--specs', 'G1', '--criterion', 'the moved command executes', '--brief', 'Files: web/old-check.mjs\nTest: the moved command executes', '--check', box.command);
  await json(web, 'claim', '1');
  const before = (await json(web, 'show', '1')).item_frozen;
  assert.equal((await json(web, 'check', '1', '--yes')).green, true);
  assert.equal(e2e.commitFile(box, web, 'web/item.txt', 'built\n', 'feat(web): build mapped fixture [G1]').status, 0);
  const submitted = await json(web, 'submit', '1');
  box.git(box.repo, 'switch', '-q', '--detach', submitted.commit);
  try { await json(box.repo, 'verify', '1', 'accept', '--as', 'coordinator', '--note', 'The original frozen command executes the mapped file.'); }
  finally { box.git(box.repo, 'switch', '-q', 'main'); }
  assert.equal((await json(web, 'show', '1')).item_frozen, before);
});

test('Rigor requires its census provider before starting a proof or acquiring its lease [C7,D1]', async () => {
  const box = e2e.project('true', undefined, { withWorktree: false });
  const commit = box.git(box.repo, 'rev-parse', 'HEAD');
  const marker = join(box.dir, 'unexpected-proof');
  const before = box.git(box.repo, 'worktree', 'list', '--porcelain');
  await assert.rejects(runCheckAt(box.repo, commit, 'unused', {
    executable: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
  }), error => error.code === 'RIGOR_UNPROVEN' && /census parser/u.test(error.message));
  const cause = { key: 'work:missing-census', items: [{ id: 1, commits: [commit] }] };
  await assert.rejects(proveCauseCheck(box.repo, cause, { check: 'true', red: commit, green: commit }),
    error => error.code === 'RIGOR_UNPROVEN' && /census parser/u.test(error.message));
  assert.equal(existsSync(marker), false, 'a missing custody provider cannot execute the real proof child');
  assert.equal(box.git(box.repo, 'worktree', 'list', '--porcelain'), before, 'the missing provider leaves no proof worktree');
});

test('a named Rigor proof checks the actual old red file and moved green file [C7]', async () => {
  const box = e2e.project('true', undefined, { withWorktree: false });
  const title = 'mapped proof [C7]';
  mkdirSync(join(box.repo, 'web/cell'), { recursive: true });
  const source = expected => `import test from 'node:test'; import assert from 'node:assert/strict'; test('${title}', () => assert.equal(1, ${expected}));\n`;
  writeFileSync(join(box.repo, OLD), source(2));
  box.git(box.repo, 'add', '-A'); box.git(box.repo, 'commit', '-q', '-m', 'chore: seed failing named proof');
  const red = box.git(box.repo, 'rev-parse', 'HEAD');
  renameSync(join(box.repo, OLD), join(box.repo, NEW));
  writeFileSync(join(box.repo, NEW), source(1));
  writeFileSync(join(box.repo, 'path-map.json'), JSON.stringify({ [OLD]: NEW }));
  box.git(box.repo, 'add', '-A'); box.git(box.repo, 'commit', '-q', '-m', 'chore: repair and move named proof');
  const green = box.git(box.repo, 'rev-parse', 'HEAD');
  // Synthetic noticed metadata tests source binding; the two checks below execute real Node tests.
  const cause = { key: `test:${NEW}::${title}`, items: [{ id: 1, commits: [red] }] };
  const prepared = await prepareCauseProof(box.repo, cause, { check: `node --test ${NEW}`, red, green });
  assert.equal(prepared.runner.filesAt[red], OLD);
  assert.equal(prepared.runner.filesAt[green], NEW);
  const failed = await runCheckAt(box.repo, red, prepared.check, prepared.runner, { parseProcessCensus });
  const passed = await runCheckAt(box.repo, green, prepared.check, prepared.runner, { parseProcessCensus });
  assert.equal(failed.exit, 1);
  assert.equal(passed.exit, 0);
  assert.match(failed.stdout, /not ok 1 - mapped proof/u);
  assert.match(passed.stdout, /ok 1 - mapped proof/u);
});

test('why on an old name includes work landed at the new name [C7]', async () => {
  const box = e2e.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.landing = { ...config.landing, manualOverride: true, publish: 'separate' };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure private history landing');
  /** Run one public board move and retain its real result. */
  const json = async (cwd, ...args) => {
    const result = await box.runLocal(cwd, ...args, '--json');
    assert.equal(result.code, 0, result.err || result.out);
    return JSON.parse(result.out);
  };
  /** Build, independently check and land an actual fixture item before querying its trailer. */
  const land = async (id, file, content) => {
    await json(box.repo, 'add', 'web', `Path history ${id}`, '--specs', 'G1', '--criterion', 'the named file exists', '--brief', `Files: ${file}\nTest: the named file exists`, '--check', `test -f ${file}`);
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    await json(box.web, 'claim', String(id));
    assert.equal(e2e.commitFile(box, box.web, file, content, 'feat(web): preserve moved history [G1]').status, 0);
    const submitted = await json(box.web, 'submit', String(id));
    box.git(box.repo, 'switch', '-q', '--detach', submitted.commit);
    try { await json(box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'The named fixture file exists at the submitted source.'); }
    finally { box.git(box.repo, 'switch', '-q', 'main'); }
    assert.deepEqual((await json(box.repo, 'land')).landed, [id]);
  };
  await land(1, OLD, 'console.log("before-move");\n');
  mkdirSync(join(box.repo, 'web/cell'), { recursive: true });
  renameSync(join(box.repo, OLD), join(box.repo, NEW));
  writeFileSync(join(box.repo, 'path-map.json'), JSON.stringify({ [OLD]: MID, [MID]: NEW }));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: move history into cell');
  await land(2, NEW, 'console.log("after-move");\n');
  assert.deepEqual(itemsTouching(box.repo, { file: OLD, line: null }), [1, 2]);
  assert.deepEqual(itemsTouching(box.repo, { file: NEW, line: null }), [1, 2]);
});

test('flake and Rigor read projections join moved names while original SQLite events stay unchanged [C7]', async () => {
  const box = movedFixture();
  /** @pullboard-board-file persistence: the case proves the original SQLite events on disk stay unchanged after a move. */
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    const actor = store.register(board, { lane: 'web', path: join(box.dir, 'observation-seat') });
    /** Synthetic receipt metadata tests identity projection without claiming a native flake. */
    const receipt = green => ({ green, sha256: (green ? 'a' : 'b').repeat(64), bytes: 1,
      artifact: `flake-evidence/fixture/${green ? 'paired' : 'original'}.log`, profileSha256: null });
    for (const [index, file] of [OLD, OLD, NEW, NEW].entries()) {
      nativeRecordFlakeObservation(board, { agentId: actor, lane: 'web', observation: {
        id: `path-map-synthetic-${index}`, file, name: 'synthetic path identity fixture', head: box.head,
        tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}'), main: box.head,
        kind: 'check', classification: 'flake', reason: 'Synthetic ledger metadata; no flake execution is claimed.',
        commandSha256: 'c'.repeat(64), at: new Date().toISOString(), diagnosticMs: 1,
        load: { average: [0, 0, 0], cpus: 1, freeMB: 100 }, original: receipt(false), paired: receipt(true), mainReceipt: null } });
    }
    const before = store.events(board);
    const projected = nativeFlakeLedger(board, { root: box.repo });
    assert.equal(projected.length, 1);
    assert.equal(projected[0].file, NEW);
    assert.equal(projected[0].count, 4);
    assert.deepEqual(projected[0].observations.map(value => value.file), [OLD, OLD, NEW, NEW]);
    assert.equal(projected[0].repairs.length, 2, 'both independently drafted repair relationships survive joining');
    const oldReader = join(box.dir, 'old-reader');
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', oldReader, box.base);
    assert.deepEqual(nativeFlakeLedger(board, { root: oldReader }), projected, 'an old reader uses the primary branch map');
    const printed = await box.runLocal(oldReader, 'flakes');
    assert.equal(printed.code, 0, printed.err);
    for (const id of projected[0].repairs) assert.match(printed.out, new RegExp(`#${id}\\b`, 'u'));
    const history = before.filter(event => event.event_kind === 'flake-observation');
    assert.ok(history.every(event => JSON.parse(event.event_detail).engine === NATIVE_FLAKE_ENGINE));
    const causes = rigorReport(history, { person: 'person', root: box.repo }).causes;
    assert.equal(causes.length, 1);
    assert.equal(causes[0].key, `test:${NEW}::synthetic path identity fixture`);
    assert.equal(causes[0].occurrences, 4);
    assert.deepEqual(rigorReport(history, { person: 'person', root: oldReader }).causes, causes);
    assert.deepEqual(store.events(board), before, 'queries never rewrite source observations or their authority');
  } finally { store.closeBoard(board); }
});

test('a split test-name pattern stays data while its positional file follows the map [C7]', () => {
  const box = movedFixture();
  writeFileSync(join(box.repo, NEW), `import {test} from 'node:test'; test(${JSON.stringify(OLD)},()=>console.log('SELECTED_OLD_TITLE')); test('unselected',()=>{throw Error('must stay unselected')});\n`);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: name a private case after its original file');
  const command = `node --test --test-name-pattern ${OLD} ${OLD}`;
  assert.equal(mappedCheck(box.repo, command), `node --test --test-name-pattern ${OLD} '${NEW}'`);
  assert.equal(mappedCheck(box.repo, `node --test --test-name-pattern=${OLD} ${OLD}`),
    `node --test --test-name-pattern=${OLD} '${NEW}'`, 'equals-form selector stays unchanged');
  const item = { item_id: 1, item_commit: box.git(box.repo, 'rev-parse', 'HEAD'), item_claim_head: box.base,
    item_frozen: JSON.stringify({ check: command, policy: { commit: box.base } }) };
  const env = { ...process.env };
  // Node's inherited test harness context would silently skip this independent nested test command.
  delete env.NODE_TEST_CONTEXT;
  const script = `import {checkAtCommit} from ${JSON.stringify(new URL('../../../runner/index.js', import.meta.url).href)};
console.log(JSON.stringify(checkAtCommit(${JSON.stringify(box.repo)},${JSON.stringify(item)})));`;
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: box.repo, env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.state, 'pass', result.report);
  assert.match(result.outputTail, /SELECTED_OLD_TITLE/u);
});

test('a file-looking grep pattern stays data while its positional input follows the map [C7]', () => {
  const box = movedFixture();
  writeFileSync(join(box.repo, NEW), OLD + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: retain an original path as private searched data');
  const command = `grep -F ${OLD} ${OLD}`;
  assert.equal(mappedCheck(box.repo, command), `grep -F ${OLD} '${NEW}'`);
  const item = { item_id: 1, item_commit: box.git(box.repo, 'rev-parse', 'HEAD'), item_claim_head: box.base,
    item_frozen: JSON.stringify({ check: command, policy: { commit: box.base } }) };
  const result = checkAtCommit(box.repo, item);
  assert.equal(result.state, 'pass', result.report);
  assert.match(result.outputTail, /web\/old-check\.mjs/u);
});


test('literal operand roles preserve data flags quoting boundaries and unknown commands [C7]', () => {
  const box = movedFixture();
  assert.equal(mappedCheck(box.repo, `node --test --test-skip-pattern '${OLD}' --test-reporter ${OLD} ${OLD}`),
    `node --test --test-skip-pattern '${OLD}' --test-reporter ${OLD} '${NEW}'`);
  assert.equal(mappedCheck(box.repo, `grep -F -e '${OLD}' ${OLD} && node '${OLD}'`),
    `grep -F -e '${OLD}' '${NEW}' && node '${NEW}'`);
  assert.equal(mappedCheck(box.repo, `grep -f ${OLD} ${OLD}`), `grep -f '${NEW}' '${NEW}'`);
  for (const command of [`custom --selector ${OLD} ${OLD}`, `node --unknown-option ${OLD} ${OLD}`,
    `grep --unknown-option ${OLD} ${OLD}`, `node --test ${OLD} > ${OLD}`,
    `node --test ${OLD} # ${OLD}`]) assert.equal(mappedCheck(box.repo, command), command);
});


test('ordinary script arguments eval expressions and shell comments never become mapped files [C7]', () => {
  const box = movedFixture();
  for (const command of [`node script.mjs --test ${OLD}`, `node script.mjs --test-name-pattern ${OLD}`,
    `node --eval=${OLD} ${OLD}`, `node --print=${OLD} ${OLD}`,
    `# comment && node ${OLD}`, `node --test ${OLD} # comment && node ${OLD}`]) {
    assert.equal(mappedCheck(box.repo, command), command);
  }
  assert.equal(mappedCheck(box.repo, `# comment && node ${OLD}\nnode ${OLD}`),
    `# comment && node ${OLD}\nnode '${NEW}'`, 'a real newline ends the shell comment');
  assert.equal(mappedCheck(box.repo, `grep -e '#' ${OLD}`), `grep -e '#' '${NEW}'`, 'a quoted hash is pattern data');
  assert.equal(mappedCheck(box.repo, `node --test \\# && node ${OLD}`),
    `node --test \\# && node '${NEW}'`, 'an escaped hash does not start a shell comment');
});
