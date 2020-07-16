/*
 * Copyright (c) 2017, Two Sigma Open Source
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

const assert       = require("chai").assert;
const ChildProcess = require("child-process-promise");
const co           = require("co");
const colors       = require("colors");
const NodeGit      = require("nodegit");

const Checkout            = require("./checkout");
const CherryPickUtil      = require("./cherry_pick_util");
const ConfigUtil          = require("./config_util");
const ConflictUtil        = require("./conflict_util");
const DoWorkQueue         = require("./do_work_queue");
const GitUtil             = require("./git_util");
const MergeCommon         = require("./merge_common");
const Open                = require("./open");
const RepoStatus          = require("./repo_status");
const SequencerState      = require("./sequencer_state");
const SequencerStateUtil  = require("./sequencer_state_util");
const SparseCheckoutUtil  = require("./sparse_checkout_util");
const StatusUtil          = require("./status_util");
const SubmoduleChange     = require("./submodule_change");
const SubmoduleFetcher    = require("./submodule_fetcher");
const SubmoduleRebaseUtil = require("./submodule_rebase_util");
const SubmoduleUtil       = require("./submodule_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const UserError           = require("./user_error");

const CommitAndRef    = SequencerState.CommitAndRef;
const Conflict        = ConflictUtil.Conflict;
const ConflictEntry   = ConflictUtil.ConflictEntry;
const FILEMODE        = NodeGit.TreeEntry.FILEMODE;
const MERGE           = SequencerState.TYPE.MERGE;
const MergeContext    = MergeCommon.MergeContext;
const MergeStepResult = MergeCommon.MergeStepResult;
const MODE            = MergeCommon.MODE;
const SUB_OPEN_OPTION = Open.SUB_OPEN_OPTION;

/**
 * If there is a sequencer with a merge in the specified `path` return it,
 * otherwise, return null.
 *
 * @param {String} path
 * @return {String|null}
 */
const getSequencerIfMerge = co.wrap(function *(path) {
    const seq = yield SequencerStateUtil.readSequencerState(path);
    if (null !== seq && MERGE === seq.type) {
        return seq;
    }
    return null;
});

/**
 * If there is a sequencer with a merge in the specified `path` return it,
 * otherwise, throw a `UserError` indicating that there is no merge.
 *
 * @param {String} path
 * @return {String}
 */
const checkForMerge = co.wrap(function *(path) {
    const seq = yield getSequencerIfMerge(path);
    if (null === seq) {
        throw new UserError("No merge in progress.");
    }
    return seq;
});

/**
 * Return a formatted string indicating merge will abort for 
 * irresolvable conflicts.
 * 
 * @param {Object} conflicts map from name to commit causing conflict
 * @return {String} conflict message
 */
const getBareMergeConflictsMessage = function(conflicts) {
    if (0 === Object.keys(conflicts).length) {
        return "";
    }
    let errorMessage = "CONFLICT (content): \n";
    const names = Object.keys(conflicts).sort();
    for (let name of names) {
        const conflict = conflicts[name];
        if (Array.isArray(conflict)) {
            for (const path of conflict) {
                errorMessage += `\tconflicted:  ${name}/${path}\n`;
            }
        } else {
            errorMessage += `Merge conflict in submodule '${name}' itself
(e.g. delete/modify or add/modify)\n`;
        }
    }
    errorMessage += "\nAutomatic merge failed\n";
    return errorMessage;
};


/**
 * Perform a fast-forward merge in the specified `repo` to the
 * specified `commit`. The behavior is undefined unless `commit` 
 * is different from but descendant of the HEAD commit in `repo`.
 *
 * @param {NodeGit.Repository}    repo
 * @param {MergeCommon.MODE}      mode
 * @param {NodeGit.Commit}        commit
 */
exports.fastForwardMerge = co.wrap(function *(repo, commit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);

    // Remember the current branch; the checkoutCommit function will move it.

    const branch = yield repo.getCurrentBranch();

    yield Checkout.checkoutCommit(repo, commit, false);

    // If we were on a branch, make it current again.

    if (branch.isBranch()) {
        yield branch.setTarget(commit, "ffwd merge");
        yield repo.setHead(branch.name());
    }
});

