import { viewApiPorts } from '../../../../view/index.js';
import { apiBoardOpeners } from '../../../../cli/tests/fixtures/board.js';
import {
  nativeBoardPorts as relayPresentationNativePorts,
  openBoard,
} from '../../../../lib/index.js';
/** Native view state against the sealed relay presentation, field by field [H5,H17]. Run it explicitly: the default gate skips *.study.js. */
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { serveApi } from '../../../../../packages/api/index.js';
import { refusalDocument } from '../../../../cli/index.js';
import { main } from '../../../../cli/tests/fixtures/native.js';
import { relayPresentation } from '../../../../../packages/pages/index.js';
import { presentationState } from '../../../index.js';
import { relayClientFixture } from '../../../../cli/tests/fixtures/relay/client.js';
import { apiFetch } from '../../../../cli/tests/fixtures/api.js';
import {
  paths,
  valueDifferences,
} from '../../../../../packages/pages/tests/fixtures/study.js';

/** Bind the real canonical presentation providers once for this fixture module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;

test('relay study diffs the native view state and the relay reader state [H5,H17]', { timeout: 180_000 }, async t => {
  const box = await relayClientFixture(t);
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const item = store.addItem(board, { by: 'coordinator', lane: box.lane, title: 'Study parity item',
    criterion: 'Every field reaches both readers.', brief: 'A seeded brief.', specIds: [] });
  store.appendFact(board, item, { agentId: 'coordinator', kind: 'measurement', text: 'Measured seed observation.' });
  const decision = store.shout(board, { from: 'coordinator', to: 'person', text: 'Seeded person decision?', lanes: [box.lane], decision: true });
  store.shout(board, { from: 'coordinator', to: 'all', text: 'Seeded answer.', lanes: [box.lane], answers: decision });
  store.shout(board, { from: 'coordinator', to: 'all', text: 'Open coordinator question?', lanes: [box.lane], decision: true });
  const project = { root: box.root, name: 'study', project: '', added: '2026-10-25T00:00:00.000Z' };
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, projects: () => [project], stateDetail: 'full' });
  t.after(() => api.close());
  const address = new URL(api.url);
  const fixture = { origin: address.origin, secret: address.searchParams.get('k') };
  const listing = await (await apiFetch(fixture, '/api/v1/boards')).json();
  const id = listing.boards[0].id;
  const native = (await (await apiFetch(fixture, '/api/v1/boards/' + id + '/state')).json()).state;
  const relay = presentationState(relayPresentation(box.root, {}, RELAY_PRESENTATION_PORTS), id);
  const nativePaths = paths(native), relayPaths = paths(relay);
  const onlyNative = [...nativePaths].filter(path => !relayPaths.has(path)).sort();
  const onlyRelay = [...relayPaths].filter(path => !nativePaths.has(path)).sort();
  t.diagnostic(JSON.stringify({ phase: 'native-versus-relay-reader', node: process.versions.node,
    nativePaths: nativePaths.size, relayPaths: relayPaths.size, onlyNative, onlyRelay,
    differingValues: valueDifferences(native, relay),
    scope: 'One seeded board read twice at once: GET /api/v1/boards/:id/state (stateDetail full, the native view) and relayPresentation through presentationState (what a relay reader renders).' }));
});
