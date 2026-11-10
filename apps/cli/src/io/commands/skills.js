/** The pullboard skills command, in its own module so an item adding another command never edits these lines. */
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  updateSkills,
} from '../skills.js';
import {
  context,
} from '../entry.js';

/** Run `pullboard skills` and return its exit code. */
export function run(io, { first, second, rest, values }) {
  if (first || second || rest.length || !values.update) throw new Refused('USAGE', 'pullboard skills --update');
  const ctx = context(io);
  const result = updateSkills(ctx.info.root);
  io.result?.(result);
  if (result.updated.length) io.say(`updated Claude Code skills: ${result.updated.map((file) => file.split('/')[2]).join(', ')}`);
  else io.say('Claude Code skills are current or customized; no files were replaced');
  for (const item of result.customized) {
    const change = item.missing.length ? `; missing changes: ${item.missing.join('; ')}` : '';
    io.say(`kept customized skill ${item.path}${change}`);
  }
  return 0;
}