/**
 * Write tree representation of the index to the disk, create a commit
 * from the tree and update reference if needed.
 * 
 * @async
 * @param {NodeGit.Repository}      repo
 * @param {NodeGit.Index}           indexToWrite
 * @param {NodeGit.Commit | null}   ourCommit
 * @param {NodeGit.Commit}          theirCommit
 * @param {String}                  commitMessage
 * @param {String | null}           refToUpdate
 * @param {NodeGit.Signature}       author
 * @param {NodeGit.Signature}       committer
 * @return {Object}
 * @return {String|null} return.infoMessage informative message
 * @return {String|null} return.metaCommit in case no further merge operation
 *    is required, this is the merge commit.
 */
exports.makeMetaCommit = co.wrap(function *(repo,
                                            indexToWrite,
                                            ourCommit,
                                            theirCommit,
                                            commitMessage,
                                            refToUpdate,
                                            author,
                                            committer) {
    const id = yield indexToWrite.writeTreeTo(repo);
    const metaCommit = yield repo.createCommit(refToUpdate,
                                                author,
                                                committer,
                                                commitMessage,
                                                id,
                                                [ourCommit, theirCommit]);
    const commitSha = metaCommit.tostrS();
    return {
        metaCommit: commitSha,
        infoMessage: `Merge commit created at ` +
            `${colors.green(commitSha)}.`,
    };
});

/**
 * Merge the specified `subName` and update the in memory `metaindex`.
 * 
 * @async
 * @param {NodeGit.Index}      metaIndex index of the meta repo
 * @param {String}             subName submodule name
 * @param {SubmoduleChange}    change specifies the commits to merge
 * @param {String}             message commit message
 * @param {SubmoduleFetcher}   fetcher helper to fetch commits in the sub
 * @param {NodeGit.Signature}  author author signature
 * @param {NodeGit.Signature}  author committer signature
 * @param {Open.Opener}        opener helper to open a sub
 * @param {SUB_OPEN_OPTION}    openOption option to open a sub
 * @return {Object}
 * @return {String|null} return.mergeSha
 * @return {String|null} return.conflictSha
 * @return {String []}   return.conflictPaths
 */
