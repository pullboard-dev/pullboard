/** Runs one pull cycle whose fake gate job prints a receipt line with phase rows, and returns the receipt the runner posts [C7,#9778]. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveRunner } from '../../index.js';
import { runTestGit } from './git.js';
import { testGit as pullGit } from './git.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';

/**
 * The job prints one PULLBOARD_GATE_RECEIPT line holding `check` and `proof` rows; each row's profilePath sits in the job's scratch folder (its TMPDIR).
 * Why the path is built in the job: the runner picks the scratch folder, so only the running job can name a path inside it.
 */
const JOB = `const { join } = require('node:path');
const scratch = process.env.TMPDIR;
const phase = (name, log) => ({ name, log, profilePath: join(scratch, log + '.profile.json'), green: true });
process.stdin.resume();
process.stdin.on('end', () => console.log('PULLBOARD_GATE_RECEIPT ' + JSON.stringify({ version: 1, green: true, check: phase('check', 'check.log'), proof: phase('proof', 'proof.log') })));`;

/**
 * Serve one fake pulled job against a one-commit trunk and a board stand-in, and return what the runner posted.
 *
 * @param {string} trunk - An empty folder for the one-commit trunk.
 * @param {string} cache - An empty folder for the runner's cache.
 * @returns {Promise<{ receipt: object, scratch: string | null }>} receipt: the body of the board's `receipt` call.
 */
export async function runPhaseRows(trunk, cache) {
  const sh = async (...args) => (await runTestGit(trunk, ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args])).stdout;
  await sh('init', '-q', '-b', 'main');
  writeFileSync(join(trunk, 'file.txt'), 'one\n');
  await sh('add', '.'); await sh('commit', '-q', '-m', 'one');
  const commit = await sh('rev-parse', 'HEAD');
  let claimed = false, receipt = null;
  const reply = document => ({ status: 200, json: async () => document });
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    if (call.action === 'claim') {
      const claim = claimed ? null : { job: 'gate:phase-rows', attempt: 1, token: 't1', candidate: commit, base: commit, run: [] };
      claimed = true;
      return reply({ trunk, claim });
    }
    if (call.action === 'request') return reply({ request: { run: ['node', '-e', JOB], input: { main: commit, entry: 'x', data: {} }, commits: [] } });
    if (call.action === 'receipt') receipt = call.receipt;
    return reply({ recorded: true, renewed: true });
  };
  await serveRunner({ git: pullGit, board: BOARD, runner: 'r-phase-rows', capabilities: [], cache, once: true, fetchImpl, trunkPack: async () => {}, say: () => {} });
  return { receipt };
}
