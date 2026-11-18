/** The commit-msg hook logic run inside the test process, for fixture commits that need its answer and not a Node start [C7,#9212]. */
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { runCliInProcess } from '../process.js';

/**
 * Write `message` to a message file as git does, run `pullboard hook commit-msg <file>` in the checkout at `cwd`
 * through the production dispatcher, and read the file back, because the hook rewrites it (trailer, header style).
 * Why: the real hook costs a Node start per commit; the dispatcher is the same code without it.
 *
 * @param {{ env: Record<string, string> }} box - A fixture box, whose env is the hook's environment.
 * @param {string} cwd - The checkout being committed in.
 * @param {string} message - The commit message, without the final newline git adds.
 * @returns {Promise<{ status: number, stderr: string, message: string }>} The hook's status, stderr and the message as it left it.
 */
export async function runCommitMsgInProcess(box, cwd, message) {
  const file = join(privateFixtureFiles('pullboard-commit-msg-').root, 'COMMIT_EDITMSG');
  writeFileSync(file, message === '' ? '' : `${message}\n`);
  const { status, stderr } = await runCliInProcess(['hook', 'commit-msg', file], { cwd, env: box.env });
  return { status, stderr, message: readFileSync(file, 'utf8').trimEnd() };
}
