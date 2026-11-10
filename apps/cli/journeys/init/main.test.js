/** What pullboard init tells a person to open once setup is done [I1,N26]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { HOSTED_ORIGIN } from '../../../view/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { takeDefaultViewPort } from '../../tests/fixtures/view/port.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Stop the background view this private home's session record names, if init started one. */
async function stopRecordedView(box, port) {
  let record;
  try { record = JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, `view-${port}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!Number.isInteger(record.pid) || record.pid <= 1 || record.pid === process.pid) return;
  try { process.kill(record.pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

test('init names app.pullboard.dev and never the bare view address [I1,N26]', async (t) => {
  const box = e2e.sandbox();
  const lease = await takeDefaultViewPort(box.dir, { agent: `init-hosted-${process.pid}` });
  t.after(() => stopRecordedView(box, lease.port));
  t.after(() => lease.release());
  box.env.PULLBOARD_VIEW_PORT = String(lease.port);
  delete box.env.PULLBOARD_VIEW_BACKGROUND;
  delete box.env.PULLBOARD_VIEW_FOREGROUND;
  delete box.env.PULLBOARD_VIEW_BACKGROUND_CHILD;
  const repo = join(box.dir, 'fresh');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  box.git(repo, 'config', 'user.name', 'Init Fixture');
  box.git(repo, 'config', 'user.email', 'init@example.com');
  box.git(repo, 'commit', '-q', '--allow-empty', '-m', 'start');

  const init = box.run(repo, 'init', '--yes', '--model', 'x');
  assert.equal(init.code, 0, init.err || init.out);
  const said = init.out + init.err;
  assert.ok(said.includes(HOSTED_ORIGIN), `init tells the person to open ${HOSTED_ORIGIN}:\n${said}`);
  const bare = said.split('\n').filter((line) => /http:\/\/(?:127\.0\.0\.1|localhost):\d+(?![\w/#?])/u.test(line));
  assert.deepEqual(bare, [], 'no line names the view address without its key, which opens only to a refusal');
});