exports.mergeSubmodule = co.wrap(function *(metaIndex,
                                            subName,
                                            change,
                                            message,
                                            opener,
                                            fetcher,
                                            author,
                                            committer,
                                            openOption) {
    assert.instanceOf(metaIndex, NodeGit.Index);
    assert.isString(subName);
    assert.instanceOf(change, SubmoduleChange);
    assert.isString(message);
    assert.instanceOf(opener, Open.Opener);
    assert.instanceOf(fetcher, SubmoduleFetcher);
    assert.instanceOf(author, NodeGit.Signature);
    assert.instanceOf(committer, NodeGit.Signature);
    assert.isNumber(openOption);

    let subRepo = yield opener.getSubrepo(subName, openOption);

    const isHalfOpened = yield opener.isHalfOpened(subName);
    const forceBare = openOption === SUB_OPEN_OPTION.FORCE_BARE;
    const theirSha = change.newSha;
    try {
        yield fetcher.fetchSha(subRepo, subName, theirSha);
        if (null !== change.ourSha) {
            yield fetcher.fetchSha(subRepo, subName, change.ourSha);
        }
    } catch (e) {
        console.log(
            `Unable to fetch changes in submodule '${subName}', ` +
            "abort merging."
        );
        throw e;
    }
    const theirCommit = yield subRepo.getCommit(theirSha);

    const ourSha = change.ourSha;
    const ourCommit = yield subRepo.getCommit(ourSha);
    
    const result = {
        mergeSha: null,
        conflictSha: null,
        conflictPaths: [],
    };

    // See if up-to-date
    if (yield NodeGit.Graph.descendantOf(subRepo, ourSha, theirSha)) {
        yield CherryPickUtil.addSubmoduleCommit(metaIndex, subName, ourSha);
        return result;                                                // RETURN
    }

    // See if can fast-forward and update HEAD if the submodule is opened.
    if (yield NodeGit.Graph.descendantOf(subRepo, theirSha, ourSha)) {
        if (isHalfOpened) {
            yield CherryPickUtil.addSubmoduleCommit(metaIndex,
                                                    subName,
                                                    theirSha);
        } else {
            yield GitUtil.setHeadHard(subRepo, theirCommit);
            yield metaIndex.addByPath(subName);    
        }
        return result;                                                // RETURN
    }

    console.error(`Submodule ${colors.blue(subName)}: merging commit \
${colors.green(theirSha)}.`);

    // Start the merge.
    let subIndex = yield NodeGit.Merge.commits(subRepo,
                                               ourCommit,
                                               theirCommit,
                                               null);
    if (!isHalfOpened) {
        yield NodeGit.Checkout.index(subRepo, subIndex, {
            checkoutStrategy: NodeGit.Checkout.STRATEGY.FORCE,
        });  
    }

    // handle conflicts:
    // 1. if force bare, bubble up conflicts and direct return
    // 2. if this is interactive merge and bare is allowed, open submodule,
    //    record conflicts and then bubble up the conflicts.
    // 3. if bare is not allowed, record conflicts and bubble up conflicts
    if (subIndex.hasConflicts()) {
        result.conflictPaths =
            Object.keys(StatusUtil.readConflicts(subIndex, []));
        if (forceBare) {
            result.conflictSha = theirSha;
            return result;
        }
        // fully open the submodule if conflict for manual resolution
        if (isHalfOpened) {
            opener.clearAbsorbedCache(subName);
            subRepo = yield opener.getSubrepo(subName,
                                              SUB_OPEN_OPTION.FORCE_OPEN);
            yield NodeGit.Checkout.index(subRepo, subIndex, {
                checkoutStrategy: NodeGit.Checkout.STRATEGY.FORCE,
            });
        }
        const seq = new SequencerState({
            type: MERGE,
            originalHead: new CommitAndRef(ourCommit.id().tostrS(), null),
            target: new CommitAndRef(theirSha, null),
            currentCommit: 0,
            commits: [theirSha],
            message: message,
        });
        yield SequencerStateUtil.writeSequencerState(subRepo.path(), seq);
        result.conflictSha = theirSha;
        return result;                                                // RETURN
    }

    // Otherwise, finish off the merge.
    if (!isHalfOpened) {
        subIndex = yield subRepo.index();
    }

    const refToUpdate = isHalfOpened ? null : "HEAD";
    const treeId = yield subIndex.writeTreeTo(subRepo);
    const mergeCommit = yield subRepo.createCommit(refToUpdate,
                                                   author,
                                                   committer,
                                                   message,
                                                   treeId,
                                                   [ourCommit, theirCommit]);
    const mergeSha = mergeCommit.tostrS();
    result.mergeSha = mergeSha;
    if (isHalfOpened) {
        yield CherryPickUtil.addSubmoduleCommit(metaIndex, subName, mergeSha);
    } else {
        yield metaIndex.addByPath(subName);
        // Clean up the conflict for this submodule and stage our change.
        yield metaIndex.conflictRemove(subName);        
    }
    return result;
});

/**
 * Perform preparation work before merge, including
 * 1. locate merge base
 * 2. check if working dir is clean (non-bare repo)
 * 3. check if two merging commits are the same or if their commit
 *    is an ancestor of ours, both cases are no-op.
 * 
 * @async
 * @param {MergeContext} context
 * @return {MergeStepResult}
 */
const mergeStepPrepare = co.wrap(function *(context) {
    assert.instanceOf(context, MergeContext);

    let errorMessage = null;
    let infoMessage = null;

    const forceBare = context.forceBare;
    const metaRepo = context.metaRepo;
    const ourCommit = yield context.getOurCommit();
    const ourCommitSha = ourCommit.id().tostrS();
    const theirCommit = context.theirCommit;
    const theirCommitSha = theirCommit.id().tostrS();

    const baseCommit = 
        yield GitUtil.getMergeBase(metaRepo, theirCommit, ourCommit);

    if (null === baseCommit) {
        errorMessage = "No commits in common with" + 
            `${colors.red(GitUtil.shortSha(ourCommitSha))} and ` +
            `${colors.red(GitUtil.shortSha(theirCommitSha))}`;
        return MergeStepResult.error(errorMessage);                  // RETURN
    }

    if (!forceBare) {
        const status = yield StatusUtil.getRepoStatus(metaRepo);
        const statusError = StatusUtil.checkReadiness(status);
        if (null !== statusError) {
            return MergeStepResult.error(statusError);                // RETURN
        }
        if (!status.isDeepClean(false)) {
            errorMessage = "The repository has uncommitted changes. "+ 
                "Please stash or commit them before running merge.";
            return MergeStepResult.error(errorMessage);               // RETURN
        }
    }

    if (ourCommitSha === theirCommitSha) {
        infoMessage = "Nothing to do.";
        return MergeStepResult.justMeta(infoMessage, theirCommit);    // RETURN
    }

    const upToDate  = yield NodeGit.Graph.descendantOf(metaRepo,
                                                       ourCommitSha,
                                                       theirCommitSha);

    if (upToDate) {
        return MergeStepResult.justMeta(infoMessage, ourCommitSha);    // RETURN
    }
    return MergeStepResult.empty();
});

