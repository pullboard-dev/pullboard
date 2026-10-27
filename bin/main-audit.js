#!/usr/bin/env node
/** Independent ordinary-admission main audit; no foreground lease or identity is borrowed. */
import { runMainAudits } from '../src/main-audit-worker.js';
import { isAbsolute } from 'node:path';

const [root, token, ...extra] = process.argv.slice(2);
if (extra.length || typeof root !== 'string' || !isAbsolute(root) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(token ?? '')) {
  throw new Error('main-audit requires an explicit root and native UUID token');
}
await runMainAudits(root, token);
