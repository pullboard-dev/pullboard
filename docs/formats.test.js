/** @pullboard-test-input packages/state/src/logic/engines/* */
/** Keep the format guide aligned with parser behavior, live SQLite schema and static export [A5,A10]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  relative,
} from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openBoard } from '../apps/lib/index.js';
import { COORDINATOR } from '../packages/config/index.js';
import { declarationDocBlocks } from '../apps/cli/src/io/generated/declarations.js';
import { JSON_SHAPES } from '../packages/config/index.js';
import { exportView } from '../apps/cli/src/io/commands/view.js';
import { main as nativeTestMain } from '../apps/cli/tests/fixtures/native.js';
import { openBoard as nativeOpenBoard, openBoardForRead as nativeOpenBoardForRead } from '../apps/lib/index.js';
import { refusalDocument } from '../apps/cli/index.js';
import { ENGINE_VERSION } from '../packages/state/index.js';
import { discoverEngines } from '../packages/state/index.js';
import { readEngineLeaves } from '../packages/state/src/io/engine/numbers.js';
import { addItem, closeBoard, EVENT_LOG_VERSION, board_ensureCoordinator as ensureCoordinator, events, boardId, release, reopen, SCHEMA_VERSION } from '../packages/store/index.js';
import {
  ID_RE,
  readSignoffs,
  SPEC_GRAMMAR_VERSION,
  STATUSES,
  TIERS,
  lintSpec,
  parseSpec,
  unmetRows,
} from '../packages/spec/index.js';
import {
  sha256,
  signRows,
} from '../packages/spec/index.js';
import { block, documentedEvents } from '../apps/lib/tests/fixtures/formats-guide.js';

const guide = readFileSync(new URL('./formats.md', import.meta.url), 'utf8');
/** The SPEC.md and DOCTRINE.md section lives on its own page; its sentences and marked tables are read there. */
const specPage = readFileSync(new URL('./formats/spec.md', import.meta.url), 'utf8');

