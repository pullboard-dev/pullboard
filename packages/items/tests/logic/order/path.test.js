/** @pullboard-test-input source-cell packages/items */
/** The critical-path order reads the engine numbers through the state light door and never reaches the state machine module [C7,#6480,#10740]. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { relative } from "node:path";
import { resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const ENTRY = resolve(ROOT, "packages/items/src/logic/order/path.js");
const ITEMS = resolve(ROOT, "packages/items") + "/";
const STATIC_IMPORT = /(?:^|[\n;])\s*(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]/gu;

/** Resolve a relative specifier to a file, trying the path itself then its index.js. */
function resolveSpecifier(from, specifier) {
  const target = resolve(dirname(from), specifier);
  if (existsSync(target) && statSync(target).isFile()) return target;
  const index = resolve(target, "index.js");
  return existsSync(index) ? index : null;
}

/** Static imports reachable from path.js: items files are read, files outside the items cell are recorded as edges and not read. */
function walk() {
  const seen = new Set([ENTRY]);
  const outside = new Set();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.pop();
    for (const match of readFileSync(file, "utf8").matchAll(STATIC_IMPORT)) {
      const next = resolveSpecifier(file, match[1]);
      if (!next || seen.has(next)) continue;
      seen.add(next);
      if (next.startsWith(ITEMS)) queue.push(next);
      else outside.add(relative(ROOT, next));
    }
  }
  return [...outside].sort();
}

test('items.logic-order-path.engine-numbers-from-light-door: clause 2: path.js imports the engine numbers from the state light door and its static imports never reach the state barrel or the state machine [C7,#6480]', () => {
  const source = readFileSync(ENTRY, "utf8");
  assert.match(source, /import \{ CRITICAL_PATH_ENGINE \} from "[./]*state\/light\.js"/u);
  assert.match(source, /import \{ ENGINE_VERSION \} from "[./]*state\/light\.js"/u);
  const outside = walk();
  assert.ok(outside.includes("packages/state/light.js"), "the walker finds the light door, so an empty walk cannot pass");
  const state = outside.filter((file) => file.startsWith("packages/state/"));
  assert.deepEqual(state, ["packages/state/light.js"]);
});
