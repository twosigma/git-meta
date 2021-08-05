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

const assert  = require("chai").assert;
const co      = require("co");
const colors  = require("colors");
const fs      = require("fs-promise");
const NodeGit = require("nodegit");

const CloseUtil           = require("./close_util");
const ConfigUtil          = require("./config_util");
const DiffUtil           = require("./diff_util");
const GitUtil             = require("./git_util");
const Open                = require("./open");
const PrintStatusUtil     = require("./print_status_util");
const RepoStatus          = require("./repo_status");
const SparseCheckoutUtil  = require("./sparse_checkout_util");
const StatusUtil          = require("./status_util");
const SubmoduleUtil       = require("./submodule_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const SubmoduleRebaseUtil = require("./submodule_rebase_util");
const TreeUtil            = require("./tree_util");
const UserError           = require("./user_error");

const Commit = NodeGit.Commit;
const Change = TreeUtil.Change;
const FILEMODE = NodeGit.TreeEntry.FILEMODE;

const MAGIC_DELETED_SHA = NodeGit.Oid.fromString(
    "de1e7ed0de1e7ed0de1e7ed0de1e7ed0de1e7ed0");

const GITMODULES = SubmoduleConfigUtil.modulesFileName;

/**
 * Return the IDs of tress reflecting the current state of the index and
 * workdir for the specified `repo`, having the specified `status`.  If the
 * specified `includeUntracked` is provided, include untracked files.
 *
 * @param {NodeGit.Repository} repo
 * @param {RepoStatus}         status
 * @param {Boolean}            includeUntracked
 * @return {Object}
 * @return {NodeGit.Oid} return.index
 * @return {NodeGit.Oid} return.workdir
 */
exports.stashRepo = co.wrap(function *(repo, status, includeUntracked) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(status, RepoStatus);
    assert.isBoolean(includeUntracked);

    // Get a tree for the index

    const index = yield repo.index();
    const indexId = yield index.writeTree();

    // Create a tree for the workdir based on the index.

    const indexTree = yield NodeGit.Tree.lookup(repo, indexId);
    const changes = yield TreeUtil.listWorkdirChanges(repo,
                                                status,
                                                includeUntracked);
    const workdirTree = yield TreeUtil.writeTree(repo, indexTree, changes);

    return {
        index: indexId,
        workdir: workdirTree.id(),
    };
});

const metaStashRef = "refs/meta-stash";

function makeSubRefName(sha) {
    return `refs/sub-stash/${sha}`;
}

/**
 * Return a message describing the stash being created in the specified `repo`.
 *
 * @param {NodeGit.Repository} repo
 */
exports.makeLogMessage = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);
    const head = yield repo.getHeadCommit();
    const message = head.message().split("\n")[0];
    const branchName = yield GitUtil.getCurrentBranchName(repo);
    const branchDesc = (null === branchName) ?  "(no branch)" : branchName;
    return `\
WIP on ${branchDesc}: ${GitUtil.shortSha(head.id().tostrS())} ${message}`;
});


function getNewGitModuleSha(diff) {
    const numDeltas = diff.numDeltas();
    for (let i = 0;  i < numDeltas; ++i) {
        const delta = diff.getDelta(i);
        // We assume that the user hasn't deleted the .gitmodules file.
        // That would be bonkers.
        const file = delta.newFile();
        const path = file.path();
        if (path === GITMODULES) {
            return delta.newFile().id();
        }
    }
    // diff does not include .gitmodules
    return null;
}


