/**
 * What `pullboard resume` tells the coordinator seat about its inbox [I1,A9].
 *
 * The blueprint trial found a coordinating agent that never read its inbox in about 17 turns: its
 * resume buried one unread line near the end, and its next step never named the inbox. So the
 * coordinator's resume opens with how many shouts and decisions wait for it and the newest few,
 * and its next step reads them first. Resume only looks: `pullboard inbox` is what marks shouts
 * read, so a session that starts and stops never swallows a message nobody read.
 */
import * as store from './board.js';
import { differFromHead } from './git.js';
import { SIGNOFFS_FILE } from './spec.js';

/** How many of the newest unread shouts resume names; the rest are a count and a command. */
export const INBOX_NEWEST = 3;

/** The command that reads every waiting shout and marks it read. */
const READ_ALL = 'pullboard inbox';

/**
 * The coordinator's waiting inbox, read without marking anything read: the unread count, the open
 * decisions addressed to it, and the newest unread shouts, oldest of them first. Only shouts to
 * the seat, its lane or all count, never another seat's private shouts (the inbox's own rule).
 *
 * @param {any} board
 * @param {string} agentId
 * @param {{ id: number }[]} openDecisions the open decisions addressed to this seat
 * @returns {{ unread: number, decisions: number, newest: { id: number, from: string, at: string, text: string }[], more: number, read: string }}
 */
export function coordinatorInbox(board, agentId, openDecisions) {
  const unread = store.unreadCount(board, agentId);
  const newest = store.peekShouts(board, agentId, INBOX_NEWEST).map((shout) => ({
    id: shout.shout_id, from: shout.shout_from, at: shout.shout_at, text: shout.shout_text,
  }));
  return { unread, decisions: openDecisions.length, newest, more: Math.max(0, unread - newest.length), read: READ_ALL };
}

/**
 * The text lines for the coordinator's inbox: one count line, then the newest few by name and
 * the command that reads them all. Bounded, so a busy board never floods the session start.
 *
 * @param {ReturnType<typeof coordinatorInbox>} inbox
 * @param {(id: string) => string} name display name for an agent id
 * @param {(at: string) => string} age how long ago a time was
 * @param {(text: string) => string} firstLine
 * @returns {string[]}
 */
export function coordinatorInboxLines(inbox, name, age, firstLine) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const counts = `${plural(inbox.unread, 'unread shout')}, ${plural(inbox.decisions, 'open decision')} for you`;
  if (!inbox.unread && !inbox.decisions) return [`inbox: ${counts}`];
  const lines = [`inbox: ${counts}; read them with ${inbox.read}`];
  for (const shout of [...inbox.newest].reverse()) {
    lines.push(`  newest #${shout.id} from ${name(shout.from)} (${age(shout.at)} ago): ${firstLine(shout.text)}`);
  }
  if (inbox.more) lines.push(`  ${inbox.more} more; read them all with ${inbox.read}`);
  return lines;
}

/**
 * The coordinator's next step with a waiting inbox in front of it, so reading comes first.
 *
 * @param {ReturnType<typeof coordinatorInbox>} inbox
 * @param {string} next the step the board names otherwise
 * @returns {string}
 */
export function inboxFirst(inbox, next) {
  if (!inbox.unread) return next;
  return `read your ${inbox.unread === 1 ? 'unread shout' : `${inbox.unread} unread shouts`} first: ${inbox.read}; then ${next}`;
}

/** The commit message resume hands the coordinator for the row files `spec apply` changed. */
const APPLY_MESSAGE = 'docs(spec): apply row decisions';

/**
 * Quote one word for a POSIX shell only when it needs it, as the CLI's own commands do.
 *
 * @param {string} text
 * @returns {string}
 */
