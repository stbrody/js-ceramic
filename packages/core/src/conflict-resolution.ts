import type CID from 'cids'
import {
  AnchorCommit,
  AnchorProof,
  AnchorStatus,
  AnchorValidator,
  CommitData,
  CommitType,
  Context,
  InternalOpts,
  LogEntry,
  Stream,
  StreamHandler,
  StreamState,
  StreamStateHolder,
  StreamUtils,
} from '@ceramicnetwork/common'
import { Dispatcher } from './dispatcher'
import cloneDeep from 'lodash.clonedeep'
import { CommitID } from '@ceramicnetwork/streamid'
import { StateValidation } from './state-management/state-validation'
import { HandlersMap } from './handlers-map'

/**
 * Verifies anchor commit structure
 *
 * @param dispatcher - To get raw blob from IPFS
 * @param anchorValidator - AnchorValidator to verify chain inclusion
 * @param commit - Anchor commit
 */
async function verifyAnchorCommit(
  dispatcher: Dispatcher,
  anchorValidator: AnchorValidator,
  commit: AnchorCommit
): Promise<AnchorProof> {
  const proofCID = commit.proof
  const proof = await dispatcher.retrieveFromIPFS(proofCID)

  let prevCIDViaMerkleTree
  try {
    // optimize verification by using ipfs.dag.tree for fetching the nested CID
    if (commit.path.length === 0) {
      prevCIDViaMerkleTree = proof.root
    } else {
      const merkleTreeParentRecordPath =
        '/root/' + commit.path.substr(0, commit.path.lastIndexOf('/'))
      const last: string = commit.path.substr(commit.path.lastIndexOf('/') + 1)

      const merkleTreeParentRecord = await dispatcher.retrieveFromIPFS(
        proofCID,
        merkleTreeParentRecordPath
      )
      prevCIDViaMerkleTree = merkleTreeParentRecord[last]
    }
  } catch (e) {
    throw new Error(`The anchor commit couldn't be verified. Reason ${e.message}`)
  }

  if (commit.prev.toString() !== prevCIDViaMerkleTree.toString()) {
    throw new Error(
      `The anchor commit proof ${commit.proof.toString()} with path ${
        commit.path
      } points to invalid 'prev' commit`
    )
  }

  await anchorValidator.validateChainInclusion(proof)
  return proof
}

/**
 * Given two different StreamStates representing two different conflicting histories of the same
 * stream, pick which commit to accept, in accordance with our conflict resolution strategy
 * @param state1 - first log's state
 * @param state2 - second log's state
 * @returns the StreamState containing the log that is selected
 */
export async function pickLogToAccept(
  state1: StreamState,
  state2: StreamState
): Promise<StreamState> {
  const isState1Anchored = state1.anchorStatus === AnchorStatus.ANCHORED
  const isState2Anchored = state2.anchorStatus === AnchorStatus.ANCHORED

  if (isState1Anchored != isState2Anchored) {
    // When one of the logs is anchored but not the other, take the one that is anchored
    return isState1Anchored ? state1 : state2
  }

  if (isState1Anchored && isState2Anchored) {
    // compare anchor proofs if both states are anchored
    const { anchorProof: proof1 } = state1
    const { anchorProof: proof2 } = state2

    if (proof1.chainId != proof2.chainId) {
      // TODO: Add logic to handle conflicting updates anchored on different chains
      throw new Error(
        'Conflicting logs on the same stream are anchored on different chains. Chain1: ' +
          proof1.chainId +
          ', chain2: ' +
          proof2.chainId
      )
    }

    // Compare block heights to decide which to take
    if (proof1.blockNumber < proof2.blockNumber) {
      return state1
    } else if (proof2.blockNumber < proof1.blockNumber) {
      return state2
    }
    // If they have the same block number fall through to fallback mechanism
  }

  // The anchor states are the same for both logs. Compare log lengths and choose the one with longer length.
  if (state1.log.length > state2.log.length) {
    return state1
  } else if (state1.log.length < state2.log.length) {
    return state2
  }

  // If we got this far, that means that we don't have sufficient information to make a good
  // decision about which log to choose.  The most common way this can happen is that neither log
  // is anchored, although it can also happen if both are anchored but in the same blockNumber or
  // blockTimestamp. At this point, the decision of which log to take is arbitrary, but we want it
  // to still be deterministic. Therefore, we take the log whose last entry has the lowest CID.
  return state1.log[state1.log.length - 1].cid.bytes < state2.log[state2.log.length - 1].cid.bytes
    ? state1
    : state2
}

