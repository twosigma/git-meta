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
 * * Neither the name of slim nor the names of its
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

const co      = require("co");
const NodeGit = require("nodegit");

const GitUtil       = require("../slmu/slmu_gitutil");
const Status        = require("../slmu/slmu_status");
const SubmoduleUtil = require("../slmu/slmu_submoduleutil");

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
 * @class {SubmoduleRebaser}
 * This is a mechanism class that maintains the state of a submodule through a
 * rebase operation.
 *
 * @constructor
 * Create a new `SubmoduleRebaser` for the specified `submodule` having the
 * specified `repo`.  If a rebase is started, perform the rebase on the
 * branch having the specified `branchName`.
 *
 * @param {NodeGit.Submodule}  submodule
 * @param {NodeGit.Repository} repo
 * @param {String}             branchName
 */
function SubmoduleRebaser(submodule, repo, branchName) {
    var rebase         = null;   // set to `NodeGit.Rebase` object when started
    var signature      = null;   // lazily set when needed
    var finishedRebase = false;  // true if the rebase was finished

    /**
     * Begin a rebase for this submodule from the current branch onto the
     * specified `remoteCommitId`.  If a rebase is in progress do nothing.
     *
     * @async
     * @private
     * @param {NodeGit.Oid} remoteCommitId
     */
    const init = co.wrap(function *(remoteCommitId) {
        if (null !== rebase) {
            return;                                                   // RETURN
        }
        const branch = yield repo.getBranch(branchName);
        const localAnnotated =
                           yield NodeGit.AnnotatedCommit.fromRef(repo, branch);
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
     * @param {NodeGit.Oid} commitId
     */
    const next = co.wrap(function *(commitId) {

        // If there is no rebase happening, just set the repo to the right
        // commit.

        if (null === rebase) {
            const subCommit = yield NodeGit.Commit.lookup(repo, commitId);
            yield repo.checkoutBranch(branchName);
            yield NodeGit.Reset.reset(repo,
                                      subCommit,
                                      NodeGit.Reset.TYPE.HARD);
            return true;                                              // RETURN
        }
        const oper = yield callNext(rebase);
        if (null === oper) {
            rebase.finish();
            finishedRebase = true;
            return true;                                              // RETURN
        }
        const index = yield repo.openIndex();
        if (index.hasConflicts()) {
            console.error("The sub-repo '" + submodule.name() +
                          `' has conflicts.  Please resolve and stage them
then run 'rebase --continue'.`);
            return false;                                             // RETURN
        }
        const entries = index.entries();
        var changed = false;
        entries.forEach(x => {
            index.addByPath(x.path);
            changed = true;
        });
        if (changed) {
            index.write();
            if (null === signature) {
                signature = repo.defaultSignature();
            }
            rebase.commit(null, signature, null);
        }

        // There may be more than one commit in the submodule corresponding to
        // a single commit in the meta-repo.  If the commit on the current
        // operation is not 'commitId', call 'next' again.

        if (oper.id().equal(commitId)) {
            return true;
        }

        return yield callNext(commitId);
    });

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

    function path() {
        return submodule.name();
    }

    return {
        init: init,
        next: next,
        finish: finish,
        path: path,
    };
}


/**
 * Fail and log if the specified `metaRepo` or any of the specefied
 * `submodules` cannot be pulled.  A repository cannot be pulled if:
 *
 * - it has unstaged changes
 * - it has staged, uncommitted changes
 * - it does not have a remote with the specified `remoteName`
 *
 * @private
 * @async
 * @param {NodeGit.Repository} repo
 * @param {Object}             submodules
 * @param {NodeGit.Submodules} submodules.submodule
 * @param {NodeGit.Repository} submodules.repo
 * @param {String}             remoteName
 */
const validateRepos = co.wrap(function *(metaRepo, submodules, remoteName) {

    var allGood = true;
    const checker = co.wrap(function *(repo, description) {

        const validRemote = yield GitUtil.isValidRemoteName(repo, remoteName);
        if (!validRemote) {
            allGood = false;
            console.error(description + " does not have a remote named '" +
                          remoteName + "'.");
        }
    });
    var checkers = submodules.map(sub => {
        const name = sub.submodule.path();
        checker(sub.repo, "The sub-repo '" + name + "'");
    });
    checkers.push(checker(metaRepo, "The meta-repo"));
    yield checkers;
    if (!allGood) {
        process.exit(-1);
    }
});

/**
 * Return a map from submodule name to `SubmoduleRebaser` object for the
 * submodules in the specified `metaRepo`.
 *
 * @param {NodeGit.Repository} repo
 * @return Object
 */
const getSubmoduleRebasers = co.wrap(function *(metaRepo) {

    const branch = yield metaRepo.getCurrentBranch();
    const branchName = branch.shorthand();


    const submoduleRepos = yield SubmoduleUtil.getSubmoduleRepos(metaRepo);

    var result = {};

    submoduleRepos.forEach(sub => {
        const rebaser =
                     new SubmoduleRebaser(sub.submodule, sub.repo, branchName);
        result[sub.submodule.name()] = rebaser;
    });
    return result;
});

/**
 * Run the remaining rebase operations on the specified `rebase` for the
 * specified `metaRepo` handing submodule changes with the specified
 * `submoduleRebasers`.  Sign commits to the meta-repo with the specified
 * `signature`.
 *
 * @private
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {SubmoduleRebaser}   submoduleRebasers
 * @param {NodeGit.Rebase}     rebase
 * @param {NodeGit.Signature}  signature
 */
const runRebase =
    co.wrap(function *(metaRepo, submoduleRebasers, rebase, signature) {

    const rebaseOper = yield callNext(rebase);

    // IF the call to `callNext` returns null, there are no more rebase
    // operations to perform.  We need to give the submodules a chance to
    // finish then call `finish` on the `rebase` object.

    if (null === rebaseOper) {
        var submoduleFinishers = [];
        for (var s in submoduleRebasers) {
            var rebaser = submoduleRebasers[s];
            submoduleFinishers.push(rebaser.finish());
        }
        yield submoduleFinishers;
        rebase.finish();
        return;                                                       // RETURN
    }

    // We're going to loop over the entries of the index for the rebase
    // operation.  We have several tasks (I'll repeat later):
    //
    // 1. Stage "normal", un-conflicted, non-submodule changes.  This process
    //    requires that we set the submodule to the correct commit.
    // 2. When a conflict is detected in a submodule, call `init` on the
    //    rebaser for that submodule.
    // 3. Pass any change in a submodule off to the appropriate submodule
    //    rebaser.

    const index = yield metaRepo.openIndex();
    var inits = [];  // `init` operations to run
    var nexts = [];  // rebaser and id to run `next` on in parallel

    function addNext(rebaser, id) {
        nexts.push({rebaser: rebaser, id: id});
    }

    var allGood = true;

    index.entries().forEach(function (e) {
       const id = NodeGit.Oid.fromString(e.id.tostrS());

       // From libgit2 index.h.  This information is not documented in
       // the nodegit or libgit2 documentation.

       const stage = Status.getStage(e.flags);
       switch (stage) {
       case Status.STAGE.NORMAL:
           const normalPath = e.path;
           const normalRebaser = submoduleRebasers[normalPath];
           if (undefined !== normalRebaser) {
               addNext(normalRebaser, id);
           }
           else {
               index.addByPath(e.path);
           }
           break;
       case Status.STAGE.OURS:
           const initRebaser = submoduleRebasers[e.path];
           if (undefined !== initRebaser) {

               // This case is an indication that we have a conflict with an
               // upstream commit.  Initialize a rebase for the affected
               // submodule, letting it know the id of the upstream commit onto
               // which it should rebase.  The `Entry` that comes with the
               // stage set to GIT_INDEX_STAGE_THEIRS will contain the id of
               // the commit that we are rebasing FROM.

               inits.push(initRebaser.init(id));
           }
           else {
               allGood = false;
               console.error("'" + e.path + `' is conflicted in the
meta-repo.  Please resolve, stage, and run 'rebase --continue'.`);
            }
            break;
        case Status.STAGE.THEIRS:
            const theirPath = e.path;
            const theirRebaser = submoduleRebasers[theirPath];
            if (undefined !== theirRebaser) {

                // Found the part of a conflict that corresponds to the
                // branch we're rebasing from.  Need to schedule a call
                // to the `SubmoduleRebaser.next` method to process the
                // commit.

                addNext(theirRebaser, id);
            }
        break;
        default:
        }
    });

    // Clean up conflicts unless we found one in the meta-repo that was not
    // a submodule change.

    if (allGood) {
        index.conflictCleanup();
    }

    // Initiate scheduled rebases.

    yield inits;

    // Process next commits for all submodule rebases.

    const doNext = co.wrap(function *(rebaser, id) {
        const result = yield rebaser.next(id);
        if (result) {
            index.addByPath(rebaser.path());
        }
        else {
            allGood = false;
        }
    });
    const runNexts = nexts.map(next => doNext(next.rebaser, next.id));
    yield runNexts;

    if (!allGood) {
        process.exit(-1);
    }

    index.write();
    rebase.commit(null, signature, null);

    // Recurse.

    yield runRebase(metaRepo, submoduleRebasers, rebase, signature);
});

/**
 * Pull the specified `source` branch from the remote having the specified
 * `remoteName` into the specified `metaRepo`.  If the specified `any` is true,
 * attempt to pull from all repositories that do not have local changes.
 * Otherwise, fail if any visible repositories or the meta repository has
 * uncommitted changes.
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {Boolean}            any
 * @param {String}             remoteName
 * @param {String}             source
 */
exports.pull = co.wrap(function *(metaRepo, remoteName, source) {
    // It's important to note that we will be rebasing the sub-repos on top of
    // commits identified in the meta-repo, not those from their upstream
    // branches.  When we implement the `rebase` command we can probably
    // refactor most of this code out.  Main steps:
    //
    // 1. Validate that no repos have local modifications and that they all
    //    have the remote with the name `remoteName`.
    // 2. Check to see if meta-repo is up-to-date; if it is we can exit.
    // 3. Start the rebase operation in the meta-repo.
    // 4. When we encounter a conflict with a submodules, this indicates that
    //    we need to perform a rebase on that submodule as well.  This
    //    operation is complicated by the need to sync meta-repo commits with
    //    commits to the submodules, which may or may not be one-to-one.
    //
    // TODO: account for submodule creation and removal.

    // First do some sanity checking on the repos to see if they have a remote
    // with `remoteName` and are clean.

    yield Status.ensureCleanAndConsistent(metaRepo);

    const submodules = yield SubmoduleUtil.getSubmoduleRepos(metaRepo);
    yield validateRepos(metaRepo, submodules, remoteName);

    // Next, fetch the meta-repo and check to see if it needs to be rebased.

    yield GitUtil.fetch(metaRepo, remoteName);
    const remoteBranch = yield GitUtil.findRemoteBranch(metaRepo,
                                                        remoteName,
                                                        source);
    if (null === remoteBranch) {
        console.error("The meta-repo does not have a branch named '" +
                      source + "' in the remote '" + remoteName + "'.");
        process.exit(-1);
    }
    const localBranch = yield metaRepo.getCurrentBranch();
    const remoteCommitId = remoteBranch.target();
    const localCommitId = localBranch.target();

    // First, see if there are any changes upstream that haven't been
    // incorporated.  If not, we can exit immediately.

    const isFF =
             yield GitUtil.isAncestor(metaRepo, localCommitId, remoteCommitId);
    if (isFF) {
        console.log("'" + localBranch.shorthand() + "' is up to date with '" +
                    remoteBranch.shorthand() + "'.");
        return;                                                       // RETURN
    }

    // This operation is complicated by poor documentation in nodegit and
    // libgit2, not to mention poor support for submodules in Git in general.
    // I'll try to call out workarounds as needed.
    //
    // One of the things overall that seem to confound rebasing with merges is
    // that having a submodule pointing to a different commit than what is
    // indicated in the meta-repo makes the rebase/merge/index system think
    // that there are unstged changes in the working directory.  A lot of the
    // extra work we have to do is in pointing the HEAD commits of the
    // submodules to the commits that we expect.

    const submoduleRebasers =
                 yield getSubmoduleRebasers(metaRepo, localBranch.shorthand());

    // Kick off the rebase; it wants to operate on "annotated" commits for some
    // reason.

    const localAnnotedCommit =
                  yield NodeGit.AnnotatedCommit.fromRef(metaRepo, localBranch);
    const remoteAnnotedCommit =
                 yield NodeGit.AnnotatedCommit.fromRef(metaRepo, remoteBranch);
    var rebase = yield NodeGit.Rebase.init(metaRepo,
                                           localAnnotedCommit,
                                           remoteAnnotedCommit,
                                           null,
                                           null);

    // !!! First workaround: You have to call `Rebase.next` after `Rebase.init`
    // to kick off the rebase, at least once.  However, if there is a change in
    // a submodule, the first call to `next` results in an error about losing
    // commits.  I think the source of this problem is that immediately after
    // the call to `init`, the working directory appears to be dirty due to the
    // fact that the onto commit of the rebase indicates a different commit
    // than the one that the submodule points to (rebase doesn't change the
    // HEADs of the submodules).  Solution: sync the submodules after calling
    // `init`.  I've opened:
    // https://github.com/libgit2/libgit2.github.com/issues/59 with the libgit2
    // people.

    yield SubmoduleUtil.syncSubmodules(metaRepo, remoteName);

    // We'll need this signature every time we make a rebase commit.

    const signature = metaRepo.defaultSignature();

    yield runRebase(metaRepo, submoduleRebasers, rebase, signature);
});
