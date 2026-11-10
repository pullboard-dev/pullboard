/** @pullboard-test-loads src/brief.js packages/store/src/io/board.js packages/state/src/io/engine.js packages/state/src/io/machine.js src/board-engine-ports.js */
/** External references stay distinct from the board's requirement and dependency links [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { briefSections } from '../../../../packages/spec/index.js';
import * as store from '../../../../packages/store/index.js';
import {
  openBoard,
  nativeBoardPorts,
} from '../../../lib/index.js';
import { minimumMoveEngine } from '../../../../packages/moves/index.js';
import { REFERENCE_ENGINE } from '../../../../packages/state/light.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
const { relaySenderProblem } = nativeBoardPorts().enginePorts;
import {
  AGENT_SHELL_MARKERS,
  SSH_SHELL_MARKERS,
} from '../../../../packages/kernel/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  referenceLines,
  referenceAcknowledged,
} from '../../../../packages/spec/index.js';
import {
  bridgeProject,
  bridgeProvider,
  landBridgeItems,
  runBridgeCLI,
  runBridgeCLIAs,
} from '../../tests/fixtures/bridge.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

test('changelog matching distinguishes issue numbers and accepts Markdown acknowledgement links [C7]', () => {
  const reference = { target: 'https://github.com/example/project/issues/1', handle: 'Reporter' };
  assert.equal(referenceAcknowledged(reference, ['https://github.com/example/project/issues/10 @Reporter']), false);
  assert.equal(referenceAcknowledged(reference, ['https://github.com/example/project/issues/1/other @Reporter']), false);
  assert.equal(referenceAcknowledged(reference, ['[issue](https://github.com/example/project/issues/1), thanks @reporter.']), true);
  assert.equal(referenceAcknowledged(reference, ['https://github.com/example/project/issues/1 @ReporterOther']), false);
});

test('reference points 19 and 23: only explicitly labelled lines can acknowledge someone [C7]', () => {
  const brief = 'Reference: https://example.com/public @Reporter\nprivate unlabelled continuation @PrivatePerson\nReference: https://example.com/private';
  assert.deepEqual(referenceLines(brief), [
    { text: 'https://example.com/public @Reporter', target: 'https://example.com/public', handle: 'Reporter' },
    { text: 'https://example.com/private', target: 'https://example.com/private', handle: null },
  ]);
});

test('reference point 23: actual PR create and update publish handled references and keep all others private [C7,B3,R3]', async t => {
  const box = bridgeProject(t);
  const publicReference = 'https://example.com/acknowledged-report';
  const privateReference = 'https://example.com/PRIVATE-REFERENCE-SENTINEL';
  const privateContinuation = 'PRIVATE-CONTINUATION-SENTINEL @PrivatePerson';
  const entries = landBridgeItems(box, { briefs: [
    `Reference: ${publicReference} @Reporter\n${privateContinuation}\nReference: ${privateReference}`,
    'Reference: PRIVATE-CONVERSATION-SENTINEL',
  ] });
  const provider = await bridgeProvider(t, box);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const published = await runBridgeCLI(box, 'publish', '--json');
    assert.equal(published.code, 0, published.err || published.out);
    assert.equal(provider.pulls.length, 1);
    const pull = provider.pulls[0];
    assert.ok(pull.body.includes(publicReference), 'the acknowledged reference is included in the actual provider body');
    assert.ok(pull.body.includes('@Reporter'));
    for (const entry of entries) assert.ok(pull.body.includes(entry.commit), 'existing exact accepted receipt remains');
    assert.equal(box.git(box.remote, 'rev-parse', 'main'), box.published, 'the protected remote remains unchanged');
  }
  const outgoing = JSON.stringify(provider.requests.filter(request => request.method !== 'GET').map(request => request.body));
  for (const secret of [privateReference, privateContinuation, 'PRIVATE-CONVERSATION-SENTINEL', '@PrivatePerson']) {
    assert.equal(outgoing.includes(secret), false, `unhandled private reference never leaves the board: ${secret}`);
  }
  assert.equal(provider.requests.some(request => request.path.endsWith('/merge') && request.method !== 'GET'), false);
});

test('reference point 21: shipping checks only the selected release and every landed handled reference [C7,N26]', t => {
  const box = bridgeProject(t);
  const shared = 'https://example.com/shared @Reporter';
  const first = 'https://example.com/first @FirstReporter';
  const second = 'https://example.com/second @SecondReporter';
  const entries = landBridgeItems(box, { briefs: [
    `Reference: ${shared}\nReference: ${first}\nReference: PRIVATE-RELEASE-SENTINEL`,
    `Reference: ${shared}\nReference: ${second}`,
  ] });
  assert.equal(box.run(box.repo, 'milestone', 'add', '0.9.3', '--reason', 'Arrange fixture release', '--items', entries.map(entry => entry.id).join(',')).code, 0);
  assert.equal(box.run(box.repo, 'milestone', 'add', '0.9.4').code, 0);
  const future = fixtureAdd(box.run, box.repo, 'web', 'Unlanded acknowledgement', '--brief', 'Reference: https://example.com/unlanded @LaterReporter', '--json');
  assert.equal(future.code, 0, future.err || future.out);
  assert.equal(box.run(box.repo, 'milestone', 'items', '0.9.3', '--reason', 'Arrange fixture release', '--add', String(JSON.parse(future.out).item.item_id)).code, 0);
  /** Commit the actual release section so the check cannot read unrelated working-tree edits. */
  const changelog = lines => {
    writeFileSync(join(box.repo, 'CHANGELOG.md'), `# Changelog\n\n## [0.9.3]\n${lines.join('\n')}\n\n## [0.9.2]\n- ${shared}\n- ${first}\n- ${second}\n`);
    box.git(box.repo, 'add', 'CHANGELOG.md');
    box.git(box.repo, 'commit', '-q', '-m', 'docs: prepare release acknowledgements [G1]');
  };
  changelog(['Release preparation.']);
  const missing = box.run(box.repo, 'milestone', 'ship', '0.9.3', '--json');
  assert.equal(missing.code, 1, 'older release acknowledgements cannot satisfy this release');
  const refusal = JSON.parse(missing.out).error;
  assert.equal(refusal.code, 'REFERENCES_MISSING');
  for (const reference of [shared, first, second]) assert.ok(refusal.message.includes(reference), refusal.message);
  assert.equal(refusal.message.includes('PRIVATE-RELEASE-SENTINEL'), false);
  assert.equal(refusal.message.includes('unlanded'), false);
  changelog([`- ${shared}`, `- ${first}`, `- ${second}`]);
  const shipped = box.run(box.repo, 'milestone', 'ship', '0.9.3', '--json');
  assert.equal(shipped.code, 0, shipped.err || shipped.out);
});