const stashGitModules = co.wrap(function *(repo, headTree) {
    assert.instanceOf(repo, NodeGit.Repository);

    const result = {};
    // RepoStatus throws away the diff new sha, and rather than hack
    // it, since it's used all over the codebase, we'll just redo the
    // diffs for this one file.

    const workdirToTreeDiff =
          yield NodeGit.Diff.treeToWorkdir(repo,
                                           headTree,
                                           {pathspec: [GITMODULES]});


    const newWorkdir = getNewGitModuleSha(workdirToTreeDiff);
    if (newWorkdir !== null) {
        result.workdir = newWorkdir;
    }

    const indexToTreeDiff =
          yield NodeGit.Diff.treeToIndex(repo,
                                         headTree,
                                         yield repo.index(),
                                         {pathspec: [GITMODULES]});

    const newIndex = getNewGitModuleSha(indexToTreeDiff);
    if (newIndex !== null) {
        result.staged = newIndex;
    }

    yield NodeGit.Checkout.tree(repo, headTree, {
        paths: [GITMODULES],
        checkoutStrategy: NodeGit.Checkout.STRATEGY.FORCE,
    });

    return result;
});

/**
 * Save the state of the submodules in the specified, `repo` having the
 * specified `status` and clean the sub-repositories to match their respective
 * HEAD commits.  If the specified `includeUntracked` is true, include
 * untracked files in the stash and clean them.  Do not stash any information
 * for the meta-repo itself.  Update the `refs/meta-stash` reference and its
 * reflog to point to a new stash commit.  This commit will have the current
 * HEAD of the repository as its child, and a tree with containing updated shas
 * for stashed submodules pointing to their respective stash commits.  In each
 * stashed submodule, crete a synthetic-meta-ref in the form of
 * `refs/sub-stash/${sha}`, where `sha` is the stash commit of that submodule.
 * Return a map from submodule name to stashed commit for each submodule that
 * was stashed.
 *
 * Normal stashes have up to two parents:
 * 1. HEAD at stash time
 * 2. a new commit, with tree = index at stash time
 *
 * Our stashes can have up to two additional parents:
 *
 * 3. If the user has a commit inside the submodule, that commit
 * 4. If the user has staged a commit in the meta index, that commit
 *
 * @param {NodeGit.Repository} repo
 * @param {RepoStatus}         status
 * @param {Boolean}            includeUntracked
 * @param {String|null}        message
 * @return {Object}    submodule name to stashed commit
 */
