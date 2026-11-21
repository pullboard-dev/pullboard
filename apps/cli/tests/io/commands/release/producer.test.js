/** @pullboard-test-input source-tree */
/** A native private release records every registered executor for one simulated host, and a red private release collects tiny shard results without a native envelope or green stamp [C7,V4]. */
import { installReleaseProducerCases } from '../../../fixtures/release/cases/producer.js';

installReleaseProducerCases('count1');

installReleaseProducerCases('red');
