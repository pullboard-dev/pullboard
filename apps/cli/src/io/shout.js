/** Helpers for `pullboard shout` and `pullboard inbox`: evidence and one-line text. Split from src/cli.js, which re-exports it [C7]. */
import { tryGit } from '../../../../packages/git/index.js';
import { Refused } from '../../../../packages/kernel/index.js';

/**
 * The evidence a shout carries, from its flags (B22). The commit is resolved here, in this repo,
 * so the board only ever stores a full SHA that names a real commit.
 *
 * @param {any} ctx
 * @param {any} values
 * @returns {{ kind: string, outcome: string, item: number, commit: string }}
 */
export function evidenceFrom(ctx, values) {
  const rev = values.commit ?? '';
  const resolved = rev ? tryGit(ctx.info.root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]) : { status: 1, stdout: '' };
  if (resolved.status !== 0) throw new Refused('BAD_EVIDENCE', `evidence names a commit in this repo: --commit <rev> (saw "${rev}")`);
  const item = /^\d+$/.test(values.item ?? '') ? Number(values.item) : NaN;
  return { kind: values.evidence, outcome: values.outcome ?? '', item, commit: resolved.stdout };
}

/**
 * A shout's evidence as one line: its kind, outcome, item and commit (B22).
 *
 * @param {any} shout
 * @returns {string}
 */
export const evidenceLine = (shout) => `${shout.shout_evidence_kind}: ${shout.shout_evidence_outcome}, #${shout.shout_evidence_item} at ${shout.shout_evidence_commit.slice(0, 12)}`;

/**
 * A shout's text cut to one short line.
 *
 * @param {string} text
 * @returns {string}
 */
export const firstLine = (text) => {
  const line = String(text).split('\n')[0];
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
};

