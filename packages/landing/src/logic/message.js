/** Landing messages from board state through the shared commit-message builder (RFC 0005) [B3,R3,C7]. */
import {
  buildCommitMessage,
  commitMessageProblems,
  parseCommitMessage,
} from '../../../commits/index.js';
import { landingRows } from '../../../commits/index.js';
import { tryGit } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import { loadSpec } from '../../../spec/index.js';

/** The merge header type an item with no typed commit takes from its lane; any other lane lands as chore. */
const LANE_MERGE_TYPES = Object.freeze({ docs: 'docs', test: 'test' });

/** Which commit type names an item when its commits mix types: the first in this list wins. */
const TYPE_RANK = Object.freeze(['feat', 'fix', 'perf', 'refactor', 'revert', 'docs', 'test', 'build', 'ci', 'style', 'chore']);

/**
 * The item's type, read from the typed headers of its own commits (those in `commit` and not in
 * `base`): feat over fix over the rest (RFC 0005 takes the type from the item, and an item has no
 * type field). Null when none of its commits is typed, so the lane rule applies.
 *
 * @param {string} root
 * @param {string | null | undefined} base
 * @param {string | null | undefined} commit
 * @returns {string | null}
 */
export function itemCommitType(root, base, commit) {
  if (!root || !commit) return null;
  const listed = tryGit(root, ['log', '--no-merges', '--format=%s', base ? `${base}..${commit}` : commit]);
  if (listed.status !== 0) return null;
  const types = new Set(listed.stdout.split('\n').map((subject) => parseCommitMessage(subject).type).filter(Boolean));
  return TYPE_RANK.find((type) => types.has(type)) ?? null;
}

/**
 * The whole landing message from board state through the shared builder [B3,R3]: header
 * `<type>(merge): <title> [<rows that fit>,+N]`, then `Pullboard-Item` and `Pullboard-Rows` as the
 * last paragraph. It never refuses for how many rows an item cites. The type is the item's own
 * (from its commits), with or without rows; only an item with no typed commit takes the lane rule.
 *
 * @param {any} item
 * @param {{ spec?: { rows: { id: string }[] } | null, type?: string | null }} [options]
 * @returns {{ header: string, body: string, trailers: string, message: string, rows: string[], type: string }}
 */
export function landingMessage(item, { spec = null, type = null } = {}) {
  const rows = landingRows(item, spec);
  const chosen = type ?? (rows.length ? 'chore' : (LANE_MERGE_TYPES[item.item_lane] ?? 'chore'));
  return { ...buildCommitMessage({ type: chosen, scope: 'merge', title: item.item_title, item: item.item_id, rows, preferRows: true }), rows, type: chosen };
}

/** Produce a hook-valid lower-case merge header at a word boundary [R3]. */
export function landingSubject(item, options = {}) {
  return landingMessage(item, options).header;
}

/**
 * Check every item's landing message before the first merge of a batch [B3,R3]. The builder
 * writes them, so a problem here is a Pullboard defect, never something an item's citations fix.
 *
 * @param {any[]} items
 * @param {{ spec: { rows: { id: string }[] } | null, typeOf?: (item: any) => string | null }} context
 * @returns {Map<number, ReturnType<typeof landingMessage>>}
 */
export function checkLandingMessages(items, { spec, typeOf = () => null }) {
  const messages = new Map();
  for (const item of items) {
    const built = landingMessage(item, { spec, type: typeOf(item) });
    const problems = commitMessageProblems(built.message, { item: item.item_id, rows: built.rows });
    if (problems.length) {
      throw new Refused('LAND_HEADER', `the landing message for #${item.item_id} fails its own check (${problems.join('; ')}); nothing merged; shout the coordinator: pullboard shout coordinator --kind exception "#${item.item_id} landing message fails its check"`);
    }
    messages.set(item.item_id, built);
  }
  return messages;
}

/** The trunk spec a landing orders rows by, or none when the repo has no spec file. */
function landingSpec(root, config) {
  return config?.spec ? loadSpec(root, config) : null;
}

/**
 * Everything a landing message needs from the trunk at `base`: its spec and each item's own type.
 *
 * @param {string} root
 * @param {string} base
 * @param {any} config
 * @param {(item: any) => string} commitOf - The item's checked landing commit.
 * @returns {{ spec: any, typeOf: (item: any) => string | null }}
 */
export function landingContext(root, base, config, commitOf) {
  return { spec: landingSpec(root, config), typeOf: (item) => itemCommitType(root, base, commitOf(item)) };
}

/**
 * The exact hand merge that lands an item in a repo with no remote: the same generated header and
 * one trailer paragraph `pullboard land` writes, then the merged receipt [B3,R3].
 *
 * @param {any} item
 * @param {string} commit - The checked composition to merge.
 * @param {{ root: string, base?: string | null, spec?: any, quote: (word: string) => string }} context
 * @returns {string}
 */
export function handMergeCommand(item, commit, { root, base = null, spec = null, quote }) {
  const message = landingMessage(item, { spec, type: itemCommitType(root, base, commit) });
  const trailers = `"$(printf '%s\\n' ${message.trailers.split('\n').map(quote).join(' ')})"`;
  return `git merge --no-ff ${commit} -m ${quote(message.header)} -m ${trailers} && pullboard merged ${item.item_id} HEAD`;
}
