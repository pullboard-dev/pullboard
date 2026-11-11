/** The pullboard init command, in its own module so an item adding another command never edits these lines. */
import {
  keepViewRunning,
} from '../../../../view/index.js';
import {
  installedBlueprints,
  landEach,
  readBlueprints,
} from '../../../../../packages/blueprints/index.js';
import * as store from '../../../../../packages/store/index.js';
import {
  COORDINATOR,
  loadConfig,
} from '../../../../../packages/config/index.js';
import {
  codeIsFromMain,
  repoInfo,
} from '../../../../../packages/git/index.js';
import {
  beginInitCommit,
  finishInitCommit,
  initNextLine,
  initViewLine,
  reportInitSetup,
  SETUP_COMMIT_LATER,
} from '../init/finish.js';
import {
  RELAY_LATER,
  RELAY_OFFER_QUESTION,
  acceptsRelayOffer,
  initRepo,
  relayOfferAtInit,
} from '../init.js';
import { captureSpecApprovalBaseline } from '../../../../../packages/spec/index.js';
import {
  agentSessionDigest,
} from '../../../../../packages/person/index.js';
import {
  projectBoardIdentity,
  registerProjectAndLink,
} from '../../../../../packages/seats/index.js';
import { projectLinkPorts } from '../ports/project.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  offerRelayAtInit,
} from '../../../../../packages/link/index.js';
import {
  relayLinked,
} from '../../../../../packages/link/index.js';
import {
  join,
} from 'node:path';
import {
  addBlueprintHere,
  context,
  optionalModel,
  ordered,
  recordSetupState,
  refuseRemoteCoordinatorModel,
  setupIdentity,
  withBoard,
} from '../entry.js';

/** Run `pullboard init` and return its exit code. */
export async function run(io, { values }) {
  const info = repoInfo(io.cwd);
  // Every blueprint is read and checked before anything is written: an unknown name, a broken file, a URL
  // or a second product leaves the repo untouched (#678, #720). Then each is added as blueprint add does.
  const blueprints = readBlueprints(values.blueprint ?? [], io.cwd, 'init', installedBlueprints(info.root));
  const model = optionalModel(values.model);
  const linked = relayLinked(info.root);
  const ctx = linked && model !== undefined ? context(io) : null;
  if (model !== undefined && linked) refuseRemoteCoordinatorModel(ctx, 'init');
  const setupPlan = beginInitCommit(info);
  const notes = initRepo({
    info,
    onWritten: setupPlan.written,
    model,
    permissions: !values['no-permissions'],
    agentHooks: !values['no-hooks'],
    openBoardHere: () => io.nativeBoard.openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'), io.clock, { isMain: codeIsFromMain() }),
    /** Keep a linked coordinator's canonical identity without writing a clone-local path. */
    register: (board, options) => {
      if (!linked) {
        const existing = board.db.prepare('SELECT 1 FROM agent WHERE agent_id=?').get(COORDINATOR);
        const registered = store.register(board, options);
        if (!store.specApprovalBaselineExists(board)) store.recordSpecApprovalBaseline(board, {
          agentId: COORDINATOR, baseline: captureSpecApprovalBaseline(info.root, loadConfig(info.root)),
        });
        if (!existing) recordSetupState({ info }, setupIdentity(board), 'started');
        return registered;
      }
      if (!board.db.prepare('SELECT 1 FROM agent WHERE agent_id=?').get(COORDINATOR)) {
        throw new Refused('NO_AGENT', 'the linked snapshot has no coordinator; restore a consistent relay snapshot before initializing');
      }
      return COORDINATOR;
    },
    closeBoard: store.closeBoard,
  });
  if (linked && model !== undefined) await withBoard(ctx, (board) => ordered(ctx, board, 'register', [
    { lane: COORDINATOR, path: info.root, model },
  ]));
  // Keep blueprint initialization and the person's unwritten lane proposals in the same result.
  const landed = await landEach(blueprints, ({ reference, blueprint }, drafted) => addBlueprintHere(io, reference, { report: false, blueprint, drafted }));
  const { result } = reportInitSetup(io, info, notes, landed, { verbose: values.verbose });
  const setupCommit = await finishInitCommit(setupPlan, { io, yes: values.yes, landed, permissions: !values['no-permissions'] });
  result.setupCommit = setupCommit;
  const handleIdentity = await withBoard(context(io), board => projectBoardIdentity(info.root, store.boardId(board)));
  if (await registerProjectAndLink(info.root, new Date(), loadConfig(info.root), io, handleIdentity, projectLinkPorts(io))) io.say('registered this project on this machine, so pullboard view lists it');
  // Once registered, a background view lists this board for pullboard.dev [H5,N26].
  const view = await keepViewRunning();
  io.result?.({ ...result, view });
  const viewLine = initViewLine(view, { verbose: values.verbose });
  if (viewLine) io.say(viewLine);
  // Sharing remains a separate choice; --yes confirms only the setup commit.
  const code = await offerRelayAtInit(info.root, io, { details: values.verbose === true, offerPorts: { relayOfferAtInit, acceptsRelayOffer, RELAY_OFFER_QUESTION, RELAY_LATER } });
  if (setupCommit.skipped.length) io.say(values.verbose
    ? `Your earlier changes remain uncommitted: ${setupCommit.skipped.join(', ')}.`
    : `Kept ${setupCommit.skipped.length} earlier changes uncommitted.`);
  if (setupCommit.state === 'pending' && values.verbose) io.say(SETUP_COMMIT_LATER);
  if (setupCommit.state === 'committed') io.say(`Committed ${setupCommit.skipped.length ? 'only unchanged Pullboard files' : 'Pullboard setup'} at ${setupCommit.commit.slice(0, 12)}.`);
  io.say(initNextLine(Boolean(agentSessionDigest()), { verbose: values.verbose }));
  return code;
}
