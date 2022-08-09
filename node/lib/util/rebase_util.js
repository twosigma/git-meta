/*
 * Copyright (c) 2016, Two Sigma Open Source
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * * Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * * Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * * Neither the name of git-meta nor the names of its
 *   contributors may be used to endorse or promote products derived from
 *   this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */
"use strict";

const assert  = require("chai").assert;
const co      = require("co");
const colors  = require("colors");
const NodeGit = require("nodegit");

const Checkout            = require("./checkout");
const CherryPickUtil      = require("./cherry_pick_util");
const Reset               = require("./reset");
const GitUtil             = require("./git_util");
const Hook                = require("./hook");
const SequencerState      = require("./sequencer_state");
const SequencerStateUtil  = require("./sequencer_state_util");
const StatusUtil          = require("./status_util");
const SubmoduleRebaseUtil = require("./submodule_rebase_util");
const UserError           = require("./user_error");

const CommitAndRef = SequencerState.CommitAndRef;

/**
 * Accumulate specfied `intermediate` result into `result`, gathering new and
 * rewritten submodule commits generated from a single rebase operation.
 *
 * @param {Object} result
 * @param {Object} result.submoduleCommits        path to map from sha to sha
 * @param {Object} intermediate
 * @param {Object} intermediate.submoduleCommits  path to map from sha to sha
 */
function accumulateRebaseResult(result, intermediate) {
    assert.isObject(result);
    assert.isObject(intermediate);

    for (let name in intermediate.submoduleCommits) {
        const commits = Object.assign(result.submoduleCommits[name] || {},
                                      intermediate.submoduleCommits[name]);
        result.submoduleCommits[name] = commits;
    }
    result.errorMessage = intermediate.errorMessage;
}

/**
 * If the specified `seq` has a non-null ref that is a branch, make it the
 * current branch in the specified `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @param {SequencerState}     seq
 */
const restoreHeadBranch = co.wrap(function *(repo, seq) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(seq, SequencerState);

    const originalRefName = seq.originalHead.ref;
    if (null !== originalRefName) {
        const ref = yield NodeGit.Reference.lookup(repo, originalRefName);
        if (ref.isBranch()) {
            const head = yield repo.getHeadCommit();
            yield ref.setTarget(head, "git-meta rebase");
            yield repo.setHead(originalRefName);
        }
    }
});

/**
 * Throw a `UserError` unlessn the specified `seq` is non-null and has type
 * `REBASE`.
 * @param {SequencerState} seq
 */
function ensureRebaseInProgress(seq) {
    if (null !== seq) {
        assert.instanceOf(seq, SequencerState);
    }

    if (null === seq || SequencerState.TYPE.REBASE !== seq.type) {
        throw new UserError("Error: no rebase in progress");
    }
    return seq;
}

/**
 * Apply the remaining rebase operations described in the specified `seq` to
 * the specified `repo`.  Return an object describing any created commits.
 * Before applying a commit, record a sequencer representing the current state.
 *
 * @param {NodeGit.Repository} repo
 * @param {SequencerState} seq
 * @return {Object} [return]
 * @return {Object} return.metaCommits      maps from new to rebased commits
 * @return {Object} return.submoduleCommits maps from submodule name to
 *                                          a map from new to rebased commits
 * @return {String|null} return.errorMessage
 */
exports.runRebase = co.wrap(function *(repo, seq) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(seq, SequencerState);
    const result = {
        metaCommits: {},
        submoduleCommits: {},
        errorMessage: null,
    };
    for (let i = seq.currentCommit; i !== seq.commits.length; ++i) {
        const nextSeq = seq.copy({ currentCommit: i, });
        yield SequencerStateUtil.writeSequencerState(repo.path(), nextSeq);
        const sha = nextSeq.commits[i];
        const commit = yield repo.getCommit(sha);
        SubmoduleRebaseUtil.logCommit(commit);
        const cherryResult = yield CherryPickUtil.rewriteCommit(repo, commit, 
            "rebase");
        if (null !== cherryResult.newMetaCommit) {
            result.metaCommits[cherryResult.newMetaCommit] = sha;
        }
        accumulateRebaseResult(result, cherryResult);
        if (null !== result.errorMessage) {
            return result;
        }
    }

    yield restoreHeadBranch(repo, seq);
    yield SequencerStateUtil.cleanSequencerState(repo.path());
    console.log("Finished rebase.");
    yield Hook.execHook(repo, "post-rewrite", ["rebase"]);
    return result;
});