exports.save = co.wrap(function *(repo, status, includeUntracked, message) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(status, RepoStatus);
    assert.isBoolean(includeUntracked);
    if (null !== message) {
        assert.isString(message);
    }

    const subResults = {};  // name to sha
    const subChanges = {};  // name to TreeUtil.Change
    const subRepos   = {};  // name to submodule open repo

    const sig = yield ConfigUtil.defaultSignature(repo);
    const head = yield repo.getHeadCommit();
    const headTree = yield head.getTree();

    // First, we process the submodules.  If a submodule is open and dirty,
    // we'll create the stash commits in its repo, populate `subResults` with
    // the `Stash.Submodule` that will be returned, `subChanges` with the sha
    // of the commit to be made to be used in generating the new submodule
    // tree, and `subRepos` to cache the open repo for each sub to be used
    // later.

    const submodules = status.submodules;
    yield Object.keys(submodules).map(co.wrap(function *(name) {
        const sub = submodules[name];
        const wd = sub.workdir;

        let stashId;

        if (sub.commit === null) {
            // I genuinely have no idea when this happens -- it's not:
            // (a) a closed submodule with a change staged in the meta repo
            // (b) a submodule yet to be born -- that is, a submodule
            // added to .gitmodules but without any commits.
            // (c) a submodule which does not even appear inside the
            // .gitmodules (e.g. one that you meant to add but didn't)
            console.error(`BUG: ${name} is in an unexpected state. Please \
report this.  Continuing stash anyway.`);
            return;
        }

        if (null === wd) {
            // closed submodule
            if (sub.index === null || sub.index.sha === null) {
                // deleted submodule
                stashId = MAGIC_DELETED_SHA;
                yield NodeGit.Checkout.tree(repo, headTree, {
                    paths: [name],
                    checkoutStrategy: NodeGit.Checkout.STRATEGY.FORCE,
                });
            } else {
                if (sub.commit.sha === sub.index.sha) {
                    // ... with no staged changes
                    return;                                           // RETURN
                }
                // This is a case that regular git stash doesn't really have
                // to handle. In a normal stash commit, the tree points
                // to the working directory tree, but here, there is no working
                // directory.  But if there were, we would want to have
                // this commit checked out.

                const subRepo = yield SubmoduleUtil.getRepo(repo, name);

                const subCommit = yield Commit.lookup(subRepo, sub.commit.sha);
                const indexCommit = yield Commit.lookup(subRepo, sub.index.sha);
                const indexTree = yield indexCommit.getTree();
                stashId = yield Commit.create(subRepo,
                                              null,
                                              sig,
                                              sig,
                                              null,
                                              "stash",
                                              indexTree,
                                              4,
                                              [subCommit,
                                               indexCommit,
                                               indexCommit,
                                               indexCommit]);
            }
        } else {
            // open submodule
            if (sub.commit.sha !== sub.index.sha &&
                sub.index.sha !== wd.status.headCommit) {
                // Giant mess case: the user has commit staged in the
                // meta index, and new commits in the submodule (which
                // may or may not be related to those staged in the
                // index).

                // In theory, our data structures support writing this case,
                // but since we don't yet support reading it, we probably
                // shouldn't let the user get into a state that they can't
                // easily get out of.

                throw new UserError(`${name} is in a state that is too \
complicated for git-meta to handle right now.  There is a commit inside the \
submodule, and also a different commit staged in the index.  Consider either \
staging or unstaging ${name} in the meta repository`);
            }

            const untrackedFiles = Object.keys(wd.status.workdir).length > 0;

            const uncommittedChanges = (!wd.status.isClean() ||
                                        (includeUntracked && untrackedFiles));

            if (!uncommittedChanges &&
                wd.status.headCommit === sub.commit.sha &&
                sub.commit.sha === sub.index.sha) {
                // Nothing to do for fully clean subs
                return;                                               // RETURN
            }

            const subRepo = yield SubmoduleUtil.getRepo(repo, name);
            subRepos[name] = subRepo;

            if (uncommittedChanges) {
                const FLAGS = NodeGit.Stash.FLAGS;
                const flags = includeUntracked ?
                      FLAGS.INCLUDE_UNTRACKED :
                      FLAGS.DEFAULT;
                stashId = yield NodeGit.Stash.save(subRepo, sig, "stash",
                                                   flags);
                if (wd.status.headCommit !== sub.commit.sha ||
                    sub.commit.sha !== sub.index.sha) {
                    // That stashed the local changes in the submodule, if
                    // any.  So now we need to mangle this commit to
                    // include more parents.

                    const stashCommit = yield Commit.lookup(subRepo, stashId);
                    const stashTree = yield stashCommit.getTree();
                    if (stashCommit.parentcount() !== 2) {
                        throw new Error(`BUG: expected newly-created stash \
commit to have two parents`);
                    }
                    const parent1 = yield stashCommit.parent(0);
                    const parent2 = yield stashCommit.parent(1);

                    const metaHeadSha = sub.commit.sha;
                    const headCommit = yield Commit.lookup(subRepo,
                                                           metaHeadSha);
                    const indexCommit = yield Commit.lookup(subRepo,
                                                            sub.index.sha);

                    const parents = [parent1, parent2, headCommit,
                                    indexCommit];
                    stashId = yield Commit.create(subRepo,
                                                  null,
                                                  sig,
                                                  sig,
                                                  null,
                                                  "stash",
                                                  stashTree,
                                                  4,
                                                  parents);

                }

            } else {
                // we need to manually create the commit here.
                const metaHead = yield Commit.lookup(subRepo, sub.commit.sha);
                const head = yield Commit.lookup(subRepo, wd.status.headCommit);
                const indexCommit = yield Commit.lookup(subRepo,
                                                        sub.index.sha);

                const parents = [metaHead,
                                 metaHead,
                                 head,
                                 indexCommit];
                const headCommit = yield Commit.lookup(subRepo,
                                                       wd.status.headCommit);
                const headTree = yield headCommit.getTree();

                stashId = yield Commit.create(subRepo,
                                              null,
                                              sig,
                                              sig,
                                              null,
                                              "stash",
                                              headTree,
                                              4,
                                              parents);
            }
            const subCommit = yield Commit.lookup(subRepo,
                                                  sub.commit.sha);
            yield NodeGit.Checkout.tree(subRepo, subCommit, {
                checkoutStrategy: NodeGit.Checkout.STRATEGY.FORCE,
            });
            subRepo.setHeadDetached(subCommit);
        }
        subResults[name] = stashId.tostrS();
        // Record the values we've created.

        subChanges[name] = new TreeUtil.Change(stashId, FILEMODE.COMMIT);
    }));

    const parents = [head];

    const gitModulesChanges = yield stashGitModules(repo, headTree);
    if (gitModulesChanges) {
        if (gitModulesChanges.workdir) {
            subChanges[GITMODULES] = new Change(gitModulesChanges.workdir,
                                                FILEMODE.BLOB);
        }
        if (gitModulesChanges.staged) {
            const indexChanges = {};
            Object.assign(indexChanges, subChanges);

            indexChanges[GITMODULES] = new Change(gitModulesChanges.staged,
                                                  FILEMODE.BLOB);


            const indexTree = yield TreeUtil.writeTree(repo, headTree,
                                                       indexChanges);
            const indexParent = yield Commit.create(repo,
                                                    null,
                                                    sig,
                                                    sig,
                                                    null,
                                                    "stash",
                                                    indexTree,
                                                    1,
                                                    [head]);

            const indexParentCommit = yield Commit.lookup(repo, indexParent);
            parents.push(indexParentCommit);
        }
    }

    const subsTree = yield TreeUtil.writeTree(repo, headTree, subChanges);
    const stashId = yield Commit.create(repo,
                                        null,
                                        sig,
                                        sig,
                                        null,
                                        "stash",
                                        subsTree,
                                        parents.length,
                                        parents);

    const stashSha = stashId.tostrS();

    // Make synthetic-meta-ref style refs for sub-repos.

    yield Object.keys(subRepos).map(co.wrap(function *(name) {
        const sha = subResults[name];
        const refName = makeSubRefName(sha);
        yield NodeGit.Reference.create(subRepos[name],
                                       refName,
                                       sha,
                                       1,
                                       "sub stash");
    }));

    // Update the stash ref and the ref log

    if (null === message) {
        message = yield exports.makeLogMessage(repo);
    }
    yield NodeGit.Reference.create(repo,
                                   metaStashRef,
                                   stashId,
                                   1,
                                   message);

    yield exports.createReflogIfNeeded(repo, metaStashRef, stashSha, message);
    return subResults;
});

