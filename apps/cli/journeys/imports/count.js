/** Preload for the closure-budget lint: records every repo file a command loads, one file URL per line, to $PULLBOARD_COUNT_FILE [C7]. */
import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, next) {
    if (url.startsWith('file:')) appendFileSync(process.env.PULLBOARD_COUNT_FILE, `${url}\n`);
    return next(url, context);
  },
});
