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

const DeinitUtil          = require("./deinit_util");
const DoWorkQueue         = require("../util/do_work_queue");
const Open                = require("./open");
const GitUtil             = require("./git_util");
const Hook                = require("../util/hook");
const RepoStatus          = require("./repo_status");
const RebaseFileUtil      = require("./rebase_file_util");
const StatusUtil          = require("./status_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const SubmoduleUtil       = require("./submodule_util");
const UserError           = require("./user_error");

/**
 * Return a conflict description for the submodule having the specified `name`.
 *
 * @param {String} name
 * @return {String}
 */
function subConflictErrorMessage(name) {
    return `Conflict in ${colors.red(name)}`;
}

/**
 * Put the head of the specified `repo` on the specified `commitSha`.
 */
const setHead = co.wrap(function *(repo, commitSha) {
    const commit = yield repo.getCommit(commitSha);
    yield GitUtil.setHeadHard(repo, commit);
});

/**
 * Call `next` on the specified `rebase`; return the rebase operation for the
 * rebase or null if there is no further operation.
 *
 * TODO: independent test
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

const cleanupRebaseDir = co.wrap(function *(repo) {
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
        yield cleanupRebaseDir(repo);
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
    };
    const signature = repo.defaultSignature();
    while (null !== op) {
        const index = yield repo.index();
        if (index.hasConflicts()) {
            result.conflictedCommit = op.id().tostrS();
            return result;                                            // RETURN
        }
        const newCommit = rebase.commit(null, signature, null);
        const originalCommit = op.id().tostrS();
        result.commits[newCommit.tostrS()] = originalCommit;
        op = yield exports.callNext(rebase);
    }
    yield callFinish(repo, rebase);
    return result;
});

/**
 * Rebease the commits from the specified `branch` commit on the HEAD of
 * the specified `repo`.  If the optionally specified `upstream` is provided,
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
 */
exports.rewriteCommits = co.wrap(function *(repo, branch, upstream) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(branch, NodeGit.Commit);
    if (null !== upstream) {
        assert.instanceOf(upstream, NodeGit.Commit);
    }

    const head = yield repo.head();
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
 * Return an object indicating the commits that were created during rebasing
 * and/or an error message indicating that the rebase was stopped due to a
 * conflict.
 *
 * @param {Open.Opener} opener
 * @param {String}      name   of the submodule
 * @param {String}      from   commit rebasing from
 * @param {String}      onto   commit rebasing onto
 * @return {Object}
 * @return {Object}       return.commits  map from original to created commit
 * @return {Strring|null} return.conflictedCommit  sha of conflicted commit
 */
const rebaseSubmodule = co.wrap(function *(opener, name, from, onto) {
    const fetcher = yield opener.fetcher();
    const repo = yield opener.getSubrepo(name);
    yield fetcher.fetchSha(repo, name, from);
    yield fetcher.fetchSha(repo, name, onto);
    const fromCommit = yield repo.getCommit(from);
    yield NodeGit.Reset.reset(repo, fromCommit, NodeGit.Reset.TYPE.HARD);
    const head = yield repo.head();
    const fromAnnotated = yield NodeGit.AnnotatedCommit.fromRef(repo, head);
    const ontoCommitId = NodeGit.Oid.fromString(onto);
    const ontoAnnotated =
                    yield NodeGit.AnnotatedCommit.lookup(repo, ontoCommitId);
    const rebase = yield NodeGit.Rebase.init(repo,
                                             fromAnnotated,
                                             ontoAnnotated,
                                             null,
                                             null);
    console.log(`Submodule ${colors.blue(name)}: starting \
rebase; rewinding to ${colors.green(ontoCommitId.tostrS())}.`);
    const op = yield exports.callNext(rebase);
    return yield exports.processRebase(repo, rebase, op);
});

/**
 * Process the specified `entry` from the specified `index`  for the specified
 * `metaRepo` during a rebase from the specified `fromCommit` on the specified
 * `ontoCommit`.  Use the specified `opener` to open submodules as needed.
 * Return an object indicating that an error occurred, that a submodule needs
 * to be rebased, or neither.
 *
 * @return {Object}
 * @return {String|null} return.error
 * @return {String|null} return.subToRebase
 * @return {String|undefined} return.rebaseFrom  only if `subToRebase !== null`
 */
const processMetaRebaseEntry = co.wrap(function *(metaRepo,
                                                  index,
                                                  entry,
                                                  opener,
                                                  fromCommit,
                                                  ontoCommit) {

    const id = entry.id;
    const isSubmodule = entry.mode === NodeGit.TreeEntry.FILEMODE.COMMIT;
    const fetcher = yield opener.fetcher();
    const stage = NodeGit.Index.entryStage(entry);

    const result = {
        error: null,
        subToRebase: null,
    };

    switch (stage) {
    case RepoStatus.STAGE.NORMAL:
        // If this is an unchanged, visible sub, make sure its sha is in the
        // right place in case it was ffwded.

        const open = yield opener.isOpen(entry.path);
        if (open) {
            const name = entry.path;
            const fromSha = id.tostrS();
            const subRepo = yield opener.getSubrepo(name);
            const subHead = yield subRepo.getHeadCommit();
            if (subHead.id().tostrS() !== fromSha) {
                yield fetcher.fetchSha(subRepo, name, fromSha);
                yield setHead(subRepo, fromSha);
            }
        }
        break;
    case RepoStatus.STAGE.OURS:
        if (isSubmodule) {
            result.subToRebase = entry.path;
            result.rebaseFrom = id.tostrS();
        }
        else {
            if (SubmoduleConfigUtil.modulesFileName === entry.path) {
                const succeeded = yield SubmoduleUtil.mergeModulesFile(
                                                                   metaRepo,
                                                                   fromCommit,
                                                                   ontoCommit);
                if (succeeded) {
                    yield index.addByPath(SubmoduleConfigUtil.modulesFileName);
                    break;                                             // BREAK
                }
            }
            result.error =
                `There is a conflict in ${colors.red(entry.path)}.\n`;
        }
        break;
    }
    return result;
});

/**
 * Close the submodules opened by the specified `opener` that have no entry in
 * the specified `subCommits` map or the specified `conflicted` set.
 *
 * @param {Open.Opener} opener
 * @param {Object}      subCommits   sub name to commit map
 * @param {Set}         conflicted   name of subs with conflicts.
 */
const closeAutoOpenedSubmodules = co.wrap(function *(opener,
                                                     subCommits,
                                                     conflicted) {
    const repo = opener.repo;
    const opened = yield opener.getOpenedSubs();
    yield opened.map(co.wrap(function *(name) {
        const commits = subCommits[name];
        if ((undefined === commits || 0 === Object.keys(commits).length) &&
            !conflicted.has(name)) {
            console.log(`Closing ${colors.green(name)} -- no commit created.`);
            yield DeinitUtil.deinit(repo, name);
        }
    }));
});

/**
 * Process the specified `op` for the specified `rebase` in the specified
 * `metaRepo` that maps to the specified `ontoCommit`.  Load the generated
 * commits into the specified `result`.
 *
 * @param {NodeGit.Repository}      metaRepo
 * @param {NodeGit.Commit}          ontoCommit
 * @param {NodeGit.Rebase}          rebase
 * @param {NodeGit.RebaseOperation} op
 * @param {Object}                  result
 * @param {Object}                  result.submoduleCommits
 * @param {Object}                  result.metaCommits
 */
const processMetaRebaseOp = co.wrap(function *(metaRepo,
                                               ontoCommit,
                                               rebase,
                                               op,
                                               result) {
    // We're going to loop over the entries of the index for the rebase
    // operation.  We have several tasks (I'll repeat later):
    //
    // 1. Stage "normal", un-conflicted, non-submodule changes.  This
    //    process requires that we set the submodule to the correct commit.
    // 2. When a conflict is detected in a submodule, call `init` on the
    //    rebaser for that submodule.
    // 3. Pass any change in a submodule off to the appropriate submodule
    //    rebaser.

    const fromCommit = yield metaRepo.getCommit(op.id());
    const urls = yield SubmoduleConfigUtil.getSubmodulesFromCommit(
                                                                metaRepo,
                                                                fromCommit);
    const names = Object.keys(urls);
    const ontoShas = yield SubmoduleUtil.getSubmoduleShasForCommit(
                                                                metaRepo,
                                                                names,
                                                                fromCommit);
    const opener = new Open.Opener(metaRepo, fromCommit);

    const index = yield metaRepo.index();
    const subsToRebase = {}; // map from name to sha to rebase onto

    let errorMessage = "";

    const entries = index.entries();
    for (let i = 0; i < entries.length; ++i) {
        const ret = yield processMetaRebaseEntry(metaRepo,
                                                 index,
                                                 entries[i],
                                                 opener,
                                                 fromCommit,
                                                 ontoCommit);
        if (null !== ret.error) {
            errorMessage += ret.error + "\n";
        }
        else if (null !== ret.subToRebase) {
            subsToRebase[ret.subToRebase] = ret.rebaseFrom;
        }
    }

    // Clean up conflicts unless we found one in the meta-repo that was not
    // a submodule change.

    if ("" === errorMessage) {
        yield index.conflictCleanup();
    }

    const conflicted = new Set();

    // Process submodule rebases.

    for (let name in subsToRebase) {
        const from = subsToRebase[name];
        const ret = yield rebaseSubmodule(opener,
                                          name,
                                          ontoShas[name],
                                          from);
        yield index.addByPath(name);
        if (name in result.submoduleCommits) {
            Object.assign(result.submoduleCommits[name], ret.commits);
        }
        else {
            result.submoduleCommits[name] = ret.commits;
        }

        if (null !== ret.conflictedCommit) {
            errorMessage += subConflictErrorMessage(name) + "\n";
            conflicted.add(name);
        }
    }

    yield closeAutoOpenedSubmodules(opener,
                                    result.submoduleCommits,
                                    conflicted);

    if ("" !== errorMessage) {
        throw new UserError(errorMessage);
    }

    // Write the index and new commit, recording a mapping from the
    // original commit ID to the new one.

    yield index.write();
    const newCommit = yield SubmoduleUtil.cacheSubmodules(metaRepo, () => {
        const signature = metaRepo.defaultSignature();
        const commit = rebase.commit(null, signature, null);
        return Promise.resolve(commit);
    });
    const newCommitSha = newCommit.tostrS();
    const originalSha = op.id().tostrS();
    if (originalSha !== newCommitSha) {
        result.metaCommits[newCommitSha] = originalSha;
    }
});

/**
 * Drive a rebase operation in the specified `metaRepo` from the specified
 * `fromCommit` to the specified `ontoCommit`.  Call the specified
 * `initializer` to set up the rebase initially.
 *
 * Essentially, this function factors out the core rebase logic to be shared
 * between normal rebase and continued rebases.
 *
 * @param {NodeGit.Repository}                                metaRepo
 * @param {(openSubs, getSubmoduleRebaser) => NodeGit.Rebase} initializer
 * @param {NodeGit.Commit}                                    fromCommit
 * @param {NodeGit.Commit}                                    ontoCommit
 */
const driveRebase = co.wrap(function *(metaRepo,
                                       initializer,
                                       fromCommit,
                                       ontoCommit) {
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.isFunction(initializer);
    assert.instanceOf(fromCommit, NodeGit.Commit);
    assert.instanceOf(ontoCommit, NodeGit.Commit);

    const init = yield initializer(metaRepo);
    const rebase  = init.rebase;
    const result = {
        metaCommits: {},
        submoduleCommits: init.submoduleCommits,
    };

    // Now, iterate over the rebase commits.  We pull the operation out into a
    // separate function to avoid problems associated with creating functions
    // in loops.

    let idx = rebase.operationCurrent();
    const total = rebase.operationEntrycount();
    function makeCallNext() {
        return exports.callNext(rebase);
    }
    while (idx < total) {
        const rebaseOper = rebase.operationByIndex(idx);
        console.log(`Applying ${colors.green(rebaseOper.id().tostrS())}.`);
        yield processMetaRebaseOp(metaRepo,
                                  ontoCommit,
                                  rebase,
                                  rebaseOper,
                                  result);
        yield SubmoduleUtil.cacheSubmodules(metaRepo, makeCallNext);
        ++idx;
    }

    // If this was a fast-forward rebase, we need to set the heads of the
    // submodules correctly.

    const wasFF = yield NodeGit.Graph.descendantOf(metaRepo,
                                                    ontoCommit.id(),
                                                    fromCommit.id());
    if (wasFF) {
        const opener = new Open.Opener(metaRepo, ontoCommit);
        const fetcher = yield opener.fetcher();
        const openSubs = Array.from(yield opener.getOpenSubs());
        const shas = yield SubmoduleUtil.getSubmoduleShasForCommit(metaRepo,
                                                                   openSubs,
                                                                   ontoCommit);
        const fetchOpened = co.wrap(function *(name) {
            const subRepo = yield opener.getSubrepo(name);
            const head = yield subRepo.head();
            const sha = shas[name];
            if (head.target().tostrS() !== sha) {
                yield fetcher.fetchSha(subRepo, name, sha);
                yield setHead(subRepo, sha);
            }
        });
        yield DoWorkQueue.doInParallel(openSubs, fetchOpened);
    }

    yield callFinish(metaRepo, rebase);
    return result;
});

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
 * @return {Object} [return]
 * @return {Object} return.metaCommits      maps from new to rebased commits
 * @return {Object} return.submoduleCommits maps from submodule name to
 *                                          a map from new to rebased commits
 */
exports.rebase = co.wrap(function *(metaRepo, commit) {
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    // It's important to note that we will be rebasing the sub-repos on top of
    // commits identified in the meta-repo, not those from their upstream
    // branches.  Main steps:

    // 1. Check to see if meta-repo is up-to-date; if it is we can exit.
    // 2. Start the rebase operation in the meta-repo.
    // 3. When we encounter a conflict with a submodules, this indicates that
    //    we need to perform a rebase on that submodule as well.  This
    //    operation is complicated by the need to sync meta-repo commits with
    //    commits to the submodules, which may or may not be one-to-one.

    let currentBranchName = "HEAD";
    try {
        const currentBranch = yield metaRepo.getCurrentBranch();
        currentBranchName = currentBranch.name();
    }
    catch (e) {
    }

    const currentBranch = yield metaRepo.getBranch(currentBranchName);
    const fromCommitId = currentBranch.target();
    const fromCommit = yield metaRepo.getCommit(fromCommitId);
    const commitId = commit.id();

    // First, see if 'commit' already exists in the current history.  If so, we
    // can exit immediately.

    if (yield GitUtil.isUpToDate(metaRepo,
                                 fromCommitId.tostrS(),
                                 commitId.tostrS())) {
        console.log(`${colors.green(currentBranch.shorthand())} is \
up-to-date.`);
        return {
            metaCommits: {},
            submoduleCommits: {},
        };
    }

    const initialize = co.wrap(function *() {
        const fromAnnotedCommit =
                yield NodeGit.AnnotatedCommit.fromRef(metaRepo, currentBranch);
        const ontoAnnotatedCommit =
                      yield NodeGit.AnnotatedCommit.lookup(metaRepo, commitId);
        return yield SubmoduleUtil.cacheSubmodules(metaRepo,
                                                   co.wrap(function *() {
            const rebase = yield NodeGit.Rebase.init(metaRepo,
                                                     fromAnnotedCommit,
                                                     ontoAnnotatedCommit,
                                                     null,
                                                     null);
            console.log(`Rewinding to ${colors.green(commitId.tostrS())}.`);
            yield exports.callNext(rebase);
            return {
                rebase: rebase,
                submoduleCommits: {},
            };
        }));
    });
    const result = yield driveRebase(metaRepo, initialize, fromCommit, commit);

    // Run post-rewrite hook with "rebase" as args, means rebase command
    // invoked this hook.

    console.log("Finished rebase.");
    yield Hook.execHook("post-rewrite", ["rebase"]);
    return result;
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

    yield SubmoduleUtil.cacheSubmodules(repo, co.wrap(function*() {
        const rebase = yield NodeGit.Rebase.open(repo);
        rebase.abort();
    }));

    const head = yield repo.head();
    console.log(`Set HEAD back to ${colors.green(head.target().tostrS())}.`);

    // This is a little "heavy-handed'.  TODO: abort active rebases in only
    // those open submodueles whose rebases are associated with the one in the
    // meta-repo.  It's possible (though unlikely) that the user could have an
    // independent rebase going in an open submodules.

    const openSubs = yield SubmoduleUtil.listOpenSubmodules(repo);
    yield openSubs.map(co.wrap(function *(name) {
        const subRepo = yield SubmoduleUtil.getRepo(repo, name);
        if (!subRepo.isRebasing()) {
            return;                                                   // RETURN
        }
        const rebaseInfo = yield RebaseFileUtil.readRebase(subRepo.path());
        const subRebase = yield NodeGit.Rebase.open(subRepo);
        subRebase.abort();
        console.log(`Submodule ${colors.blue(name)}: reset to \
${colors.green(rebaseInfo.originalHead)}.`);
    }));
});

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

/**
 * Continue rebases in the submodules in the specifed `repo` having the
 * `index and `status`.  If staged changes are found in submodules that don't
 * have in-progress rebases, commit them using the specified message and
 * signature from the specified original `commit`.  Return an object describing
 * any commits that were generated along with an error message if any continues
 * failed.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Index}      index
 * @param {RepoStatus}         status
 * @param {NodeGit.Commit}     commit
 * @return {Object}
 * @return {Object} return.commits  map from name to sha map
 * @return {Object} return.newCommits  from name to newly-created commits
 * @return {String|null} return.errorMessage
 */
exports.continueSubmodules = co.wrap(function *(repo, index, status, commit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(index, NodeGit.Index);
    assert.instanceOf(status, RepoStatus);
    assert.instanceOf(commit, NodeGit.Commit);

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
            errorMessage += subConflictErrorMessage(name) + "\n";
        }
        else {
            yield index.addByPath(name);
            yield index.conflictRemove(name);
        }
    });
    yield DoWorkQueue.doInParallel(Object.keys(subs), continueSub);
    return {
        errorMessage: "" === errorMessage ? null : errorMessage,
        commits: commits,
        newCommits: newCommits,
    };
});