/**
 * Perform a fast-forward merge in the specified `repo` to the
 * specified `commit`.  When generating a merge commit, use the
 * optionally specified `message`.  The behavior is undefined unless
 * `commit` is different from but descendant of the HEAD commit in
 * `repo`.
 * 
 * @async
 * @param {MergeContext} content
 * @return {MergeStepResult}
 */
const mergeStepFF = co.wrap(function *(context) {
    assert.instanceOf(context, MergeContext);

    const forceBare      = context.forceBare;
    const metaRepo       = context.metaRepo;
    const mode           = context.mode;
    const ourCommit      = yield context.getOurCommit();
    const ourCommitSha   = ourCommit.id().tostrS();
    const theirCommit    = context.theirCommit;
    const theirCommitSha = theirCommit.id().tostrS();

    let errorMessage     = null;
    let infoMessage      = null;

    const canFF  = yield NodeGit.Graph.descendantOf(metaRepo,
                                                    theirCommitSha,
                                                    ourCommitSha);
    if (MODE.FF_ONLY === mode && !canFF) {
        errorMessage = "The meta-repository cannot be fast-forwarded " +
            `to ${colors.red(theirCommitSha)}.`;
        return MergeStepResult.error(errorMessage);                   // RETURN
    } else if (canFF && MODE.FORCE_COMMIT !== mode) {
        infoMessage = `Fast-forwarding meta repo from `+
            `${colors.green(ourCommitSha)} to `+
            `${colors.green(theirCommitSha)}`;
        if (!forceBare) {
            yield exports.fastForwardMerge(metaRepo, theirCommit);
        }
        return MergeStepResult.justMeta(infoMessage, theirCommitSha); // RETURN
    }
    return MergeStepResult.empty();
});

/**
 * @async
 * @param {MergeContext} context
 * @return {MergeStepResult} 
 */
