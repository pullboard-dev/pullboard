/** installKind tells a global, npx, project or unknown install from the script path and env [C7,#1303]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installKind } from '../../src/logic/install-kind.js';

const env = { PWD: '/work/app', npm_config_prefix: '/usr/local' };

test('cli.logic-install-kind.returns-global-npx-project-or-unknown: clause 1: installKind({ scriptPath, env }) returns global for a path under a global npm prefix node_modules, npx for a path under an _npx cache folder, project for a path under the cwd node_modules, and unknown otherwise [C7,#1303]', () => {
  assert.equal(installKind({ scriptPath: '/usr/local/lib/node_modules/pullboard/apps/cli/pullboard.js', env }), 'global');
  assert.equal(installKind({ scriptPath: '/usr/local/node_modules/pullboard/apps/cli/pullboard.js', env }), 'global');
  assert.equal(installKind({ scriptPath: '/home/u/.npm/_npx/ab12/node_modules/pullboard/apps/cli/pullboard.js', env }), 'npx');
  assert.equal(installKind({ scriptPath: '/work/app/node_modules/pullboard/apps/cli/pullboard.js', env }), 'project');
  assert.equal(installKind({ scriptPath: '/src/pullboard/apps/cli/pullboard.js', env }), 'unknown');
  assert.equal(installKind({ scriptPath: '/elsewhere/node_modules/pullboard/apps/cli/pullboard.js', env }), 'unknown');
  assert.equal(installKind({ scriptPath: '/usr/local/lib/node_modules_extra/x.js', env }), 'unknown');
  assert.equal(installKind({ scriptPath: '/x/pullboard.js', env: {} }), 'unknown');
  assert.equal(installKind({ scriptPath: 'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\1\\node_modules\\pullboard\\pullboard.js', env }), 'npx');
});
