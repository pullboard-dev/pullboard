/** The pullboard blueprint command, in its own module so an item adding another command never edits these lines. */
import {
  fitCommand,
} from '../../../../../packages/blueprints/index.js';
import {
  startersCommand,
} from '../../../../../packages/blueprints/index.js';
import {
  combinedSummary,
  installedBlueprints,
  landEach,
  readBlueprints,
} from '../../../../../packages/blueprints/index.js';
import {
  bundledBlueprints,
  saveBlueprint,
} from '../../../../../packages/blueprints/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  loadSpec,
} from '../../../../../packages/spec/index.js';
import {
  existsSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  resolve,
} from 'node:path';
import {
  actOn,
  addBlueprint,
  context,
  ordered,
  privateNames,
  whoAmI,
  withBoard,
} from '../entry.js';

/** Run `pullboard blueprint` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  const act = (work) => actOn(io, work);
  if (first === 'save') {
    if (rest.length) throw new Refused('USAGE', 'pullboard blueprint save [file] [--name <name>] [--title "<title>"]');
    const ctx = context(io);
    const { root, commonDir } = ctx.info;
    const project = ctx.config.project || ctx.config.name || basename(dirname(resolve(root, commonDir)));
    const file = resolve(io.cwd ?? process.cwd(), second ?? `${project}.blueprint.json`);
    if (existsSync(file)) throw new Refused('BLUEPRINT_EXISTS', `${file} already exists; name another file: pullboard blueprint save <file>`);
    const spec = loadSpec(root, ctx.config);
    const { names, parts } = withBoard(ctx, (board) => privateNames(root, board, spec));
    const { blueprint, left } = saveBlueprint(spec, { name: values.name, title: values.title, gate: ctx.config.gate, names, parts });
    writeFileSync(file, `${JSON.stringify(blueprint, null, 2)}\n`, { flag: 'wx' });
    io.result?.({ file, name: blueprint.name, rules: blueprint.rules?.length ?? 0, questions: blueprint.questions?.length ?? 0, left });
    io.say(`saved ${blueprint.rules?.length ?? 0} rules and ${blueprint.questions?.length ?? 0} answered questions to ${file}`);
    for (const entry of left) io.say(`  left out ${entry.id}: ${entry.reason}`);
    return 0;
  }
  if (first === 'starters') {
    return startersCommand(io, { second, rest, context, withBoard });
  }
  return act(async (ctx, board, me) => {
  if (first === 'fit') return await fitCommand(ctx, board, me, 'propose', [second, ...rest].filter((value) => value !== undefined), values, { ordered, whoAmI });
  const references = [...(second ? [second] : []), ...(values.blueprint ?? [])];
  if (first !== 'add' || !references.length || rest.length) throw new Refused('USAGE', `pullboard blueprint add <name or file> [--blueprint <name or file>]... | save [file]; bundled: ${bundledBlueprints().join(', ')}`);
  // Several blueprints land in the order given, as one result; one lands exactly as before (#720).
  const listed = readBlueprints(references, io.cwd, 'blueprint add', installedBlueprints(ctx.info.root));
  const landed = await landEach(listed, ({ blueprint }, drafted) => addBlueprint(ctx, board, me, blueprint, { result: listed.length === 1, drafted }));
  if (listed.length > 1) io.result?.(combinedSummary(landed));
  return 0;
});
}
