/** Shared real private Git/SSH/SQLite and loopback E32 fixture, with no production credentials [E32,B24]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { addSigner } from '../../../../../packages/spec/index.js';
import {
  runFixtureChild,
  runFixtureGit,
  fixtureChildMessage,
} from '../child.js';
import { boardStorageBytes } from '../../../../relay/index.js';
import { createGitHubClient } from '../../../../relay/index.js';
import { createRelayAuth } from '../../../../relay/index.js';
import { serveRelay } from '../../../../relay/index.js';

/** Create an isolated native board with its established SSH signer authority. */
export function signedBoard(t, name, clock) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-board-link-'));
  let board = null;
  t.after(() => { if (board) store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  const root = join(directory, 'repo');
  const key = join(directory, 'signer');
  mkdirSync(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Link fixture', GIT_AUTHOR_EMAIL: 'link@example.invalid',
    GIT_COMMITTER_NAME: 'Link fixture', GIT_COMMITTER_EMAIL: 'link@example.invalid' };
  const generated = runFixtureChild('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { env, encoding: 'utf8' });
  assert.equal(generated.status, 0, fixtureChildMessage(generated));
  const git = (...args) => runFixtureGit(args, { cwd: root, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'Private board-link fixture.\n');
  git('add', '.');
  git('commit', '-q', '-m', 'fixture: establish board signer root');
  addSigner(root, { by: name, key: key + '.pub' });
  board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), clock);
  return { root, key, git, by: name, board, reference: { boardId: store.boardId(board), organization: 'fixture', handle: name } };
}

/** Obtain genuine independent approval of the exact same link document from both boards. */
export async function consent(api, authority, parent, child, linkId, disclosure = 'states', generation = 1) {
  let record = { version: 1, linkId, parent: parent.reference, child: child.reference,
    generation, disclosure, approvals: [], revocation: null };
  record = await api.approveBoardLink(record, parent.reference.boardId, authority, { by: parent.by, key: parent.key });
  return api.approveBoardLink(record, child.reference.boardId, authority, { by: child.by, key: child.key });
}

/** Start the existing authenticated relay with real stand-in OAuth and private native snapshots. */
export async function linkRelay(t, boards, authority) {
  const { githubFixture } = await import('../relay.js');
  const { request } = await import('../../../../../packages/link/index.js');
  const { generateBoardKey, seal } = await import('../../../../../packages/kernel/src/logic/seal.js');
  const { exportBoard } = await import('../../../../../packages/store/index.js');
  const { ENGINE_VERSION } = await import('../../../../../packages/state/index.js');
  const provider = await githubFixture(t);
  // Each private board belongs to its own repository, as the native one-team-board contract requires.
  provider.state.repositories = boards.map(box => box.reference.handle);
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-link-relay-'));
  let time = Date.now();
  const auth = createRelayAuth({ database: join(directory, 'auth.sqlite'),
    github: createGitHubClient(provider.config), now: () => time });
  let service = null;
  t.after(async () => {
    try { if (service) await service.close(); }
    finally { auth.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  const grant = await auth.beginDevice();
  provider.state.deviceAuthorized = true;
  time += grant.interval * 1000;
  const person = await auth.pollDevice(grant.ticket);
  for (const box of boards) await auth.linkBoard(person.token, box.reference.boardId, `fixture/${box.reference.handle}`);
  service = await serveRelay({ directory: join(directory, 'relay'), auth, maintenanceMs: 0,
    now: () => time, boardLinkAuthority: authority });
  let origin = 'http://127.0.0.1:' + service.port;
  const states = new Map();
  for (const box of boards) {
    const board = box.reference.boardId;
    const key = await generateBoardKey();
    const snapshot = await seal(key, Buffer.from(JSON.stringify(exportBoard(box.board))), { boardId: board, kind: 'snapshot', sequence: 0 });
    const uploaded = await fetch(origin + '/api/v1/boards/' + board + '/state', { method: 'PUT',
      headers: { authorization: 'Bearer ' + person.token, 'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json' },
      body: JSON.stringify({ sequence: 0, sealed: Buffer.from(snapshot).toString('base64url') }) });
    assert.equal(uploaded.status, 200, JSON.stringify(await uploaded.json()));
    const issued = await auth.issueToken(person.token, { board, agent: 'link-agent' });
    states.set(board, { url: origin, token: issued.token, board, agent: 'link-agent' });
  }
  return { states, request,
    async restart(options = {}) {
      await service.close();
      service = await serveRelay({ directory: join(directory, 'relay'), auth, maintenanceMs: 0,
        now: () => time, boardLinkAuthority: authority, accountStorageBytes: options.accountStorageBytes });
      origin = 'http://127.0.0.1:' + service.port;
      for (const state of states.values()) state.url = origin;
    },
    async storedBytes() {
      return boards.reduce((total, box) => total + boardStorageBytes(join(directory, 'relay'), box.reference.boardId), 0);
    },
  };
}

