/*
 * Copyright (c) 2018, Two Sigma Open Source
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
const path    = require("path");
const rimraf  = require("rimraf");

const ConfigUtil          = require("./config_util");
const GitUtil             = require("./git_util");
const DoWorkQueue         = require("./do_work_queue");
const RebaseFileUtil      = require("./rebase_file_util");
const RepoStatus          = require("./repo_status");
const SparseCheckoutUtil  = require("./sparse_checkout_util");
const SubmoduleUtil       = require("./submodule_util");

/**
 * Continue the rebase in the specified `repo` and return an object describing
 * any generated commits and the sha of the conflicted commit if there was one.
 * The behavior is undefined unless `true === repo.isRebasing()`.
 *
 * @param {NodeGit.Repository} repo
 * @return {Object} return
 * @return {Object} return.commits
 * @return {String|null} return.conflictedCommit
 */
const continueRebase = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert(repo.isRebasing());

    const rebase = yield NodeGit.Rebase.open(repo);
    const idx = rebase.operationCurrent();
    const op = rebase.operationByIndex(idx);
    return yield exports.processRebase(repo, rebase, op);
});

const cleanupRebaseDir = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const gitDir = repo.path();
    const rebaseDir = yield RebaseFileUtil.findRebasingDir(gitDir);
    if (null !== rebaseDir) {
        const rebasePath = path.join(gitDir, rebaseDir);
        yield (new Promise(callback => {
            return rimraf(rebasePath, {}, callback);
        }));
    }
});

/**
 * Make a new commit on the head of the specified `repo` having the same
 * committer and message as the specified original `commit`, and return its
 * sha.
 *
 * TODO: independent test
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 * @return {String}
 */
exports.makeCommit = co.wrap(function *(repo, commit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);

    const defaultSig = yield ConfigUtil.defaultSignature(repo);
    const metaCommit = yield repo.createCommitOnHead([],
                                                     commit.author(),
                                                     defaultSig,
                                                     commit.message());
    return metaCommit.tostrS();
});

/**
 * Finish the specified `rebase` in the specified `repo`.  Note that this
 * method is necessary only as a workaround for:
 * https://github.com/twosigma/git-meta/issues/115.
 *
 * TODO: independent test
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Rebase} rebase
 */
exports.callFinish = co.wrap(function *(repo, rebase) {
    const result = rebase.finish();
    const CLEANUP_FAILURE = -15;
    if (CLEANUP_FAILURE === result) {
        yield cleanupRebaseDir(repo);
    }
});

/**
 * Call `next` on the specified `rebase`; return the rebase operation for the
 * rebase or null if there is no further operation.
 *
 * @async
 * @private
 * @param {NodeGit.Rebase} rebase
 * @return {RebaseOperation|null}
 */
exports.callNext = co.wrap(function *(rebase) {
    try {
        return yield rebase.next();
    }
    catch (e) {
        // It's cumbersome, but the way the nodegit library indicates
        // that you are at the end of the rebase is by throwing an
        // exception.  At this point we call `finish` on the rebase and
        // break out of the contaiing while loop.

        if (e.errno === NodeGit.Error.CODE.ITEROVER) {
            return null;
        }
        throw e;
    }
});

/**
 * Process the specified `rebase` for the specified `repo`, beginning with the
 * specified `op`.  Return an object describing any encountered error and
 * commits made.  If successful, clean up and finish the rebase.  If
 * `null === op`, finish the rebase and return.
 *
 * @param {NodeGit.Repository}           repo
 * @param {NodeGit.Rebase}               rebase
 * @param {NodeGit.RebaseOperation|null} op
 * @return {Object}
 * @return {Object} return.commits
 * @return {String|null} return.conflictedCommit
 * @returns {Boolean} return.ffwd
 */
exports.processRebase = co.wrap(function *(repo, rebase, op) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(rebase, NodeGit.Rebase);
    if (null !== op) {
        assert.instanceOf(op, NodeGit.RebaseOperation);
    }
    const result = {
        commits: {},
        conflictedCommit: null,
        ffwd: false,
    };
    const signature = yield ConfigUtil.defaultSignature(repo);
    while (null !== op) {
        const index = yield repo.index();
        if (index.hasConflicts()) {
            result.conflictedCommit = op.id().tostrS();
            return result;                                            // RETURN
        }
        let newCommit;
        try {
            newCommit = yield rebase.commit(null, signature, null);
        } catch (e) {
            // If there's nothing to commit, `NodeGit.Rebase.commit` will throw
            // an error.  If that's the case, we want to just ignore the
            // operation and move on, as Git does.
        }
        if (undefined !== newCommit) {
            const originalCommit = op.id().tostrS();
            result.commits[newCommit.tostrS()] = originalCommit;
        }
        op = yield exports.callNext(rebase);
    }
    yield exports.callFinish(repo, rebase);
    return result;
});

/**
 * Rebase the commits from the specified `branch` commit on the HEAD of the
 * specified `repo`.  If the optionally specified `upstream` is provided,
 * rewrite only commits beginning with `upstream`; otherwise, rewrite all
 * reachable commits.  Return an object containing a map that describes any
 * written commits and an error message if some part of the rewrite failed.
 *
 * @param {NodeGit.Repository}  repo
 * @param {NodeGit.Commit}      commit
 * @param {NodeGit.Commit|null} upstream
 * @return {Object}
 * @return {Object}      return.commits           new sha to original sha
 * @return {String|null} return.conflictedCommit  error message if failed
 * @return {Boolean}     return.ffwd              true if fast-forwarded
 */
