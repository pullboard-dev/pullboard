/** Real SSH membership handover controls, kept separate from the team lifecycle file [H15,E17]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { ENGINE_VERSION as PEOPLE_VERSION } from '../../../../packages/state/index.js';
import {
  createDeviceKeys,
  unwrapDeviceBoardKey,
} from '../../../../packages/keys/index.js';
import {
  handOverBoardKeys,
  statementBytes,
} from '../../../../packages/link/index.js';
import { signSshVouch } from '../../../../packages/link/index.js';
import { runFixtureChild } from './child.js';

/** Preserve the real device-key and direct GitHub-signature boundary using the team's private Git helpers. */
export async function memberHandoverCase(t, { helpers, withBoard }) {
  const folder = mkdtempSync(join(tmpdir(), 'pullboard-handover-membership-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const box = helpers.project();
  const state = { board: withBoard(box.repo, store.boardId), repository: 'fixture/repository', login: 'alice' };
  const boardKey = randomBytes(32);
  /** Make an actual SSH signature and device key, independent of what the malicious relay asserts. */
  async function request(login) {
    const file = join(folder, login);
    const made = runFixtureChild('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file], { encoding: 'utf8' });
    assert.equal(made.status, 0, 'OpenSSH creates the private fixture signing key');
    const device = await createDeviceKeys();
    const statement = { v: 1, board: state.board, repository: state.repository, login, device: device.deviceId,
      publicKey: device.publicKey, engine: PEOPLE_VERSION, expires: Date.now() + 60_000 };
    const input = file + '.statement';
    writeFileSync(input, statementBytes(statement), { mode: 0o600 });
    const signed = runFixtureChild('ssh-keygen', ['-Y', 'sign', '-q', '-n', 'pullboard-device-key', '-f', file, input], { encoding: 'utf8' });
    assert.equal(signed.status, 0, "the request is genuinely signed by that login's SSH key");
    return { device, signingKey: file, publicKey: readFileSync(file + '.pub', 'utf8').trim().split(' ').slice(0, 2).join(' '),
      entry: { id: login, login, statement, signature: readFileSync(input + '.sig', 'utf8') } };
  }
  const outsider = await request('bob');
  const member = await request('alice');
  const body = { v: 1, board: state.board, repository: state.repository, login: 'alice' };
  const identity = { body, signature: signSshVouch(JSON.stringify(['pullboard-person-identity', body]), 'pullboard-person-identity', member.signingKey) };
  /** Present attacker-controlled relay entries while resolving SSH ownership directly for each account. */
  async function answer(person) {
    const deliveries = [];
    await handOverBoardKeys(state, boardKey, {
      root: box.repo, identity,
      async send(_state, _path, options) {
        if (options.method === 'PUT') { deliveries.push(options.body); return {}; }
        return { requests: [person.entry] };
      },
      async githubKeys(login) { return login === person.entry.login ? [person.publicKey] : []; },
    }, { openBoard, err() {} });
    assert.equal(deliveries.length, 1, 'each request gets one explicit refusal or delivery');
    return deliveries[0];
  }
  const refused = await answer(outsider);
  const leaked = refused.wrapped ? await unwrapDeviceBoardKey(outsider.device.privateKey,
    JSON.parse(Buffer.from(refused.wrapped, 'base64url').toString('utf8')),
    { board: state.board, device: outsider.device.deviceId, engine: PEOPLE_VERSION }) : null;
  assert.equal(leaked !== null && Buffer.from(leaked).equals(boardKey), false, 'the outsider cannot decrypt the actual board key');
  assert.equal(refused.refused?.code, 'RELAY_NOT_MEMBER', 'a valid outsider signature cannot establish trusted board membership');
  assert.equal(Object.hasOwn(refused, 'wrapped'), false, 'the relay receives no key ciphertext it could unwrap as the outsider');
  const allowed = await answer(member);
  assert.ok(allowed.wrapped, 'the linked person can still bootstrap their own independently vouched device');
  const unwrapped = await unwrapDeviceBoardKey(member.device.privateKey,
    JSON.parse(Buffer.from(allowed.wrapped, 'base64url').toString('utf8')),
    { board: state.board, device: member.device.deviceId, engine: PEOPLE_VERSION });
  assert.deepEqual(Buffer.from(unwrapped), boardKey, 'the legitimate new device receives the actual board key');
}