/**
 * Rebase the current branch onto the specified `onto` commit in the specified
 * `repo` having the specified `status`.  Throw a `UserError` if the rebase
 * cannot proceed due to unclean state or because another operation is in
 * progress.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     onto
 * @return {Object} [return]
 * @return {Object} return.metaCommits      maps from new to rebased commits
 * @return {Object} return.submoduleCommits maps from submodule name to
 *                                          a map from new to rebased commits
 */
exports.rebase = co.wrap(function *(repo, onto) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(onto, NodeGit.Commit);

    // First, make sure we're in a state in which we can run a rebase.

    const status = yield StatusUtil.getRepoStatus(repo);
    StatusUtil.ensureReady(status);
    if (!status.isDeepClean(false)) {
        throw new UserError(`\
The repository has uncommitted changes.  Please stash or commit them before
running rebase.`);
    }

    const result = {
        metaCommits: {},
        submoduleCommits: {},
        errorMessage: null,
    };

    const headCommit = yield repo.getHeadCommit();
    const headRef = yield repo.head();
    const headSha = headCommit.id().tostrS();
    const ontoSha = onto.id().tostrS();

    // First, see if 'commit' already exists in the current history.  If so, we
    // can exit immediately.

    if (yield GitUtil.isUpToDate(repo, headSha, ontoSha)) {
        const name = headRef.shorthand();
        console.log(`${colors.green(name)} is up-to-date.`);
        return result;                                                // RETURN
    }

    const canFF = yield NodeGit.Graph.descendantOf(repo, ontoSha, headSha);
    if (canFF) {
        yield Reset.reset(repo, onto, Reset.TYPE.HARD);
        console.log(`Fast-forwarded to ${GitUtil.shortSha(ontoSha)}`);
        yield Hook.execHook(repo, "post-checkout", [headSha, ontoSha, "1"]);
        return result;                                                // RETURN
    }

    console.log("First, rewinding head to replay your work on top of it...");

    yield Checkout.checkoutCommit(repo, onto, true);

    const commits = yield exports.listRebaseCommits(repo, headCommit, onto);
    const headName = headRef.isBranch() ? headRef.name() : null;
    const seq = new SequencerState({
        type: SequencerState.TYPE.REBASE,
        originalHead: new CommitAndRef(headSha, headName),
        target: new CommitAndRef(ontoSha, null),
        currentCommit: 0,
        commits,
    });
    return yield exports.runRebase(repo, seq);
});

/**
 * Abort the rebase in progress on the specified `repo` and all open
 * submodules, returning them to their previous heads and checking them out.
 * The behavior is undefined unless the specified `repo` has a rebase in
 * progress.
 *
 * @param {NodeGit.Repository} repo
 */
exports.abort = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const seq = yield SequencerStateUtil.readSequencerState(repo.path());
    ensureRebaseInProgress(seq);
    const commit = yield repo.getCommit(seq.originalHead.sha);
    yield Reset.reset(repo, commit, Reset.TYPE.MERGE);
    yield restoreHeadBranch(repo, seq);
    yield SequencerStateUtil.cleanSequencerState(repo.path());
});

/**
 * Continue the rebase in progress on the specified `repo`.  Return an object
 * describng the commits that were created an an error message if the operation
 * could not be completed.
 *
 * @param {NodeGit.Repository} repo
 * @return {Object} [return]
 * @return {Object} return.metaCommits      maps from new to rebased commits
 * @return {Object} return.submoduleCommits maps from submodule name to
 *                                          a map from new to rebased commits
 * @return {Object} return.newCommits       commits made in non-rebasing
 *                                          submodules, path to sha
 */