/**
 * If there is no reflog for the specified `reference` in the specified `repo`,
 * create one with the specified `sha` as its first and only entry, using the
 * specified log `message`. Otherwise, do nothing.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             reference
 * @param {String}             sha
 * @param {String}             message
 */
exports.createReflogIfNeeded = co.wrap(function *(repo,
                                                  reference,
                                                  sha,
                                                  message) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(reference);
    assert.isString(sha);
    assert.isString(message);
    const log = yield NodeGit.Reflog.read(repo, reference);
    if (0 === log.entrycount()) {
        const id = NodeGit.Oid.fromString(sha);
        log.append(id, yield ConfigUtil.defaultSignature(repo), message);
        yield log.write();
    }
});

/**
 * Make the commit having the specified `sha` be the top of the stash of the
 * specified `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             sha
 */
exports.setStashHead = co.wrap(function *(repo, sha) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(sha);
    let currentRef;
    try {
        currentRef = yield NodeGit.Reference.lookup(repo, "refs/stash");
    }
    catch (e) {
        // ref doesn't exist
    }
    if (undefined !== currentRef && currentRef.target().tostrS() === sha) {
        // if the stash already points to `sha`, bail

        return;                                                       // RETURN
    }

    // otherwise, either there is no stash, or it points to the wrong thing

    const message = "sub stash";
    yield NodeGit.Reference.create(repo, "refs/stash", sha, 1, message);
    yield exports.createReflogIfNeeded(repo, "refs/stash", sha, message);
});