exports.rewriteCommits = co.wrap(function *(repo, branch, upstream) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(branch, NodeGit.Commit);
    if (null !== upstream) {
        assert.instanceOf(upstream, NodeGit.Commit);
    }
    const head = yield repo.head();
    const headSha = head.target().tostrS();
    const branchSha = branch.id().tostrS();
    const upstreamSha = (upstream && upstream.id().tostrS()) || null;

    const result = {
        commits: {},
        conflictedCommit: null,
        ffwd: false,
    };

    // If we're up-to-date with the commit to be rebased onto, return
    // immediately.  Detach head as this is the normal behavior.

    if (headSha === branchSha ||
        (yield NodeGit.Graph.descendantOf(repo, headSha, branchSha))) {
        repo.detachHead();
        return result;                                                // RETURN
    }

    // If the upstream is non-null, but is an ancestor of HEAD or equal to it,
    // libgit2 will try to rewrite commits that should not be rewritten and
    // fail.  In this case, we set upstream to null, indicating at all commits
    // should be included (as they should).

    if (null !== upstream) {
        if (upstreamSha === headSha ||
           (yield NodeGit.Graph.descendantOf(repo, headSha, upstreamSha))) {
            upstream = null;
        }
    }

    // We can do a fast-forward if `branch` and its entire history should be
    // included.  This requires two things to be true:
    // 1. `branch` is a descendant of `head` or equal to `head`
    // 2. `null === upstream` (implying that all ancestors are to be included)

    if (null === upstream) {
        if (yield NodeGit.Graph.descendantOf(repo, branchSha, headSha)) {
            yield GitUtil.setHeadHard(repo, branch);
            result.ffwd = true;
            return result;                                            // RETURN
        }
    }

    const ontoAnnotated = yield NodeGit.AnnotatedCommit.fromRef(repo, head);
    const branchAnnotated =
                       yield NodeGit.AnnotatedCommit.lookup(repo, branch.id());
    let upstreamAnnotated = null;
    if (null !== upstream) {
        upstreamAnnotated =
                     yield NodeGit.AnnotatedCommit.lookup(repo, upstream.id());
    }
    const rebase = yield NodeGit.Rebase.init(repo,
                                             branchAnnotated,
                                             upstreamAnnotated,
                                             ontoAnnotated,
                                             null);
    const op = yield exports.callNext(rebase);
    return yield exports.processRebase(repo, rebase, op);
});

/**
 * Return a conflict description for the submodule having the specified `name`.
 *
 * TODO: independent test
 *
 * @param {String} name
 * @return {String}
 */
exports.subConflictErrorMessage = function (name) {
    return `Submodule ${colors.red(name)} is conflicted.\n`;
};

/**
 * Log a message indicating that the specified `commit` is being applied.
 *
 * @param {NodeGit.Commit} commit
 */
exports.logCommit = function (commit) {
    assert.instanceOf(commit, NodeGit.Commit);
    console.log(`Applying '${commit.message().split("\n")[0]}'`);
};

/**
 * Continue rebases in the submodules in the specifed `repo` having the
 * `index and `status`.  If staged changes are found in submodules that don't
 * have in-progress rebases, commit them using the specified message and
 * signature from the specified original `commit`.  If there are any changes to
 * commit, make a new commit in the meta-repo.   Return an object describing
 * any commits that were generated along with an error message if any continues
 * failed.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Index}      index
 * @param {RepoStatus}         status
 * @param {NodeGit.Commit}     commit
 * @return {Object}
 * @return {String|null}       metaCommit
 * @return {Object} return.commits  map from name to sha map
 * @return {Object} return.newCommits  from name to newly-created commits
 * @return {String|null} return.errorMessage
 */
exports.continueSubmodules = co.wrap(function *(repo, index, status, commit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(index, NodeGit.Index);
    assert.instanceOf(status, RepoStatus);
    assert.instanceOf(commit, NodeGit.Commit);

    exports.logCommit(commit);
    const commits = {};
    const newCommits = {};
    const subs = status.submodules;
    let errorMessage = "";
    const continueSub = co.wrap(function *(name) {
        const sub = subs[name];
        const workdir = sub.workdir;
        if (null === workdir) {
            // Return early if the submodule is closed.
            return;                                                   // RETURN
        }
        const subStatus = workdir.status;
        const rebaseInfo = subStatus.rebase;
        const subRepo = yield SubmoduleUtil.getRepo(repo, name);
        if (null === rebaseInfo) {
            if (0 !== Object.keys(subStatus.staged).length) {
                const id = yield subRepo.createCommitOnHead([],
                                                            commit.author(),
                                                            commit.committer(),
                                                            commit.message());
                newCommits[name] = id.tostrS();
            }
            yield index.addByPath(name);

            // Return early if no rebase in this submodule.
            return;                                                   // RETURN
        }
        console.log(`Submodule ${colors.blue(name)} continuing \
rewrite from ${colors.green(rebaseInfo.originalHead)} onto \
${colors.green(rebaseInfo.onto)}.`);
        const result = yield continueRebase(subRepo);
        commits[name] = result.commits;
        if (null !== result.conflictedCommit) {
            errorMessage += exports.subConflictErrorMessage(name);
        }
        else {
            yield index.addByPath(name);
            yield index.conflictRemove(name);
        }
    });
    yield DoWorkQueue.doInParallel(Object.keys(subs), continueSub);
    yield SparseCheckoutUtil.setSparseBitsAndWriteIndex(repo, index);
    const result = {
        errorMessage: "" === errorMessage ? null : errorMessage,
        commits: commits,
        newCommits: newCommits,
        metaCommit: null,
    };
    if (null === result.errorMessage) {
        if (status.isIndexDeepClean()) {
            console.log("Nothing to commit.");
        } else {
            result.metaCommit = yield exports.makeCommit(repo, commit);
        }
    }
    return result;
});
