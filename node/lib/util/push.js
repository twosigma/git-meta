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

/**
 * This module contains methods for pushing.
 */

const assert       = require("chai").assert;
const ChildProcess = require("child-process-promise");
const co           = require("co");
const colors       = require("colors");
const NodeGit      = require("nodegit");

const DoWorkQueue         = require("./do_work_queue");
const ForcePushSpec       = require("./force_push_spec");
const GitUtil             = require("./git_util");
const SubmoduleUtil       = require("./submodule_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const SyntheticBranchUtil = require("./synthetic_branch_util");
const UserError           = require("./user_error");

// This magic SHA represents an empty tree in Git.

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * For a given commit, determine a reasonably close oid that has
 * already been pushed. This does *not* do a fetch, but rather just
 * compares against all available remote refs.
 *
 * This works by building a revwalk and removing all ancestors of remote refs
 * for the given remote. It then reverses the result, and returns the first
 * parent of the oldest, unpushed commit. This is not an absolute last pushed
 * oid, but is a very good proxy to determine what to push.
 *
 * Returns a commit that exists in a remote ref, or null if no such commit
 * exists. If the given commit exists in a remote ref, will return itself.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 */
exports.getClosePushedCommit = co.wrap(function*(repo, commit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);

    // Search for the first commit that is not an ancestor of a remote ref, ie.
    // the first commit that is unpushed. NodeGit Revwalk is too slow, so
    // we shell out.

    // First, get the list of remote refs to exclude
    const excludeRefs = [];
    for (const ref of (yield NodeGit.Reference.list(repo))) {
        if (ref.startsWith("refs/remotes/")) {
            excludeRefs.push("^" + ref);
        }
    }
    if (excludeRefs.length === 0) {
        return null;
    }

    const args = ["-C", repo.workdir(), "rev-list", "--reverse",
                  "--topo-order", commit, ...excludeRefs];
    let result = yield ChildProcess.execFile("git", args, {
        maxBuffer: 1024*1024*100
    });
    if (result.error) {
        throw new Error(
            `Unexpected error figuring out what to push:
stderr:
{result.stderr}
stdout:
{result.stdout}`);
    }
    const out = result.stdout;
    if (!out) {
        // Nothing new to push
        return commit;
    }

    const firstNewOid = out.substring(0, out.indexOf("\n"));

    const firstNewCommit = yield repo.getCommit(firstNewOid);

    // If the first unpushed commit has no parents, then the entire set of
    // commits to push is new.

    if (0 === firstNewCommit.parentcount()) {
        return null;
    }
    return yield repo.getCommit(firstNewCommit.parentId(0));
});

/**
 * For a given proposed push, return a map from submodule to sha,
 * excluding any submodules that the server likely already has.
 *
 * Return in the map only those submodules that (1) exist locally, in
 * `.git/modules` and (2) are changed between `commit` and the merge base of
 * `commit` and each relevant branch.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             source
 * @param {NodeGit.Commit}     commit
 */
exports.getPushMap = co.wrap(function*(repo,  source, commit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(source);
    assert.instanceOf(commit, NodeGit.Commit);

    const baseCommit = yield exports.getClosePushedCommit(repo, commit);
    let baseTree;
    if (null !== baseCommit) {
        baseTree = yield baseCommit.getTree();
    } else {
        baseTree = EMPTY_TREE;
    }

    const tree = yield commit.getTree();
    const diff = yield NodeGit.Diff.treeToTree(repo, baseTree, tree, null);
    const changes = SubmoduleUtil.getSubmoduleChangesFromDiff(diff, true);

    const pushMap = {};
    for (const path of Object.keys(changes)) {
        const change = changes[path];
        if (!change.deleted) {
            pushMap[path] = change.newSha;
        }
    }

    const openSubmodules = yield SubmoduleUtil.listOpenSubmodules(repo);
    const absorbedSubmodules = 
        yield SubmoduleUtil.listAbsorbedSubmodules(repo);

    const availableSubmodules = new Set([...openSubmodules, 
                                        ...absorbedSubmodules]);

    // Make sure we have the repositories and commits we want to push.
    for (const sub of Object.keys(pushMap)) {
        if (!availableSubmodules.has(sub)) {
            delete pushMap[sub];
            continue;
        }

        const subRepo = yield SubmoduleUtil.getBareRepo(repo, sub);
        try {
            yield subRepo.getCommit(pushMap[sub]);
        } catch (e) {
            delete pushMap[sub];
        }
    }

    return pushMap;
});

