/**
 * Fix the mechanical header rules in place: a capitalised subject and a trailing period.
 * Why: each of these cost a full hook run per retry, and the fix is never a judgement call [C7].
 * A header over the length limit is never cut here: dropping words changes what the person wrote, so the commit rules refuse it with its length and the limit [C7,#12030].
 */

const EXEMPT = /^(Merge |Revert "|fixup! |squash! |amend! )/u;

/** Lowercase the subject's first word: a whole acronym ("CLI") or just its first letter ("Explain"). */
function lowercased(subject) {
  const word = /^[A-Z][A-Z0-9]+\b/u.exec(subject);
  return word ? word[0].toLowerCase() + subject.slice(word[0].length) : subject[0].toLowerCase() + subject.slice(1);
}

/**
 * The message with its header's mechanical style fixed, and one note per fix for the person committing. A header that
 * is not `type(scope): subject [ids]`, or whose type, scope and ids alone leave no room for a subject, is returned
 * unchanged for the commit rules to refuse.
 *
 * @param {string} raw - The message as git hands it, comments included.
 * @param {{ maxHeader: number, types: string[] }} rules
 * @returns {{ message: string, notes: string[] }}
 */
export function fixCommitHeader(raw, rules) {
  const lines = raw.split('\n');
  const at = lines.findIndex(line => !line.startsWith('#'));
  const header = at < 0 ? '' : lines[at];
  const match = new RegExp(`^((?:${rules.types.join('|')})(?:\\([a-z0-9._/-]+\\))?!?: )(.+?)(\\s*\\[[^\\]]*\\])?\\s*$`, 'u').exec(header);
  if (!match || EXEMPT.test(header)) return { message: raw, notes: [] };
  const [, prefix, original, ids = ''] = match;
  const notes = [];
  let subject = original;
  if (/^[A-Z]/u.test(subject)) {
    subject = lowercased(subject);
    notes.push(`lowercased the subject's first word ("${original.split(' ')[0]}" to "${subject.split(' ')[0]}")`);
  }
  if (/\.$/u.test(subject)) {
    subject = subject.replace(/\.+$/u, '');
    notes.push('removed the period at the end of the subject');
  }
  if (!notes.length) return { message: raw, notes };
  const fixed = `${prefix}${subject}${ids}`;
  return { message: [...lines.slice(0, at), fixed, ...lines.slice(at + 1)].join('\n'), notes: [...notes, `header is now: ${fixed}`] };
}
