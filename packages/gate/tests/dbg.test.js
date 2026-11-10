import { test } from 'node:test';
import { fixture } from '../../landing/tests/fixtures/plan.js';
import { withCellLintParser } from '../../codemap/index.js';
import { cellLintParsers } from '../../codemap/index.js';
import { cellLintReport } from '../../codemap/index.js';
import { cellLintBaseline } from '../../codemap/index.js';
import { planCellLintBaseline } from '../../codemap/index.js';
import { writeCellLintBaseline } from '../../codemap/index.js';

test('debug init verify diff [C7]', t => {
  const box = fixture(t);
  withCellLintParser(compile => {
    const parsers = cellLintParsers(compile);
    const plan = planCellLintBaseline(cellLintReport(box.root, parsers));
    let after;
    try { writeCellLintBaseline(box.root, plan.baseline, { initialize: true, verify: () => { after = cellLintBaseline(cellLintReport(box.root, parsers)); return JSON.stringify(after) === JSON.stringify(plan.baseline); } }); } catch (e) { console.log('DBG refused', e.message); }
    const a = JSON.parse(JSON.stringify(plan.baseline)), b = JSON.parse(JSON.stringify(after ?? {}));
    for (const m of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[m]) !== JSON.stringify(b[m])) console.log('DBG metric', m, JSON.stringify(a[m])?.slice(0, 600), '=>', JSON.stringify(b[m])?.slice(0, 900));
  });
});
