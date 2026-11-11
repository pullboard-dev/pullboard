/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  after,
  assert,
  fetchFresh,
  helpers,
  nameRepo,
  run,
  siblingRepo,
  store,
  test,
  withBoard,
} from '../../tests/fixtures/scenarios/team.js';

test("one decision list across a project's repos [N34]", { timeout: 180_000 }, async t => { // budget: hang ceiling for three real repos' CLI runs and one view process; not a speed target.
  const box = helpers.project();
  const other = siblingRepo(box, 'repo-b').repo;
  const lone = siblingRepo(box, 'repo-c').repo;
  nameRepo(box, box.repo, 'alpha', 'shop');
  nameRepo(box, other, 'beta', 'shop');
  nameRepo(box, lone, 'gamma', 'elsewhere');
  const ask = (root, text) => {
    const asked = box.run(root, 'shout', 'person', text, '--decision');
    assert.equal(asked.code, 0, asked.err);
    return Number(/as #(\d+)/.exec(asked.out)?.[1]);
  };
  const alphaId = ask(box.repo, 'Ship alpha?');
  const betaId = ask(other, 'Ship beta?');
  ask(lone, 'Ship gamma?');
  const listed = () => JSON.parse(box.run(box.repo, 'decisions', '--as', 'person', '--json').out);

  // The person sees both repos of the project, each with its repo, and not another project's.
  const text = box.run(box.repo, 'decisions', '--as', 'person');
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, new RegExp(`alpha#${alphaId} .*Ship alpha\\?`));
  assert.match(text.out, new RegExp(`beta#${betaId} .*Ship beta\\?`));
  assert.doesNotMatch(text.out, /gamma|Ship gamma/);
  const both = listed();
  assert.deepEqual(both.decisions.map(({ repo, shout_id: id }) => `${repo}#${id}`).sort(), [`alpha#${alphaId}`, `beta#${betaId}`].sort());

  // The local API lists the same decisions, each with its board and repo.
  const view = await helpers.startView(box, box.repo);
  t.after(view.stop);
  const headers = { 'x-pullboard-key': view.key };
  const boards = (await (await fetchFresh(`${view.base}/api/v1/boards`, { headers })).json()).boards;
  const alphaBoard = boards.find(entry => entry.root === box.repo);
  const betaBoard = boards.find(entry => entry.root === other);
  const api = await (await fetchFresh(`${view.base}/api/v1/decisions?board=${alphaBoard.id}`, { headers })).json();
  assert.equal(api.project, 'shop');
  assert.deepEqual(api.decisions.map(({ board, repo }) => `${repo}:${board}`).sort(), [`alpha:${alphaBoard.id}`, `beta:${betaBoard.id}`].sort());

  // Answering from the first repo closes the decision on the second repo's own board, and nowhere else.
  const answered = box.run(box.repo, 'answer', `beta#${betaId}`, 'Yes, ship it.', '--as', 'person');
  assert.equal(answered.code, 0, answered.err);
  assert.deepEqual(withBoard(other, board => store.openDecisions(board, store.PERSON)), []);
  assert.equal(withBoard(box.repo, board => store.openDecisions(board, store.PERSON)).length, 1);
  assert.deepEqual(listed().decisions.map(({ repo }) => repo), ['alpha']);
  const unknown = box.run(box.repo, 'answer', 'nowhere#1', 'x', '--as', 'person');
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.err, /PROJECT_REPO_UNKNOWN/);
});

test('two repos of a project that share a name are addressed by folder, never guessed [N34]', { timeout: 120_000 }, () => { // budget: hang ceiling for two real repos' CLI runs; not a speed target.
  const box = helpers.project();
  const other = siblingRepo(box, 'repo-twin').repo;
  nameRepo(box, box.repo, 'twin', 'shop');
  nameRepo(box, other, 'twin', 'shop');
  const ask = (root, text) => Number(/as #(\d+)/.exec(box.run(root, 'shout', 'person', text, '--decision').out)?.[1]);
  ask(box.repo, 'Ship first?');
  const secondId = ask(other, 'Ship second?');
  const listed = JSON.parse(box.run(box.repo, 'decisions', '--as', 'person', '--json').out).decisions.map(({ repo }) => repo).sort();
  assert.deepEqual(listed, ['repo', 'repo-twin']);
  const guessed = box.run(box.repo, 'answer', `twin#${secondId}`, 'yes', '--as', 'person');
  assert.notEqual(guessed.code, 0);
  assert.match(guessed.err, /PROJECT_REPO_AMBIGUOUS/);
  assert.equal(withBoard(other, board => store.openDecisions(board, store.PERSON)).length, 1, 'nothing closed on either board');
  assert.equal(box.run(box.repo, 'answer', `repo-twin#${secondId}`, 'yes', '--as', 'person').code, 0);
  assert.deepEqual(withBoard(other, board => store.openDecisions(board, store.PERSON)), []);
  assert.equal(withBoard(box.repo, board => store.openDecisions(board, store.PERSON)).length, 1, 'the same-numbered question here stays open');
});
