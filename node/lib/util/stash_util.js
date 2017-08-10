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
const NodeGit = require("nodegit");

const GitUtil         = require("./git_util");
const Open            = require("./open");
const PrintStatusUtil = require("./print_status_util");
const RepoStatus      = require("./repo_status");
const StatusUtil      = require("./status_util");
const SubmoduleUtil   = require("./submodule_util");
const TreeUtil        = require("./tree_util");
const UserError       = require("./user_error");

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
    const changes = TreeUtil.listWorkdirChanges(repo,
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
 */
const makeLogMessage = co.wrap(function *(repo) {
    const head = yield repo.getHeadCommit();
    const branchName = yield GitUtil.getCurrentBranchName(repo);
    const branchDesc = (null === branchName) ?  "(no branch)" : branchName;
    return `\
WIP on ${branchDesc}: ${GitUtil.shortSha(head.id().tostrS())} \
${head.message()}`;
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
 * @param {NodeGit.Repository} repo
 * @param {RepoStatus}         status
 * @param {Boolean}            includeUntracked
 * @return {Object}    submodule name to stashed commit
 */
exports.save = co.wrap(function *(repo, status, includeUntracked) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(status, RepoStatus);
    assert.isBoolean(includeUntracked);

    const subResults = {};  // name to sha
    const subChanges = {};  // name to TreeUtil.Change
    const subRepos   = {};  // name to submodule open repo

    const sig = repo.defaultSignature();

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
        if (null === wd ||
            (wd.status.isClean() &&
                (!includeUntracked ||
                    0 === Object.keys(wd.status.workdir).length))) {
            // Nothing to do for closed or clean subs

            return;                                                   // RETURN
        }
        const subRepo = yield SubmoduleUtil.getRepo(repo, name);
        subRepos[name] = subRepo;
        const FLAGS = NodeGit.Stash.FLAGS;
        const flags = includeUntracked ?
                      FLAGS.INCLUDE_UNTRACKED :
                      FLAGS.DEFAULT;
        const stashId = yield NodeGit.Stash.save(subRepo, sig, "stash", flags);
        subResults[name] = stashId.tostrS();

        // Record the values we've created.

        subChanges[name] = new TreeUtil.Change(
                                            stashId,
                                            NodeGit.TreeEntry.FILEMODE.COMMIT);
    }));
    const head = yield repo.getHeadCommit();
    const headTree = yield head.getTree();
    const subsTree = yield TreeUtil.writeTree(repo, headTree, subChanges);
    const stashId = yield NodeGit.Commit.create(repo,
                                                null,
                                                sig,
                                                sig,
                                                null,
                                                "stash",
                                                subsTree,
                                                1,
                                                [head]);

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

    const message = yield makeLogMessage(repo);
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
        log.append(id, repo.defaultSignature(), message);
        log.write();
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
 * @return {Boolean}
 */
exports.apply = co.wrap(function *(repo, id) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(id);

    const commit = yield repo.getCommit(id);

    // TODO: patch libgit2/nodegit: the commit object returned from `parent`
    // isn't properly configured with a `repo` object, and attempting to use it
    // in `getSubmodulesForCommit` will fail, so we have to look it up.

    const parentId = (yield commit.parent(0)).id();
    const parent = yield repo.getCommit(parentId);
    const baseSubs = yield SubmoduleUtil.getSubmodulesForCommit(repo, parent);
    const newSubs = yield SubmoduleUtil.getSubmodulesForCommit(repo, commit);
    const opener = new Open.Opener(repo, null);
    let result = {};
    yield Object.keys(newSubs).map(co.wrap(function *(name) {
        const stashSha = newSubs[name].sha;
        if (baseSubs[name].sha === stashSha) {
            // If there is no change in sha, then there is no stash

            return;                                                   // RETURN
        }
        const subRepo = yield opener.getSubrepo(name);

        // Try to get the comit for the stash; if it's missing, fail.

        try {
            yield subRepo.getCommit(stashSha);
        }
        catch (e) {
            console.error(`\
Stash commit ${colors.red(stashSha)} is missing from submodule \
${colors.red(name)}`);
            result = null;
            return;                                                   // RETURN
        }

        // Make sure this sha is the current stash.

        yield exports.setStashHead(subRepo, stashSha);

        // And then apply it.

        const APPLY_FLAGS = NodeGit.Stash.APPLY_FLAGS;

        try {
            yield NodeGit.Stash.pop(subRepo, 0, {
                flags: APPLY_FLAGS.APPLY_REINSTATE_INDEX,
            });
        }
        catch (e) {
            result = null;
        }
        if (null !== result) {
            result[name] = stashSha;
        }
    }));
    return result;
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
    const count = log.entrycount();
    if (count <= index) {
        throw new UserError(`Invalid stash index: ${colors.red(index)}.`);
    }
    log.drop(index, 1 /* rewrite previous entry */);
    log.write();

    // We dropped the first element.  We need to update `refs/meta-stash`

    if (0 === index) {
        if (count > 1) {
            const entry = log.entryByIndex(0);
            NodeGit.Reference.create(repo,
                                     metaStashRef,
                                     entry.idNew(),
                                     1,
                                     "removeStash");
        }
        else {
            NodeGit.Reference.remove(repo, metaStashRef);
        }
    }
});

/**
 * Attempt to restore the most recent stash in the specified `repo`.  If
 * successful, make the second stash current; if there is no other stash,
 * remove `refs/meta-stash`.
 *
 * @param {NodeGit.Repository} repo
 */
exports.pop = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    // Try to look up the meta stash; return early if not found.

    let stashRef;
    try {
        stashRef = yield NodeGit.Reference.lookup(repo, metaStashRef);
    }
    catch (e) {
        console.warn("No meta stash found.");
        return;                                                       // RETURN
    }

    const stashSha = stashRef.target().tostrS();

    const applyResult = yield exports.apply(repo, stashSha);

    const status = yield StatusUtil.getRepoStatus(repo);
    process.stdout.write(PrintStatusUtil.printRepoStatus(status, ""));

    // If the application succeeded, remove it.

    if (null !== applyResult) {
        yield exports.removeStash(repo, 0);
        console.log(`\
Dropped ${colors.green(metaStashRef + "@{0}")} ${colors.blue(stashSha)}`);

        // Clean up sub-repo meta-refs

        Object.keys(applyResult).forEach(co.wrap(function *(subName) {
            const subRepo = yield SubmoduleUtil.getRepo(repo, subName);
            const refName = makeSubRefName(applyResult[subName]);
            NodeGit.Reference.remove(subRepo, refName);
        }));
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
