#!/usr/bin/env node
/** Regenerate the 0.9.4 case study from a real readonly board and static lint inventory [C7,D3]. */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { caseStudy, readCaseStudyBaseline, writeCaseStudy } from './case-study/report.js';

const { values } = parseArgs({ options: {
  root: { type: 'string', default: '.' }, board: { type: 'string' },
  from: { type: 'string' }, to: { type: 'string' }, baseline: { type: 'string' },
  output: { type: 'string' }, finished: { type: 'boolean', default: false },
  'suite-log-table': { type: 'string' },
} });
if (!values.board || !values.from || !values.to) {
  throw new Error('use node docs/tools/case-study.js --board <sqlite> --from <ISO> --to <ISO> [--root <repo>] [--baseline <json>] [--output <directory>] [--finished]');
}
const report = caseStudy({ root: resolve(values.root), boardPath: resolve(values.board),
  from: values.from, to: values.to, finished: values.finished,
  baseline: values.baseline ? readCaseStudyBaseline(resolve(values.baseline)) : null,
  suiteLogTable: values['suite-log-table'] ? resolve(values['suite-log-table']) : null });
if (values.output) writeCaseStudy(report, resolve(values.output));
else process.stdout.write(JSON.stringify(report, null, 2) + '\n');