test('formats guide documents resume release notes and checkout recording [N19]', () => {
  const section = block('<!-- resume-release-notes:start -->', '<!-- resume-release-notes:end -->');
  const example = /```json\n([\s\S]*?)\n```/u.exec(section);
  assert.ok(example, 'the resume contract includes a JSON example');
  assert.deepEqual(JSON.parse(example[1]), {
    whatsNew: { releases: [{ version: '0.8.7', headline: 'A new session', paragraph: 'Release headline paragraph.' }], omitted: 0, notes: 'CHANGELOG.md' },
  });
  assert.match(section, /`whatsNew` is `null` when nothing is new/u);
  assert.match(section, /newest first/u);
  assert.match(section, /newest three/u);
  assert.match(section, /`omitted` counts the earlier releases left out/u);
  assert.match(section, /`notes` names the full release notes/u);
  assert.match(section, /Both text and JSON resumes record the displayed version once per checkout/u);
  assert.match(section, /A checkout's first run records its version quietly/u);
  assert.ok(section.includes("`pullboard-checkout/resume-version` in the checkout's Git directory"));
  assert.match(section, /outside the shared board/u);
});

test('clause 1: the formats guide documents collision grandfathering and doctrine citations on the spec page [A5]', () => {
  assert.match(specPage, /A bare id names a row in `SPEC\.md`/u);
  assert.match(specPage, /`doctrine:<id>` in item spec ids and commit headers/u);
  assert.match(specPage, /Collisions already present in the primary checkout's attached branch are reported as known warnings/u);
  assert.match(specPage, /adding a colliding row is an error that names both file paths and line numbers/u);
});

/** Read names from the first code-formatted cell of each row in a marked table. */
function listedValues(start, end) {
  return block(start, end).split(/\r?\n/).flatMap((line) => {
    const match = /^\| `([^`]+)` \|/.exec(line);
    return match ? [match[1]] : [];
  });
}

/** List every regular file below a snapshot directory with paths relative to its root. */
function filesUnder(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(root, path) : [relative(root, path)];
  }).sort();
}

/** Read the documented static snapshot file paths. */
function documentedSnapshotFiles() {
  return block('<!-- snapshot-files:start -->', '<!-- snapshot-files:end -->').split(/\r?\n/).flatMap((line) => {
    const row = /^\| `([^`]+)` \|/.exec(line);
    return row ? [row[1]] : [];
  });
}

/** Create isolated Git, SQLite and OpenSSH state for real required-signer receipts. */
function signerFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-formats-signers-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  const keys = join(directory, 'keys');
  mkdirSync(root);
  mkdirSync(keys);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  /** Run Git against the isolated fixture without inherited worktree variables. */
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Formats test');
  git('config', 'user.email', 'formats@example.invalid');
  writeFileSync(join(root, 'SPEC.md'), [
    '# Formats signer fixture', '', '## G · Goals',
    '- A1 [approved, must] One principal signs. | gate: test | signers: alice@example.invalid',
    '- A2 [approved, must] Both principals sign. | gate: test | signers: alice@example.invalid, bob@example.invalid', '',
  ].join('\n'));
  git('add', 'SPEC.md');
  git('commit', '-q', '-m', 'fixture');
  const firstCommit = git('rev-parse', 'HEAD');
  const signerKeys = {};
  for (const principal of ['alice@example.invalid', 'bob@example.invalid', 'extra@example.invalid']) {
    const name = principal.split('@')[0];
    const privateKey = join(keys, name);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', principal, '-f', privateKey], { stdio: 'pipe' });
    const publicKey = readFileSync(`${privateKey}.pub`, 'utf8').trim();
    signerKeys[principal] = { privateKey, publicKey };
  }
  const signers = Object.entries(signerKeys).map(([principal, key]) => `${principal} namespaces="pullboard-signoff" ${key.publicKey}`).join('\n') + '\n';
  const initialHash = sha256(signers);
  const pullboard = join(root, '.pullboard');
  mkdirSync(pullboard);
  writeFileSync(join(pullboard, 'signers'), signers);
  writeFileSync(join(pullboard, 'first-commit'), `${firstCommit}\n`);
  writeFileSync(join(pullboard, 'signers.initial'), `${initialHash}\n`);

  const boardPath = join(root, '.git', 'pullboard', 'board.sqlite');
  let board = openBoard(boardPath);
  try {
    ensureCoordinator(board, root);
    addItem(board, { by: COORDINATOR, lane: 'core', title: 'Signed formats fixture', specIds: ['A5'] });
  } finally {
    closeBoard(board);
  }
  board = openBoard(boardPath);
  try {
    assert.ok(board.db.prepare("SELECT 1 FROM item WHERE item_title='Signed formats fixture'").get(), 'the file-backed SQLite board preserves the fixture item');
  } finally {
    closeBoard(board);
  }
  return { root, firstCommit, initialHash, signerKeys };
}

/** Keep the guide at the highest landed engine while allowing one branch-local pending leaf. */
function assertEngineGuideVersion(guideVersion, leaves, branchVersion) {
  const landed = Math.max(0, ...leaves.flatMap(({ number }) => number === null ? [] : [number]));
  const pending = leaves.filter(({ number }) => number === null);
  assert.ok(
    pending.length <= 1,
    `two unassigned engine leaves are not allowed: ${pending.map(({ file }) => file).join(', ')}`,
  );
  assert.equal(guideVersion, landed, `move engine guide version ${guideVersion} must match highest landed engine ${landed}`);
  const expectedBranchVersion = pending.length === 1 ? landed + 1 : landed;
  assert.equal(
    branchVersion,
    expectedBranchVersion,
    `executable engine version ${branchVersion} must match the branch state ${expectedBranchVersion}`,
  );
}

/** Create a minimal engine-leaf directory and return its parsed and executable versions. */
function engineLeafFixture(t, landedVersion, pendingLeaves) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-format-engines-'));
  const source = join(root, 'src');
  mkdirSync(source);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(source, 'landed-engine.js'), `export const LANDED_ENGINE = ${landedVersion};\n`);
  for (const leaf of pendingLeaves) {
    const exported = `${leaf.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase()).toUpperCase().replace(/-/gu, '_')}_ENGINE`;
    writeFileSync(join(source, `${leaf}-engine.js`), `import { unassignedEngine } from './engine-next.js';\nexport const ${exported} = unassignedEngine();\n`);
  }
  const leaves = readEngineLeaves(source);
  const engines = Object.values(discoverEngines(pathToFileURL(`${source}/`)));
  return { leaves, branchVersion: Math.max(...engines) };
}

