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
const fs      = require("fs-promise");
const NodeGit = require("nodegit");
const path    = require("path");
const rimraf  = require("rimraf");

const Open                = require("./open");
const GitUtil             = require("./git_util");
const RepoStatus          = require("./repo_status");
const RebaseFileUtil      = require("./rebase_file_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const SubmoduleFetcher    = require("./submodule_fetcher");
const SubmoduleUtil       = require("./submodule_util");
const UserError           = require("./user_error");

/**
 * Return a messsage indicating a conflict in the submodule having the
 * specified `name`.
 *
 * @param {String} name
 * @return {String}
 */
function submoduleConflictMessage(name) {
    return `
Conflict rebasing the submodule ${colors.red(name)}.`;
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
 * @class {SubmoduleRebaser}
 * This is a mechanism class that maintains the state of a submodule through a
 * rebase operation.
 *
 * @constructor
 * Create a new `SubmoduleRebaser` for the specified `submodule` having the
 * specified `repo`.  Record commits (from new to old) in the specified
 * `submoduleCommits` map.
 *
 * @param {String}             submoduleName
 * @param {NodeGit.Repository} repo
 * @param {Object}             submoduleCommits writable
 * @param {SubmoduleFetcher}   fetcher
 */
function SubmoduleRebaser(submoduleName, repo, submoduleCommits, getFetcher) {
    assert.isString(submoduleName);
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isObject(submoduleCommits);
    assert.isFunction(getFetcher);

    const commits = {};
    const signature = repo.defaultSignature();
    submoduleCommits[submoduleName] = commits;

    let rebase         = null;   // set to `NodeGit.Rebase` object when started
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
        const fetcher = getFetcher();
        yield fetcher.fetchSha(repo, submoduleName, remoteCommitSha);
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
        console.log(`Submodule ${colors.blue(submoduleName)}: starting \
rebase; rewinding to ${colors.green(remoteCommitId.tostrS())}.`);
    });

    /**
     * Process the specified rebase `oper` on the specified `commitSha`;
     * staging changed files and creating commits.
     */
    const processOper = co.wrap(function *(commitSha, oper) {
        console.log(`Submodule ${colors.blue(submoduleName)}: applying \
commit ${colors.green(oper.id().tostrS())}.`);
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
            const newCommit = rebase.commit(null, signature, null);
            const originalCommit = oper.id().tostrS();
            commits[newCommit.tostrS()] = originalCommit;
        }
        return true;
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
            console.log(`Submodule ${colors.blue(submoduleName)}: setting \
head to ${colors.green(commitSha)}.`);
            yield setHead(repo, commitSha);
            return true;                                              // RETURN
        }
        const oper = yield callNext(rebase);
        if (null === oper) {
            console.log(`Submodule ${colors.blue(submoduleName)}: finished \
rebase.`);
            yield callFinish(repo, rebase);
            finishedRebase = true;
            return true;                                              // RETURN
        }
        const result = yield processOper(commitSha, oper);
        if (!result) {
            return false;                                             // RETURN
        }

        return yield next(commitSha);
    });

    const continueRebase = co.wrap(function *(curSha, index) {
        if (!repo.isRebasing()) {
            return;                                                   // RETURN
        }
        const subInfo = yield RebaseFileUtil.readRebase(repo.path());
        console.log(`Submodule ${colors.blue(submoduleName)} continuing \
rebase from ${colors.green(subInfo.originalHead)} onto \
${colors.green(subInfo.onto)}.`);
        rebase = yield NodeGit.Rebase.open(repo);
        const idx = rebase.operationCurrent();
        const oper = rebase.operationByIndex(idx);
        const result = yield processOper(curSha, oper);
        if (!result) {
            return false;                                             // RETURN
        }
        yield index.addByPath(submoduleName);
        return yield next(curSha);
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
        continueRebase: continueRebase,
        path: path,
        repo: repo,
    };
}

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

    const result = {
        metaCommits: {},
        submoduleCommits: {},
    };

    const submoduleRebasers = {};  // Cache of opened submodules
    const subs = yield SubmoduleUtil.getSubmodulesForCommit(metaRepo,
                                                            fromCommit);

    const openSubs = yield SubmoduleUtil.listOpenSubmodules(metaRepo);
    const visibleSubs = new Set(openSubs);

    let currentCommit;    // Current NodeGit.Commit being applied
    let fetcher;          // Set to a SubmoduleFetcher bound to currentCommit

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

        if (!(path in subs)) {
            return null;                                              // RETURN
        }

        const promise = co(function *() {
            let repo;
            const submodule = subs[path];
            // Open the submodule if it's not open.

            if (visibleSubs.has(path)) {
                visibleSubs.add(path);
                repo = yield SubmoduleUtil.getRepo(metaRepo, path);
            }
            else { 
                console.log(`Submodule ${colors.blue(path)}: opening`);
                repo = yield Open.openOnCommit(fetcher, path, submodule.sha);
            }
            return new SubmoduleRebaser(path,
                                        repo,
                                        result.submoduleCommits,
                                        () => fetcher);
        });

        submoduleRebasers[path] = promise;
        return yield promise;
    });

    const rebase  = yield initializer(openSubs, getSubmoduleRebaser);
    const signature  = metaRepo.defaultSignature();

    let mergeBase = null; // Will load merge-base into this if needed.

    const getMergeBase = co.wrap(function *() {
        if (null !== mergeBase) {
            return mergeBase;                                         // RETURN
        }
        const baseId = yield NodeGit.Merge.base(metaRepo,
                                                currentCommit.id(),
                                                ontoCommit.id());
        mergeBase = yield metaRepo.getCommit(baseId);
        return mergeBase;
    });
 
    let baseSubmodules = null;  // state of submodules at merge-base
    const getMergeBaseSubs = co.wrap(function *() {
        if (null !== baseSubmodules) {
            return baseSubmodules;                                    // RETURN
        }
        const base = yield getMergeBase();
        baseSubmodules =
              yield SubmoduleConfigUtil.getSubmodulesFromCommit(metaRepo, base);
        return baseSubmodules;
    });

    let ontoSubmodules = null;  // state of subs in commit rebasing onto
    const getOntoSubs = co.wrap(function *() {
        if (null !== ontoSubmodules) {
            return ontoSubmodules;                                    // RETURN
        }
        ontoSubmodules = yield SubmoduleConfigUtil.getSubmodulesFromCommit(
                                                                    metaRepo,
                                                                    ontoCommit);
        return ontoSubmodules;
    });

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
                    if (SubmoduleConfigUtil.modulesFileName === e.path) {

                        // If there is a conflict in the '.gitmodules' file,
                        // attempt to resolve it by comparing the current
                        // change against the original onto commit and the
                        // merge base between the base and onto commits.

                        const Conf = SubmoduleConfigUtil;
                        const getSubs = Conf.getSubmodulesFromCommit;
                        const fromNext = yield getSubs(metaRepo,
                                                       currentCommit);
                        const fromBase = yield getMergeBaseSubs();
                        const fromOnto = yield getOntoSubs();
                        const merged = Conf.mergeSubmoduleConfigs(fromNext,
                                                                  fromOnto,
                                                                  fromBase);
                        // If it was resolved, write out and stage the new
                        // modules state.

                        if (null !== merged) {
                            const newConf = Conf.writeConfigText(merged);
                            yield fs.writeFile(path.join(metaRepo.workdir(),
                                                         Conf.modulesFileName),
                                               newConf);
                            yield index.addByPath(e.path);
                            break;
                        }
                    }
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
                errorMessage += submoduleConflictMessage(rebaser.path());
            }
        }));

        if ("" !== errorMessage) {
            throw new UserError(errorMessage);
        }

        // Write the index and new commit, recording a mapping from the
        // original commit ID to the new one.

        yield index.write();
        const newCommit = rebase.commit(null, signature, null);
        const newCommitSha = newCommit.tostrS();
        const originalSha = rebaseOper.id().tostrS();
        if (originalSha !== newCommitSha) {
            result.metaCommits[newCommitSha] = originalSha;
        }
    });

    let idx = rebase.operationCurrent();
    const total = rebase.operationEntrycount();
    while (idx < total) {
        const rebaseOper = rebase.operationByIndex(idx);
        console.log(`Applying ${colors.green(rebaseOper.id().tostrS())}.`);
        currentCommit = yield metaRepo.getCommit(rebaseOper.id());
        fetcher = new SubmoduleFetcher(metaRepo, currentCommit);
        yield processRebase(rebaseOper);
        yield callNext(rebase);
        ++idx;
    }

    // After the main rebase completes, we need to give the submodules a chance
    // to finish then call `finish` on the `rebase` object.

    yield Object.keys(submoduleRebasers).map(co.wrap(function *(name) {
        const rebaser = yield submoduleRebasers[name];
        yield rebaser.finish();
    }));

    // If this was a fast-forward rebase, we need to set the heads of the
    // submodules correctly.

    const wasFF = undefined === currentCommit ||
                  (yield NodeGit.Graph.descendantOf(metaRepo,
                                                    ontoCommit.id(),
                                                    currentCommit.id()));
    if (wasFF) {
        fetcher = new SubmoduleFetcher(metaRepo, ontoCommit);
        const shas = yield SubmoduleUtil.getSubmoduleShasForCommit(metaRepo,
                                                                   openSubs,
                                                                   ontoCommit);
        yield openSubs.map(co.wrap(function *(name) {
            const sha = shas[name];
            if (sha !== subs[name].sha) {
                const subRepo = yield SubmoduleUtil.getRepo(metaRepo, name);
                yield fetcher.fetchSha(subRepo, name, sha);
                yield setHead(subRepo, sha);
            }
        }));
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
        const rebase = yield NodeGit.Rebase.init(metaRepo,
                                                 fromAnnotedCommit,
                                                 ontoAnnotatedCommit,
                                                 null,
                                                 null);
        console.log(`Rewinding to ${colors.green(commitId.tostrS())}.`);
        yield callNext(rebase);
        return rebase;
    });
    return yield driveRebase(metaRepo, initialize, fromCommit, commit);
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

    const rebase = yield NodeGit.Rebase.open(repo);
    rebase.abort();

    const head = yield repo.head();
    console.log(`Set HEAD back to ${colors.green(head.target().tostrS())}.`);

    // This is a little "heavy-handed'.  TODO: abort active rebases in only
    // those open submodueles whose rebases are associated with the one in the
    // meta-repo.  It's possible (though unlikely) that the user could have an
    // independent rebase going in an open submodules.

    const openSubs = yield SubmoduleUtil.listOpenSubmodules(repo);
    yield openSubs.map(co.wrap(function *(name) {
        // TODO: Using `NodeGit.Rebase.abort` to abort rebases in a submodule
        // causes them to become corrupt.  See:
        // https://github.com/twosigma/git-meta/issues/151.  Will work around
        // the problem for now.

        const subRepo = yield SubmoduleUtil.getRepo(repo, name);
        if (!subRepo.isRebasing()) {
            return;                                                   // RETURN
        }
        const rebaseInfo = yield RebaseFileUtil.readRebase(subRepo.path());
        yield cleanupRebaseDir(subRepo);
        const originalCommit = yield subRepo.getCommit(
                                                      rebaseInfo.originalHead);
        yield NodeGit.Reset.reset(subRepo,
                                  originalCommit,
                                  NodeGit.Reset.TYPE.HARD);
        const branch = yield GitUtil.findBranch(subRepo, rebaseInfo.headName);
        if (null === branch) {
            subRepo.detachHead();
        }
        else {
            subRepo.setHead(branch.name());
        }
        console.log(`Submodule ${colors.blue(name)}: reset to \
${colors.green(rebaseInfo.originalHead)}.`);
    }));
});

