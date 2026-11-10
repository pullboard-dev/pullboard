/** The complete person-signing case, extracted without changing its native fixtures or assertions [E22,H16]. */
import { apiBoardOpeners } from '../board.js';
import assert from 'node:assert/strict';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  relayClientFixture,
  relayFixtureChild,
} from '../relay/client.js';
import {
  runFixtureChild,
  runFixtureGit,
} from '../child.js';
import {
  grantChallenge,
  softwarePasskey,
} from './passkey.js';
import { refuseNamedSigners } from '../../../../../packages/person/index.js';
import { relayWorkBudgetMs } from '../relay/budget.js';
import { executeMove } from '../../../../../packages/api/index.js';
import { main } from '../native.js';

/** Reuse the original test's paths, process helpers and request/credential assertions. */
export async function personSigningCase(t, { CLI, TRUSTED_CLI, helpers, passkeyRequest, holdsNoPersonCredential, relayCall, receivedRequests }) {
  const box = await relayClientFixture(t);
  // The shipped command, handed the loopback fixture relay as an explicit trusted parameter in this test's own call path:
  // no environment variable or global can make the real CLI trust it (#408 rulings 38756cb3 and 28611).
  const trusted = [TRUSTED_CLI, box.origin];
  /** Run the command in the main checkout with a chosen environment, trusting only this fixture relay. */
  const cli = (env, ...args) => relayFixtureChild(box.root, env, [...trusted, ...args, '--json']);
  // S10a: an agent that cleared AI_AGENT and CLAUDECODE has exactly the person's shell markers.
  const cleared = { ...box.env };
  const marked = { ...box.env, AI_AGENT: '1', CLAUDECODE: '1' };

  // Off, the default: person moves work as today, and status says once that they are not signed.
  const text = runFixtureChild(process.execPath, [CLI, 'status'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(text.status, 0);
  assert.equal(text.stdout.split('\n').filter((line) => /person moves are not signed/u.test(line)).length, 1, 'status says it in one line');
  assert.equal((await box.cli('status')).document.person.signed, false);
  const early = (await box.cli('shout', 'person', 'A decision before signing', '--decision')).document.id;
  assert.equal((await cli(box.env, 'answer', String(early), 'Off answers as today', '--as', 'person')).code, 0, 'off: the terminal answers as the person');

  // A board with no relay cannot turn signing on: only the relay can vouch for a passkey (#408 trust-anchor ruling).
  const offline = await cli(marked, 'settings', 'person.signed', 'on');
  assert.equal(offline.document.error?.code, 'PERSON_SIGNING_RELAY', `no relay, no signing: ${JSON.stringify(offline.document)}`);
  // Linked, turning signing on is allowed from the terminal, even an agent's; unlinking then still works with no tap.
  assert.equal((await box.link()).code, 0);
  const on = await cli(marked, 'settings', 'person.signed', 'on');
  assert.equal(on.code, 0, `an agent may turn signing on: ${JSON.stringify(on.document)}`);
  assert.equal(on.document.person.signed, true);
  const ask = (await box.cli('shout', 'person', 'A decision only the person answers', '--decision')).document.id;
  // The same board on a device that is not paired: its link set aside, restored below without linking again, and no
  // move succeeds meanwhile, so the relay and the board still agree when it returns.
  renameSync(box.linkFile, `${box.linkFile}.unpaired`);

  // S10a and the on-and-unpaired case: every person move fails closed at once, naming how to pair a passkey.
  const calls = box.calls.length;
  for (const words of [['answer', String(ask), 'S10a cleared markers', '--as', 'person'], ['spec', 'approve', 'E1'], ['spec', 'approve', 'doctrine:D1'],
    ['spec', 'decline', 'E1', '--reason', 'no'], ['land', '--waive', 'test/x.test.js', '--until', '2099-01-01', '--reason', 'flaky'], ['settings', 'person.signed', 'off']]) {
    const refused = await cli(cleared, ...words);
    assert.equal(refused.code, 1, words.join(' '));
    assert.equal(refused.document.error.code, 'PERSON_SIGNED', `${words.join(' ')}: ${JSON.stringify(refused.document)}`);
    assert.match(refused.document.error.next, /relay on --all/u, 'unpaired: the next step pairs a phone or browser');
    assert.match(refused.document.error.next, /passkey/u);
  }
  assert.equal(box.calls.length, calls, 'refused locally, before any network call or wait');
  assert.equal((await cli(marked, 'answer', String(ask), 'marked agent', '--as', 'person')).document.error.code, 'PERSON_SIGNED', 'an agent shell is refused too');
  const remote = await cli({ ...cleared, SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' }, 'answer', String(ask), 'from SSH', '--as', 'person');
  assert.equal(remote.document.error.code, 'PERSON_SIGNED', 'over SSH the same passkey step applies');

  // No local file edit turns it off: not the project config, not machine settings.
  const config = join(box.root, 'pullboard.json');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), person: { signed: false } }, null, 2) + '\n');
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ person: { signed: false } }) + '\n');
  assert.equal((await cli(cleared, 'answer', String(ask), 'after edits', '--as', 'person')).document.error.code, 'PERSON_SIGNED', 'edits leave it on');
  assert.equal((await box.cli('status')).document.person.signed, true);

  // S10b: whatever the OS user can read, an agent can read, so the local view's channel is refused too.
  const viewed = await executeMove(box.root, { verb: 'answer', item: ask, args: { as: 'person', text: 'through the view secret' } }, main, undefined, undefined, undefined, apiBoardOpeners);
  assert.equal(viewed.body.error?.code, 'PERSON_SIGNED', 'the view channel is not the person once signing is on');

  // Linked, a terminal person move goes to the passkey as an action-bound request and says where to confirm.
  renameSync(`${box.linkFile}.unpaired`, box.linkFile);
  assert.ok(holdsNoPersonCredential(box, box.root) && holdsNoPersonCredential(box, box.env.HOME), 'no file holds a person session or grant');
  const terminal = helpers.launch({ ...box, env: { ...cleared, SSH_CONNECTION: '127.0.0.1 40000 127.0.0.1 22' } },
    box.root, process.execPath, [...trusted, 'answer', String(ask), 'Signed on the passkey', '--as', 'person', '--json']);
  t.after(async () => { if (terminal.exitCode === null && terminal.signalCode === null) terminal.kill('SIGTERM'); await terminal.closed; });
  /** Observe fixture SQLite directly; no second command may execute the waiting action. */
  const nativeRows = (sql, ...args) => {
    const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
    try { return db.prepare(sql).all(...args); } finally { db.close(); }
  };
  /** Read durable request receipts without running status, export or another command. */
  const nativeRequests = () => Object.fromEntries(JSON.parse(nativeRows('SELECT meta_value FROM board_meta WHERE meta_key=?',
    'relay_person_requests')[0]?.meta_value ?? '[]').filter(record => !record.duplicateOf).map(record => [record.id, record]));
  await helpers.waitFor(() => {
    assert.equal(terminal.exitCode, null, terminal.stderrText);
    return terminal.stderrText.includes(box.origin) && terminal.stderrText.includes('this terminal is waiting');
  }, 'the original SSH terminal asks for one passkey confirmation', relayWorkBudgetMs(5));
  const proposals = JSON.parse(nativeRows('SELECT meta_value FROM board_meta WHERE meta_key=?', 'person_proposals')[0].meta_value);
  const proposal = proposals.at(-1);
  assert.deepEqual(proposal.move, { verb: 'answer', item: ask, args: { as: 'person', text: 'Signed on the passkey' } }, 'the exact move waits for the passkey');

  // The person registers a passkey with user presence; agents and machines cannot ask for a grant.
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const phone = (await box.phoneSession()).token;
  const passkey = softwarePasskey(box.origin);
  const challenge = await relayCall(box, phone, 'POST', '/api/v1/passkeys/challenge', {});
  assert.equal(challenge.status, 200, JSON.stringify(challenge.document));
  const registered = await relayCall(box, phone, 'POST', '/api/v1/passkeys', { challenge: challenge.document.challenge, ...passkey.create(challenge.document.challenge) });
  assert.equal(registered.status, 200, JSON.stringify(registered.document));
  const document = { version: 1, type: 'person-request', id: proposal.id, move: proposal.move };
  const machineGrant = await relayCall(box, link.token, 'POST', `/api/v1/boards/${link.board}/person-grants`, { request: proposal.id, digest: 'a'.repeat(64) });
  assert.equal(machineGrant.document.error?.code, 'HUMAN_REQUIRED', 'the machine credential, which agents share, gets no grant');
  /** Ask the relay for a fresh single-use grant for this request and the digest of its exact intent. */
  const grantFor = async (document) => {
    const digest = createHash('sha256').update(JSON.stringify(document)).digest('hex');
    const issued = await relayCall(box, phone, 'POST', `/api/v1/boards/${link.board}/person-grants`, { request: document.id, digest });
    assert.equal(issued.status, 200, JSON.stringify(issued.document));
    assert.deepEqual(issued.document.credentials, [passkey.id]);
    return issued.document.grant;
  };

  // Without user presence, or with no assertion at all, nothing acts as the person.
  const absent = await passkeyRequest(box, phone, document, { grant: await grantFor(document), ...passkey.get(grantChallenge('not-this-grant')) });
  assert.equal(absent.document.error?.code, 'PASSKEY_ASSERTION', 'an assertion over another challenge is refused');
  const grant = await grantFor(document);
  const noPresence = await passkeyRequest(box, phone, document, { grant, ...passkey.get(grantChallenge(grant), { presence: false }) });
  assert.equal(noPresence.document.error?.code, 'PASSKEY_PRESENCE', 'an authenticator answer with no user present is refused');
  const elsewhere = await passkeyRequest(box, phone, document, { grant, ...passkey.get(grantChallenge(grant), { origin: 'http://elsewhere.localhost' }) });
  assert.equal(elsewhere.document.error?.code, 'PASSKEY_ASSERTION', 'an answer made for another site is refused');
  const forgedSignature = { grant, ...passkey.get(grantChallenge(grant)), signature: passkey.get(grantChallenge('other bytes')).signature };
  assert.equal((await passkeyRequest(box, phone, document, forgedSignature)).document.error?.code, 'PASSKEY_ASSERTION', 'a signature over other bytes is refused');
  const unsigned = { version: 1, type: 'person-request', id: randomUUID(), move: proposal.move };
  assert.equal((await passkeyRequest(box, phone, unsigned)).status, 200, 'the relay stores a session request without a passkey');
  await helpers.waitFor(() => nativeRequests()[unsigned.id]?.status === 'refused', 'the waiting terminal refuses unsigned intent', relayWorkBudgetMs(5));
  let received = nativeRequests();
  assert.equal(received[unsigned.id].status, 'refused');
  assert.equal(received[unsigned.id].error.code, 'PERSON_SIGNED', 'without a passkey the native board refuses it');

  // One confirmation on the passkey carries out the exact move, once.
  const presence = { grant, ...passkey.get(grantChallenge(grant)) };
  const signed = await passkeyRequest(box, phone, document, presence);
  assert.equal(signed.status, 200, JSON.stringify(signed.document));
  const terminalResult = await terminal.closed;
  assert.equal(terminalResult.code, 0, terminal.stderrText);
  assert.equal(JSON.parse(terminal.stdoutText).request, proposal.id, 'the original terminal reports its exact request');
  received = nativeRequests();
  assert.equal(received[proposal.id].status, 'done', JSON.stringify(received[proposal.id]));
  const answers = nativeRows('SELECT * FROM shout WHERE shout_answers=?', ask);
  assert.deepEqual(answers.map((row) => [row.shout_from, row.shout_text]), [['person', 'Signed on the passkey']]);
  const replay = await passkeyRequest(box, phone, { ...document, id: randomUUID() }, presence);
  assert.equal(replay.document.error?.code, 'PHONE_APPROVAL_USED', 'the grant is single-use');
  assert.ok(holdsNoPersonCredential(box, box.root) && holdsNoPersonCredential(box, box.env.HOME), 'the grant was never stored');

  // A hand edit to the board file cannot forge a passkey request, turn signing off or swap the relay key.
  const raw = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    /** One board metadata value, read straight from the file. */
    const meta = (key) => raw.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key)?.meta_value;
    assert.equal(meta('event_log_version'), '2', 'a Pullboard from before signed moves refuses this board');
    assert.throws(() => raw.prepare("UPDATE board_meta SET meta_value='{}' WHERE meta_key='person_authority_local'").run(), /PERSON_AUTHORITY/u, 'the pinned relay key stays');
    assert.throws(() => raw.prepare("INSERT OR REPLACE INTO board_meta(meta_key,meta_value) VALUES ('person_authority_local','{}')").run(), /PERSON_AUTHORITY/u);
    assert.throws(() => raw.prepare("DELETE FROM event WHERE event_kind='person_signing'").run(), /APPEND_ONLY/u, 'the signing history stays');
    const records = JSON.parse(meta('relay_person_requests'));
    const genuine = records.find((record) => record.id === proposal.id);
    const sender = JSON.parse(genuine.received).sender;
    // A genuine stamp copied into a hand-written off names the digest of another request.
    raw.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?,?,?,?,?)').run(new Date().toISOString(), 'person', 'person_signing', null,
      JSON.stringify({ signed: false, request: proposal.id, presence: sender.presence, intent: { version: 1, type: 'person-request', id: proposal.id, move: { verb: 'signing', args: { signed: 'off' } } } }));
    // The same stamp on a rewritten request: the same id, another answer, waiting to run again.
    const forged = structuredClone(document);
    forged.move.args.text = 'A forged second answer';
    const { result, resultSequence, executor, executorUntil, ...rest } = genuine;
    const rewritten = { ...rest, move: forged.move, encoded: JSON.stringify(forged), received: JSON.stringify({ document: forged, sender }), status: 'waiting' };
    raw.prepare('UPDATE board_meta SET meta_value=? WHERE meta_key=?').run(JSON.stringify(records.map((record) => record.id === genuine.id ? rewritten : record)), 'relay_person_requests');
  } finally { raw.close(); }
  assert.equal((await box.cli('status')).document.person.signed, true, 'the hand-written off turns nothing off');
  const waitingAgain = helpers.launch({ ...box, env: cleared }, box.root, process.execPath,
    [...trusted, 'answer', String(ask), 'still signed', '--as', 'person', '--json']);
  try {
    await helpers.waitFor(() => { assert.equal(waitingAgain.exitCode, null, waitingAgain.stderrText); return waitingAgain.stderrText.includes('this terminal is waiting'); },
      'a cleared-marker terminal still waits for a new confirmation', relayWorkBudgetMs(5));
    assert.equal(nativeRows('SELECT * FROM shout WHERE shout_answers=?', ask).length, 1, 'waiting creates no second person answer');
  } finally { if (waitingAgain.exitCode === null && waitingAgain.signalCode === null) waitingAgain.kill('SIGTERM'); await waitingAgain.closed; }
  assert.equal((await box.cli('export')).document.tables.shout.filter((row) => row.shout_answers === ask).length, 1, 'the rewritten request never runs as the person');

  // A signed row decision binds the exact rows the person saw; a row naming SSH signers is refused by name.
  const shown = { id: 'G1', text: 'A row the person decides on the passkey.' };
  writeFileSync(join(box.root, 'SPEC.md'), readFileSync(join(box.root, 'SPEC.md'), 'utf8').replace('## G · Goals: what the client asked for\n',
    `## G · Goals: what the client asked for\n\n- G1 [draft, must] ${shown.text} | gate: review\n`));
  // The template's own placeholder G1 may sit beside it; the person sees the row this test wrote.
  shown.source = readFileSync(join(box.root, 'SPEC.md'), 'utf8').split(/\r?\n/u).find(line => line.startsWith('- G1 ') && line.includes(shown.text));
  const blind = { version: 1, type: 'person-request', id: randomUUID(), move: { verb: 'spec-approve', args: { ids: 'G1' } } };
  const seen = { ...blind, id: randomUUID(), rows: [shown] };
  for (const request of [blind, seen]) {
    const rowGrant = await grantFor(request);
    assert.equal((await passkeyRequest(box, phone, request, { grant: rowGrant, ...passkey.get(grantChallenge(rowGrant)) })).status, 200);
  }
  received = await receivedRequests(box, (...args) => cli(box.env, ...args));
  assert.equal(received[blind.id].error?.code, 'STALE_ROW_DECISION', 'a decision that does not name the rows shown is refused');
  assert.notEqual(received[seen.id].status, 'refused', JSON.stringify(received[seen.id]));
  const decided = (await box.cli('export')).document.tables.event.filter((row) => row.event_kind === 'row_decision');
  assert.deepEqual(decided.map((row) => [row.event_by, JSON.parse(row.event_detail).record.id]), [['person', 'G1']], 'the passkey decided exactly the row it showed');
  // The real CLI applies that decision, checked against the authority its relay vouches for, never a stored key (#408).
  const applied = await cli(box.env, 'spec', 'apply');
  assert.equal(applied.code, 0, JSON.stringify(applied.document));
  assert.match(readFileSync(join(box.root, 'SPEC.md'), 'utf8'), /- G1 \[approved, must\] A row the person decides on the passkey\./u, 'the native CLI applies the passkey approval');
  assert.throws(() => refuseNamedSigners([{ id: 'G2', signers: ['alice@example.com'] }], ['G2']), { code: 'PERSON_SIGNER_REQUIRED', message: /G2 names its SSH signers alice@example\.com/u });

  /** One live SSH command, one confirmation, no status/export/other CLI before its original exit. */
  async function confirmTerminal(argv, expectedVerb) {
    const beforeIds = new Set(JSON.parse(nativeRows('SELECT meta_value FROM board_meta WHERE meta_key=?', 'person_proposals')[0]?.meta_value ?? '[]').map(entry => entry.id));
    const child = helpers.launch({ ...box, env: { ...cleared, SSH_CONNECTION: '127.0.0.1 40000 127.0.0.1 22' } },
      box.root, process.execPath, [...trusted, ...argv, '--json']);
    try {
      const proposal = await helpers.waitFor(() => {
        assert.equal(child.exitCode, null, child.stderrText);
        if (!child.stderrText.includes('this terminal is waiting')) return null;
        return JSON.parse(nativeRows('SELECT meta_value FROM board_meta WHERE meta_key=?', 'person_proposals')[0]?.meta_value ?? '[]').find(entry => !beforeIds.has(entry.id));
      }, 'the exact new terminal proposal', relayWorkBudgetMs(5));
      assert.equal(proposal.move.verb, expectedVerb);
      const request = { version: 1, type: 'person-request', id: proposal.id, move: proposal.move,
        ...(proposal.rows ? { rows: proposal.rows } : {}) };
      const actionGrant = await grantFor(request);
      const actionResponse = await passkeyRequest(box, phone, request, { grant: actionGrant, ...passkey.get(grantChallenge(actionGrant)) });
      assert.equal(actionResponse.status, 200, JSON.stringify(actionResponse.document));
      const outcome = await child.closed;
      assert.equal(outcome.code, 0, child.stderrText);
      const result = JSON.parse(child.stdoutText);
      assert.equal(result.request, proposal.id);
      assert.ok(['done', 'waiting'].includes(nativeRequests()[proposal.id].status));
      return result;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await child.closed;
    }
  }
  // Each newly mapped action must complete on its original terminal, with exact target/meaning.
  const factItem = (await box.cli('add', box.lane, 'SIGNED_FACT_TARGET')).document.item.item_id;
  const fact = await confirmTerminal(['fact', String(factItem), 'decision', 'Keep this exact rule', '--as', 'person', '--cause', 'row:G1', '--never-again'], 'fact');
  assert.equal(fact.item, factItem);
  assert.equal(fact.fact.text, 'Keep this exact rule');
  const held = await confirmTerminal(['hold', box.lane, '--as', 'person', '--reason', 'Wait for the exact reviewed rule'], 'hold');
  assert.equal(held.held, true);
  assert.equal(nativeRows('SELECT hold_reason,hold_by FROM hold WHERE hold_lane=?', box.lane)[0].hold_by, 'person');
  const unheld = await confirmTerminal(['hold', box.lane, '--as', 'person', '--off'], 'hold');
  assert.equal(unheld.held, false);
  assert.equal(nativeRows('SELECT * FROM hold WHERE hold_lane=?', box.lane).length, 0);
  for (const name of ['signed-watch-approved', 'signed-watch-declined']) {
    assert.equal((await box.cli('sentinel', 'propose', name, '--check', 'true', '--every', 'hourly', '--owner', 'coordinator')).code, 0);
  }
  const watch = await confirmTerminal(['sentinel', 'approve', 'signed-watch-approved'], 'sentinel-approve');
  assert.equal(watch.sentinel.status, 'approved');
  const declinedWatch = await confirmTerminal(['sentinel', 'decline', 'signed-watch-declined', '--reason', 'Do not run this exact watch'], 'sentinel-decline');
  assert.equal(declinedWatch.sentinel.status, 'declined');
  const question = 'Which store holds the data: SQLite. Choices: SQLite, Postgres.';
  writeFileSync(join(box.root, 'SPEC.md'), readFileSync(join(box.root, 'SPEC.md'), 'utf8')
    + `\n- G2 [pending, must] ${question} | gate: review\n- G3 [draft, must] A terminal-approved row. | gate: review\n- G4 [draft, must] A terminal-declined row. | gate: review\n`);
  const answeredRow = await confirmTerminal(['spec', 'answer', 'G2', 'Postgres'], 'spec-answer');
  assert.equal(answeredRow.decisions[0].id, 'G2');
  assert.match(answeredRow.decisions[0].text, /data: Postgres/u);
  const approvedRow = await confirmTerminal(['spec', 'approve', 'G3'], 'spec-approve');
  assert.equal(approvedRow.decisions[0].decision, 'approve');
  const declinedRow = await confirmTerminal(['spec', 'decline', 'G4', '--reason', 'Do not approve this row'], 'spec-decline');
  assert.equal(declinedRow.decisions[0].decision, 'decline');
  writeFileSync(join(box.root, 'SPEC.md'), readFileSync(join(box.root, 'SPEC.md'), 'utf8')
    + '\n- G5 [approved, must] An optional sign-off row. | gate: review\n- G6 [approved, must] A named-signature row. | gate: review | signers: alice@example.com\n');
  mkdirSync(join(box.root, 'test'), { recursive: true });
  writeFileSync(join(box.root, 'test/signed-evidence.test.js'), '/** [G5] Cited evidence fixture; no test run is implied by optional sign-off. */\n');
  runFixtureGit(['add', 'test/signed-evidence.test.js'], { cwd: box.root, env: box.env });
  const sshFile = join(box.root, '.pullboard', 'signoffs.jsonl');
  const beforeSsh = existsSync(sshFile) ? readFileSync(sshFile, 'utf8') : null;
  const optionalSignoff = await confirmTerminal(['spec', 'signoff', 'G5'], 'spec-approve');
  assert.equal(optionalSignoff.count, 1);
  assert.equal(optionalSignoff.by, 'person');
  assert.equal(existsSync(sshFile) ? readFileSync(sshFile, 'utf8') : null, beforeSsh, 'passkey approval never writes an SSH signature');
  const namedSignoff = await cli(cleared, 'spec', 'signoff', 'G6');
  assert.equal(namedSignoff.document.error?.code, 'PERSON_SIGNER_REQUIRED');
  assert.match(namedSignoff.document.error.message, /G6 names its SSH signers alice@example\.com/u);
  const signerChange = await cli(cleared, 'spec', 'signers', 'add', '--by', 'alice@example.com', '--key', 'unread-key');
  assert.equal(signerChange.document.error?.code, 'PERSON_SIGNER_REQUIRED');
  assert.match(signerChange.document.error.message, /alice@example\.com/u);

  const waiver = await confirmTerminal(['land', '--waive', 'gate:lint', '--until', '2099-01-01', '--reason', 'An explicit bounded fixture exception'], 'land-waive');
  assert.equal(waiver.waiver.test, 'gate:lint');

  // Only the passkey turns signing off; unlinking offline keeps it on.
  const switchedOff = await confirmTerminal(['settings', 'person.signed', 'off'], 'signing');
  assert.equal(switchedOff.person.signed, false);
  assert.equal((await cli(box.env, 'status')).document.person.signed, false, 'the passkey turned signing off');
  assert.equal((await cli(marked, 'settings', 'person.signed', 'on')).code, 0);
  await box.stopRelay();
  await cli(cleared, 'relay', 'off');
  assert.equal(existsSync(box.linkFile), false, 'unlinking works offline with no tap');
  assert.equal((await box.cli('status')).document.person.signed, true, 'unlinking never turns signing off');
}