test('[A5] the generated event table names exactly the documented event kinds', () => {
  // The other [A5] case proves the documented kinds equal the kinds the board writes; regenerating must keep them.
  const rows = declarationDocBlocks(join(import.meta.dirname, '..')).events.matchAll(/^\| `([^`]+)` \|/gmu);
  const generated = [...new Set([...rows].map(match => match[1]))];
  assert.deepEqual(generated.sort(), Object.keys(documentedEvents()).sort());
});

test('clause 1: [A5] the grammar table on the spec page describes values the parser actually reads', () => {
  assert.equal(ID_RE.source, '^[A-Za-z]+\\d+(?:\\.\\d+)*$');
  assert.deepEqual(listedValues('<!-- statuses:start -->', '<!-- statuses:end -->'), STATUSES);
  assert.deepEqual(listedValues('<!-- tiers:start -->', '<!-- tiers:end -->'), TIERS);

  const source = [
    '# Example',
    'intro before a section',
    '## Sample section',
    '- A1 [approved, must] Requirement text. | gate: node test | serves: B2, C3 | signers: co@example.invalid, AB | custom: preserved',
  ].join('\n');
  const parsed = parseSpec(source);
  assert.equal(parsed.sections[0].name, 'Sample section');
  assert.deepEqual(parsed.rows[0], {
    id: 'A1', status: 'approved', tier: 'must', text: 'Requirement text.', gate: 'node test',
    serves: ['B2', 'C3'], signers: ['co@example.invalid', 'AB'], unknown: ['custom: preserved'], section: 'Sample section', line: 4,
  });
  assert.deepEqual(listedValues('<!-- parser-fields:start -->', '<!-- parser-fields:end -->'), Object.keys(parsed.rows[0]));
  assert.match(specPage, /\| gate: <command> \| serves: <ID, ID> \| signers: <principal, principal>/);

  const validSigner = lintSpec(parseSpec('## Signers\n- A1 [draft] Row with a signer. | signers: build@example.invalid\n'));
  assert.equal(validSigner.some((finding) => finding.message.startsWith('signer ')), false);
  const commentSigner = lintSpec(parseSpec('## Signers\n- A1 [draft] Row with a comment-like signer. | signers: #comment\n'));
  assert.ok(commentSigner.some((finding) => finding.message.includes('must be one SSH principal')));
  const spacedSigner = lintSpec(parseSpec('## Signers\n- A1 [draft] Row with a spaced signer. | signers: build team\n'));
  assert.ok(spacedSigner.some((finding) => finding.message.includes('must be one SSH principal')));
  const duplicateSigners = lintSpec(parseSpec('## Signers\n- A1 [draft] Row with duplicates. | signers: build@example.invalid, build@example.invalid\n'));
  assert.ok(duplicateSigners.some((finding) => finding.message === 'signers are unique on a row'));
  assert.match(specPage, /Each signer is one unique principal with no spaces, commas or leading `#`/);
  assert.match(specPage, /every listed principal has a verified SSH receipt for its current text/);

  const noTier = parseSpec('## Plain\n- A1 [draft] Row without a tier.\n');
  assert.equal(noTier.rows[0].tier, '');
  assert.deepEqual(lintSpec(parseSpec('## Must\n- A1 [approved, must] Must names a gate.\n')).filter((finding) => finding.level === 'error').map((finding) => finding.message), [
    'an approved must-row names its gate: | gate: <the test or check that proves it>',
  ]);
});

