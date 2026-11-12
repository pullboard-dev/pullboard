/** @pullboard-test-loads packages/link/src/io/relay.js apps/cli/src/io/entry.js */
/** A transient outage never turns an acknowledged-authority exception into a local move [H21,H16]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { relayOutboxSetting } from '../../index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import {
  outboxFile,
  outboxQueueable,
} from '../../../../packages/outbox/index.js';
import { Refused } from '../../../../packages/kernel/light.js';
import {
  legacyRelayClientFixture,
  relayClientFixture,
} from '../../tests/fixtures/relay/client.js';

const CLI = fileURLToPath(new URL('../../pullboard.js', import.meta.url));

/** Commit the private board's absent-setting default, as the real policy reader requires. */
function commitDefaultOutbox(box) {
  const configFile = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(Object.hasOwn(config.relay ?? {}, 'outbox'), false, 'the private board uses the absent-setting default');
  // The real policy reader reads committed configuration; the fixture already committed this file.
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${CLI}" "$@"\n`, { mode: 0o700 });
  assert.equal(relayOutboxSetting(box.root), true, 'the committed absent setting really enables fallback');
}

/** Run a synchronous policy control with a synthetic token, restoring the test process's original environment. */
function withToken(value, work) {
  const original = process.env.PULLBOARD_RELAY_TOKEN;
  if (value === undefined) delete process.env.PULLBOARD_RELAY_TOKEN;
  else process.env.PULLBOARD_RELAY_TOKEN = value;
  try { return work(); }
  finally {
    if (original === undefined) delete process.env.PULLBOARD_RELAY_TOKEN;
    else process.env.PULLBOARD_RELAY_TOKEN = original;
  }
}

/** An already accepted ordered link and the public transient failure needed for policy-only controls. */
function policy(state = {}, operation = 'shout', io = {}, args = []) {
  return outboxQueueable({ mode: 'ordered', baselineAccepted: true, ...state },
    new Refused('RELAY_UNAVAILABLE', 'the private relay is unavailable'), operation,
    { relayOutbox: () => true, ...io }, args);
}

test('ordinary accepted-link transient fallback honors the effective outbox setting [H21,H16]', () => withToken(undefined, () => {
  assert.equal(policy(), true);
  assert.equal(policy({}, 'appendFact', {}, [1, { agentId: 'fixture' }]), true);
  assert.equal(policy({}, 'shout', { relayOutbox: () => false }), false, 'an explicit opt-out stays off');
  assert.equal(policy({}, 'shout', { relayOutbox() { throw new Error('private configuration unavailable'); } }), false);
  assert.equal(policy({ baselineAccepted: false }), false);
  assert.equal(policy({ baselineConflict: {} }), false);
  assert.equal(outboxQueueable({ mode: 'ordered', baselineAccepted: true }, new Refused('AUTH_REQUIRED', 'sign in again'),
    'shout', { relayOutbox: () => true }, []), false, 'a definite authentication refusal never queues a move');
}));

test('all environment-token sessions require acknowledgment instead of offline fallback [H21,H16,E18]', () => {
  withToken(undefined, () => assert.equal(policy({ environment: { agent: 'fixture' } }), false, 'a saved ephemeral link never queues'));
  for (const token of ['pa_' + 'x'.repeat(43), '']) {
    withToken(token, () => assert.equal(policy(), false, 'the presence of an environment token excludes even an otherwise ordinary link'));
  }
});

test('takeover landing and person-request authority cannot gain a transient fallback [H21,H16]', () => withToken(undefined, () => {
  for (const operation of ['register', 'ensureCoordinator', 'takeCoordinator', 'landingLeaseMove']) {
    assert.equal(policy({}, operation), false, `${operation} needs relay acknowledgment`);
  }
  assert.equal(policy({}, 'shout', { personRequest: {} }), false);
  assert.equal(policy({}, 'shout', { personRequestMoveId: 'private-request' }), false);
}));

