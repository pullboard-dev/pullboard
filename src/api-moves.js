/** Literal API-to-CLI argument translation shared by native and sealed person requests [A2,H12]. */
import { Refused } from './refused.js';

/** Declarative CLI forms keep API calls on the same argument parser and engine as terminal moves. */
const MOVES = {
  'spec-approve': { prefix: ['spec', 'approve'], positions: ['ids'], flags: ['by', 'text'] },
  'spec-decline': { prefix: ['spec', 'decline'], positions: ['ids'], flags: ['reason'] },
  'sentinel-approve': { prefix: ['sentinel', 'approve'], positions: ['name'], flags: ['digest'] },
  'sentinel-decline': { prefix: ['sentinel', 'decline'], positions: ['name'], flags: ['digest', 'reason'] },
  'spec-answer': { prefix: ['spec', 'answer'], positions: ['row', 'answer'] },
  'check-accept': { prefix: ['check', 'accept'], item: true },
  'land-waive': { prefix: ['land'], flags: ['waive', 'until', 'reason'] },
  'bar-sign': { prefix: ['bar', 'sign'], item: true, flags: ['note'] },
  signing: { prefix: ['settings', 'person.signed'], positions: ['signed'] },
  add: { positions: ['lane', 'title'], flags: ['criterion', 'specs', 'parent', 'after', 'brief', 'route', 'check', 'as'], booleans: ['wait'] },
  edit: { item: true, flags: ['criterion', 'brief', 'route', 'check', 'reason', 'after', 'as'], booleans: ['wait'] },
  fact: { item: true, positions: ['kind', 'text'], flags: ['answers', 'supersedes', 'ref', 'implies', 'as', 'cause'], booleans: ['never-again'] },
  claim: { item: true },
  release: { item: true, flags: ['note'] },
  submit: { item: true },
  done: { item: true },
  verify: { item: true, positions: ['decision'], flags: ['reason', 'note', 'cause', 'clause', 'as', 'implies'] },
  merged: { item: true, positions: ['commit'] },
  withdraw: { item: true, positions: ['reason'] },
  refreeze: { item: true },
  reopen: { item: true, flags: ['note', 'cause'], lists: ['conflict'], booleans: ['withdraw-verdict'] },
  escalate: { item: true, flags: ['note'] },
  hold: { positions: ['lane'], flags: ['reason', 'as'], booleans: ['off'] },
  shout: { positions: ['to', 'text'], optional: ['to'], booleans: ['decision', 'news'], flags: ['kind', 'evidence', 'outcome', 'item', 'commit', 'options'] },
  answer: { item: true, positions: ['text'], flags: ['as', 'implies', 'supersedes', 'origin', 'rationale'] },
  pass: { item: true, positions: ['note'] },
  next: { flags: ['as'], booleans: ['verify', 'build'] },
};

/** Reject unsupported fields, then pass values as distinct argv entries, never a shell command. */
export function moveArgs({ verb, item, args = {} }) {
  if (verb === 'accept' || verb === 'reject') return moveArgs({ verb: 'verify', item, args: { ...args, decision: verb } });
  const form = Object.hasOwn(MOVES, verb) ? MOVES[verb] : null;
  if (!form) throw new Refused('BAD_REQUEST', `no API move ${String(verb)}; use a board move such as add, claim, submit, verify, shout or answer`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Refused('BAD_REQUEST', 'args needs a JSON object containing this move\'s arguments');
  if (['sentinel-approve', 'sentinel-decline'].includes(verb)) {
    if (typeof args.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(args.digest)) {
      throw new Refused('BAD_REQUEST', 'a sentinel decision needs the exact proposal digest; refresh the pending watch before deciding');
    }
    if (verb === 'sentinel-decline' && (typeof args.reason !== 'string' || !args.reason.trim())) {
      throw new Refused('BAD_REQUEST', 'declining a sentinel needs a reason; say why this proposal should not run');
    }
  }
  const allowed = [...(form.positions ?? []), ...(form.flags ?? []), ...(form.lists ?? []), ...(form.booleans ?? [])];
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Refused('BAD_REQUEST', `${verb} does not take args.${key}; use only this CLI move's arguments`);
  const argv = form.prefix ? [...form.prefix] : [verb];
  if (form.item) {
    if (!Number.isSafeInteger(item) || item < 1) throw new Refused('BAD_REQUEST', `${verb} needs a positive integer item; use the item id from the board state`);
    argv.push(String(item));
  } else if (item !== undefined && item !== null) throw new Refused('BAD_REQUEST', `${verb} does not take item; put its arguments in args`);
  const positional = [];
  for (const key of form.positions ?? []) {
    if (args[key] === undefined && form.optional?.includes(key)) continue;
    const cliRefusesBlank = verb === 'shout' && key === 'text';
    if (typeof args[key] !== 'string' || (!args[key].trim() && !cliRefusesBlank)) throw new Refused('BAD_REQUEST', `${verb} needs args.${key} as nonempty text; supply the CLI move's argument`);
    positional.push(args[key]);
  }
  for (const key of form.flags ?? []) if (args[key] !== undefined) {
    if (typeof args[key] !== 'string') throw new Refused('BAD_REQUEST', `args.${key} needs text; supply the CLI flag's value`);
    argv.push(`--${key}=${args[key]}`);
  }
  // A list flag repeats once per value, so each value reaches the CLI exactly, never split or joined.
  for (const key of form.lists ?? []) if (args[key] !== undefined) {
    const values = [args[key]].flat();
    if (!values.length || values.some((value) => typeof value !== 'string')) throw new Refused('BAD_REQUEST', `args.${key} needs text or an array of text; supply one value per CLI flag`);
    for (const value of values) argv.push(`--${key}=${value}`);
  }
  for (const key of form.booleans ?? []) if (args[key] !== undefined) {
    if (typeof args[key] !== 'boolean') throw new Refused('BAD_REQUEST', `args.${key} needs true or false`);
    if (args[key]) argv.push(`--${key}`);
  }
  // Positionals follow -- so titles and notes beginning with a dash never become CLI flags.
  argv.push('--json', '--', ...positional);
  return argv;
}