/**
 * Restore the meta stash having the specified commit `id` in the specified
 * `repo` and return a map from submodule name to the sha of its stash for each
 * submodule restored on success, or null if one or more submodules could not
 * be restored.  The behavior is undefined unless `id` identifies a valid stash
 * commit.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             id
 * @param {Boolean}            reinstateIndex
 * @return {Object}            submodule name to stashed commit
 */
exports.apply = co.wrap(function *(repo, id, reinstateIndex) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(id);

    const commit = yield repo.getCommit(id);
    const repoIndex = yield repo.index();

    // TODO: patch libgit2/nodegit: the commit object returned from `parent`
    // isn't properly configured with a `repo` object, and attempting to use it
    // in `getSubmodulesForCommit` will fail, so we have to look it up.

    const parentId = (yield commit.parent(0)).id();
    const parent = yield repo.getCommit(parentId);
    const parentTree = yield parent.getTree();

    const baseSubs = yield SubmoduleUtil.getSubmodulesForCommit(repo,
                                                                parent,
                                                                null);

    let indexSubs = baseSubs;
    if (commit.parentcount() > 1) {
        const parent2Id = (yield commit.parent(1)).id();
        const parent2 = yield repo.getCommit(parent2Id);
        indexSubs = yield SubmoduleUtil.getSubmodulesForCommit(repo,
                                                               parent2,
                                                               null);
    }

    const newSubs = yield SubmoduleUtil.getSubmodulesForCommit(repo,
                                                               commit,
                                                               null);

    const toDelete = [];
    yield Object.keys(baseSubs).map(co.wrap(function *(name) {
        if (newSubs[name] === undefined) {
            if (fs.existsSync(name)) {
                // sub deleted in working tree
                toDelete.push(name);
            }
        }
    }));

    CloseUtil.close(repo, repo.workdir(), toDelete, false);
    for (const name of toDelete) {
        yield fs.rmdir(name);
    }

    yield Object.keys(baseSubs).map(co.wrap(function *(name) {
        if (indexSubs[name] === undefined) {
            // sub deleted in the index
            yield repoIndex.removeByPath(name);
        }
    }));

    // apply gitmodules diff
    const headTree = yield commit.getTree();
    yield NodeGit.Checkout.tree(repo, headTree, {
        paths: [GITMODULES],
        baseline: parentTree,
        checkoutStrategy: NodeGit.Checkout.STRATEGY.MERGE,
    });

    const opener = new Open.Opener(repo, null);
    let result = {};
    const index = {};
    yield Object.keys(newSubs).map(co.wrap(function *(name) {
        const stashSha = newSubs[name].sha;
        if (baseSubs[name].sha === stashSha) {
            // If there is no change in sha, then there is no stash

            return;                                                   // RETURN
        }
        let subRepo =
            yield opener.getSubrepo(name,
                                    Open.SUB_OPEN_OPTION.FORCE_OPEN);

        // Try to get the commit for the stash; if it's missing, fail.
        let stashCommit;
        try {
            stashCommit = yield Commit.lookup(subRepo, stashSha);
        } catch (e) {
            console.error(`\
Stash commit ${colors.red(stashSha)} is missing from submodule \
${colors.red(name)}`);
            result = null;
            return;                                                   // RETURN
        }

        const indexCommit = yield stashCommit.parent(1);

        if (stashCommit.parentcount() > 2) {
            const oldHead = yield stashCommit.parent(2);
            if (stashCommit.parentcount() > 3) {
                const stagedCommit = yield stashCommit.parent(3);
                index[name] = stagedCommit.id();
            }

            // Before we get started, we might need to rebase the
            // commits from oldHead..commitBeforeStash

            const commitBeforeStash = yield stashCommit.parent(0);

            const rebaseError = function(resolution) {
                console.error(`The stash for submodule ${name} had one or \
more commits, ending with ${commitBeforeStash.id()}.  We tried to rebase these \
commits onto the current commit, but this failed.  ${resolution}
After you are done with this rebase, you may need to apply working tree \
and index changes.  To restore the index, try (inside ${name}) 'git read-tree \
${indexCommit.id()}'.  To restore the working tree, try (inside ${name}) \
'git checkout ${stashCommit} -- .'`);
            };

            try {
                const res = yield SubmoduleRebaseUtil.rewriteCommits(
                    subRepo,
                    commitBeforeStash,
                    oldHead);
                if (res.errorMessage) {
                    rebaseError(res.errorMessage);
                    result = null;
                    return;
                }
            } catch (e) {
                // We expect these errors to be caught, but if
                // something goes wrong, wWe are leaving the user in a
                // pretty yucky state.  the alternative is to try to
                // back out the whole stash apply, which seems worse.

                rebaseError(`We are leaving the rebase half-finished, so \
that you can fix the conflicts and continue by running 'git rebase \
--continue' inside of ${name} (note: not 'git meta rebase').`);
                console.error(`The underlying error, which might be useful \
for debugging, is:`, e);
                result = null;
                return;
            }
        }

        // Make sure this sha is the current stash.

        yield exports.setStashHead(subRepo, stashSha);

        // And then apply it.

        const APPLY_FLAGS = NodeGit.Stash.APPLY_FLAGS;
        const flag = reinstateIndex ?
            APPLY_FLAGS.APPLY_REINSTATE_INDEX : APPLY_FLAGS.APPLY_DEFAULT;

        try {
            yield NodeGit.Stash.pop(subRepo, 0, {
                flags: flag,
            });
        }
        catch (e) {
            result = null;
        }
        if (null !== result) {
            result[name] = stashSha;
        }
    }));

    if (null !== result) {
        for (let name of Object.keys(index)) {
            const entry = new NodeGit.IndexEntry();
            entry.flags = 0;
            entry.flagsExtended = 0;
            entry.id = index[name];
            repoIndex.add(entry);
        }
    }

    yield SparseCheckoutUtil.setSparseBitsAndWriteIndex(repo, repoIndex);
    return result;
});