test('[A5,H16] grammar and executable engine versions match the format guide', () => {
  assert.equal(SPEC_GRAMMAR_VERSION, 1);
  const versions = block('<!-- format-versions:start -->', '<!-- format-versions:end -->');
  const versionOf = (name) => {
    const match = new RegExp('^\\| `' + name + '` \\| `(\\d+)` \\|', 'm').exec(versions);
    assert.ok(match, `guide declares ${name} version`);
    return Number(match[1]);
  };
  assert.equal(versionOf('CLI JSON envelope'), JSON_SHAPES.version);
  assert.equal(versionOf('row grammar'), SPEC_GRAMMAR_VERSION);
  assert.equal(versionOf('board schema'), SCHEMA_VERSION);
  assert.equal(versionOf('event log'), EVENT_LOG_VERSION);
  const sourceDirectory = fileURLToPath(new URL('../packages/state/src/logic/engines/', import.meta.url));
  const leaves = readEngineLeaves(sourceDirectory);
  assertEngineGuideVersion(versionOf('move engine'), leaves, ENGINE_VERSION);
  assert.match(versions, /Bump when a move's meaning changes/);
  assert.match(versions, /`ENGINE_VERSION`.*naming both versions/);
  assert.match(guide, /Engine 10 adds coordinator-only reopening for an unmerged verified item after a red landing candidate/u);
  assert.match(guide, /Engines 8 and 9 retain their submitted-only `reopen` behavior/u);
  assert.match(versions, /`SPEC_GRAMMAR_VERSION`/);
  assert.match(versions, /`JSON_SHAPES\.version`/);
  assert.match(versions, /`SCHEMA_VERSION`/);
  assert.match(versions, /`EVENT_LOG_VERSION`/);

  for (const file of ['SPEC.md', 'PRACTICE.md']) {
    const body = `## Sample\n- A1 [draft] Row text.\n`;
    assert.equal(parseSpec(body).grammarVersion, SPEC_GRAMMAR_VERSION, `${file} without a marker defaults to the current grammar`);
    assert.equal(parseSpec(`<!-- pullboard-grammar ${SPEC_GRAMMAR_VERSION} -->\n${body}`).grammarVersion, SPEC_GRAMMAR_VERSION, `${file} accepts the current marker`);
    assert.throws(
      () => parseSpec(`<!-- pullboard-grammar ${SPEC_GRAMMAR_VERSION + 1} -->\n${body}`),
      (error) => error?.code === 'A5_GRAMMAR_VERSION'
        && error.message.includes(`grammar ${SPEC_GRAMMAR_VERSION + 1}`)
        && error.message.includes(`reads grammar ${SPEC_GRAMMAR_VERSION}`)
        && error.message.includes('upgrade Pullboard'),
      `${file} refuses a different declared grammar with a usable next step`,
    );
    assert.throws(() => parseSpec(`<!-- pullboard-grammar invalid -->\n${body}`), (error) => error?.code === 'A5_GRAMMAR_VERSION', `${file} refuses an invalid marker`);
    assert.equal(parseSpec(`\`\`\`text\n<!-- pullboard-grammar ${SPEC_GRAMMAR_VERSION + 1} -->\n\`\`\`\n${body}`).grammarVersion, SPEC_GRAMMAR_VERSION, `${file} ignores a marker in a fenced example`);
  }
});

test("[A5,H16] a branch with one unassigned engine leaf matches the guide's landed number", (t) => {
  const versions = block('<!-- format-versions:start -->', '<!-- format-versions:end -->');
  const guideEngine = Number(/^\| `move engine` \| `(\d+)` \|/mu.exec(versions)?.[1]);
  assert.ok(Number.isSafeInteger(guideEngine), 'the guide declares its landed move engine number');
  const sourceDirectory = fileURLToPath(new URL('../packages/state/src/logic/engines/', import.meta.url));
  const landed = Math.max(0, ...readEngineLeaves(sourceDirectory).flatMap(({ number }) => number === null ? [] : [number]));
  const onePending = engineLeafFixture(t, landed, ['pending']);

  assertEngineGuideVersion(guideEngine, onePending.leaves, onePending.branchVersion);

  const twoPending = engineLeafFixture(t, landed, ['first-pending', 'second-pending']);
  assert.throws(
    () => assertEngineGuideVersion(guideEngine, twoPending.leaves, twoPending.branchVersion),
    /two unassigned engine leaves.*first-pending-engine\.js.*second-pending-engine\.js/u,
    'two unassigned leaves are rejected by name',
  );
  assert.throws(
    () => assertEngineGuideVersion(guideEngine + 1, onePending.leaves, onePending.branchVersion),
    new RegExp(`move engine guide version ${guideEngine + 1} must match highest landed engine ${landed}`, 'u'),
    'a guide row off by one names both engine numbers',
  );
});

test('[A5] approved signer rows require every exact verified principal', (t) => {
  const box = signerFixture(t);
  const spec = parseSpec(readFileSync(join(box.root, 'SPEC.md'), 'utf8'));
  /** Find the parsed fixture row by its stable id. */
  const row = (id) => spec.rows.find((entry) => entry.id === id);
  /** Return unmet row ids for a candidate receipt set. */
  const ids = (signoffs) => unmetRows(spec.rows, signoffs).map((entry) => entry.id);
  /** Construct one deterministic signer receipt payload for the fixture. */
  const receipt = (id, by) => ({
    id, text: row(id).text, commit: box.firstCommit, firstCommit: box.firstCommit, initialHash: box.initialHash, by,
    on: '2026-10-08T00:00:00.000Z', note: '',
  });

  signRows(box.root, [receipt('A2', 'extra@example.invalid')], box.signerKeys['extra@example.invalid'].privateKey);
  assert.deepEqual(ids(readSignoffs(box.root)), ['A1', 'A2'], 'a valid receipt from a non-required principal does not count');

  assert.deepEqual(ids([]), ['A1', 'A2'], 'rows without receipts remain unmet');
  const unverifiedAlice = { type: 'row', ...receipt('A1', 'alice@example.invalid'), signature: 'not verified' };
  assert.deepEqual(ids([unverifiedAlice]), ['A1', 'A2'], 'a receipt not verified against the Git signer list cannot meet a required row');
  const receiptFile = join(box.root, '.pullboard', 'signoffs.jsonl');
  writeFileSync(receiptFile, `${JSON.stringify(unverifiedAlice)}\n`);
  assert.throws(() => readSignoffs(box.root), (error) => error?.code === 'BAD_SIGNATURE', 'the real receipt reader rejects an invalid signed receipt');
  rmSync(receiptFile);

  signRows(box.root, [
    receipt('A1', 'alice@example.invalid'),
    receipt('A2', 'alice@example.invalid'),
  ], box.signerKeys['alice@example.invalid'].privateKey);
  assert.deepEqual(ids(readSignoffs(box.root)), ['A2'], 'one verified principal cannot satisfy another required principal');

  signRows(box.root, [receipt('A2', 'bob@example.invalid')], box.signerKeys['bob@example.invalid'].privateKey);
  const verified = readSignoffs(box.root);
  assert.deepEqual(ids(verified), [], 'every required verified principal meets its approved row');
  const changedSpec = parseSpec(readFileSync(join(box.root, 'SPEC.md'), 'utf8').replace('One principal signs.', 'One principal signs again.'));
  assert.deepEqual(unmetRows(changedSpec.rows, verified).map((entry) => entry.id), ['A1'], 'a valid receipt for old text is stale when the row changes');
});

test('[A5,A10] static export files and page readers match API v1', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-formats-export-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'pullboard.json'), `${JSON.stringify({
      name: 'Formats fixture', project: 'formats-test', gate: 'true', spec: 'SPEC.md', practice: 'PRACTICE.md',
      lanes: { docs: { owns: ['docs/'], specs: ['A5', 'A10'] } }, shared: [],
    }, null, 2)}\n`);
    writeFileSync(join(root, 'SPEC.md'), '# Formats fixture\n\n## G · Goals\n- G1 [approved, must] Preserve the exported board. | gate: true\n');
    writeFileSync(join(root, 'PRACTICE.md'), '');
    const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
    ensureCoordinator(board, root);
    closeBoard(board);

    const output = join(root, 'snapshot');
    await exportView(root, output, { runCommand: nativeTestMain, boardOpeners: { openBoard: nativeOpenBoard, openBoardForRead: nativeOpenBoardForRead }, refusalDocument });
    const boardsFile = 'api/v1/boards.json';
    const listing = JSON.parse(readFileSync(join(output, boardsFile), 'utf8'));
    const boardId = listing.boards[0].id;
    assert.ok(boardId, 'the exported API v1 listing names the fixture board');
    const actualFiles = filesUnder(output).map((path) => path.replaceAll(boardId, '<board-id>'));
    assert.deepEqual(actualFiles, documentedSnapshotFiles().sort());

    const documents = [
      [boardsFile, JSON_SHAPES.http.boards],
      [`api/v1/boards/${boardId}/state.json`, JSON_SHAPES.http.state],
      [`api/v1/boards/${boardId}/events.json`, JSON_SHAPES.http.events],
    ];
    for (const [path, shape] of documents) {
      const document = JSON.parse(readFileSync(join(output, path), 'utf8'));
      for (const [field, type] of Object.entries(shape.required)) {
        assert.ok(Object.hasOwn(document, field), `${path} contains API v1 field ${field}`);
        if (type === 'array') assert.ok(Array.isArray(document[field]), `${path}.${field} is an array`);
        else if (type === 'object') assert.ok(document[field] && typeof document[field] === 'object' && !Array.isArray(document[field]), `${path}.${field} is an object`);
        else assert.equal(typeof document[field], type, `${path}.${field} is ${type}`);
      }
    }

    const page = readFileSync(join(output, 'index.html'), 'utf8');
    assert.match(page, /const snapshot = true;/);
    assert.match(page, /href="view\.css"/);
    assert.match(page, /path = snapshot \? path\.split\('\?'\)\[0\]\.slice\(1\) \+ '\.json'/);
    assert.match(page, /api\(boardPath\(view\.root\) \+ '\/events'\)/);
    assert.match(guide, /The page fetches these files without a session key and reads the events file to replay the snapshot/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** @pullboard-world-pin: clause 2 reads docs/formats.md itself to prove it states the job tables export rule. */
test('clause 2: formats.md states that job and job_step are part of a board export only while they hold rows [A5,A10]', () => {
  const guide = readFileSync(new URL('./formats.md', import.meta.url), 'utf8');
  assert.match(guide, /The `job` and `job_step` tables are part of a board export only while they hold rows/);
  assert.match(guide, /an import treats a missing `job` or `job_step` table as empty/);
});