exports.continue = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const status = yield StatusUtil.getRepoStatus(repo);
    const seq = status.sequencerState;
    ensureRebaseInProgress(seq);

    if (status.isConflicted()) {
        throw new UserError("Cannot continue rebase due to conflicts.");
    }

    const currentSha = seq.commits[seq.currentCommit];
    const currentCommit = yield repo.getCommit(currentSha);
    const index = yield repo.index();

    // First, continue in-progress rebases in the submodules and generate a
    // commit for the curren operation.

    const continueResult = yield SubmoduleRebaseUtil.continueSubmodules(
                                                                repo,
                                                                index,
                                                                status,
                                                                currentCommit);
    const result = {
        metaCommits: {},
        newCommits: continueResult.newCommits,
        submoduleCommits: continueResult.commits,
        errorMessage: continueResult.errorMessage,
    };
    if (null !== continueResult.metaCommit) {
        result.metaCommits[continueResult.metaCommit] =
                                                seq.commits[seq.currentCommit];
    }
    if (null !== result.errorMessage) {
        // Stop if there was a problem finishing the current operation.

        return result;                                                // RETURN
    }

    // Then, call back to `runRebase` to complete any remaining commits.

    const nextSeq = seq.copy({
        currentCommit: seq.currentCommit + 1,
    });
    const nextResult = yield exports.runRebase(repo, nextSeq);
    Object.assign(result.metaCommits, nextResult.metaCommits);
    accumulateRebaseResult(result, nextResult);
    return result;
});

/**
 * From the specified `repo`, return a list of non-merge commits that are part
 * of the history of `from` but not of `onto` (inclusive of `from`), in
 * depth-first order from left-to right.  Note that this will include commits
 * that could be fast-forwarded; if you need to do something else when `onto`
 * can be fast-forwarded from `from`, you must check beforehand.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     from
 * @param {NodeGit.Commit}     onto
 * @return [String]
 */
exports.listRebaseCommits = co.wrap(function *(repo, from, onto) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(from, NodeGit.Commit);
    assert.instanceOf(onto, NodeGit.Commit);

    const ontoSha = onto.id().tostrS();
    const seen = new Set([ontoSha]);    // shas that stop traversal
    const result = [];
    const todo = [];  // { sha: String | null, parents: [Commit]}

    // We proceed as follows:
    //
    // 1. Each item in the `todo` list represents a child commit with
    //    zero or more parents left to process.
    // 2. If the list of parents is empty in the last element of `todo`,
    //    record the sha of the child commit of this element into `result`
    //    (unless it was null, which would indicate a skipped merge commit).
    // 3. Otherwise, pop the last parent off and "enqueue" it onto the todo
    //    list.
    // 4. The `enqueue` function will skip any commits that have been
    //    previously seen, or that are in the history of `onto`.
    // 5. We start things off by enqueuing `from`.
    //
    // Note that (2) ensures that all parents of a commit are added to `result`
    // (where appropriate) before the commit itself, and (3) that a commit and
    // all of its ancestors are processed before any of its siblings.

    const enqueue = co.wrap(function *(commit) {
        const sha = commit.id().tostrS();

        // If we've seen a commit already, do not process it or any of its
        // children.  Otherwise, record that we've seen it.

        if (seen.has(sha)) {
            return;                                                   // RETURN
        }
        seen.add(sha);

        // Skip this commit if it's an ancestor of `onto`.

        const inHistory = yield NodeGit.Graph.descendantOf(repo, ontoSha, sha);
        if (inHistory) {
            return;                                                   // RETURN
        }
        const parents = yield commit.getParents();

        // Record a null as the `sha` if this was a merge commit so that we
        // know not to add it to `result` after processing its parents.  We
        // work from the back, so reverse the parents to get left first.

        todo.push({
            sha: 1 >= parents.length ? sha : null,
            parents: parents.reverse(),
        });
    });

    yield enqueue(from);  // Kick it off with the first, `from`, commit.

    while (0 !== todo.length) {
        const back = todo[todo.length - 1];
        const parents = back.parents;
        if (0 === parents.length) {
            // If nothing to do for last item, pop it off, record the child sha
            // in the result list if non-null (indicating non-merge), and move
            // on.

            if (null !== back.sha) {
                result.push(back.sha);
            }
            todo.pop();
        } else {
            // Otherwise, pop off the last parent and attempt to enqueue it.

            const next = parents.pop();
            yield enqueue(next);
        }
    }
    return result;
});
