/** Literal API-to-CLI argument translation shared by native and sealed person requests [A2,H12]. */
import { Refused } from './refused.js';

/** Declarative CLI forms keep API calls on the same argument parser and engine as terminal moves. */
const MOVES = {
  'spec-approve': { prefix: ['spec', 'approve'], positions: ['ids'], flags: ['by', 'text'] },
  'spec-decline': { prefix: ['spec', 'decline'], positions: ['ids'], flags: ['reason'] },
  add: { positions: ['lane', 'title'], flags: ['criterion', 'specs', 'parent', 'after', 'brief', 'route', 'check'] },
  edit: { item: true, flags: ['criterion', 'brief', 'route', 'check'] },
  fact: { item: true, positions: ['kind', 'text'], flags: ['supersedes', 'ref'] },
  claim: { item: true },
  release: { item: true },
  submit: { item: true },
  done: { item: true },
  verify: { item: true, positions: ['decision'], flags: ['reason', 'note', 'as'] },
  merged: { item: true, positions: ['commit'] },
  withdraw: { item: true, positions: ['reason'] },
  refreeze: { item: true },
  escalate: { item: true, flags: ['note'] },
  hold: { positions: ['lane'], flags: ['reason'], booleans: ['off'] },
  shout: { positions: ['to', 'text'], optional: ['to'], booleans: ['decision'], flags: ['evidence', 'outcome', 'item', 'commit'] },
  answer: { item: true, positions: ['text'], flags: ['as'] },
  pass: { item: true, positions: ['note'] },
  next: { flags: ['as'], booleans: ['verify', 'build'] },
};

/** Reject unsupported fields, then pass values as distinct argv entries, never a shell command. */
export function moveArgs({ verb, item, args = {} }) {
  if (verb === 'accept' || verb === 'reject') return moveArgs({ verb: 'verify', item, args: { ...args, decision: verb } });
  const form = Object.hasOwn(MOVES, verb) ? MOVES[verb] : null;
  if (!form) throw new Refused('BAD_REQUEST', `no API move ${String(verb)}; use a board move such as add, claim, submit, verify, shout or answer`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Refused('BAD_REQUEST', 'args needs a JSON object containing this move\'s arguments');
  const allowed = [...(form.positions ?? []), ...(form.flags ?? []), ...(form.booleans ?? [])];
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Refused('BAD_REQUEST', `${verb} does not take args.${key}; use only this CLI move's arguments`);
  const argv = form.prefix ? [...form.prefix] : [verb];
  if (form.item) {
    if (!Number.isSafeInteger(item) || item < 1) throw new Refused('BAD_REQUEST', `${verb} needs a positive integer item; use the item id from the board state`);
    argv.push(String(item));
  } else if (item !== undefined && item !== null) throw new Refused('BAD_REQUEST', `${verb} does not take item; put its arguments in args`);
  const positional = [];
  for (const key of form.positions ?? []) {
    if (args[key] === undefined && form.optional?.includes(key)) continue;
    if (typeof args[key] !== 'string' || !args[key].trim()) throw new Refused('BAD_REQUEST', `${verb} needs args.${key} as nonempty text; supply the CLI move's argument`);
    positional.push(args[key]);
  }
  for (const key of form.flags ?? []) if (args[key] !== undefined) {
    if (typeof args[key] !== 'string') throw new Refused('BAD_REQUEST', `args.${key} needs text; supply the CLI flag's value`);
    argv.push(`--${key}=${args[key]}`);
  }
  for (const key of form.booleans ?? []) if (args[key] !== undefined) {
    if (typeof args[key] !== 'boolean') throw new Refused('BAD_REQUEST', `args.${key} needs true or false`);
    if (args[key]) argv.push(`--${key}`);
  }
  // Positionals follow -- so titles and notes beginning with a dash never become CLI flags.
  argv.push('--json', '--', ...positional);
  return argv;
}