/**
 * Continue the rebase in progress on the specified `repo`.
 *
 * @param {NodeGit.Repository} repo
 */
exports.continue = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const rebaseInfo = yield RebaseFileUtil.readRebase(repo.path());
    if (null === rebaseInfo) {
        throw new UserError("Error: no rebase in progress");
    }
    const fromCommit = yield repo.getCommit(rebaseInfo.originalHead);
    const ontoCommit = yield repo.getCommit(rebaseInfo.onto);

    let errorMessage = "";

    const initializer = co.wrap(function *(openSubs, getSubmoduleRebaser) {
        console.log(`Continuing rebase from \
${colors.green(rebaseInfo.originalHead)} onto \
${colors.green(rebaseInfo.onto)}.`);
        const rebase = yield NodeGit.Rebase.open(repo);
        const curIdx = rebase.operationCurrent();
        const curOper = rebase.operationByIndex(curIdx);
        const curSha = curOper.id().tostrS();
        const index = yield repo.index();
        yield openSubs.map(co.wrap(function *(name) {
            const subRebaser = yield getSubmoduleRebaser(name);
            const result = yield subRebaser.continueRebase(curSha, index);
            if (!result) {
                errorMessage += submoduleConflictMessage(name);
            }
        }));
        if ("" !== errorMessage) {
            throw new UserError(errorMessage);
        }
        return rebase;
    });
    return yield driveRebase(repo, initializer, fromCommit, ontoCommit);
});