const mergeStepMergeSubmodules = co.wrap(function *(context) {
    assert.instanceOf(context, MergeContext);

    const changes        = yield context.getChanges();
    const fetcher        = yield context.getFetcher();
    const forceBare      = context.forceBare;
    const index          = yield context.getIndexToWrite();
    const opener         = context.opener;
    const openOption     = context.openOption;
    const ourCommit      = yield context.getOurCommit();
    const ourCommitSha   = ourCommit.id().tostrS();
    const refToUpdate    = context.refToUpdate;
    const repo           = context.metaRepo;
    const author         = yield context.getAuthor();
    const committer      = yield context.getCommitter();
    const theirCommit    = context.theirCommit;
    const theirCommitSha = theirCommit.id().tostrS();
    const doNotRecurse   = context.doNotRecurse;

    let conflictMessage = "";
    // abort merge if conflicted under FORCE_BARE mode
    if (forceBare && Object.keys(changes.conflicts).length > 0) {
        conflictMessage = getBareMergeConflictsMessage(changes.conflicts);
        return MergeStepResult.error(conflictMessage);                // RETURN
    }

    // deal with simple changes
    if (forceBare) {
        // for merge-bare, no need to open or delete submodules, directly
        // writes the post merge urls to .gitmodules file.
        yield SubmoduleConfigUtil.writeUrls(repo, index, changes.urls, true);
    } else {
        yield CherryPickUtil.changeSubmodules(repo,
                                              opener,
                                              index,
                                              changes.simpleChanges,
                                              changes.urls);
    }

    const message = yield context.getCommitMessage();
    if ("" === message) {
        return MergeStepResult.empty();
    }

    const merges = {
        conflicts: {},
        conflictPaths: {},
        commits: {},
    };
    const mergeSubmoduleRunner = co.wrap(function *(subName) {
        for (const prefix of doNotRecurse) {
            if (subName.startsWith(prefix + "/") || subName === prefix) {
                const change = changes.changes[subName];
                const sha = change.newSha;
                merges.conflicts[subName] = sha;
                merges.conflictPaths[subName] = [""];
                const old = new ConflictEntry(FILEMODE.COMMIT, change.oldSha);
                const our = new ConflictEntry(FILEMODE.COMMIT, change.ourSha);
                const new_ = new ConflictEntry(FILEMODE.COMMIT, change.newSha);
                changes.conflicts[subName] = new Conflict(old, our, new_);
                return;
            }
        }
        const subResult =
            yield exports.mergeSubmodule(index,
                                         subName,
                                         changes.changes[subName],
                                         message,
                                         opener,
                                         fetcher,
                                         author,
                                         committer,
                                         openOption);
        if (null !== subResult.mergeSha) {
            merges.commits[subName] = subResult.mergeSha;
        }
        if (null !== subResult.conflictSha) {
            merges.conflicts[subName] = subResult.conflictSha;
            merges.conflictPaths[subName] = subResult.conflictPaths;
        }
    });
    yield DoWorkQueue.doInParallel(Object.keys(changes.changes),
                                   mergeSubmoduleRunner);
    // Render any conflicts 
    if (forceBare) {
        conflictMessage = getBareMergeConflictsMessage(merges.conflictPaths);
    } else {
        conflictMessage =
            yield CherryPickUtil.writeConflicts(repo,
                                                index,
                                                changes.conflicts);
        ///
        Object.keys(merges.conflicts).sort().forEach(name => {
            conflictMessage +=
                SubmoduleRebaseUtil.subConflictErrorMessage(name);
        });
    }

    // finishing merge for interactive merges
    // 1. close unnecessarily opened submodules
    // 2. write the index to the meta repo or the staging we've done earlier
    //    will go away
    if (!forceBare) {
        yield CherryPickUtil.closeSubs(opener, merges);
        yield SparseCheckoutUtil.setSparseBitsAndWriteIndex(repo, index);
    }

    if ("" !== conflictMessage) {
        // For interactive merge, record that there is a merge in progress so
        // that we can continue or abort it later
        if (!forceBare) {
            const seq = new SequencerState({
                type: MERGE,
                originalHead: new CommitAndRef(ourCommitSha, null),
                target: new CommitAndRef(theirCommitSha, null),
                currentCommit: 0,
                commits: [theirCommitSha],
                message: message,
            });
            yield SequencerStateUtil.writeSequencerState(repo.path(), seq);    
        }
        return MergeStepResult.error(conflictMessage);
    }

    let infoMessage = `Merging meta-repo commits ` +
        `${colors.green(ourCommitSha)} and ` +
        `${colors.green(theirCommitSha)}`;
    const metaCommitRet = yield exports.makeMetaCommit(repo,
                                                       index,
                                                       ourCommit,
                                                       theirCommit,
                                                       message,
                                                       refToUpdate,
                                                       author,
                                                       committer);
    infoMessage += "\n" + metaCommitRet.infoMessage;
    return new MergeStepResult(infoMessage,
                               null,
                               metaCommitRet.metaCommit,
                               merges.commits);
});

/**
 * Merge  `theirCommit` into `ourCommit` in the specified `repo` with specific
 * commitMessage. using the specified `mode` to control whether or not a merge
 * commit will be generated. `openOption` tells if creating a submodule under
 * the working directory is forbidden (bare repo), is not encouraged or is 
 * always enforced. Commit message is either provided from `commitMessage` 
 * or from the `editMessage` callback. 
 * 
 * Return an object describing the resulting commit which can be:
 * 1. our commit if our commit is up to date
 * 2. their commit if this is a fast forward merge and FF is allowed
 * 3. new commit whose parents are `ourCommit` and `theirCommit`
 * 
 * Throw a `UserError` if: 
 * 1. there are no commits in common between  `theirCommit` and `ourCommit`.
 * 2. the repository has uncommitted changes
 * 3. FF is enforced but not possible
 * 4. FORCE_BARE is enabled, but there are merging conflicts
 *
 * @async
 * @param {NodeGit.Repository}      repo
 * @param {NodeGit.Commit|null}     ourCommit
 * @param {NodeGit.Commit}          theirCommit
 * @param {MergeCommon.MODE}        mode
 * @param {Open.SUB_OPEN_OPTION}    openOption
 * @param {String|null}             commitMessage
 * @param {() -> Promise(String)}   editMessage
 * @return {Object}
 * @return {String|null} return.metaCommit
 * @return {Object}      return.submoduleCommits  map from submodule to commit
 * @return {String|null} return.errorMessage
 */
