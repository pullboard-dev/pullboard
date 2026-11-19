/** Tier ownership comes from package and app folders alone, never from a cells plan [C7,#2467]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cellOwners } from "../../../src/io/test/tiers.js";
import { ownerOf } from "../../../src/io/test/tiers.js";

test('gate.io-test-tiers.owners-from-folders: clause 1: every file under a package or app folder is owned by that folder root on a file map with no plan entries [C7,#2467]', () => {
  const files = new Map([
    ["package.json", Buffer.from("{}")],
    ["packages/alpha/index.js", Buffer.from("")],
    ["packages/alpha/src/io/deep/file.js", Buffer.from("")],
    ["apps/beta/src/main.js", Buffer.from("")],
    ["tools/loose.js", Buffer.from("")],
  ]);
  const owners = cellOwners(files);
  assert.equal(owners.get("packages/alpha/index.js"), "packages/alpha");
  assert.equal(owners.get("packages/alpha/src/io/deep/file.js"), "packages/alpha");
  assert.equal(owners.get("apps/beta/src/main.js"), "apps/beta");
  assert.equal(owners.has("tools/loose.js"), false);
  assert.equal(ownerOf("packages/alpha/src/io/deep/file.js", files, owners), "packages/alpha");
  assert.equal(ownerOf("tools/loose.js", files, owners), ".");
});
