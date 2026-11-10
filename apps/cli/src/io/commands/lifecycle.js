/** The pullboard lifecycle command, in its own module so an item adding another command never edits these lines. */
import {
  lifecycleMarkdown,
} from '../../../../../packages/state/index.js';

/** Run `pullboard lifecycle` and return its exit code. */
export function run(io, { values = {} } = {}) {
  io.result?.({ markdown: lifecycleMarkdown().trimEnd() });
  io.say(lifecycleMarkdown(undefined, { compact: !values.detail }).trimEnd());
  return 0;
}
