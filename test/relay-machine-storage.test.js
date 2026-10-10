/** Legacy person credentials are removed rather than loaded by native or agent work [H15,H16,B26]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { relayClientFixture } from './relay-client-fixture.js';

const APPROVAL_MODULE = new URL('../src/relay-approval.js', import.meta.url).href;
const MACHINE_MODULE = new URL('../src/relay-machine.js', import.meta.url).href;

test('legacy machine and board sessions are scrubbed before an agent read or fresh sign-in [H15,H16,B26]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const original = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const phone = await box.phoneSession();
  const machineDirectory = join(box.env.PULLBOARD_HOME, 'relay-machine');
  const machineFile = join(machineDirectory, 'state.json');
  const legacy = { v: 1, autoLink: true, session: { token: phone.token, account: original.account, url: box.origin },
    devices: [], excluded: [join(box.root, 'excluded')], pending: null, revocations: [] };
  mkdirSync(machineDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(machineFile, JSON.stringify(legacy), { mode: 0o600 });
  const machineFragment = join(machineDirectory, 'state.1234.abcd-1234.tmp');
  writeFileSync(machineFragment, JSON.stringify(legacy), { mode: 0o600 });
  const linkFragment = box.linkFile + '.abcd-1234.tmp';
  writeFileSync(linkFragment, JSON.stringify({ ...original, token: phone.token }), { mode: 0o600 });
  writeFileSync(box.linkFile, JSON.stringify({ ...original, token: phone.token, tokenId: phone.id }), { mode: 0o600 });
  const legacyFile = join(box.env.PULLBOARD_HOME, 'relay-keys', original.board + '.session.json');
  const otherLegacyFile = join(box.env.PULLBOARD_HOME, 'relay-keys', 'f'.repeat(32) + '.session.json.1234-abcd.tmp');
  writeFileSync(legacyFile, JSON.stringify({ v: 1, token: phone.token, id: phone.id, url: box.origin }), { mode: 0o600 });
  writeFileSync(otherLegacyFile, phone.token, { mode: 0o600 });
  const keyBefore = readFileSync(box.keyFile);
  const agentRead = await box.script(`
    import { readRelayMachine } from ${JSON.stringify(MACHINE_MODULE)};
    process.env.AI_AGENT = '1'; process.env.CODEX_SHELL = '1'; process.env.SSH_CONNECTION = '127.0.0.1 1 127.0.0.1 2';
    const state = readRelayMachine();
    process.stdout.write(JSON.stringify({ version: state.v, noSession: !Object.hasOwn(state, 'session'),
      owner: state.owner, machine: state.machine, excluded: state.excluded }));
  `);
  assert.equal(agentRead.code, 0);
  assert.equal(agentRead.document.version, 2);
  assert.equal(agentRead.document.noSession, true, 'an agent never receives the retired machine person session');
  assert.deepEqual(agentRead.document.owner, { account: original.account, url: box.origin });
  assert.match(agentRead.document.machine, /^machine-[0-9a-f-]+$/u);
  assert.deepEqual(agentRead.document.excluded, legacy.excluded, 'migration retains the explicit local opt-out');
  assert.equal(readFileSync(machineFile).includes(phone.token), false, 'machine metadata no longer contains a person bearer');
  assert.equal(existsSync(legacyFile), false, 'the rejected per-board session store is deleted without hydration');
  assert.equal(existsSync(otherLegacyFile), false, 'a retired atomic-write session fragment is deleted too');
  assert.equal(existsSync(machineFragment), false, 'a crashed legacy machine write cannot retain person authority');
  assert.deepEqual(readFileSync(box.keyFile), keyBefore, 'scrubbing person sessions preserves the paired board key');
  const status = await box.cli('status');
  assert.equal(status.code, 0, 'the board remains readable while foreground reauthentication is required');
  assert.equal(existsSync(linkFragment), false, 'the link lock removes a crashed legacy person-bearing write');
  const scrubbed = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.equal(scrubbed.token, null);
  assert.equal(scrubbed.tokenId, undefined);
  assert.equal(scrubbed.personReauth, true);
  assert.equal(readFileSync(box.linkFile).includes(phone.token), false, 'the old Git-directory person bearer is atomically removed');
  assert.equal((await box.cli('relay', 'on', '--url', box.origin)).code, 0, 'fresh foreground sign-in restores only machine authority');
  const replacement = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.equal(replacement.machine, agentRead.document.machine, 'the migrated machine identity remains stable');
  assert.equal(/^pm_[A-Za-z0-9_-]{43}$/u.test(replacement.token), true);

  // The rejected session-file design had no token field in relay.json: migrate that format too.
  const noToken = { ...replacement };
  delete noToken.token; delete noToken.tokenId;
  writeFileSync(box.linkFile, JSON.stringify(noToken), { mode: 0o600 });
  writeFileSync(legacyFile, JSON.stringify({ v: 1, token: phone.token, id: phone.id, url: box.origin }), { mode: 0o600 });
  assert.equal((await box.cli('status')).code, 0, 'the session-file-era link migrates without loading its credential');
  assert.equal(existsSync(legacyFile), false);
  assert.equal(JSON.parse(readFileSync(box.linkFile, 'utf8')).personReauth, true);
  assert.equal((await box.cli('relay', 'on', '--url', box.origin)).code, 0);
  const safeMachine = readFileSync(machineFile);
  const refusedDurableGrant = await box.script(`
    import { updateRelayMachine } from ${JSON.stringify(MACHINE_MODULE)};
    const { createApprovalReply } = await import(${JSON.stringify(APPROVAL_MODULE)});
    const reply = await createApprovalReply({ link: true });
    let code;
    try { updateRelayMachine(state => { state.approvals.push({ root: process.cwd(), publisherRoot: process.cwd(), published: false, sealed: 'AQ', replyKey: reply.storedKey,
      context: { id: 'native-action-cannot-persist', account: ${JSON.stringify(original.account)}, publisher: ${JSON.stringify(original.board)}, board: ${JSON.stringify(original.board)},
        device: 'device-' + 'd'.repeat(32), action: 'revoke-token', target: 'some-agent-token', machine: state.machine, command: 'pullboard relay revoke some-agent-token', expires: Date.now() + 600000 } }); }); }
    catch (error) { code = error.code; }
    process.stdout.write(JSON.stringify({ code }));
  `);
  assert.equal(refusedDurableGrant.document.code, 'RELAY_MACHINE_STORAGE', 'durable proposals accept only non-person board-link replies');
  assert.deepEqual(readFileSync(machineFile), safeMachine, 'invalid person-action metadata cannot replace the trusted machine state');
});