export class HistoryLog {
  static fromState(dispatcher: Dispatcher, state: StreamState): HistoryLog {
    return new HistoryLog(dispatcher, state.log)
  }

  constructor(private readonly dispatcher: Dispatcher, readonly items: LogEntry[]) {}

  get length(): number {
    return this.items.length
  }

  /**
   * Determines if the HistoryLog includes a CID, returning true or false as appropriate.
   */
  includes(cid: CID): boolean {
    const index = this.findIndex(cid)
    return index !== -1
  }

  get last(): CID {
    return this.items[this.items.length - 1].cid
  }

  /**
   * Find index of the commit in the array
   *
   * @param cid - CID value
   */
  findIndex(cid: CID): number {
    return this.items.findIndex((entry) => entry.cid.equals(cid))
  }

  slice(start?: number, end?: number): HistoryLog {
    const next = this.items.slice(start, end)
    return new HistoryLog(this.dispatcher, next)
  }
}

/**
 * Fetch log to find a connection for the given CID.
 * Expands SignedCommits and adds a CID into the log for their inner `link` records
 *
 * @param dispatcher - Get commit from IPFS
 * @param cid - Commit CID
 * @param stateLog - Log from the current stream state
 * @param unappliedCommits - Unapplied commits found so far
 * @param timestamp - Previously found timestamp
 * @private
 */
export async function fetchLog(
  dispatcher: Dispatcher,
  cid: CID,
  stateLog: HistoryLog,
  unappliedCommits: CommitData[] = [],
  timestamp?: number
): Promise<CommitData[]> {
  if (stateLog.includes(cid)) {
    // already processed
    return []
  }
  const commit = await dispatcher.retrieveCommit(cid)
  if (!commit) throw new Error(`No commit found for CID ${cid.toString()}`)

  let nextCommitData: CommitData
  if (StreamUtils.isSignedCommit(commit)) {
    const linkedCommit = await dispatcher.retrieveCommit(commit.link)
    if (!linkedCommit) throw new Error(`No commit found for CID ${commit.link.toString()}`)
    nextCommitData = { cid: cid, type: CommitType.SIGNED, commit: linkedCommit, envelope: commit, timestamp: timestamp }
  } else if (StreamUtils.isAnchorCommit(commit)) {
    const proof = await dispatcher.retrieveFromIPFS(commit.proof)
    timestamp = proof.blockTimestamp
    nextCommitData = { cid: cid, type: CommitType.ANCHOR, commit: commit, timestamp: timestamp }
  } else {
    // For all cases not using DagJWS for signing (e.g. CAIP-10 links)
    nextCommitData = { cid: cid, type: CommitType.SIGNED, commit: commit, timestamp: timestamp }
  }
  const prevCid: CID = nextCommitData.commit.prev
  if (!prevCid) {
    // Someone sent a tip that is a fake log, i.e. a log that at some point does not refer to a previous or genesis
    // commit.
    return []
  }

  // Should be unshift [O(N)], but push [O(1)] + reverse [O(N)] seem better
  unappliedCommits.push(nextCommitData)
  if (stateLog.includes(prevCid)) {
    // we found the connection to the canonical log
    return unappliedCommits.reverse()
  }
  return fetchLog(dispatcher, prevCid, stateLog, unappliedCommits, timestamp)
}

export function commitAtTime(stateHolder: StreamStateHolder, timestamp: number): CommitID {
  let commitCid: CID = stateHolder.state.log[0].cid
  for (const entry of stateHolder.state.log) {
    if (entry.type === CommitType.ANCHOR) {
      if (entry.timestamp <= timestamp) {
        commitCid = entry.cid
      } else {
        break
      }
    }
  }
  return stateHolder.id.atCommit(commitCid)
}

