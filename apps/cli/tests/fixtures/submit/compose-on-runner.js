/** The submit scenario of the compose-on-runner tests: a real claimed item, a moved main and one submit, with submit.composeOnRunner set as asked [C7,#10756]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { runFixtureGit } from '../../../../../packages/gate/tests/fixtures/child.js';
import { pullProject } from '../pull.js';
import { pullQueue } from '../pull.js';

/** Claim item 1, commit one file in its folder, move main on, and submit with submit.composeOnRunner set as `on` says; `jobsOf` is the board read the calling test imports; with `declared`, accepted main also declares gen/out.txt as made from gen/in.txt with submit.regenerateDeclared on, and the item edits only gen/in.txt. */
export async function runSubmit(t, { on, declared = false }, { jobsOf }) {
  const box = await pullProject(t, 1);
  if (declared) {
    const configFile = join(box.repo, 'pullboard.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    config.lanes.web.owns.push('gen/');
    config.submit = { ...(config.submit ?? {}), regenerateDeclared: true };
    config.generated = [{ file: 'gen/out.txt', generator: 'cp gen/in.txt gen/out.txt', inputs: ['gen/in.txt'] }];
    assert.equal((await box.helpers.commitFile(box, box.repo, 'gen/in.txt', 'one\n', 'chore: declare a generated file [G1]')).status, 0);
    assert.equal((await box.helpers.commitFile(box, box.repo, 'gen/out.txt', 'one\n', 'chore: its generated output [G1]')).status, 0);
    assert.equal((await box.helpers.commitFile(box, box.repo, 'pullboard.json', JSON.stringify(config), 'chore: accept the generated policy [G1]')).status, 0);
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  }
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { localRunner: false, runnerDispatch: 'pull' }, submit: { composeOnRunner: on } });
  const [id] = box.ids;
  const claimed = await box.runLocal(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err);
  const folder = JSON.parse(claimed.out).itemFolder ?? box.web;
  if (declared) assert.equal((await box.helpers.commitFile(box, folder, 'gen/in.txt', 'two\n', `feat(web): change the generator input ${id} [G1]`)).status, 0);
  assert.equal((await box.helpers.commitFile(box, folder, `web/${id}.txt`, `compose ${id}\n`, `feat(web): runner composed submit ${id} [G1]`)).status, 0);
  assert.equal((await box.helpers.commitFile(box, box.repo, 'web/newer-main.txt', 'newer\n', 'feat(web): main moved on [G1]')).status, 0);
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env: box.env }).trim();
  const head = git(folder, 'rev-parse', 'HEAD');
  const main = git(box.repo, 'rev-parse', 'refs/heads/main');
  const result = await box.runLocal(folder, 'submit', String(id));
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  const { board } = await pullQueue(t, box);
  const [row] = jobsOf(board.db, { kind: 'gate', item: id });
  return { folder, git, head, main, id, result, row };
}
