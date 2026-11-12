/** pullboard digest: a readable, bounded, read-only briefing of one real board [A2,N26]. */
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { addMilestone } from '../../../../packages/store/index.js';
import { DIGEST_MAX_BYTES } from '../../../../packages/items/index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { registerProject } from '../../../../packages/seats/index.js';
import {
  AGENT_SHELL_MARKERS,
  SSH_SHELL_MARKERS,
} from '../../../../packages/kernel/index.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import {
  runFixtureGit,
  startFixtureChild,
} from '../../tests/fixtures/child.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');

/**
 * A real repository with its own board in a private temporary folder, so the developer's registry
 * and board are never read or touched.
 */
function fixture(t, name, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-digest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const env = { ...process.env, PULLBOARD_HOME: join(dir, 'home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !key.startsWith('GIT_CONFIG') && !/^GIT_(AUTHOR|COMMITTER)_/u.test(key)) delete env[key];
  for (const marker of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[marker];
  delete env.PULLBOARD_RELAY_TOKEN;
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: repo, env });
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ name, spec: 'SPEC.md', gate: 'true', lanes: { web: { owns: ['web/'] } }, ...extra }));
  writeFileSync(join(repo, 'SPEC.md'), '# Fixture\n\n## G · Goals\n- G1 [approved, must] Keep the board. | gate: true\n');
  runFixtureGit(['add', '-A'], { cwd: repo, env });
  runFixtureGit(['commit', '-q', '-m', 'chore: start the digest fixture'], { cwd: repo, env });
  const commonDir = join(repo, '.git');
  const file = join(commonDir, 'pullboard', 'board.sqlite');
  const board = openBoard(file);
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: repo });
  store.register(board, { lane: 'web', path: join(dir, 'builder') });
  store.register(board, { lane: 'web', path: join(dir, 'reviewer') });
  return { dir, repo, env, commonDir, file, board };
}

/** Add an item through the board's own API, so the fixture obeys the lifecycle rules. */
function add(board, title, extra = {}) {
  return store.addItem(board, { by: 'coordinator', lane: 'web', title, criterion: `Done means ${title} works`, specIds: ['G1'], ...extra });
}

/** Run the production CLI dispatch in-process in the fixture repo and return its stdout. */
async function cli(box, ...args) {
  const result = await runCliInProcess(args, { cwd: box.repo, env: box.env });
  assert.equal(result.status, 0, result.failure || result.stderr);
  return result.stdout;
}

/** What a read-only command must leave exactly as it was: every row, and the event count. */
function snapshot(box) {
  return { events: box.board.db.prepare('SELECT count(*) AS n, max(event_id) AS last FROM event').get(), tables: exportBoard(box.board) };
}

/** Register both projects in the fixture's private registry, as two boards on one machine. */
function registerBoth(home, roots) {
  const previous = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = home;
  try { for (const root of roots) registerProject(root); }
  finally { if (previous === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = previous; }
}

/** The body of one `## ` section, up to the next heading. */
function sectionOf(markdown, title) {
  const start = markdown.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `the briefing has a ${title} section`);
  const end = markdown.indexOf('\n## ', start + 4);
  return markdown.slice(start, end < 0 ? undefined : end);
}

