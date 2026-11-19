/** @pullboard-test-input source-cell packages/health */
/** Health reaches stats through its light door, never the stats barrel [C7,#10182]. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { resolve } from "node:path";
import { test } from "node:test";
import { readWorkFreeReleases as fromBarrel } from "../../../../stats/index.js";
import { readWorkFreeReleases as fromDoor } from "../../../../stats/light.js";

const SRC = join(import.meta.dirname, "..", "..", "..", "src");
const BARREL = resolve(import.meta.dirname, "..", "..", "..", "..", "stats", "index.js");
const SPECIFIER = /^\s*(?:import|export)\s[^"\x27]*?from\s*["\x27]([^"\x27]+)["\x27]|import\(\s*["\x27]([^"\x27]+)["\x27]\s*\)/gmu;

test('health.io-main-door.no-barrel-import: clause 1: no import specifier in packages/health/src/io/main.js resolves to the stats barrel file [C7,#10182]', () => {
  const main = join(SRC, "io", "main.js");
  const resolved = [];
  const source = readFileSync(main, "utf8");
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? match[2];
    if (specifier.startsWith(".")) resolved.push(resolve(dirname(main), specifier));
  }
  assert.ok(resolved.some((path) => path.endsWith(join("stats", "light.js"))), "main.js reads the stats light door");
  assert.deepEqual(resolved.filter((path) => path === BARREL), []);
});

test('health.io-main-door.same-function: clause 1: readWorkFreeReleases from the stats light door is strictly equal to the barrel\x27s [C7,#10182]', () => {
  assert.equal(typeof fromDoor, "function");
  assert.equal(fromDoor, fromBarrel);
});
