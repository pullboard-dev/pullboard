/** The done alias shares submission and gate-completion wait behavior with submit [V2]. */
import { run as submit } from './submit.js';

/** Run the historical alias through the same public command implementation. */
export async function run(io, args) {
  return submit(io, args);
}