exports.merge = co.wrap(function *(repo,
                                    ourCommit,
                                    theirCommit,
                                    mode,
                                    openOption,
                                    doNotRecurse,
                                    commitMessage,
                                    editMessage) {
    // pack and validate merging objects
   const context = new MergeContext(repo,
                                    ourCommit,
                                    theirCommit,
                                    mode,
                                    openOption,
                                    doNotRecurse,
                                    commitMessage,
                                    editMessage,
                                    process.env.GIT_AUTHOR_NAME,
                                    process.env.GIT_AUTHOR_EMAIL,
                                    process.env.GIT_COMMITTER_NAME,
                                    process.env.GIT_COMMITTER_EMAIL);
    // 
    const result = {
        metaCommit: null,
        submoduleCommits: {},
        errorMessage: null,
    };
    const mergeAsyncSteps = [
        mergeStepPrepare,
        mergeStepFF,
        mergeStepMergeSubmodules,
    ];

    for (const asyncStep of mergeAsyncSteps) {
        const ret = yield asyncStep(context);
        if (null !== ret.infoMessage) {
            console.error(ret.infoMessage);
        }
        if (null !== ret.errorMessage) {
            throw new UserError(ret.errorMessage);
        }
        if (null !== ret.finishSha) {
            result.metaCommit = ret.finishSha;
            result.submoduleCommits = ret.submoduleCommits;
            return result;
        }
    }
    return result;
});

/**
 * Throw a `UserError` if the specified `index` has non-submodule conflicts and
 * do nothing otherwise.
 *
 * @param {NodeGit.Index} index
 */
const checkForConflicts = function (index) {
    assert.instanceOf(index, NodeGit.Index);
    const entries = index.entries();
    for (let i = 0; i < entries.length; ++i) {
        const entry = entries[i];
        const stage = NodeGit.Index.entryStage(entry);
        if (RepoStatus.STAGE.OURS === stage &&
            FILEMODE.COMMIT !== entry.mode) {
            throw new UserError("Meta-repo has conflicts.");
        }
    }
};

/**
 * Continue the merge in the specified `repo`.  Throw a `UserError` if there is
 * no merge in progress in `repo` or if `repo` still has outstanding conflicts.
 * Return an object describing generated commits.
 *
 * @param {NodeGit.Repository} repo
 * @return {Object|null}
 * @return {String} return.metaCommit
 * @return {Object} return.submoduleCommits  map from submodule to commit
 */