test('reference point 19: repeated external references remain separate labelled brief entries [C7]', () => {
  const references = [
    'https://github.com/example/project/issues/10 @Reporter',
    'a private conversation with the maintainer',
    'src/feature.js:12@' + 'a'.repeat(40),
  ];
  const brief = ['Files: web/site.js', ...references.map(value => 'Reference: ' + value), 'Test: node --test test/site.test.js'].join('\n');
  const sections = briefSections(brief);
  assert.deepEqual(sections.reference, references, 'every reference has its own entry, preserving private text and the explicit acknowledgement');
  assert.deepEqual(sections.files, ['web/site.js'], 'references never become file instructions');
  assert.deepEqual(sections.test, ['node --test test/site.test.js']);
});

test('historical brief references retain their old routing grammar and replay floor [C7,H16]', t => {
  const e2e = createE2eHelpers();
  const box = e2e.project('true');
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  t.after(() => { store.closeBoard(board); e2e.cleanup(); });
  const brief = 'Files: web/site.js\nReference: H21';
  assert.deepEqual(briefSections(brief, { references: false }).files, ['web/site.js', 'Reference: H21']);
  const addition = { by: 'coordinator', lane: 'web', title: 'Historical reference', brief };
  assert.equal(minimumMoveEngine('addItem', [addition]), 1, 'unstructured historical text never gains a new replay floor');
  assert.equal(minimumMoveEngine('editItem', [1, { agentId: 'coordinator', brief }]), 1);
  board.executionEngineVersion = REFERENCE_ENGINE - 1;
  const id = store.addItem(board, addition);
  store.editItem(board, id, { agentId: 'coordinator', brief });
  delete board.executionEngineVersion;
  store.editItem(board, id, { agentId: 'coordinator', criterion: 'An unrelated edit preserves legacy text.' });
  assert.equal(store.getItem(board, id).item_brief, brief);
  assert.throws(() => store.addItem(board, addition), { code: 'REFERENCE_IS_BOARD' }, 'new moves use the new validation');
});