/**
 * Return the sha of the stash at the specified `index` in the specified
 * `repo`.  Throw a `UserError` if there is no stash at the specified index.
 *
 * @param {NodeGit.Repository} repo
 * @param {Number}             index
 * @return {String}
 */
const getStashSha = co.wrap(function *(repo, index) {

    let stashRef;
    try {
        stashRef = yield NodeGit.Reference.lookup(repo, metaStashRef);
    }
    catch (e) {
        throw new UserError("No stash found.");
    }

    const log = yield NodeGit.Reflog.read(repo, metaStashRef);
    const count = log.entrycount();
    if (count <= index) {
        throw new UserError(
`Invalid stash index: ${colors.red(index)}, max is ${count - 1}.`);
    }
    return log.entryByIndex(index).idNew().tostrS();
});

/**
 * Remove, from the stash queue for the specified `repo`, the stash at the
 * specified `index`.  Throw a `UserError` if no such stash exists.  If
 * `0 === index` and there are more elements in the queue, set
 * `refs/meta-stash` to indicate the next element; otherwise, remove
 * `refs/meta-stash` if the queue is empty.
 *
 * @param {NodeGit.Repository} repo
 * @param {Number}             index
 */
exports.removeStash = co.wrap(function *(repo, index) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isNumber(index);


    const log = yield NodeGit.Reflog.read(repo, metaStashRef);
    const stashSha = yield getStashSha(repo, index);
    const count = log.entrycount();
    log.drop(index, 1 /* rewrite previous entry */);
    yield log.write();

    // We dropped the first element.  We need to update `refs/meta-stash`

    if (0 === index) {
        if (count > 1) {
            const entry = log.entryByIndex(0);
            yield NodeGit.Reference.create(repo,
                                           metaStashRef,
                                           entry.idNew(),
                                           1,
                                           "removeStash");
            // But then in doing so, we've written a new entry for the ref,
            // remove the old one.

            log.drop(1, 1 /* rewrite previous entry */);
            yield log.write();
        }
        else {
            NodeGit.Reference.remove(repo, metaStashRef);
        }
    }
    const refText = `${metaStashRef}@{${index}}`;
    console.log(`\
Dropped ${colors.green(refText)} ${colors.blue(stashSha)}`);
});