/**
 * Continue the rebase in progress on the specified `repo`.
 *
 * @param {NodeGit.Repository} repo
 */
exports.continue = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const status = yield StatusUtil.getRepoStatus(repo);

    const rebaseInfo = status.rebase;
    if (null === rebaseInfo) {
        throw new UserError("Error: no rebase in progress");
    }

    if (status.isConflicted()) {
        throw new UserError("Cannot continue rebase due to conflicts.");
    }

    const fromCommit = yield repo.getCommit(rebaseInfo.originalHead);
    const ontoCommit = yield repo.getCommit(rebaseInfo.onto);

    const initializer = co.wrap(function *(repo) {
        console.log(`Continuing rebase from \
${colors.green(rebaseInfo.originalHead)} onto \
${colors.green(rebaseInfo.onto)}.`);
        const rebase = yield SubmoduleUtil.cacheSubmodules(repo, () => {
            return NodeGit.Rebase.open(repo);
        });
        const index = yield repo.index();
        const idx = rebase.operationCurrent();
        const op = rebase.operationByIndex(idx);
        const baseCommit = yield repo.getCommit(op.id());
        const result = yield exports.continueSubmodules(repo,
                                                        index,
                                                        status,
                                                        baseCommit);
        if (null !== result.errorMessage) {
            throw new UserError(result.errorMessage);
        }
        return {
            rebase: rebase,
            submoduleCommits: result.commits,
        };
    });
    const result =
                  yield driveRebase(repo, initializer, fromCommit, ontoCommit);
    console.log("Finished rebase.");
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
