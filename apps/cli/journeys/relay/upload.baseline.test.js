/** @pullboard-test-input apps/cli/pullboard.js apps/lib/index.js apps/lib/src/io/worker/checkpoint/relay.js packages/link/index.js packages/outbox/index.js */
/** Legacy API1 refusals recover without blocking moves; current API2 pause proofs live in relay-upload-pause.test.js [H16,B26]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import {
  closingFetch,
  relayClientFixture,
  uploadedState,
} from '../../tests/fixtures/relay/upload.js';

// The subtests each start their own private relay fixture, so they run side by side.
test('an existing or paused remote baseline never lets a refused upload fall back locally [H16]', { concurrency: 4 }, async (t) => {
  const pending = [];
  const sub = (...args) => { const run = t.test(...args); pending.push(run); return run; };
  /** A durable pre-ACK local intent cannot prove that the remote board is empty. */
  for (const sequence of [0, 1]) {
    sub(`an existing remote baseline at sequence ${sequence} never pauses locally [H16]`, async subtest => {
      const existing = await relayClientFixture(subtest);
      await existing.link();
      const first = JSON.parse(readFileSync(existing.linkFile, 'utf8'));
      const response = await closingFetch(existing.origin + '/api/v1/boards/' + first.board + '/state', {
        headers: { authorization: 'Bearer ' + first.token, 'x-pullboard-engine': String(ENGINE_VERSION) },
      });
      assert.equal(response.status, 200);
      const original = (await response.json()).state;
      if (sequence === 1) assert.equal((await existing.cli('add', existing.lane, 'live remote prefix before new local intent')).code, 0);
      // This is exactly a durable initial upload intent before the native client received its ACK.
      const interrupted = JSON.parse(readFileSync(existing.linkFile, 'utf8'));
      interrupted.baselineAccepted = false;
      interrupted.snapshot = { sequence: 0, sealed: original.sealed };
      writeFileSync(existing.linkFile, JSON.stringify(interrupted) + '\n', { mode: 0o600 });
      existing.rejectSnapshots({ status: 400, code: 'BAD_UPLOAD', message: 'fixture permanently refused retry' });
      const movesBefore = existing.moveAcks.length;
      const blocked = await existing.cli('add', existing.lane, 'must never diverge into local fallback');
      assert.equal(blocked.code, 1, 'an existing authenticated remote snapshot prevents local fallback');
      assert.equal(blocked.document.error.code, 'RELAY_BASELINE_EXISTS');
      assert.match(blocked.document.error.message, /protect.*ordered history/u);
      const durable = JSON.parse(readFileSync(existing.linkFile, 'utf8'));
      assert.equal(durable.baselinePause, undefined, 'no never-accepted claim is persisted for an existing remote baseline');
      assert.equal(existing.moveAcks.length, movesBefore, 'the refused command emits no divergent ordered move');
      const exported = await existing.cli('export');
      assert.equal(exported.code, 0);
      assert.equal(exported.document.tables.item.some(row => row.item_title === 'must never diverge into local fallback'), false,
        'the guarded command never applies locally either');
      assert.equal((await uploadedState(existing)).sequence, sequence, 'the actual stored remote prefix remains intact');
      const beforeRestart = await uploadedState(existing);
      existing.rejectSnapshots(null);
      const restarted = await existing.cli('add', existing.lane, 'never overwrite a conflicting baseline after restart');
      assert.equal(restarted.code, 1, 'fresh commands remain fenced even when the snapshot refusal clears');
      assert.equal(restarted.document.error.code, 'RELAY_BASELINE_EXISTS');
      assert.deepEqual(await uploadedState(existing), beforeRestart, 'the remote baseline remains byte-for-byte intact');
      assert.equal(existing.moveAcks.length, movesBefore);
      assert.equal(JSON.parse(readFileSync(existing.linkFile, 'utf8')).baselineConflict, true);
      for (const command of ['status', 'doctor']) {
        const reported = await existing.cli(command);
        assert.match((reported.document.diagnostics ?? []).join('\n'), /RELAY_BASELINE_EXISTS.*pullboard export.*pullboard relay off/u);
      }
      const relink = await existing.cli('relay', 'on', '--url', existing.origin);
      assert.equal(relink.code, 1, 'plain relay on refuses the durable conflict before sign-in or snapshot upload');
      assert.equal(relink.document.error.code, 'RELAY_BASELINE_EXISTS');
      assert.deepEqual(await uploadedState(existing), beforeRestart);
      const restartExport = await existing.cli('export');
      assert.equal(restartExport.document.tables.item.some(row => row.item_title === 'never overwrite a conflicting baseline after restart'), false);
    });
  }

  /** A remote baseline appearing after a durable pause must end local-only fallback. */
  for (const sequence of [0, 1]) {
    sub(`a previously paused board with remote sequence ${sequence} never diverges locally [H16]`, async subtest => {
      const existing = await relayClientFixture(subtest);
      existing.rejectSnapshots({ status: 400, code: 'BAD_UPLOAD', message: 'fixture refused initial baseline' });
      await existing.link();
      const paused = readFileSync(existing.linkFile, 'utf8');
      assert.ok(JSON.parse(paused).baselinePause);
      existing.rejectSnapshots(null);
      const advanced = sequence === 0 ? await existing.cli('status')
        : await existing.cli('add', existing.lane, 'actual native remote prefix');
      assert.equal(advanced.code, 0);
      assert.equal((await uploadedState(existing)).sequence, sequence);
      // Model a restarted client's still-durable pause after the remote accepted another upload.
      writeFileSync(existing.linkFile, paused, { mode: 0o600 });
      const putsBeforeConflict = existing.calls.filter(call => call.method === 'PUT' && call.path.endsWith('/state')).length;
      const beforeConflict = await uploadedState(existing);
      const blocked = await existing.cli('add', existing.lane, 'never apply a divergent paused local move');
      assert.equal(blocked.code, 1);
      assert.equal(blocked.document.error.code, 'RELAY_BASELINE_EXISTS');
      assert.equal(existing.calls.filter(call => call.method === 'PUT' && call.path.endsWith('/state')).length, putsBeforeConflict,
        'a remote baseline appearing during pause is checked before any recovered upload can overwrite it');
      assert.deepEqual(await uploadedState(existing), beforeConflict);
      const durable = JSON.parse(readFileSync(existing.linkFile, 'utf8'));
      assert.equal(durable.baselineAccepted, true, 'remote presence is durable evidence against future local fallback');
      assert.equal(durable.baselinePause, undefined);
      const exported = await existing.cli('export');
      assert.equal(exported.code, 0);
      assert.equal(exported.document.tables.item.some(row => row.item_title === 'never apply a divergent paused local move'), false);
      assert.equal((await uploadedState(existing)).sequence, sequence);
      const beforeRestart = await uploadedState(existing);
      const movesBeforeRestart = existing.moveAcks.length;
      existing.rejectSnapshots(null);
      const restarted = await existing.cli('add', existing.lane, 'never overwrite a resumed conflicting baseline');
      assert.equal(restarted.code, 1, 'the durable remote-presence fence survives a fresh CLI invocation');
      assert.equal(restarted.document.error.code, 'RELAY_BASELINE_EXISTS');
      assert.deepEqual(await uploadedState(existing), beforeRestart);
      assert.equal(existing.moveAcks.length, movesBeforeRestart);
      assert.equal(JSON.parse(readFileSync(existing.linkFile, 'utf8')).baselineConflict, true);
      for (const command of ['status', 'doctor']) {
        const reported = await existing.cli(command);
        assert.match((reported.document.diagnostics ?? []).join('\n'), /RELAY_BASELINE_EXISTS.*pullboard export.*pullboard relay off/u);
      }
      const relink = await existing.cli('relay', 'on', '--url', existing.origin);
      assert.equal(relink.code, 1, 'plain relay on refuses the durable conflict before sign-in or snapshot upload');
      assert.equal(relink.document.error.code, 'RELAY_BASELINE_EXISTS');
      assert.deepEqual(await uploadedState(existing), beforeRestart);
      const restartExport = await existing.cli('export');
      assert.equal(restartExport.document.tables.item.some(row => row.item_title === 'never overwrite a resumed conflicting baseline'), false);
    });
  }

  /** Only authenticated absence may authorize a local move, including after a failed preflight. */
  for (const refusal of [
    { label: 'unknown', status: 404, code: 'UNKNOWN_STATE' },
    { label: 'auth', status: 401, code: 'AUTH_REQUIRED' },
    { label: 'unavailable', status: 503, code: 'RELAY_UNAVAILABLE', transient: true },
    { label: 'wrong-version', status: 404, code: 'NO_BOARD', version: 2 },
    { label: 'unavailable-absence', status: 503, code: 'NO_BOARD', transient: true },
    { label: 'auth-absence', status: 401, code: 'NO_SNAPSHOT' },
  ]) {
    sub(`uncertain ${refusal.label} remote state never authorizes local fallback [H16]`, async subtest => {
      const uncertain = await relayClientFixture(subtest);
      uncertain.rejectSnapshots({ status: 400, code: 'BAD_UPLOAD', message: 'fixture refused initial baseline' });
      await uncertain.link();
      assert.ok(JSON.parse(readFileSync(uncertain.linkFile, 'utf8')).baselinePause);
      uncertain.rejectStateReads(refusal);
      const blocked = await uncertain.cli('add', uncertain.lane, 'never apply a move after uncertain preflight');
      if (refusal.transient) {
        // #919: a relay that merely cannot answer never fails a local move; the move waits for a baseline, never an ordered send.
        assert.equal(blocked.code, 0, 'an unreachable relay never fails a move before the baseline is accepted [B26]');
        assert.equal(uncertain.moveAcks.length, 0);
        const kept = await uncertain.cli('export');
        assert.equal(kept.document.tables.item.some(row => row.item_title === 'never apply a move after uncertain preflight'), true);
        return;
      }
      assert.equal(blocked.code, 1, 'a failed remote check cannot become local fallback in the same command');
      assert.equal(blocked.document.error.code, refusal.code);
      assert.equal(uncertain.moveAcks.length, 0);
      const exported = await uncertain.cli('export');
      assert.equal(exported.code, 0);
      assert.equal(exported.document.tables.item.some(row => row.item_title === 'never apply a move after uncertain preflight'), false);
    });
  }

  await Promise.all(pending);
});