/**
 * For each open submodule that exists in the commit indicated by the specified
 * `source`, push a synthetic-meta-ref for the `source` commit.
 * If all sub-repo pushes succeed, push `source` to
 * to the specified `target` branch in `remoteName`.  If any pushes fail, throw
 * a `UserError` object.
 *
 * Note that this strategy is naive: it does not handle the following
 * situations:
 *
 * - closed submodules with commits that need to be pushed
 * - submodules that do not exist in the `source` commit, but did previously
 *   and need synthetic-meta-refs
 * - submodules with divergent histories, i.e., the commit we create the
 *   synthetic-meta-ref for doesn't contain one or more commits that need to be
 *   pushed in its history
 *
 * Addressing these situations would have a performance impact, requiring
 * calculation and traversal of all meta-repo commits being pushed.  We should
 * probably add a way to do an "exhaustive" push.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             remoteName
 * @param {String}             source
 * @param {String}             target
 * @param {Boolean}            force
 */
exports.push = co.wrap(function *(repo, remoteName, source, target, force) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(remoteName);
    assert.isString(source);
    assert.isString(target);
    assert.instanceOf(force, ForcePushSpec);

    let remoteUrl = yield GitUtil.getUrlFromRemoteName(repo, remoteName);

    const annotatedCommit = yield GitUtil.resolveCommitish(repo, source);
    if (annotatedCommit === null) {
        throw new UserError(`No such ref: ${source}`);
    }
    const sha = annotatedCommit.id();
    const commit = yield repo.getCommit(sha);

    // First, push the submodules.
    const pushMap = yield exports.getPushMap(repo, source, commit);

    let errorMessage = "";

    const urls = yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo,
                                                                   commit);

    const pushSub = co.wrap(function *(subName) {
        // Push to a synthetic branch; first, calculate name.

        const sha = pushMap[subName];
        const syntheticName =
                          SyntheticBranchUtil.getSyntheticBranchForCommit(sha);
        const subRepo = yield SubmoduleUtil.getBareRepo(repo, subName);

        // Resolve the submodule's URL against the URL of the meta-repo,
        // ignoring the remote that is configured in the open submodule.

        if (!(subName in urls)) {
            throw new UserError(
                `The submodule ${subName} doesn't have an entry in .gitmodules`
            );
        }
        const subUrl = SubmoduleConfigUtil.resolveSubmoduleUrl(remoteUrl,
                                                               urls[subName]);

        // Always force push synthetic refs.  It should not be necessary, but
        // if something does go wrong forcing will allow us to auto-correct.
        // If they succeed, no need to print the output inside the submodules.

        const pushResult = yield GitUtil.push(subRepo,
                                              subUrl,
                                              sha,
                                              syntheticName,
                                              ForcePushSpec.Force,
                                              true);
        if (null !== pushResult) {
            errorMessage +=
           `Failed to push submodule ${colors.yellow(subName)}: ${pushResult}`;
        }
    });
    yield DoWorkQueue.doInParallel(Object.keys(pushMap), pushSub);

    // Throw an error if there were any problems pushing submodules; don't push
    // the meta-repo.

    if ("" !== errorMessage) {
        throw new UserError(errorMessage);
    }

    // Finally, push the meta-repo and throw on failure.

    const result = yield GitUtil.push(repo, remoteName, source, target, force);
    if (null !== result) {
        throw new UserError(`Failed to push meta-repo: ${result}`);
    }
});
