/** Resume upgrade notes and applied row files [N19,I1,L3]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
import { releaseFixture } from '../../tests/fixtures/resume/release.js';
import { LONG_CHANGELOG } from '../../tests/fixtures/resume/release.js';

/**
 * Prove resume gives each uncommitted file its right owner: the row file `spec apply` changed goes
 * to the coordinator, the setup files init wrote go to the person, and nothing else is named [I1,L3].
 * The blueprint trial found resume blaming the person for the coordinator's own applied SPEC.md
 * and handing them a commit of every setup file.
 */
test('cli.journeys-resume-flow-upgrade.resume-asks-the-coordinator-to-commit: clause 1: resume asks the coordinator to commit an applied row file [I1,L3]', async t => {
  const PERSON_LINE = "The person must commit Pullboard's setup files before agents can use worktrees: ";
  const ROW_LINE = 'The coordinator must commit the row file spec apply changed: ';
  /** Resume's text and JSON from the main checkout, both passing, and neither naming an unrelated dirty file. */
  const resume = async (box) => {
    const text = (await box.runLocal(box.repo, 'resume', '--diagnostics'));
    assert.equal(text.status, 0, text.failure || text.stderr || text.stdout);
    const json = (await box.runLocal(box.repo, 'resume', '--diagnostics', '--json'));
    assert.equal(json.status, 0, json.failure || json.stderr || json.stdout);
    const lines = text.stdout.split('\n');
    const card = JSON.parse(json.stdout);
    for (const named of [...lines.filter((line) => line.startsWith(PERSON_LINE) || line.startsWith(ROW_LINE)), JSON.stringify(card.commits ?? null)]) {
      assert.doesNotMatch(named, /README\.md|notes\.txt/u, `an unrelated dirty file is never named: ${named}`);
    }
    return { lines, card };
  };
  /** The exact commands resume should print for one owner's files. */
  const add = (box, files) => `cd ${box.repo} && git add -- ${files.join(' ')}`;
  const commit = (box, files) => `${add(box, files)} && git commit -q -m "docs(spec): apply row decisions" -- ${files.join(' ')}`;
  /** A board whose init files are committed, with a drafted row the person approved and the coordinator applied. */
  const applied = async () => {
    const box = releaseFixture(t, { freshSetup: true, historyBeforeInit: true });
    const drafted = (await box.runLocal(box.repo, 'spec', 'draft', 'The person can name the project.'));
    assert.equal(drafted.status, 0, drafted.failure || drafted.stderr || drafted.stdout);
    box.git(box.repo, 'add', '-A');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: set up pullboard');
    for (const args of [['spec', 'approve', 'G1'], ['spec', 'apply']]) {
      const ran = (await box.runLocal(box.repo, ...args));
      assert.equal(ran.status, 0, ran.failure || ran.stderr || ran.stdout);
    }
    writeFileSync(join(box.repo, 'README.md'), '# Existing repository\n\nAn unrelated edit.\n');
    writeFileSync(join(box.repo, 'notes.txt'), 'an unrelated new file\n');
    return box;
  };

  // Committed setup plus an applied SPEC.md: the coordinator commits it; the person is not asked.
  const clean = await applied();
  const after = (await resume(clean));
  assert.ok(after.lines.includes(`${ROW_LINE}${commit(clean, ['SPEC.md'])}`), after.lines.join('\n'));
  assert.equal(after.lines.some((line) => line.startsWith(PERSON_LINE)), false, `the person commits nothing:\n${after.lines.join('\n')}`);
  assert.match(after.card.next, /^commit the applied row file first: cd .+ && git add -- SPEC\.md && git commit .+; then /u);
  assert.deepEqual(after.card.commits, { coordinator: { files: ['SPEC.md'], command: commit(clean, ['SPEC.md']) }, person: null });
  // Stays real: it runs the printed shell command, which commits through git, not the CLI.
  const committed = runFixtureChild('sh', ['-c', after.card.commits.coordinator.command], { cwd: clean.repo, env: clean.env, encoding: 'utf8' });
  assert.equal(committed.status, 0, committed.failure || committed.stderr || committed.stdout);
  assert.deepEqual((await resume(clean)).card.commits, { coordinator: null, person: null }, 'the command resume names commits the row file, and only it');

  // Uncommitted setup files: the person commits exactly those, and the coordinator is not asked.
  const fresh = releaseFixture(t, { freshSetup: true, historyBeforeInit: true });
  writeFileSync(join(fresh.repo, 'notes.txt'), 'an unrelated new file\n');
  const setup = (await resume(fresh));
  const initFiles = ['.githooks/commit-msg', '.githooks/post-commit', '.githooks/pre-commit', '.githooks/pre-merge-commit', '.githooks/pre-push', 'AGENTS.md', 'DOCTRINE.md', 'SPEC.md', 'pullboard.json'];
  assert.ok(setup.lines.includes(`${PERSON_LINE}${add(fresh, initFiles)}`), setup.lines.join('\n'));
  assert.equal(setup.lines.some((line) => line.startsWith(ROW_LINE)), false, `the coordinator commits nothing:\n${setup.lines.join('\n')}`);
  assert.deepEqual(setup.card.commits, { coordinator: null, person: { files: initFiles, command: add(fresh, initFiles) } });

  // Both at once: each owner gets exactly its own files, and an unrelated dirty file is never setup.
  const mixed = await applied();
  const config = JSON.parse(readFileSync(join(mixed.repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(mixed.repo, 'pullboard.json'), JSON.stringify({ ...config, gate: 'npm test' }, null, 2) + '\n');
  const both = (await resume(mixed));
  assert.ok(both.lines.includes(`${ROW_LINE}${commit(mixed, ['SPEC.md'])}`), both.lines.join('\n'));
  assert.ok(both.lines.includes(`${PERSON_LINE}${add(mixed, ['pullboard.json'])}`), both.lines.join('\n'));
  assert.deepEqual(both.card.commits, {
    coordinator: { files: ['SPEC.md'], command: commit(mixed, ['SPEC.md']) },
    person: { files: ['pullboard.json'], command: add(mixed, ['pullboard.json']) },
  });

  // A signed apply: the receipt spec apply appended goes in the coordinator's commit with the row.
  const signed = releaseFixture(t, { freshSetup: true, historyBeforeInit: true });
  const keyPath = join(signed.root, 'co-signing-key');
  // Stays real: ssh-keygen is not the CLI.
  const keyed = runFixtureChild('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'resume@example.invalid', '-f', keyPath], { encoding: 'utf8' });
  assert.equal(keyed.status, 0, keyed.failure || keyed.stderr);
  signed.git(signed.repo, 'config', 'user.signingkey', keyPath);
  const signer = (await signed.runLocal(signed.repo, 'spec', 'signers', 'add', '--key', `${keyPath}.pub`, '--by', 'CO'));
  assert.equal(signer.status, 0, signer.failure || signer.stderr || signer.stdout);
  writeFileSync(join(signed.repo, 'SPEC.md'), `${readFileSync(join(signed.repo, 'SPEC.md'), 'utf8').trimEnd()}\n\n## G · Goals\n- G1 [draft, must] The person signs this row. | gate: true | signers: CO\n`);
  signed.git(signed.repo, 'add', '-A');
  signed.git(signed.repo, 'add', '-f', '--', ...['.pullboard/signers', '.pullboard/signers.initial', '.pullboard/first-commit'].filter((file) => existsSync(join(signed.repo, file))));
  signed.git(signed.repo, 'commit', '-q', '-m', 'chore: set up pullboard');
  for (const args of [['spec', 'approve', 'G1', '--by', 'CO'], ['spec', 'apply']]) {
    const ran = (await signed.runLocal(signed.repo, ...args));
    assert.equal(ran.status, 0, ran.failure || ran.stderr || ran.stdout);
  }
  const receipted = (await resume(signed));
  assert.deepEqual(receipted.card.commits.coordinator?.files, ['SPEC.md', '.pullboard/signoffs.jsonl'], 'the receipt spec apply appended is the coordinator\'s to commit with the row');
  assert.ok(receipted.lines.some((line) => line.startsWith('The coordinator must commit the row file spec apply changed and its sign-off receipt: ')), receipted.lines.join('\n'));
  // Stays real: it runs the printed shell command, which commits through git, not the CLI.
  const landed = runFixtureChild('sh', ['-c', receipted.card.commits.coordinator.command], { cwd: signed.repo, env: signed.env, encoding: 'utf8' });
  assert.equal(landed.status, 0, landed.failure || landed.stderr || landed.stdout);
  assert.equal(signed.git(signed.repo, 'cat-file', '-t', 'HEAD:.pullboard/signoffs.jsonl').trim(), 'blob', 'the printed command commits the receipt, so the next worktree or clone has it');
  assert.deepEqual((await resume(signed)).card.commits, { coordinator: null, person: null }, 'nothing is left for either owner');
});

// Process-level cases below stay processes: they run the fixture's copied CLI at a chosen release version and changelog, which the in-process dispatcher cannot stand in for.
test('cli.journeys-resume-flow-upgrade.resume-says-what-is-new-once: clause 2: resume says what is new once after an upgrade [N19]', async t => {
  const box = releaseFixture(t, { previous: '0.8.5' });
  const otherCheckout = join(box.root, 'other-checkout');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: initialize resume release fixture [N19]');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'other', otherCheckout);
  const lane = Object.keys(JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')).lanes)[0];
  // The join reads no release version or changelog, so it runs in-process; the resume calls below read them and stay real.
  const joined = await fixtureJoin(box.runLocal, otherCheckout, lane, '--model', 'Fixture');
  assert.equal(joined.status, 0, joined.failure || joined.stderr || joined.stdout);
  const firstCheckoutRun = box.run(otherCheckout, 'resume');
  assert.equal(firstCheckoutRun.status, 0, firstCheckoutRun.failure || firstCheckoutRun.stderr || firstCheckoutRun.stdout);
  assert.doesNotMatch(firstCheckoutRun.stdout, /new in 0\.8\.[67]|Full release notes/u);
  const first = box.run(box.repo, 'resume');
  assert.equal(first.status, 0, first.failure || first.stderr || first.stdout);
  const text = first.stdout;
  const latest = text.indexOf('new in 0.8.7 — A new session: The latest headline paragraph.');
  const middle = text.indexOf('new in 0.8.6 — See the flow: The middle headline paragraph.');
  assert.ok(latest >= 0 && middle > latest, text);
  const fullNotes = text.indexOf('Full release notes: CHANGELOG.md');
  assert.ok(fullNotes >= 0 && fullNotes < text.indexOf('resume:'), text);
  assert.doesNotMatch(text, /detailed release list|A detailed fix|new in 0\.8\.5/u);
  const second = box.run(box.repo, 'resume');
  assert.equal(second.status, 0, second.failure || second.stderr || second.stdout);
  assert.doesNotMatch(second.stdout, /new in 0\.8\.[67]/u);
});

test('cli.journeys-resume-flow-upgrade.resume-json-carries-what-is-new: clause 3: resume --json carries what is new [N19]', t => {
  const box = releaseFixture(t, { previous: '0.8.5' });
  const first = box.run(box.repo, 'resume', '--json');
  assert.equal(first.status, 0, first.failure || first.stderr || first.stdout);
  assert.deepEqual(JSON.parse(first.stdout).whatsNew, {
    releases: [
      { version: '0.8.7', headline: 'A new session', paragraph: 'The latest headline paragraph.' },
      { version: '0.8.6', headline: 'See the flow', paragraph: 'The middle headline paragraph.' },
    ], omitted: 0, notes: 'CHANGELOG.md',
  });
  const second = box.run(box.repo, 'resume', '--json');
  assert.equal(second.status, 0, second.failure || second.stderr || second.stdout);
  assert.equal(JSON.parse(second.stdout).whatsNew, null, 'JSON notes are shown once');
  const text = box.run(box.repo, 'resume');
  assert.equal(text.status, 0, text.failure || text.stderr || text.stdout);
  assert.doesNotMatch(text.stdout, /new in 0\.8\.[67]/u, 'JSON resume records the displayed notes');
  const fresh = releaseFixture(t);
  const quiet = fresh.run(fresh.repo, 'resume', '--json');
  assert.equal(quiet.status, 0, quiet.failure || quiet.stderr || quiet.stdout);
  assert.equal(JSON.parse(quiet.stdout).whatsNew, null, 'first-ever JSON resume stays quiet');
  const long = releaseFixture(t, { previous: '0.8.3', version: '0.8.9', changelog: LONG_CHANGELOG });
  const trimmed = long.run(long.repo, 'resume', '--json');
  assert.equal(trimmed.status, 0, trimmed.failure || trimmed.stderr || trimmed.stdout);
  const notes = JSON.parse(trimmed.stdout).whatsNew;
  assert.deepEqual(notes.releases.map(release => release.version), ['0.8.9', '0.8.8', '0.8.7']);
  assert.equal(notes.omitted, 2);
  assert.equal(notes.notes, 'CHANGELOG.md');
});