test('reference point 22: add and edit refuse board-only references with the right flags [C7]', t => {
  const e2e = createE2eHelpers();
  const box = e2e.project('true');
  t.after(() => e2e.cleanup());
  const valid = fixtureAdd(box.run, box.repo, 'web', 'An external reference', '--brief', 'Reference: https://example.com/report', '--json');
  assert.equal(valid.code, 0, valid.err || valid.out);
  const id = JSON.parse(valid.out).item.item_id;
  for (const [reference, flag] of [['H21', '--specs H21'], ['#17', '--after'], ['17', '--after']]) {
    for (const args of [
      ['add', 'web', 'Board ids have their own flags'],
      ['edit', String(id)],
    ]) {
      const result = box.run(box.repo, ...args, '--brief', 'Reference: ' + reference, '--json');
      assert.equal(result.code, 1, `${args[0]} must refuse Reference: ${reference}; ${result.out}${result.err}`);
      const refusal = JSON.parse(result.out).error;
      assert.equal(refusal.code, 'REFERENCE_IS_BOARD');
      assert.ok(refusal.message.includes(flag), refusal.message);
    }
  }
});


/** Exercise the actual Submit lifecycle with a private changelog owned by the fixture's lane. */
function submitReferenceFixture(t, { handled, matchingAddition }) {
  const e2e = createE2eHelpers();
  t.after(() => e2e.cleanup());
  const box = e2e.project('true');
  const target = 'https://example.invalid/conversations/reference-submit-20';
  const handle = 'ReferenceReporter';
  const acknowledgement = `${target} @${handle}`;
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.lanes.web.owns.push('CHANGELOG.md');
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  // An old matching line is insufficient: point 20 concerns what this item's change adds.
  writeFileSync(join(box.repo, 'CHANGELOG.md'), `# Changelog\n\n## Earlier release\n- Earlier work: ${acknowledgement}\n`);
  box.git(box.repo, 'add', 'pullboard.json', 'CHANGELOG.md');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: prepare reference changelog fixture [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const reference = handled ? acknowledgement : target;
  const added = fixtureAdd(box.run, box.repo, 'web', 'Submit reference reminder', '--specs', 'G1',
    '--criterion', 'The private reference change remains green.', '--check', 'test -f web/reference-change.txt',
    '--brief', `${e2e.LIGHT_BRIEF}Reference: ${reference}\n`, '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = box.run(box.web, 'claim', String(id));
  assert.equal(claimed.code, 0, claimed.err || claimed.out);
  if (matchingAddition) {
    const file = join(box.web, 'CHANGELOG.md');
    writeFileSync(file, readFileSync(file, 'utf8') + `\n## Unreleased\n- New reference change: ${acknowledgement}\n`);
  }
  const committed = e2e.commitFile(box, box.web, 'web/reference-change.txt', 'PASS\n',
    'feat(web): exercise reference submit [G1]');
  assert.equal(committed.status, 0, committed.stderr || committed.stdout);
  const submitted = box.run(box.web, 'submit', String(id), '--json');
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  const shown = box.run(box.repo, 'show', String(id), '--json');
  assert.equal(shown.code, 0, shown.err || shown.out);
  assert.equal(JSON.parse(shown.out).item_status, 'submitted', 'the reminder never prevents the native submission');
  return { submitted, target, handle };
}

test('reference point 20: Submit reminds without refusing and only for missing newly added acknowledgements [C7]', async t => {
  await t.test('an old matching line does not hide the missing addition', t => {
    const { submitted, target, handle } = submitReferenceFixture(t, { handled: true, matchingAddition: false });
    const output = `${submitted.out}\n${submitted.err}`;
    const reminders = output.split(/\r?\n/u).filter(line => /changelog/iu.test(line));
    assert.ok(reminders.some(line => line.includes(target) && line.includes(`@${handle}`)),
      'successful Submit reminds about the exact handled reference missing from this change');
  });
  await t.test('a matching newly added changelog line needs no reminder', t => {
    const { submitted } = submitReferenceFixture(t, { handled: true, matchingAddition: true });
    assert.doesNotMatch(`${submitted.out}\n${submitted.err}`, /changelog/iu,
      'the actual added acknowledgement satisfies the reminder');
  });
  await t.test('an unhandled reference needs no acknowledgement or reminder', t => {
    const { submitted } = submitReferenceFixture(t, { handled: false, matchingAddition: false });
    assert.doesNotMatch(`${submitted.out}\n${submitted.err}`, /changelog/iu,
      'private unhandled references do not acquire an acknowledgement check');
  });
});


test('GitHub issue and pull references check explicit author handles during async add and edit [C7]', async t => {
  const box = bridgeProject(t);
  const provider = await bridgeProvider(t, box);
  const personEnv = { ...box.env };
  for (const marker of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete personEnv[marker];
  const referenceCalls = path => provider.requests.filter(request => request.method === 'GET' && request.path === path).length;
  const issuePath = '/repos/fixture/repository/issues/6';
  const pullPath = '/repos/fixture/repository/pulls/7';

  const wrongIssue = await fixtureAdd(runBridgeCLI, box, 'web', 'Wrong issue author', '--brief',
    'Reference: https://github.com/fixture/repository/issues/6 @another-person', '--json');
  assert.notEqual(wrongIssue.code, 0, 'an explicit handle that differs from the issue author is refused');
  assert.match(`${wrongIssue.out}\n${wrongIssue.err}`, /issue-author/iu);
  assert.equal(referenceCalls(issuePath), 1, 'issue author is checked through the private provider');

  const matchingIssue = await runBridgeCLIAs(box, { cwd: box.repo, env: personEnv }, 'add', 'web', 'Matching issue author', '--brief',
    'Reference: https://github.com/fixture/repository/issues/6 @ISSUE-AUTHOR', '--json');
  assert.equal(matchingIssue.code, 0, matchingIssue.err || matchingIssue.out);
  assert.equal(referenceCalls(issuePath), 2, 'GitHub login matching is case-insensitive');

  const beforeUnhandled = referenceCalls(issuePath) + referenceCalls(pullPath);
  const unhandledAdd = await fixtureAdd(runBridgeCLI, box, 'web', 'Unhandled reference', '--brief',
    'Reference: https://github.com/fixture/repository/issues/6', '--json');
  assert.equal(unhandledAdd.code, 0, unhandledAdd.err || unhandledAdd.out);
  const itemId = JSON.parse(unhandledAdd.out).item.item_id;
  assert.equal(referenceCalls(issuePath) + referenceCalls(pullPath), beforeUnhandled,
    'an issue reference without an explicit handle performs no author lookup');

  const wrongPull = await runBridgeCLI(box, 'edit', String(itemId), '--brief',
    'Reference: https://github.com/fixture/repository/pull/7 @another-person', '--json');
  assert.notEqual(wrongPull.code, 0, 'an explicit handle that differs from the pull author is refused');
  assert.match(`${wrongPull.out}\n${wrongPull.err}`, /pr-author/iu);
  assert.equal(referenceCalls(pullPath), 1, 'pull author is checked through the private provider');

  const matchingPull = await runBridgeCLIAs(box, { cwd: box.repo, env: personEnv }, 'edit', String(itemId), '--brief',
    'Reference: https://github.com/fixture/repository/pull/7 @PR-AUTHOR', '--json');
  assert.equal(matchingPull.code, 0, matchingPull.err || matchingPull.out);
  assert.equal(referenceCalls(pullPath), 2, 'pull login matching is case-insensitive too');

  const beforeUnhandledEdit = referenceCalls(issuePath) + referenceCalls(pullPath);
  const unhandledEdit = await runBridgeCLI(box, 'edit', String(itemId), '--brief',
    'Reference: https://github.com/fixture/repository/pull/7', '--json');
  assert.equal(unhandledEdit.code, 0, unhandledEdit.err || unhandledEdit.out);
  assert.equal(referenceCalls(issuePath) + referenceCalls(pullPath), beforeUnhandledEdit,
    'an edit without an explicit handle performs no author lookup');
});


test('only the person can add or edit an explicit GitHub author acknowledgement [C7,B26,H16]', async t => {
  const box = bridgeProject(t);
  const provider = await bridgeProvider(t, box);
  const issuePath = '/repos/fixture/repository/issues/6';
  const pullPath = '/repos/fixture/repository/pulls/7';
  const lookups = () => provider.requests.filter(request => request.method === 'GET' &&
    [issuePath, pullPath].includes(request.path)).length;
  const humanEnv = { ...box.env };
  for (const marker of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete humanEnv[marker];
  const coordinatorAgentEnv = { ...box.env, CODEX_THREAD_ID: 'fixture-coordinator-agent' };
  const worktreeAgentEnv = { ...box.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'fixture-web-agent' };
  const beforeItems = () => {
    const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
    try { return store.listItems(board).length; } finally { store.closeBoard(board); }
  };
  const initialItems = beforeItems();

  const coordinatorMark = await runBridgeCLIAs(box, { cwd: box.repo, env: coordinatorAgentEnv },
    'add', 'web', 'Coordinator cannot acknowledge', '--brief',
    'Reference: https://github.com/fixture/repository/issues/6 @issue-author', '--json');
  assert.notEqual(coordinatorMark.code, 0, 'the coordinator agent may triage an issue but cannot mark its author acknowledged');
  assert.equal(JSON.parse(coordinatorMark.out).error.code, 'B26_PERSON_CHANNEL');
  assert.equal(beforeItems(), initialItems, 'a rejected coordinator acknowledgement has no local item effect');
  assert.equal(lookups(), 0, 'person-only authority is checked before an author network lookup');

  const ordinaryCoordinatorAdd = await runBridgeCLIAs(box, { cwd: box.repo, env: coordinatorAgentEnv },
    'add', 'web', 'Unacknowledged issue', '--brief',
    'Reference: https://github.com/fixture/repository/issues/6', '--json');
  assert.equal(ordinaryCoordinatorAdd.code, 0, ordinaryCoordinatorAdd.err || ordinaryCoordinatorAdd.out);
  const itemId = JSON.parse(ordinaryCoordinatorAdd.out).item.item_id;
  assert.equal(lookups(), 0, 'a coordinator can record an unhandled issue without looking up an author');

  const ordinaryAgentAdd = await runBridgeCLIAs(box, { cwd: box.web, env: worktreeAgentEnv },
    'add', 'web', 'Agent unhandled pull', '--brief',
    'Reference: https://github.com/fixture/repository/pull/7', '--json');
  assert.equal(ordinaryAgentAdd.code, 0, ordinaryAgentAdd.err || ordinaryAgentAdd.out);
  const agentItemId = JSON.parse(ordinaryAgentAdd.out).item.item_id;
  assert.equal(lookups(), 0, 'an agent can add an unhandled pull reference without author lookup');

  const agentMark = await runBridgeCLIAs(box, { cwd: box.web, env: worktreeAgentEnv },
    'edit', String(agentItemId), '--brief',
    'Reference: https://github.com/fixture/repository/pull/7 @pr-author', '--json');
  assert.notEqual(agentMark.code, 0, 'a lane agent cannot mark a pull author acknowledged');
  assert.equal(JSON.parse(agentMark.out).error.code, 'B26_PERSON_CHANNEL');
  assert.equal(lookups(), 0, 'a rejected agent edit performs no author lookup');

  const ordinaryAgentEdit = await runBridgeCLIAs(box, { cwd: box.web, env: worktreeAgentEnv },
    'edit', String(agentItemId), '--brief',
    'Reference: https://github.com/fixture/repository/pull/7', '--json');
  assert.equal(ordinaryAgentEdit.code, 0, ordinaryAgentEdit.err || ordinaryAgentEdit.out);
  assert.equal(lookups(), 0, 'an agent can edit an unhandled pull reference without author lookup');

  const humanAdd = await runBridgeCLIAs(box, { cwd: box.repo, env: humanEnv },
    'add', 'web', 'Person acknowledgement', '--brief',
    'Reference: https://github.com/fixture/repository/issues/6 @ISSUE-AUTHOR', '--json');
  assert.equal(humanAdd.code, 0, humanAdd.err || humanAdd.out);
  assert.equal(lookups(), 1, 'the marker-free private person terminal verifies the issue author');
  const humanEdit = await runBridgeCLIAs(box, { cwd: box.repo, env: humanEnv },
    'edit', String(itemId), '--brief',
    'Reference: https://github.com/fixture/repository/pull/7 @PR-AUTHOR', '--json');
  assert.equal(humanEdit.code, 0, humanEdit.err || humanEdit.out);
  assert.equal(lookups(), 2, 'the person may acknowledge a matching pull author, case-insensitively');
});

test('a relay agent cannot forge person authority for handled add and edit references [C7,H16]', t => {
  const box = bridgeProject(t);
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  t.after(() => store.closeBoard(board));
  const target = 'https://github.com/fixture/repository/issues/6';
  const authors = [{ target, author: 'issue-author' }];
  const add = { by: 'coordinator', lane: 'web', title: 'Forged author authority',
    brief: `Reference: ${target} @issue-author`, referenceAuthors: authors, referenceAuthority: 'person' };
  const edit = { agentId: 'coordinator', brief: `Reference: ${target} @issue-author`,
    referenceAuthors: authors, referenceAuthority: 'person' };
  assert.equal(minimumMoveEngine('addItem', [add], board), REFERENCE_ENGINE,
    'a person-authorized reference add retains the reference engine floor');
  assert.equal(minimumMoveEngine('editItem', [1, edit], board), REFERENCE_ENGINE,
    'a person-authorized reference edit retains the reference engine floor');
  for (const [operation, args] of [['addItem', [add]], ['editItem', [1, edit]]]) {
    const move = prepareEngineMove(board, operation, args, { id: `forged-reference-${operation}` });
    assert.ok(move.engine >= REFERENCE_ENGINE);
    const refusal = relaySenderProblem(move,
      { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' }, 'move');
    assert.equal(refusal?.code, 'RELAY_PERSON_ONLY', `${operation} cannot relay the forged person marker`);
  }
});