test('the digest is a readable briefing of one board [A2,N26]', async (t) => {
  // A zero stuck threshold makes pullboard health's findings appear on a board made seconds ago.
  const box = fixture(t, 'Briefing project', { health: { stuck: '0m', holds: '0m', release: '1d' } });
  const other = fixture(t, 'Other private project');
  add(other.board, 'Other board private item');
  store.shout(other.board, { from: 'web-1', to: 'coordinator', text: 'Other board shout to its coordinator', lanes: ['web'] });
  registerBoth(box.env.PULLBOARD_HOME, [box.repo, other.repo]);

  const planted = 'gh' + 'p_' + 'Q'.repeat(36); // A synthetic token, built here so no secret is committed.
  const first = add(box.board, 'Upload page', { criterion: 'A person uploads a file and sees it listed' });
  const prerequisite = add(box.board, 'Storage bucket');
  add(box.board, 'Share links', { after: [prerequisite], criterion: 'A shared link opens the file' });
  const held = add(box.board, 'Pricing page');
  store.holdItem(box.board, held, { agentId: 'coordinator', reason: 'The person picks the prices first' });
  add(box.board, 'Secret in a bar', { criterion: `Use token ${planted} for the demo` });
  store.appendFact(box.board, first, { agentId: 'coordinator', kind: 'decision', text: 'One upload path, because two paths drift apart' });
  // A synthetic PEM-shaped block, built here: its header is what the secret patterns recognise.
  const pemHeader = '-----BEGIN ' + 'PRIVATE KEY-----';
  const pemBody = 'U3ludGhldGljRGlnZXN0' + 'Qm9keU9ubHlGb3JUZXN0';
  const pemFooter = '-----END ' + 'PRIVATE KEY-----';
  store.appendFact(box.board, first, { agentId: 'coordinator', kind: 'root-cause',
    text: `The demo leaked this key:\n${pemHeader}\n${pemBody}\n${pemBody}\n${pemFooter}\nRotate it.` });
  const ask = store.shout(box.board, { from: 'web-1', to: 'coordinator', text: 'May the cache be the source of truth?', lanes: ['web'], decision: true });
  store.answerDecision(box.board, ask, { agentId: 'coordinator', text: 'No, because the cache must stay disposable', lanes: ['web'] });
  store.shout(box.board, { from: 'coordinator', to: 'person', text: 'Should a newcomer see the tour first?', lanes: ['web'], decision: true });
  store.shout(box.board, { from: 'web-1', to: 'coordinator', text: `Found a key ${planted} in the logs`, lanes: ['web'] });
  store.shout(box.board, { from: 'web-2', to: 'coordinator', text: 'The upload review is next in my queue', lanes: ['web'] });
  /** The frozen criterion a claim records. */
  const freeze = (item) => ({ text: JSON.stringify({ criterion: item.item_criterion, rows: [] }), digest: 'digest:briefing' });
  store.claim(box.board, first, { agentId: 'web-1', lane: 'web', leaseMs: 3_600_000, freeze });
  submitFixture(box.board, first, { agentId: 'web-1', commit: 'a'.repeat(40), tree: 'fixture-tree' });
  store.verify(box.board, first, { agentId: 'web-2', decision: 'REJECT', reason: 'TEST_FAILURE',
    note: 'The upload test fails on an empty file', clause: 'A person uploads a file and sees it listed', head: 'a'.repeat(40), digest: 'digest:briefing', policy: 'any' });
  addMilestone(box.board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'First release', note: 'Uploads that work', items: [first, prerequisite] });

  const before = snapshot(box);
  const markdown = await cli(box, 'digest');
  assert.deepEqual(snapshot(box), before, 'the digest changes no row and records no event');

  assert.match(markdown, /^# Board briefing: Briefing project\n/u);
  const open = sectionOf(markdown, 'Open work');
  assert.match(open, /Upload page \(#1\), in the web lane: open to claim\.\n {2}Done when: A person uploads a file and sees it listed/u);
  assert.match(open, /Storage bucket \(#2\)/u);
  const blocked = sectionOf(markdown, 'Blocked work');
  assert.match(blocked, /Share links \(#3\).*\n {2}Done when: A shared link opens the file\n {2}Waits for: Storage bucket \(#2\)\./u);
  assert.match(blocked, /Pricing page \(#4\).*\n {2}Done when: .*\n {2}Held: The person picks the prices first/u);
  const decisions = sectionOf(markdown, 'Recent decisions and answers');
  assert.match(decisions, /A decision on Upload page \(#1\) by coordinator.*\n {2}One upload path, because two paths drift apart/u);
  assert.match(decisions, /Asked: May the cache be the source of truth\?\n {2}Answer and reason: No, because the cache must stay disposable/u);
  assert.match(sectionOf(markdown, 'Recent verdicts'),
    /Upload page \(#1\) was rejected by web-2, .*: a test failed \(TEST_FAILURE\)\.\n {2}Note: The upload test fails on an empty file/u);
  assert.match(sectionOf(markdown, 'Questions waiting on you'),
    /coordinator asks, .*: Should a newcomer see the tour first\?\n {2}Answer: pullboard answer \d+ "<your answer>" --as person/u);
  const shouts = sectionOf(markdown, 'Latest shouts to the coordinator');
  assert.match(shouts, /web-2, .*: The upload review is next in my queue/u);
  assert.ok(shouts.indexOf('upload review') < shouts.indexOf('[redacted secret]'), 'the latest shout comes first');
  assert.match(sectionOf(markdown, 'Milestones'), /First release: planned; 2 items, 0 landed, 0 accepted, 0 in review, 2 open\.\n {2}Uploads that work/u);
  assert.match(sectionOf(markdown, 'At a glance'), /1 questions wait on you, and [1-9]\d* things are stuck/u);
  assert.match(sectionOf(markdown, 'Stuck and who moves it'), /- decision #\d+: .*\n {2}Next, you: /u);

  assert.equal(markdown.includes(planted), false, 'a secret never reaches the briefing');
  assert.equal(markdown.includes('ghp_'), false, 'no part of the secret survives');
  for (const part of [pemHeader, pemBody, pemFooter, 'PRIVATE KEY', 'Rotate it']) {
    assert.equal(markdown.includes(part), false, `no part of a multi-line secret block prints: ${part}`);
  }
  assert.match(decisions, /A root-cause on Upload page \(#1\) by coordinator.*\n {2}\[redacted secret\]\n/u, 'the whole entry is redacted');
  assert.match(sectionOf(markdown, 'Open work'), /Secret in a bar \(#5\).*\n {2}Done when: \[redacted secret\]/u);
  assert.match(shouts, /web-1, .*: \[redacted secret\]/u);
  for (const foreign of ['Other private project', 'Other board private item', 'Other board shout', other.repo]) {
    assert.equal(markdown.includes(foreign), false, `nothing from the second board appears: ${foreign}`);
  }
  assert.match(sectionOf(markdown, 'Left out of this briefing'), /this briefing covers this board only/u);
  assert.ok(Buffer.byteLength(markdown) < DIGEST_MAX_BYTES);

  const json = JSON.parse(await cli(box, 'digest', '--json'));
  /** The briefing from its first section on; the header carries the time it was read. */
  const body = (text) => text.slice(text.indexOf('## At a glance')).trimEnd();
  assert.match(markdown, /\nnext: pullboard next\s*$/u, 'the CLI provides its next step');
  assert.equal(body(json.markdown), body(markdown).replace(/\nnext: pullboard next$/u, ''), 'the JSON result carries the same briefing');
  assert.deepEqual(json.sections.map((entry) => entry.title), ['Stuck and who moves it', 'Open work', 'Blocked work', 'In review', 'Recent decisions and answers',
    'Recent verdicts', 'Questions waiting on you', 'Latest shouts to the coordinator', 'Milestones', 'What the board caught, last 30 days', 'Unanswered Rigor drafts', 'Capacity forecast']);

  const out = join(box.dir, 'briefing.md');
  writeFileSync(out, 'an older briefing');
  assert.match(await cli(box, 'digest', '--out', out), /wrote the briefing to .*briefing\.md/u);
  assert.match(readFileSync(out, 'utf8'), /^# Board briefing: Briefing project\n/u);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(box.dir).filter((name) => name.startsWith('.pullboard-digest-')), [], 'the replacement leaves no temporary file');
  const intoBoard = await runCliInProcess(['digest', '--out', box.file], { cwd: box.repo, env: box.env });
  assert.equal(intoBoard.status, 1);
  assert.match(intoBoard.stderr, /DIGEST_WRITE/u);
  assert.deepEqual(snapshot(box), before, 'writing the file changes nothing on the board');

  for (let index = 0; index < 240; index += 1) add(box.board, `Large item ${index}`, { criterion: 'A long bar with wide text 世界. '.repeat(200) });
  const largeBefore = snapshot(box);
  // The human CLI truncates long output; JSON carries the complete briefing to inspect its own limit.
  const large = JSON.parse(await cli(box, 'digest', '--json')).markdown;
  assert.deepEqual(snapshot(box), largeBefore);
  assert.ok(Buffer.byteLength(large) < DIGEST_MAX_BYTES, `UTF-8 bytes stay under 50 KB (${Buffer.byteLength(large)})`);
  assert.match(sectionOf(large, 'Open work'), /\n\d+ more left out to keep this briefing short\.\n/u);
  assert.match(sectionOf(large, 'Left out of this briefing'), /- Open work: \d+ of 243 shown\./u);
  assert.match(sectionOf(large, 'Left out of this briefing'), /- [1-9]\d* long texts were cut short/u);
});

/** Wait for the watched file to satisfy `predicate`; every read must be a whole briefing. */
async function waitForFile(path, predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const markdown = readFileSync(path, 'utf8');
      assert.match(markdown, /^# Board briefing: /u, 'a reader never sees a partial file');
      assert.match(markdown, /pullboard show <number> prints any item\.\n$/u, 'every replacement is whole');
      if (predicate(markdown)) return markdown;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.fail('the watched briefing did not show the board move in time');
}

test('digest --watch rewrites the file after every board move and stops cleanly [A2,N26]', { timeout: 30_000 }, async (t) => {
  const box = fixture(t, 'Watched project');
  const out = join(box.dir, 'watch.md');
  // Process-level: a long-lived --watch child that must stop cleanly on SIGINT.
  const child = startFixtureChild(process.execPath, [BIN, 'digest', '--watch', '--out', out], { cwd: box.repo, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdout.resume();
  try {
    await waitForFile(out, () => true);
    for (const text of ['First watched move', 'Second watched move']) {
      store.shout(box.board, { from: 'web-1', to: 'coordinator', text, lanes: ['web'] });
      const after = snapshot(box);
      await waitForFile(out, (markdown) => markdown.includes(text));
      assert.deepEqual(snapshot(box), after, 'the watcher never changes the board');
    }
    child.kill('SIGTERM');
    const [code, signal] = await closed;
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
    assert.deepEqual(readdirSync(box.dir).filter((name) => name.startsWith('.pullboard-digest-')), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await closed; }
  }
});