/**
 * Attempt to restore the stash at the specified `index` in the specified
 * `repo`.  If successful, remove that stash; if there is no other stash,
 * remove `refs/meta-stash`.
 *
 * @param {NodeGit.Repository} repo
 * @param {int}                index
 * @param {Boolean}            reinstateIndex
 */
exports.pop = co.wrap(function *(repo, index, reinstateIndex, shouldDrop) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isNumber(index);

    const stashSha = yield getStashSha(repo, index);
    const applyResult = yield exports.apply(repo, stashSha, reinstateIndex);

    const status = yield StatusUtil.getRepoStatus(repo);
    process.stdout.write(PrintStatusUtil.printRepoStatus(status, ""));

    // If the application succeeded, remove it.

    if (null !== applyResult) {
        if (shouldDrop) {
            yield exports.removeStash(repo, index);

            // Clean up sub-repo meta-refs

            Object.keys(applyResult).forEach(co.wrap(function* (subName) {
                const subRepo = yield SubmoduleUtil.getRepo(repo, subName);
                const refName = makeSubRefName(applyResult[subName]);
                NodeGit.Reference.remove(subRepo, refName);
            }));
        }
    }
    else {
        throw new UserError(`\
Could not restore stash ${colors.red(stashSha)} due to conflicts.`);
    }
});

/**
 * Return a string describing the meta stashes in the specified `repo`.
 *
 * @param {NodeGit.Repository} repo
 */
exports.list = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);
    let result = "";
    const log = yield NodeGit.Reflog.read(repo, metaStashRef);
    const count = log.entrycount();
    for (let i = 0; i < count; ++i) {
        const entry = log.entryByIndex(i);
        result += `meta-stash@{${i}}: ${entry.message()}\n`;
    }
    return result;
});

/**
 * Make a shadow commit for the specified `repo` having the specified `status`;
 * use the specified commit `message`.  Ignored untracked files unless the
 * specified `includeUntracked` is true.  Return the sha of the created commit.
 * Note that this method does not recurse into submodules.  If the specified
 * `incrementTimestamp` is true, use the timestamp of HEAD + 1; otherwise, use
 * the current time.
 *
 * @param {NodeGit.Repository} repo
 * @param {RepoStatus}         status
 * @param {String}             message
 * @param {Bool}               incrementTimestamp
 * @param {Bool}               includeUntracked
 * @return {String}
 */
const makeShadowCommitForRepo = co.wrap(function *(repo,
                                                   status,
                                                   message,
                                                   incrementTimestamp,
                                                   includeUntracked,
                                                   indexOnly) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(status, RepoStatus);
    assert.isString(message);
    assert.isBoolean(includeUntracked);
    assert.isBoolean(incrementTimestamp);
    assert.isBoolean(indexOnly);

    if (indexOnly) {
        const index = yield repo.index();
        const tree = yield index.writeTree();
        const sig = yield ConfigUtil.defaultSignature(repo);
        const subCommit = yield repo.createCommit(null, sig, sig,
                                                  message, tree, []);
        return subCommit.tostrS();
    }

    const changes = yield TreeUtil.listWorkdirChanges(repo,
                                                      status,
                                                      includeUntracked);
    const head = yield repo.getHeadCommit();
    const parents = [];

    const index = yield repo.index();
    const treeOid = yield index.writeTree();
    const indexTree = yield repo.getTree(treeOid);

    const newTree = yield TreeUtil.writeTree(repo, indexTree, changes);
    if (null !== head) {
        parents.push(head);
        const headTree = yield head.getTree();
        if (newTree.id().equal(headTree.id())) {
            return head.sha();
        }
    }

    let sig = yield ConfigUtil.defaultSignature(repo);
    if (incrementTimestamp && null !== head) {
        sig = NodeGit.Signature.create(sig.name(),
                                       sig.email(),
                                       head.time() + 1,
                                       head.timeOffset());
    }
    const id = yield Commit.create(repo,
                                   null,
                                   sig,
                                   sig,
                                   null,
                                   message,
                                   newTree,
                                   parents.length,
                                   parents);
    return id.tostrS();
});

