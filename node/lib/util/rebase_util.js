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
const path    = require("path");
const rimraf  = require("rimraf");

const Open           = require("./open");
const GitUtil        = require("./git_util");
const RepoStatus     = require("./repo_status");
const RebaseFileUtil = require("./rebase_file_util");
const SubmoduleUtil  = require("./submodule_util");
const UserError      = require("./user_error");

/**
 * Put the head of the specified `repo` on the specified `commitSha`.
 */
const setHead = co.wrap(function *(repo, commitSha) {
    // TODO: use a more "gentle" strategy that won't stomp on untracked files.
    // The `checkout` function won't work because it doesn't affect
    // non-conflicting staged changes.

    const commit = yield repo.getCommit(commitSha);
    yield GitUtil.setHeadHard(repo, commit);
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
const callNext = co.wrap(function *(rebase) {
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
 * Finish the specified `rebase` in the specified `repo`.  Note that this
 * method is necessary only as a workaround for:
 * https://github.com/twosigma/git-meta/issues/115.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Rebase} rebase
 */
const callFinish = co.wrap(function *(repo, rebase) {
    const result = rebase.finish();
    const CLEANUP_FAILURE = -15;
    if (CLEANUP_FAILURE === result) {
        const gitDir = repo.path();
        const rebaseDir = yield RebaseFileUtil.findRebasingDir(gitDir);
        if (null !== rebaseDir) {
            const rebasePath = path.join(gitDir, rebaseDir);
            yield (new Promise(callback => {
                return rimraf(rebasePath, {}, callback);
            }));
        }
    }
});

/**
 * @class {SubmoduleRebaser}
 * This is a mechanism class that maintains the state of a submodule through a
 * rebase operation.
 *
 * @constructor
 * Create a new `SubmoduleRebaser` for the specified `submodule` having the
 * specified `repo`.  Record commits (from new to old) in the specified
 * `commits` map.
 *
 * @param {String}             submoduleName
 * @param {NodeGit.Repository} repo
 * @param {Object}             commits writable
 */
function SubmoduleRebaser(submoduleName, repo, commits) {
    assert.isString(submoduleName);
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isObject(commits);

    let rebase         = null;   // set to `NodeGit.Rebase` object when started
    let signature      = null;   // lazily set when needed
    let finishedRebase = false;  // true if the rebase was finished

    /**
     * Begin a rebase for this submodule from the current HEAD onto the
     * specified `remoteCommitId`.  If a rebase is in progress do nothing.
     *
     * @async
     * @private
     * @param {String} remoteCommitSha
     */
    const init = co.wrap(function *(remoteCommitSha) {
        if (null !== rebase) {
            return;                                                   // RETURN
        }
        yield GitUtil.fetchSha(repo, remoteCommitSha);
        const head = yield repo.head();
        const localAnnotated =
                             yield NodeGit.AnnotatedCommit.fromRef(repo, head);
        const remoteCommitId = NodeGit.Oid.fromString(remoteCommitSha);
        const remoteAnnotated =
                    yield NodeGit.AnnotatedCommit.lookup(repo, remoteCommitId);
        rebase = yield NodeGit.Rebase.init(repo,
                                           localAnnotated,
                                           remoteAnnotated,
                                           null,
                                           null);
    });

    /**
     * Process the commit having the specified `commitId`; set the HEAD of the
     * repository for this submodule to that commit or the result of having
     * rebased that commit.  Return true if the commit was successfully
     * processed and false if it was not and the rebase should stop.
     *
     * @async
     * @private
     * @param {String} commitSha
     */
    const next = co.wrap(function *(commitSha) {

        // If there is no rebase happening, just set the repo to the right
        // commit.

        if (null === rebase) {
            yield setHead(repo, commitSha);
            return true;                                              // RETURN
        }
        const oper = yield callNext(rebase);
        if (null === oper) {
            yield callFinish(repo, rebase);
            finishedRebase = true;
            return true;                                              // RETURN
        }
        const index = yield repo.index();
        if (index.hasConflicts()) {
            return false;                                             // RETURN
        }
        const entries = index.entries();
        let changed = false;
        yield entries.map(co.wrap(function *(x) {
            yield index.addByPath(x.path);
            changed = true;
        }));
        if (changed) {
            yield index.write();
            if (null === signature) {
                signature = repo.defaultSignature();
            }
            const newCommit = rebase.commit(null, signature, null);
            const originalCommit = oper.id().tostrS();
            commits[newCommit.tostrS()] = originalCommit;
        }

        // There may be more than one commit in the submodule corresponding to
        // a single commit in the meta-repo.  If the commit on the current
        // operation is not 'commitId', call 'next' again.

        if (oper.id().tostrS() === commitSha) {
            return true;
        }

        return yield next(commitSha);
    });

    function path() {
        return submoduleName;
    }

    /**
     * Finish the current rebase.  The behavior is undefined if the rebase has
     * not been fully processed.  If no rebase is in progress do nothing.
     *
     * @private
     * @async
     */
    const finish = co.wrap(function *() {

        if (null !== rebase && !finishedRebase) {
            yield next();
            if (!finishedRebase) {
                console.warn("Failed to finish rebase for: '" + path() + "'.");
            }
        }
    });

    return {
        init: init,
        next: next,
        finish: finish,
        path: path,
        repo: repo,
    };
}

/**
 * Rebase the current branch onto the specified `commit` in the specified
 * `metaRepo` having the specified `status`.  The behavior is undefined unless
 * the `metaRepo` is in a consistent state according to
 * `Status.ensureCleanAndConsistent`.  Return an object describing generated
 * commits.
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {NodeGit.Commit}     commit
 * @param {RepoStatus}         status
 * @return {Object} [return]
 * @return {Object} return.metaCommits      maps from new to rebased commits
 * @return {Object} return.submoduleCommits maps from submodule name to
 *                                          a map from new to rebased commits
 */
exports.rebase = co.wrap(function *(metaRepo, commit, status) {
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    assert.instanceOf(status, RepoStatus);
    // It's important to note that we will be rebasing the sub-repos on top of
    // commits identified in the meta-repo, not those from their upstream
    // branches.  Main steps:

    // 1. Check to see if meta-repo is up-to-date; if it is we can exit.
    // 2. Start the rebase operation in the meta-repo.
    // 3. When we encounter a conflict with a submodules, this indicates that
    //    we need to perform a rebase on that submodule as well.  This
    //    operation is complicated by the need to sync meta-repo commits with
    //    commits to the submodules, which may or may not be one-to-one.

    const result = {
        metaCommits: {},
        submoduleCommits: {},
    };

    const metaUrl = yield GitUtil.getOriginUrl(metaRepo);

    const currentBranchName = status.currentBranchName || "HEAD";
    const currentBranch = yield metaRepo.getBranch(currentBranchName);
    const currentCommitId = NodeGit.Oid.fromString(status.headCommit);
    const commitId = commit.id();

    const submodules = status.submodules;

    // First, see if 'commit' already exists in the current history.  If so, we
    // can exit immediately.

    if (yield GitUtil.isUpToDate(metaRepo,
                                 currentCommitId.tostrS(),
                                 commitId.tostrS())) {
        console.log(`${colors.green(currentBranch.shorthand())} is \
up-to-date.`);
        return result;                                                // RETURN
    }

    const submoduleRebasers = {};  // Cache of opened submodules

    /**
     * Return the submodule rebaser for the specified `path`, or null if
     * `path` does not correspond to a submodule.  Open the subodule if it is
     * not open.
     */
    const getSubmoduleRebaser = co.wrap(function *(path) {
        assert.isString(path);

        if (path in submoduleRebasers) {
            return yield submoduleRebasers[path];
        }

        if (!(path in submodules)) {
            return null;                                              // RETURN
        }

        const promise = co(function *() {
            let repo;
            const submodule = submodules[path];
            // Open the submodule if it's not open.

            if (null === submodule.repoStatus) {
                console.log(`Opening submodule ${colors.blue(path)}.`);
                repo = yield Open.openOnCommit(metaUrl,
                                               metaRepo,
                                               path,
                                               submodule.commitUrl,
                                               submodule.commitSha);
            }
            else { 
                repo = yield SubmoduleUtil.getRepo(metaRepo, path);
            }
            const commits = {};
            result.submoduleCommits[path] = commits;
            return new SubmoduleRebaser(path, repo, commits);
        });

        submoduleRebasers[path] = promise;
        return yield promise;
    });


    // Kick off the rebase; it wants to operate on "annotated" commits.

    const currentAnnotedCommit =
                yield NodeGit.AnnotatedCommit.fromRef(metaRepo, currentBranch);
    const annotatedCommit =
                      yield NodeGit.AnnotatedCommit.lookup(metaRepo, commitId);
    const rebase = yield NodeGit.Rebase.init(metaRepo,
                                             currentAnnotedCommit,
                                             annotatedCommit,
                                             null,
                                             null);

   const signature = metaRepo.defaultSignature();

    // Now, iterate over the rebase commits.  We pull the operation out into a
    // separate function to avoid problems associated with creating functions
    // in loops.

    const processRebase = co.wrap(function *(rebaseOper) {
        // We're going to loop over the entries of the index for the rebase
        // operation.  We have several tasks (I'll repeat later):
        //
        // 1. Stage "normal", un-conflicted, non-submodule changes.  This
        //    process requires that we set the submodule to the correct commit.
        // 2. When a conflict is detected in a submodule, call `init` on the
        //    rebaser for that submodule.
        // 3. Pass any change in a submodule off to the appropriate submodule
        //    rebaser.

        const index = yield metaRepo.index();
        let inits = [];  // `init` operations to run
        let nexts = [];  // rebaser and id to run `next` on in parallel

        let errorMessage = "";

        const entries = index.entries();
        for (let i = 0; i < entries.length; ++i) {
            const e = entries[i];
            const id = e.id;

            // From libgit2 index.h.  This information is not documented in the
            // nodegit or libgit2 documentation.

            const stage = RepoStatus.getStage(e.flags);
            switch (stage) {
            case RepoStatus.STAGE.NORMAL:
                // Do nothing; this indicates same both sides.
                break;
            case RepoStatus.STAGE.OURS:
                const initRebaser = yield getSubmoduleRebaser(e.path);
                if (null !== initRebaser) {

                    // This case is an indication that we have a conflict with
                    // an upstream commit.  Initialize a rebase for the
                    // affected submodule, letting it know the id of the
                    // upstream commit onto which it should rebase.  The
                    // `Entry` that comes with the stage set to
                    // GIT_INDEX_STAGE_THEIRS will contain the id of the commit
                    // that we are rebasing FROM.

                    inits.push(initRebaser.init(id.tostrS()));
                }
                else {
                    errorMessage += `
There is a conflict in ${colors.red(e.path)}.\n`;
                 }
                 break;
             case RepoStatus.STAGE.THEIRS:
                 const theirPath = e.path;
                 const theirRebaser = yield getSubmoduleRebaser(theirPath);
                 if (null !== theirRebaser) {

                     // Found the part of a conflict that corresponds to the
                     // branch we're rebasing from.  Need to schedule a call
                     // to the `SubmoduleRebaser.next` method to process the
                     // commit.

                     nexts.push({rebaser: theirRebaser, id: id.tostrS()});
                 }
             break;
             default:
             }
        }

        // Clean up conflicts unless we found one in the meta-repo that was not
        // a submodule change.

        if ("" === errorMessage) {
            yield index.conflictCleanup();
        }

        // Initiate scheduled rebases.

        yield inits;

        // Process next commits for all submodule rebases.

        yield nexts.map(co.wrap(function *(next) {
            const rebaser = next.rebaser;
            const id = next.id;
            if (yield rebaser.next(id)) {
                yield index.addByPath(rebaser.path());
            }
            else {
                errorMessage += `
Conflict rebasing the submodule ${colors.red(rebaser.path())}.`;
            }
        }));

        if ("" !== errorMessage) {
            throw new UserError(errorMessage);
        }

        index.write();
        const newCommit = rebase.commit(null, signature, null);
        const newCommitSha = newCommit.tostrS();
        const originalSha = rebaseOper.id().tostrS();
        if (originalSha !== newCommitSha) {
            result.metaCommits[newCommitSha] = originalSha;
        }
    });

    for (let rebaseOper = yield callNext(rebase);
         null !== rebaseOper;
         rebaseOper = yield callNext(rebase)) {

        yield processRebase(rebaseOper);
    }

    // After the main rebase completes, we need to give the submodules a chance
    // to finish then call `finish` on the `rebase` object.

    yield Object.keys(submoduleRebasers).map(co.wrap(function *(name) {
        const rebaser = yield submoduleRebasers[name];
        yield rebaser.finish();
    }));

    // If this was a fast-forward rebase, we need to set the heads of the
    // submodules correctly.

    const wasFF = yield NodeGit.Graph.descendantOf(metaRepo,
                                                   commit.id(),
                                                   currentBranch.target());
    if (wasFF) {
        const metaIndex = yield metaRepo.index();
        const openSubs = yield SubmoduleUtil.listOpenSubmodules(metaRepo);
        const shas = yield SubmoduleUtil.getCurrentSubmoduleShas(metaIndex,
                                                                 openSubs);
        yield openSubs.map(co.wrap(function *(name, index) {
            const sha = shas[index];
            if (sha !== status.submodules[name].commitSha) {
                const subRepo = yield SubmoduleUtil.getRepo(metaRepo, name);
                yield GitUtil.fetchSha(subRepo, sha);
                yield setHead(subRepo, sha);
            }
        }));
    }

    yield callFinish(metaRepo, rebase);

    return result;
});
