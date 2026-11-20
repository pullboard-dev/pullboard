/** @pullboard-test-input apps/view/src/io/serve.js apps/view/src/io/projects-machine-name.js packages/api/src/io/main.js */
/** The project list the view serves carries the machine name; a view on another machine reports that machine [C7,#9452]. */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { serveView } from '../../src/io/serve.js';
import { viewMachineName } from '../../src/io/projects-machine-name.js';
import { apiBoardOpeners } from '../../../cli/tests/fixtures/board.js';
import { cellProject } from '../../../../packages/store/tests/fixtures/cell.js';

/** One GET of the board list with the view key; the body is parsed JSON. */
function boards(port, secret) {
  return new Promise((done, fail) => {
    const outbound = request({ host: '127.0.0.1', port, path: '/api/v1/boards', agent: false, headers: { connection: 'close', 'x-pullboard-key': secret } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => done({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    outbound.once('error', fail);
    outbound.end();
  });
}

/** A view scoped to one real project, reporting the given machine name. */
async function view(t, machineName) {
  const box = cellProject(t, { real: true });
  const secret = ['machine', 'name', 'test', '0123456789'].join('-');
  const none = () => { throw new Error('not used by a board list'); };
  const served = await serveView({ secret, projects: () => [{ root: box.repo, name: 'Machine fixture', project: 'machine', added: '2026-11-17T00:00:00.000Z' }], machineName, runCommand: none, renderPage: () => '', refusalDocument: () => ({}), boardOpeners: apiBoardOpeners });
  t.after(() => served.close());
  return boards(served.port, secret);
}

test('view.projects-machine-name.list-carries-machine: clause 1: the project list the view serves carries the machine name on every board [C7,#9452]', async (t) => {
  const answer = await view(t, () => 'desk-mac');
  assert.equal(answer.status, 200);
  assert.ok(answer.body.boards.length > 0, 'the list holds the project');
  for (const entry of answer.body.boards) assert.equal(entry.machine, 'desk-mac');
});

test('view.projects-machine-name.other-machine-reports-its-name: clause 1: a view started on another machine reports that machine name, and the default is this host name without its domain [C7,#9452]', async (t) => {
  const answer = await view(t, () => 'tower');
  for (const entry of answer.body.boards) assert.equal(entry.machine, 'tower');
  assert.equal(viewMachineName('Tower.local'), 'Tower');
});
