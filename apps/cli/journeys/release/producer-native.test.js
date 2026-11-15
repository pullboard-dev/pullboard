/** @pullboard-test-input source-tree */
/** The native private release producer binds stored bytes to current source across eight simulated executors [C7,V4]. */
import { installReleaseProducerCases } from '../../tests/fixtures/release/cases/producer.js';

installReleaseProducerCases('native');