/**
 * Generate a shadow commit in the specified 'repo' with the specified
 * 'message' and return an object describing the created commits.  Ignore
 * untracked files unless the specified 'includeUntracked' is true.
 * When 'includedSubrepos' is non-empty only consider files contained within the
 * paths specified in includedSubrepos.  If the
 * repository is clean, return null.  Note that this command does not affect
 * the state of 'repo' other than to generate commits.
 *
 * TODO: Note that we cannot really support `includeMeta === true` due to the
 * fact that `getRepoStatus` is broken when `true === ignoreIndex` and there
 * are new submodules (see TODO in `StatusUtil.getRepoStatus`).
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             message
 * @param {Bool}               useEpochTimestamp
 * @param {Bool}               includeMeta
 * @param {Bool}               includeUntracked
 * @param {Object}             includedSubrepos
 * @param {Bool}               indexOnly         include only staged changes
 * @return {Object|null}
 * @return {String} return.metaCommit
 * @return {Object} return.subCommits  path to sha of generated subrepo commits
 */
exports.makeShadowCommit = co.wrap(function *(repo,
                                              message,
                                              useEpochTimestamp,
                                              includeMeta,
                                              includeUntracked,
                                              includedSubrepos,
                                              indexOnly) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(message);
    assert.isBoolean(includeMeta);
    assert.isBoolean(includeUntracked);
    assert.isArray(includedSubrepos);
    assert.isBoolean(useEpochTimestamp);
    if (indexOnly === undefined) {
        indexOnly = false;
    } else {
        assert.isBoolean(indexOnly);
    }

    if (!message.endsWith("\n")) {
        message += "\n";
    }

    const status = yield StatusUtil.getRepoStatus(repo, {
        showMetaChanges: includeMeta,
        untrackedFilesOption: DiffUtil.UNTRACKED_FILES_OPTIONS.ALL,
        ignoreIndex: false,
        paths: includedSubrepos,
    });
    if (status.isDeepClean(includeUntracked)) {
        return null;                                                  // RETURN
    }
    const subCommits = {};
    const subStats = status.submodules;
    const Submodule = RepoStatus.Submodule;
    yield Object.keys(subStats).map(co.wrap(function *(name) {
        const subStatus = subStats[name];
        const wd = subStatus.workdir;

        // If the submodule is closed or its workdir is clean, we don't need to
        // do anything for it.

        if (null === wd || ((subStatus.commit === null ||
                             wd.status.headCommit === subStatus.commit.sha) &&
                            wd.status.isClean(includeUntracked))) {
            return;                                                   // RETURN
        }
        const subRepo = yield SubmoduleUtil.getRepo(repo, name);
        const subSha = yield makeShadowCommitForRepo(subRepo,
                                                     wd.status,
                                                     message,
                                                     useEpochTimestamp,
                                                     includeUntracked,
                                                     indexOnly);
        const newSubStat = new Submodule({
            commit: subStatus.commit,
            index: subStatus.index,
            workdir: new Submodule.Workdir(new RepoStatus({
                headCommit: subSha,
            }), Submodule.COMMIT_RELATION.AHEAD),
        });

        // Update the status for this submodule so that it will be written
        // correctly.

        subStats[name] = newSubStat;
        subCommits[name] = subSha;
    }));

    // Update the submodules in the status object to reflect newly-generated
    // commits.

    const newStatus = status.copy({ submodules: subStats });
    const metaCommit = yield makeShadowCommitForRepo(repo,
                                                     newStatus,
                                                     message,
                                                     useEpochTimestamp,
                                                     includeUntracked,
                                                     false);
    return {
        metaCommit: metaCommit,
        subCommits: subCommits,
    };
});
