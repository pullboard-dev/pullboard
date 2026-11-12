/** A real board linked to a loopback relay by calling the link door in process: no CLI, no hooks, no child process [C7,H1,H18]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellProject } from '../../../../packages/store/tests/fixtures/cell.js';
import { closeCellBoard } from '../../../../packages/store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../../packages/store/tests/fixtures/cell.js';
import { relayServerFixture } from './relay-server-fixture.js';
import { relayIo } from '../../../../packages/link/index.js';
import { relayOn } from '../../../../packages/link/index.js';
import { nativeBoardPorts } from '../../../lib/index.js';
import { openBoard } from '../../../lib/index.js';
import { ACKNOWLEDGED_OPERATIONS } from '../../../../packages/outbox/index.js';
import { checkpointInBackground } from '../../../../packages/outbox/index.js';
import { checkpointPublisher } from '../../../../packages/outbox/index.js';
import { decideUncertainBaseline } from '../../../../packages/outbox/index.js';
import { flushOutbox } from '../../../../packages/outbox/index.js';
import { outboxFields } from '../../../../packages/outbox/index.js';
import { outboxHasPendingCreatedItem } from '../../../../packages/outbox/index.js';
import { outboxQueueable } from '../../../../packages/outbox/index.js';
import { queueMove } from '../../../../packages/outbox/index.js';
import { relayOrdering } from '../../../../packages/outbox/index.js';
import { remoteBoardMissing } from '../../../../packages/outbox/index.js';
import { replay as replayConflictRecord } from '../../../../packages/outbox/index.js';
import { requestCheckpointCheck } from '../../../../packages/outbox/index.js';
import { scheduleCheckpoint } from '../../../../packages/outbox/index.js';
import { uncertainUploadFailure } from '../../../../packages/outbox/index.js';
import { withOutboxGuard } from '../../../../packages/outbox/index.js';

const CHECKPOINT_WORKER = fileURLToPath(new URL('../../../lib/src/io/worker/checkpoint/relay.js', import.meta.url));
const ENVIRONMENT = ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME', 'PULLBOARD_RELAY_KEY', 'PULLBOARD_RELAY_TOKEN'];

/**
 * Start a loopback relay and a project repository whose origin the relay's GitHub stand-in knows, and return a `link`
 * that signs in and links the board through relayOn. The process environment points at the project's private homes until the test ends.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ pollMs?: number, accountStorageBytes?: number, host?: string }} [options] - Passed to the relay fixture.
 * @returns {Promise<{ root: string, boardFile: string, origin: string, server: object, io: object, link: (name?: string) => Promise<object>, readLink: () => object, readKey: () => string }>}
 */
export async function relayDirectFixture(t, options = {}) {
  const project = cellProject(t);
  const root = project.repo;
  assert.equal(project.tryGit(root, 'remote', 'add', 'origin', 'git@github.com:fixture/repository.git').status, 0, 'the project names the repository the relay knows');
  const saved = Object.fromEntries(ENVIRONMENT.map(name => [name, process.env[name]]));
  for (const name of ENVIRONMENT) delete process.env[name];
  Object.assign(process.env, { PULLBOARD_HOME: project.env.PULLBOARD_HOME, PULLBOARD_MACHINE_HOME: project.env.PULLBOARD_MACHINE_HOME });
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const server = await relayServerFixture(t, { ...options, scratch: project.dir });
  const io = relayIo({
    personChannel: 'view', openBoard, nativeBoardPorts, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure,
    decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck,
    checkpointWorker: CHECKPOINT_WORKER, outboxPolicy: () => ({ acknowledgedOperations: ACKNOWLEDGED_OPERATIONS, outboxQueueable }),
    outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem,
  });
  // The project's board exists before linking, as after any first open.
  closeCellBoard(openCellBoard(project.boardFile));
  const linkFile = join(root, '.git', 'pullboard', 'relay.json');
  const readLink = () => JSON.parse(readFileSync(linkFile, 'utf8'));
  const keyFile = id => join(project.env.PULLBOARD_HOME, 'relay-keys', id + '.key');
  return {
    ...server, root, boardFile: project.boardFile, server, io, linkFile, readLink,
    readKey() { const id = readLink().board; assert.ok(existsSync(keyFile(id)), 'the device key is saved'); return readFileSync(keyFile(id), 'utf8').trim(); },
    /** Sign in through the relay's device flow and link the board, with no CLI. */
    link(name) { return relayOn(root, server.origin, io, { quiet: true, ...(name === undefined ? {} : { name }) }); },
  };
}
