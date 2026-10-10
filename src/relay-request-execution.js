/** Native person requests run the actual CLI outside the relay lock [H12,H16]. */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as store from './board.js';
import { executeMove } from './api.js';
import { loadConfig } from './config.js';
import { git, repoInfo } from './git.js';
import { laneNames } from './lanes.js';
import { refusalDocument } from './json.js';
import { Refused } from './refused.js';
import { relayLinked, relayOperation, relayRequestDevice } from './relay.js';
import { personRequestRecords, requestIntentDigest, requestStageText } from './relay-requests.js';

/** Read durable intake without retaining a SQLite connection while the CLI runs. */
function requests(root) {
  const board = store.openBoard(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite'));
  try { return personRequestRecords(board).filter(record => !record.duplicateOf); }
  finally { store.closeBoard(board); }
}

/** Give each request stage one stable ordinary-move id across command and device retries. */
function stageId(id, phase, executor) {
  return 'person-request-' + createHash('sha256').update(JSON.stringify([id, phase, executor])).digest('hex');
}

/** Publish an ordinary person shout as a durable intake, coordinator request or refusal receipt. */
async function receipt(root, record, executor, phase, io, error) {
  const message = { from: 'person', to: 'coordinator', text: requestStageText(record, phase, error), lanes: laneNames(loadConfig(root)), ...(phase === 'repo-request' ? { request: true } : {}) };
  return relayOperation(root, 'shout', [message], {
    ...io, personRequest: { id: record.id, executor, phase, digest: requestIntentDigest(record), ...(error ? { error } : {}) },
    personRequestMoveId: phase === 'claim' && record.executor && record.executor !== executor ? randomUUID() : stageId(record.id, phase, executor),
  });
}

/** Transport authorization and ordering failures leave intent waiting for a reachable signed-in device. */
function transportRefusal(error) {
  return /^(?:RELAY_|AUTH_|TOKEN_|BOARD_|PAIR_|SEQUENCE_)/u.test(error.code) || ['NO_REPO_ACCESS', 'NO_BOARD'].includes(error.code);
}

/** Fulfil queued browser intent once on its elected native device, preserving actual CLI refusals. */
export async function executePersonRequests(root, io, runCommand) {
  if (io.skipPersonRequests || !relayLinked(root)) return;
  const coordinatorRoot = git(root, ['worktree', 'list', '--porcelain']).split('\n')[0].slice('worktree '.length);
  const pending = requests(coordinatorRoot).filter(record => record.status === 'waiting' && !record.coordinatorRequest);
  if (!pending.length) return;
  const executor = await relayRequestDevice(coordinatorRoot);
  if (!executor) return;
  for (const initial of pending) {
    if (initial.status !== 'waiting') continue;
    try {
      if (initial.executor !== executor) await receipt(coordinatorRoot, initial, executor, 'claim', io);
      const record = requests(coordinatorRoot).find(entry => entry.id === initial.id);
      if (record.executor !== executor || record.status !== 'waiting') continue;
      if (!Object.hasOwn(record, 'result')) {
        const response = await executeMove(coordinatorRoot, record.move, (argv, streams) => runCommand(argv, {
          ...streams, skipPersonRequests: true,
          personRequest: { id: record.id, executor, phase: 'execute', digest: requestIntentDigest(record) },
          personRequestMoveId: stageId(record.id, 'execute', executor),
        }));
        if (response.status !== 200) {
          const error = response.body.error;
          if (transportRefusal(error) || error.code === 'PERSON_REQUEST_TAKEN') continue;
          if (requests(coordinatorRoot).find(entry => entry.id === record.id)?.status === 'waiting') await receipt(coordinatorRoot, record, executor, 'refuse', io, error);
          continue;
        }
      }
      const completed = requests(coordinatorRoot).find(entry => entry.id === record.id);
      if (['spec-approve', 'spec-decline'].includes(record.move.verb) && completed.status === 'waiting' && !completed.coordinatorRequest) {
        await receipt(coordinatorRoot, completed, executor, 'repo-request', io);
      }
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      if (['PERSON_REQUEST_TAKEN', 'PERSON_REQUEST_CLOSED', 'RELAY_PERSON_ONLY'].includes(error.code)) continue;
      if (transportRefusal(error)) { io.err('pullboard: ' + error.message); continue; }
      const record = requests(coordinatorRoot).find(entry => entry.id === initial.id);
      if (record?.executor === executor && record.status === 'waiting') await receipt(coordinatorRoot, record, executor, 'refuse', io, refusalDocument(error).error);
    }
  }
}
