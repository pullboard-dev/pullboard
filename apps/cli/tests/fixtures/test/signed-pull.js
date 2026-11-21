/** Execute one pulled test job against a private board stand-in [C7]. */
import { serveRunner } from '../../../../../packages/drive/index.js';
import { testGit } from '../../../../../packages/drive/tests/fixtures/git.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommittedGraph } from '../../../../../packages/gate/tests/fixtures/testkit.js';

/** Return the actual posted completion and independently derived source identity. */
export async function signedPullFixture(signCompletion) {
  const repo = fixtureCommittedGraph('signed-pull-trunk-'), trunk = repo.root;
  const { root: cache } = privateFixtureFiles('signed-pull-cache-');
  const git = (...args) => runFixtureGit(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], { cwd: trunk }).trim();
  repo.put('file.txt', 'one\n');
  repo.commit();
  const source = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  const nonce = 'ab'.repeat(24), job = 'test:signed-fixture';
  let claimed = false, receipt = null;
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    let answer = { recorded: true };
    if (call.action === 'claim') { answer = claimed ? { claim: null } : { trunk, claim: { job, kind: 'test', needs: [], candidate: source, base: source, attempt: 1, token: 'fixture' } }; claimed = true; }
    else if (call.action === 'request') answer = { request: { run: [process.execPath, '-e', 'process.stdout.write("ok")'], input: { data: { completionNonce: nonce } } } };
    else if (call.action === 'receipt') receipt = call.receipt;
    else if (call.action === 'renew') answer = { renewed: true };
    return { status: 200, json: async () => answer };
  };
  await serveRunner({ board: 'http://board.invalid/api/v1/boards/b?k=x', runner: 'fixture', capabilities: [], cache, once: true, fetchImpl, git: testGit, trunkPack: async () => {}, signCompletion });
  return { receipt, job, nonce, source, tree };
}