export class ConflictResolution {
  constructor(
    public anchorValidator: AnchorValidator,
    private readonly stateValidation: StateValidation,
    private readonly dispatcher: Dispatcher,
    private readonly context: Context,
    private readonly handlers: HandlersMap
  ) {}

  /**
   * Helper function for applying a single commit to a StreamState.
   * TODO: Most of this logic should be pushed down into the StreamHandler so it can be StreamType-specific.
   * @param entry - the commit to apply
   * @param state - the state to apply the commit to
   * @param handler - the handler for the streamtype
   * @private
   */
  private async applyLogEntryToState<T extends Stream>(
    entry: CommitData, state: StreamState, handler: StreamHandler<T>): Promise<StreamState> {
    const logEntry = await this.getCommitData(entry)
    const commitMeta = { cid: logEntry.cid, timestamp: logEntry.timestamp }
    if (StreamUtils.isAnchorCommit(logEntry.commit)) {
      // It's an anchor commit
      // TODO: Anchor validation should be done by the StreamHandler as part of applying the anchor commit
      await verifyAnchorCommit(this.dispatcher, this.anchorValidator, logEntry.commit)
      return await handler.applyCommit(logEntry.commit, commitMeta, this.context, state)
    } else {
      // It's a signed commit but may not be using DagJWS. If the JWS envelope is present, use that while applying the
      // commit, otherwise use the commit itself (e.g. for CAIP-10 links).
      const commitToApply = logEntry.envelope ? logEntry.envelope : logEntry.commit
      const tmpState = await handler.applyCommit(commitToApply, commitMeta, this.context, state)
      const isGenesis = !logEntry.commit.prev
      const effectiveState = isGenesis ? tmpState : tmpState.next
      // TODO: Schema validation should be done by the StreamHandler as part of applying the commit
      await this.stateValidation.validate(effectiveState, effectiveState.content)
      return tmpState // if validation is successful
    }
  }

  /**
   * Applies the log to the stream and updates the state.
   * If an error is encountered while applying a commit, commit application stops and the state
   * that was built thus far is returned, unless 'opts.throwOnInvalidCommit' is true.
   */
  private async applyLogToState<T extends Stream>(
    handler: StreamHandler<T>,
    unappliedCommits: CommitData[],
    state: StreamState | null,
    breakOnAnchor: boolean,
    opts: InternalOpts,
  ): Promise<StreamState> {
    // When we have genesis state only, and add some commits on top, we should check a signature at particular timestamp.
    // Most probably there is a timestamp information there. If no timestamp found, we consider it to be _now_.
    // `fetchLog` provides the timestamps.
    if (state && state.log.length === 1) {
      const timestamp = unappliedCommits[0].timestamp
      const genesisCid = state.log[0].cid
      const genesis = await this.dispatcher.retrieveCommit(genesisCid)
      await handler.applyCommit(genesis, { cid: genesisCid, timestamp: timestamp }, this.context)
    }

    for (const entry of unappliedCommits) {
      try {
        state = await this.applyLogEntryToState(entry, state, handler)
      } catch(err) {
        // TODO(1586): include StreamID in log message
        this.context.loggerProvider.getDiagnosticsLogger().warn(
          `Error while applying commit ${entry.cid.toString()}: ${err}`)
        if (opts.throwOnInvalidCommit) {
          throw err
        } else {
          return state
        }
      }

      if (breakOnAnchor && AnchorStatus.ANCHORED === state.anchorStatus) {
        return state
      }
    }
    return state
  }

