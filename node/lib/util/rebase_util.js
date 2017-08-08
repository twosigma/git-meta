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
const SubmoduleUtil       = require("./submodule_util");
const UserError           = require("./user_error");

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
 * Process the specified `rebase` for the submodule having the specified
 * `name`and open `repo`, beginning with the specified `op` and proceeding
 * until there are no more commits to rebase.  Return an object describing any
 * encountered error and commits made.
 *
 * @param {NodeGit.Repository}      rep
 * @param {String}                  name
 * @param {NodeGit.Rebase}          rebase
 * @param {NodeGit.RebaseOperation} op
 * @return {Object}
 * @return {Object} return.commits
 * @return {String|null} return.error
 */
const processSubmoduleRebase = co.wrap(function *(repo,
                                                  name,
                                                  rebase,
                                                  op) {
    const result = {
        commits: {},
        error: null,
    };
    const signature = repo.defaultSignature();
    while (null !== op) {
        console.log(`Submodule ${colors.blue(name)}: applying \
commit ${colors.green(op.id().tostrS())}.`);
        const index = yield repo.index();
        if (index.hasConflicts()) {
            result.error = `\
Conflict rebasing the submodule ${colors.red(name)}.`;
            break;                                                     // BREAK
        }
        const newCommit = rebase.commit(null, signature, null);
        const originalCommit = op.id().tostrS();
        result.commits[newCommit.tostrS()] = originalCommit;
        op = yield callNext(rebase);
    }
    if (null === result.error) {
        console.log(`Submodule ${colors.blue(name)}: finished \
rebase.`);
        yield callFinish(repo, rebase);
    }
    return result;
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
 * @return {Strring|null} return.error    failure message if non-null
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

    let op = yield callNext(rebase);
    return yield processSubmoduleRebase(repo, name, rebase, op);
});

/**
 * Attempt to handle a conflicted `.gitmodules` file in the specified `repo`
 * having the specified `index`, with changes coming from the specified
 * `fromCommit` and `ontoCommit` commits.  Return true if the conflict was
 * resolved and false otherwise.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Index}      index
 * @param {NodeGit.Commit}     fromCommit
 * @param {NodeGit.Commit}     ontoCommit
 * @return {Boolean}
 */
const mergeModulesFile = co.wrap(function *(repo,
                                            index,
                                            fromCommit,
                                            ontoCommit) {
    // If there is a conflict in the '.gitmodules' file, attempt to resolve it
    // by comparing the current change against the original onto commit and the
    // merge base between the base and onto commits.

    const Conf = SubmoduleConfigUtil;
    const getSubs = Conf.getSubmodulesFromCommit;
    const fromNext = yield getSubs(repo, fromCommit);

    const baseId = yield NodeGit.Merge.base(repo,
                                            fromCommit.id(),
                                            ontoCommit.id());
    const mergeBase = yield repo.getCommit(baseId);
    const baseSubs =
            yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, mergeBase);

    const ontoSubs = yield SubmoduleConfigUtil.getSubmodulesFromCommit(
                                                                   repo,
                                                                   ontoCommit);

    const merged = Conf.mergeSubmoduleConfigs(fromNext, ontoSubs, baseSubs);
                        // If it was resolved, write out and stage the new
                        // modules state.

    if (null !== merged) {
        const newConf = Conf.writeConfigText(merged);
        yield fs.writeFile(path.join(repo.workdir(), Conf.modulesFileName),
                           newConf);
        yield index.addByPath(Conf.modulesFileName);
        return true;
    }
    return false;
});

/**
 * Process the specified `entry` from the specified `index`  for the specified
 * `metaRepo` during a rebase from the specified `fromCommit` on the specified
 * `ontoCommit`.  Use the specified `opener` to open submodules
 * as needed, and obtain the SHA for a submodule on the `ontoCommit` from the
 * specified `ontoShas`.  Return an object indicating that an error occurred,
 * that a submodule needs to be rebased, or neither.
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
                                                  ontoShas,
                                                  fromCommit,
                                                  ontoCommit) {

    const id = entry.id;
    const isSubmodule = entry.mode === NodeGit.TreeEntry.FILEMODE.COMMIT;
    const fetcher = yield opener.fetcher();
    const stage = RepoStatus.getStage(entry.flags);

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
            const ontoSha = ontoShas[name];
            const fromSha = id.tostrS();
            if (ontoSha !== fromSha) {
                const subRepo = yield opener.getSubrepo(name);
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
                const succeeded = yield mergeModulesFile(metaRepo,
                                                         index,
                                                         fromCommit,
                                                         ontoCommit);
                if (succeeded) {
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
                                                 ontoShas,
                                                 fromCommit,
                                                 ontoCommit);
        if (null !== ret.error) {
            console.log("E:", ret.error);
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

        if (null !== ret.error) {
            errorMessage += ret.error + "\n";
        }
    }

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
        return callNext(rebase);
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
        yield openSubs.map(co.wrap(function *(name) {
            const subRepo = yield opener.getSubrepo(name);
            const head = yield subRepo.head();
            const sha = shas[name];
            if (head.target().tostrS() !== sha) {
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
        return yield SubmoduleUtil.cacheSubmodules(metaRepo,
                                                   co.wrap(function *() {
            const rebase = yield NodeGit.Rebase.init(metaRepo,
                                                     fromAnnotedCommit,
                                                     ontoAnnotatedCommit,
                                                     null,
                                                     null);
            console.log(`Rewinding to ${colors.green(commitId.tostrS())}.`);
            yield callNext(rebase);
            return {
                rebase: rebase,
                submoduleCommits: {},
            };
        }));
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

    const initializer = co.wrap(function *(metaRepo) {
        console.log(`Continuing rebase from \
${colors.green(rebaseInfo.originalHead)} onto \
${colors.green(rebaseInfo.onto)}.`);
        const rebase = yield SubmoduleUtil.cacheSubmodules(repo, () => {
            return NodeGit.Rebase.open(repo);
        });
        const index = yield repo.index();
        const subs = yield SubmoduleUtil.listOpenSubmodules(metaRepo);
        const subCommits = {};
        for (let i = 0; i !== subs.length; ++i) {
            const name = subs[i];
            const subRepo = yield SubmoduleUtil.getRepo(metaRepo, name);
            if (!subRepo.isRebasing()) {
                yield index.addByPath(name);
                break;                                                 // BREAK
            }
            yield index.addByPath(name);

            const subInfo = yield RebaseFileUtil.readRebase(repo.path());
            console.log(`Submodule ${colors.blue(name)} continuing \
rebase from ${colors.green(subInfo.originalHead)} onto \
${colors.green(subInfo.onto)}.`);
            const rebase = yield NodeGit.Rebase.open(subRepo);
            const idx = rebase.operationCurrent();
            const op = rebase.operationByIndex(idx);
            const result = yield processSubmoduleRebase(subRepo,
                                                        name,
                                                        rebase,
                                                        op);
            subCommits[name] = result.commits;
            if (null !== result.error) {
                errorMessage += result.error + "\n";
            }
            else {
                yield index.addByPath(name);
                yield index.conflictRemove(name);
            }
        }
        if ("" !== errorMessage) {
            throw new UserError(errorMessage);
        }
        return {
            rebase: rebase,
            submoduleCommits: subCommits,
        };
    });
    return yield driveRebase(repo, initializer, fromCommit, ontoCommit);
});