test('landing-fenced arguments remain acknowledged across every transient fallback [H21,H16]', () => withToken(undefined, () => {
  assert.equal(policy({}, 'appendFact', {}, [{ landingFence: { batch: 'fixture' } }]), false);
  assert.equal(policy({}, 'editItem', {}, [1, { landingFence: { batch: 'fixture' } }]), false);
  assert.equal(policy({}, 'editItem', {}, [1, { brief: 'ordinary change' }]), true);
}));

test('an accepted linked environment-token CLI refuses an offline move without creating an outbox [H21,H16,E18]', async t => {
  const box = await relayClientFixture(t);
  commitDefaultOutbox(box);
  assert.equal((await box.link()).code, 0);
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.equal(state.baselineAccepted, true, 'the private relay accepted this real linked board');
  const token = state.agentTokens?.coordinator?.token;
  assert.equal(typeof token, 'string', 'the actual linked coordinator has a board-scoped token');
  const text = 'An ephemeral session must receive an acknowledgment';
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shout WHERE shout_text=?').get(text).n, 0);
  assert.equal(existsSync(outboxFile(box.linkFile)), false);
  await box.stopRelay();
  const running = box.startCli(['shout', 'all', text], { PULLBOARD_RELAY_TOKEN: token });
  const result = await running.closed;
  assert.equal(result.signal, null, 'the actual private CLI terminates normally');
  assert.notEqual(result.code, 0, 'an ephemeral session cannot report an unacknowledged write as success');
  const document = JSON.parse(result.stdout);
  assert.ok(['RELAY_UNAVAILABLE', 'RELAY_RESPONSE'].includes(document.error?.code), 'the public response preserves a typed transport refusal');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shout WHERE shout_text=?').get(text).n, 0, 'the refused requested move never enters the local board');
  assert.equal(existsSync(outboxFile(box.linkFile)), false, 'no ephemeral outbox can be lost when the job exits');
});

test('an environment token cannot use legacy unaccepted-baseline local apply [H21,H16,E18]', async t => {
  const box = await legacyRelayClientFixture(t);
  commitDefaultOutbox(box);
  assert.equal((await box.link()).code, 0);
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.equal(state.baselineAccepted, true);
  const token = state.agentTokens?.coordinator?.token;
  assert.equal(typeof token, 'string');
  const response = await fetch(box.origin + '/api/v1/boards/' + state.board + '/state', {
    headers: { authorization: 'Bearer ' + state.token, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(response.status, 200);
  const original = (await response.json()).state;
  // Synthetic legacy upload intent on a genuinely accepted fixture: only the local saved state is changed.
  const legacy = { ...state, baselineAccepted: false, snapshot: { sequence: 0, sealed: original.sealed } };
  writeFileSync(box.linkFile, JSON.stringify(legacy) + '\n', { mode: 0o600 });
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  t.after(() => db.close());
  const text = 'An ephemeral legacy move still needs acknowledgment';
  const eventsBefore = db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
  await box.stopRelay();
  const result = await box.startCli(['shout', 'all', text], { PULLBOARD_RELAY_TOKEN: token }).closed;
  assert.equal(result.signal, null);
  assert.notEqual(result.code, 0, 'legacy baseline fallback must not acknowledge an ephemeral local write');
  const document = JSON.parse(result.stdout);
  assert.ok(['RELAY_UNAVAILABLE', 'RELAY_RESPONSE'].includes(document.error?.code));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shout WHERE shout_text=?').get(text).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM event').get().n, eventsBefore, 'no native event is applied');
  assert.equal(existsSync(outboxFile(box.linkFile)), false);
  // The same legacy intent remains eligible for the established persistent-session fallback (#341/#919).
  writeFileSync(box.linkFile, JSON.stringify(legacy) + '\n', { mode: 0o600 });
  const persistentText = 'A persistent legacy move is retained on this machine';
  const persistent = await box.startCli(['shout', 'all', persistentText]).closed;
  assert.equal(persistent.signal, null);
  assert.equal(persistent.code, 0, 'ordinary persistent prebaseline fallback is preserved');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shout WHERE shout_text=?').get(persistentText).n, 1);
});