  /**
   * Applies the log to the state.
   *
   * @param initialState - State to apply log to.
   * @param initialStateLog - HistoryLog representation of the `initialState.log` with SignedCommits expanded out and CIDs for their `link` record included in the log.
   * @param unappliedCommits - commits to apply
   * @param opts - options that control the behavior when applying the commit
   */
  private async applyLog(
    initialState: StreamState,
    initialStateLog: HistoryLog,
    unappliedCommits: CommitData[],
    opts: InternalOpts,
  ): Promise<StreamState | null> {
    const handler = this.handlers.get(initialState.type)
    const tip = initialStateLog.last
    if (unappliedCommits[unappliedCommits.length - 1].cid.equals(tip)) {
      // log already applied
      return null
    }
    const commitData = await this.getCommitData(unappliedCommits[0])
    if (commitData.commit.prev.equals(tip)) {
      // the new log starts where the previous one ended
      return this.applyLogToState(handler, unappliedCommits, cloneDeep(initialState), false, opts)
    }

    // we have a conflict since prev is in the log of the local state, but isn't the tip
    // BEGIN CONFLICT RESOLUTION
    const conflictIdx = initialStateLog.findIndex(commitData.commit.prev) + 1
    const canonicalLog = initialStateLog.items
    const localLog = canonicalLog.splice(conflictIdx)
    // Compute state up till conflictIdx
    const state: StreamState = await this.applyLogToState(handler, canonicalLog, null, false, opts)
    // Compute next transition in parallel
    const localState = await this.applyLogToState(handler, localLog, cloneDeep(state), true, opts)
    const remoteState = await this.applyLogToState(handler, unappliedCommits, cloneDeep(state), true, opts)

    const selectedState = await pickLogToAccept(localState, remoteState)
    if (selectedState === localState) {
      return null
    }

    return this.applyLogToState(handler, unappliedCommits, cloneDeep(state), false, opts)
  }

  /**
   * Add tip to the state. Return null if already applied.
   *
   * @param initialState - State to start from
   * @param tip - Commit CID
   * @param opts - options that control the behavior when applying the commit
   */
  async applyTip(initialState: StreamState, tip: CID, opts: InternalOpts): Promise<StreamState | null> {
    const stateLog = HistoryLog.fromState(this.dispatcher, initialState)
    const log = await fetchLog(this.dispatcher, tip, stateLog)
    if (log.length) {
      return this.applyLog(initialState, stateLog, log, opts)
    }
  }

  /**
   * Verify signature of a lone genesis commit, using current time to check for revoked key.
   */
  async verifyLoneGenesis(state: StreamState) {
    const handler = this.handlers.get(state.type)
    const genesisCid = state.log[0].cid
    const genesis = await this.dispatcher.retrieveCommit(genesisCid)
    await handler.applyCommit(genesis, { cid: genesisCid }, this.context)
  }

  /**
   * Return state at `commitId` version.
   */
  async snapshotAtCommit(initialState: StreamState, commitId: CommitID): Promise<StreamState> {
    // Throw if any commit fails to apply as we are trying to load at a specific commit and want
    // to error if we can't.
    const opts = { throwOnInvalidCommit: true }

    // If 'commit' is ahead of 'initialState', sync state up to 'commit'
    const baseState = (await this.applyTip(initialState, commitId.commit, opts)) || initialState

    const baseStateLog = HistoryLog.fromState(this.dispatcher, baseState)

    // If 'commit' is not included in stream's log at this point, that means that conflict resolution
    // rejected it.
    const commitIndex = await baseStateLog.findIndex(commitId.commit)
    if (commitIndex < 0) {
      throw new Error(
        `Requested commit CID ${commitId.commit.toString()} not found in the log for stream ${commitId.baseID.toString()}`
      )
    }

    // If the requested commit is included in the log, but isn't the most recent commit, we need
    // to reset the state to the state at the requested commit.
    const resetLog = baseStateLog.slice(0, commitIndex + 1).items
    const handler = this.handlers.get(initialState.type)
    return this.applyLogToState(handler, resetLog, null, false, opts)
  }

  /**
   * Return `CommitData` with commit and JWS envelope, if applicable and not already present.
   */
  private async getCommitData(_commitData: CommitData): Promise<CommitData> {
    // Clone the `CommitData` so that the Stream state is not affected when commit/JWS data is added to the structure
    const commitData: CommitData = {
      cid: _commitData.cid,
      type: _commitData.type,
      timestamp: _commitData.timestamp,
      commit: _commitData.commit,
      envelope: _commitData.envelope
    }
    if (!commitData.commit) {
      const commit = await this.dispatcher.retrieveCommit(commitData.cid)
      commitData.commit = commit
      if (StreamUtils.isSignedCommit(commit)) {
        commitData.commit = await this.dispatcher.retrieveCommit(commit.link)
        commitData.envelope = commit
      }
    }
    return commitData
  }
}
