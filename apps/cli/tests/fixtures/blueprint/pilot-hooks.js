/** Module hooks that seed one fault into one production file, for the in-process journey pilot (#8058) [C7]. */
import { appendFileSync } from 'node:fs';

/** The fault to seed, from the environment, so child processes and worker threads inherit it. */
const fault = process.env.PULLBOARD_PILOT_FAULT ? JSON.parse(process.env.PULLBOARD_PILOT_FAULT) : null;

/** Record a line for the study to read: 'applied' when the text was changed, 'miss' when the file loaded without the text. */
function note(kind) { if (process.env.PULLBOARD_PILOT_LOG) appendFileSync(process.env.PULLBOARD_PILOT_LOG, `${kind}\n`); }

/** Replace the fault's text in the fault's file as it loads; every other module loads untouched. */
export async function load(url, context, next) {
  const result = await next(url, context);
  if (!fault || !url.endsWith(fault.file) || result.source === null || result.source === undefined) return result;
  const source = String(result.source);
  if (!source.includes(fault.find)) { note('miss'); return result; }
  note('applied');
  return { ...result, source: source.replace(fault.find, fault.replace) };
}