exports.continue = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);
    const result = {
        metaCommit: null,
        submoduleCommits: {},
    };
    const seq = yield checkForMerge(repo.path());
    const index = yield repo.index();

    checkForConflicts(index);

    // We have to do this because there may have been outsanding submodule
    // conflicts.  We validated in `checkForConflicts` that there are no "real"
    // conflicts.

    console.log(`Continuing with merge of ${colors.green(seq.target.sha)}.`);

    let errorMessage = "";

    const continueSub = co.wrap(function *(subPath) {
        const subRepo = yield SubmoduleUtil.getRepo(repo, subPath);
        const subIndex = yield subRepo.index();
        if (subIndex.hasConflicts()) {
            errorMessage +=
                           `Submodule ${colors.red(subPath)} has conflicts.\n`;
            return;                                                   // RETURN
        }
        const sig = yield ConfigUtil.defaultSignature(subRepo);
        const subSeq = yield getSequencerIfMerge(subRepo.path());
        if (null === subSeq) {
            // There is no merge in this submodule, but if there are staged
            // changes we need to make a commit.

            const status = yield StatusUtil.getRepoStatus(subRepo, {
                showMetaChanges: true,
            });
            if (!status.isIndexClean()) {
                const id = yield subRepo.createCommitOnHead([],
                                                            sig,
                                                            sig,
                                                            seq.message);
                result.submoduleCommits[subPath] = id.tostrS();
            }
        }
        else {
            // Now, we have a submodule that was in the middle of merging.
            // Continue it and then clean up the merge.

            const head = yield subRepo.getHeadCommit();
            const mergeHead = yield subRepo.getCommit(subSeq.target.sha);
            const treeId = yield subIndex.writeTreeTo(subRepo);
            const id = yield subRepo.createCommit("HEAD",
                                                  sig,
                                                  sig,
                                                  subSeq.message,
                                                  treeId,
                                                  [head, mergeHead]);
            yield SequencerStateUtil.cleanSequencerState(subRepo.path());
            result.submoduleCommits[subPath] = id.tostrS();
        }
        yield index.addByPath(subPath);
        yield index.conflictRemove(subPath);
    });
    const openSubs = yield SubmoduleUtil.listOpenSubmodules(repo);
    yield DoWorkQueue.doInParallel(openSubs,
                                   continueSub,
                                   {failMsg: "Merge in submodule failed."});
    yield SparseCheckoutUtil.setSparseBitsAndWriteIndex(repo, index);

    if ("" !== errorMessage) {
        throw new UserError(errorMessage);
    }
    const treeId = yield index.writeTreeTo(repo);

    const sig = yield ConfigUtil.defaultSignature(repo);
    const head = yield repo.getHeadCommit();
    const mergeHead = yield repo.getCommit(seq.target.sha);
    const metaCommit = yield repo.createCommit("HEAD",
                                               sig,
                                               sig,
                                               seq.message,
                                               treeId,
                                               [head, mergeHead]);
    console.log(
            `Finished with merge commit ${colors.green(metaCommit.tostrS())}`);
    yield SequencerStateUtil.cleanSequencerState(repo.path());
    result.metaCommit = metaCommit.tostrS();
    return result;
});

const resetMerge = co.wrap(function *(repo) {
    // TODO: add this to libgit2
    const execString = `git -C '${repo.workdir()}' reset --merge`;
    yield ChildProcess.exec(execString, {
        maxBuffer: 1024*1024*100
    });
});

/**
 * Abort the merge in progress in the specified `repo`, or throw a `UserError`
 * if no merge is in progress.
 *
 * @param {NodeGit.Repository} repo
 */
exports.abort = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    yield checkForMerge(repo.path());

    const head = yield repo.getHeadCommit(repo);
    const openSubs = yield SubmoduleUtil.listOpenSubmodules(repo);
    const shas = yield SubmoduleUtil.getSubmoduleShasForCommit(repo,
                                                               openSubs,
                                                               head);
    const index = yield repo.index();
    const abortSub = co.wrap(function *(subName) {
        // Our goal here is to do a 'git reset --merge'.  Ideally, we'd do a
        // soft reset first to put the submodule on the right sha, but you
        // can't do a soft reset "in the middle of a merge", so we do an
        // initial 'git reset --merge' once, then if we're not on the right sha
        // we can do the soft reset -- the 'git reset --merge' cleans up any
        // merge conflicts -- then do one final 'git reset --merge'.

        const subRepo = yield SubmoduleUtil.getRepo(repo, subName);
        yield resetMerge(subRepo);
        const subHead = yield subRepo.getHeadCommit();
        if (subHead === null) {
            throw new UserError(
                `HEAD not found in submodule ${subName}. ` +
                "It is likely broken, please try to recover it first." +
                "Hint: try to close and then reopen it."
            );
        }
        if (subHead.id().tostrS() !== shas[subName]) {
            const commit = yield subRepo.getCommit(shas[subName]);
            yield NodeGit.Reset.reset(subRepo,
                                      commit,
                                      NodeGit.Reset.TYPE.SOFT);
            yield resetMerge(subRepo);
        }
        yield SequencerStateUtil.cleanSequencerState(subRepo.path());
        yield index.addByPath(subName);
    });
    yield DoWorkQueue.doInParallel(openSubs, abortSub);
    yield index.conflictCleanup();
    yield SparseCheckoutUtil.setSparseBitsAndWriteIndex(repo, index);
    yield resetMerge(repo);
    yield SequencerStateUtil.cleanSequencerState(repo.path());
});