function shellWord(text) {
  return /^[\w@%+=:,./-]+$/u.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * Who commits which of the main checkout's uncommitted Pullboard files [I1,L3].
 *
 * `spec apply` is the coordinator's move, so a row file (the spec or the practice file) that is
 * committed and now changed is the coordinator's to commit. Every other setup file that differs
 * from HEAD, including a row file init wrote and nobody committed yet, is the person's. Only the
 * setup files are ever named, so an unrelated dirty file never reaches either command. The
 * blueprint trial found resume blaming the person for the coordinator's own applied SPEC.md. Any
 * sign-off receipt spec apply appended (.pullboard/signoffs.jsonl) goes in the coordinator's commit
 * too, or a signed apply's receipt would never reach the next worktree or clone.
 *
 * @param {{ path: string, how: string, ignored: boolean }[]} differ setup files that differ from HEAD
 * @param {string[]} rowFiles the files `spec apply` writes
 * @param {string} root the main checkout
 * @returns {{ coordinator: { files: string[], command: string } | null, person: { files: string[], command: string } | null }}
 */
export function commitOwners(differ, rowFiles, root) {
  const rows = differ.filter(({ path, how }) => how === 'changed' && rowFiles.includes(path));
  const setup = differ.filter((entry) => !rows.includes(entry));
  // A signed apply also appends its receipt; it ships with the rows it signs.
  const applied = rows.length ? [...rows, ...differFromHead(root, [SIGNOFFS_FILE])] : rows;
  const cd = `cd ${shellWord(root)} &&`;
  /** One `git add` for these files, forced only when git ignores one of them. */
  const add = (entries) => `${cd} git add${entries.some(({ ignored }) => ignored) ? ' -f' : ''} -- ${entries.map(({ path }) => shellWord(path)).join(' ')}`;
  const words = applied.map(({ path }) => shellWord(path)).join(' ');
  return {
    coordinator: applied.length ? { files: applied.map(({ path }) => path), command: `${add(applied)} && git commit -q -m "${APPLY_MESSAGE}" -- ${words}` } : null,
    person: setup.length ? { files: setup.map(({ path }) => path), command: add(setup) } : null,
  };
}

/**
 * The resume lines naming who commits what: the coordinator's applied row files, then the person's
 * setup files, each only when it has files.
 *
 * @param {ReturnType<typeof commitOwners>} owners
 * @returns {string[]}
 */
export function commitOwnerLines(owners) {
  return [
    ...(owners.coordinator ? [`The coordinator must commit the row file spec apply changed${owners.coordinator.files.includes(SIGNOFFS_FILE) ? ' and its sign-off receipt' : ''}: ${owners.coordinator.command}`] : []),
    ...(owners.person ? [`The person must commit Pullboard's setup files before agents can use worktrees: ${owners.person.command}`] : []),
  ];
}

/**
 * The person's row decisions recorded on the board but not yet applied to the row file. The local
 * view records a decision silently, so resume must name it or the coordinator never applies it.
 *
 * @param {ReturnType<typeof store.rowDecisions>} records
 * @returns {{ id: string, kind: string, decision: string }[]}
 */
export function pendingRowApply(records) {
  return records.filter((record) => !record.applied).map(({ id, kind, decision }) => ({ id, kind, decision }));
}

/** One decision as resume says it: `G9 approved`. */
const decided = (record) => `${record.id} ${record.decision === 'approve' ? 'approved' : 'declined'}`;

/**
 * @param {ReturnType<typeof pendingRowApply>} pending
 * @param {string} root the main checkout
 * @returns {string[]}
 */
export function rowDecisionLines(pending, root) {
  if (!pending.length) return [];
  return [`The coordinator must apply the person's recorded row decision${pending.length === 1 ? '' : 's'}: ${pending.map(decided).join(', ')}, pending apply: cd ${root} && pullboard spec apply`];
}

/**
 * The coordinator's next step with a recorded row decision still unapplied, so it applies first:
 * every other step would plan against rows the person has already decided differently.
 *
 * @param {ReturnType<typeof pendingRowApply>} pending
 * @param {string} root
 * @param {string} next the step the board names otherwise
 * @returns {string}
 */
export function applyFirst(pending, root, next) {
  if (!pending.length) return next;
  return `apply the person's recorded row decisions first: cd ${root} && pullboard spec apply (${pending.map(decided).join(', ')}); then ${next}`;
}

/**
 * The coordinator's next step with an applied row file still uncommitted, so it commits first:
 * a worktree started before that commit would work from the old rows.
 *
 * @param {ReturnType<typeof commitOwners>} owners
 * @param {string} next the step the board names otherwise
 * @returns {string}
 */
export function commitFirst(owners, next) {
  if (!owners.coordinator) return next;
  return `commit the applied row file first: ${owners.coordinator.command}; then ${next}`;
}
