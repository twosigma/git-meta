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
const NodeGit = require("nodegit");

const DoWorkQueue         = require("../util/do_work_queue");
const GitUtil          = require("./git_util");
const Open             = require("./open");
const StatusUtil       = require("./status_util");
const SubmoduleFetcher = require("./submodule_fetcher");
const SubmoduleUtil    = require("./submodule_util");
const UserError        = require("./user_error");

const TYPE = {
    SOFT: "soft",
    MIXED: "mixed",
    HARD: "hard",
};
Object.freeze(TYPE);
exports.TYPE = TYPE;

/**
 * Return the `NodeGit.Reset.TYPE` value from the specified `type`.
 * @param {TYPE} type
 * @return {NodeGit.Reset.TYPE}
 */
function getType(type) {
    switch (type) {
        case TYPE.SOFT : return NodeGit.Reset.TYPE.SOFT;
        case TYPE.MIXED: return NodeGit.Reset.TYPE.MIXED;
        case TYPE.HARD : return NodeGit.Reset.TYPE.HARD;
    }
    assert(false, `Bad type: ${type}`);
}

/**
 * Change the `HEAD` commit to the specified `commit` in the specified `repo`,
 * unstaging any staged changes.  Reset all open submodule in the same way to
 * the commit indicated by `commit`.  If the specified `type` is `SOFT`,
 * preserve the current index.  If `type` is `MIXED`, preserve the working
 * directory.  If `type` is `HARD`, set both index and working directory to the
 * tree specified by `commit`.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 * @param {TYPE}               type
 */
exports.reset = co.wrap(function *(repo, commit, type) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    assert.isString(type);

    const head = yield repo.getHeadCommit();
    const headTree = yield head.getTree();
    const commitTree = yield commit.getTree();
    const diff = yield NodeGit.Diff.treeToTree(repo,
                                               commitTree,
                                               headTree,
                                               null);
    const changedSubs = yield SubmoduleUtil.getSubmoduleChangesFromDiff(diff,
                                                                        true);

    // Prep the opener to open submodules on HEAD; otherwise, our resets will
    // be noops.

    const opener = new Open.Opener(repo, null);
    const fetcher = yield opener.fetcher();

    const resetType = getType(type);

    // First, reset the meta-repo.

    yield SubmoduleUtil.cacheSubmodules(repo, () => {
        return NodeGit.Reset.reset(repo, commit, resetType);
    });

    // Make a list of submodules to reset, including all that have been changed
    // between HEAD and 'commit', and all that are open.

    const openSubsSet = yield opener.getOpenSubs();
    const pathsToResetSet = new Set(openSubsSet);
    Object.keys(changedSubs).forEach(path => pathsToResetSet.add(path));
    const pathsToReset = Array.from(pathsToResetSet);
    const shas = yield SubmoduleUtil.getSubmoduleShasForCommit(repo,
                                                               pathsToReset,
                                                               commit);
    const index = yield repo.index();
    const resetSubmodule = co.wrap(function *(name) {
        const change = changedSubs[name];
        if (undefined !== change &&
            (null === change.oldSha || null === change.newSha)) {
            // If the submodule has been added or removed since 'commit',
            // there's nothing to do.
            return;                                                   // RETURN
         }
        const sha = shas[name];

        // When doing a hard reset, we don't need to open closed submodules
        // because we would be throwing away the changes anyway.

        if (TYPE.HARD === type && !openSubsSet.has(name)) {
            return;                                                   // RETURN
        }

        // Open the submodule and fetch the sha of the commit to which we're
        // resetting in case we don't have it.

        const subRepo = yield opener.getSubrepo(name);
        yield fetcher.fetchSha(subRepo, name, sha);

        const subCommit = yield subRepo.getCommit(sha);
        yield NodeGit.Reset.reset(subRepo, subCommit, resetType);

        // Set the index to have the commit to which we just set the submodule;
        // otherwise, Git will see a staged change and worktree modifications
        // for the submodule.

        yield index.addByPath(name);
    });
    yield DoWorkQueue.doInParallel(pathsToReset, resetSubmodule);
    // Write the index in case we've had to stage submodule changes.

    yield index.write();
});

/**
 * Helper method for `resolvePaths` to simplify use of `cacheSubmodules`.
 */
const resetPathsHelper = co.wrap(function *(repo, commit, resolvedPaths) {
    // Get a `Status` object reflecting only the values in `paths`.

    const status = yield StatusUtil.getRepoStatus(repo, {
        showMetaChanges: true,
        paths: resolvedPaths,
    });

    // Reset the meta-repo.

    const metaStaged = Object.keys(status.staged);
    if (0 !== metaStaged.length) {
        yield NodeGit.Reset.default(repo, commit, metaStaged);
    }

    const subs = status.submodules;
    const fetcher = new SubmoduleFetcher(repo, commit);
    const subNames = Object.keys(subs);
    const shas =
         yield SubmoduleUtil.getSubmoduleShasForCommit(repo, subNames, commit);

    yield subNames.map(co.wrap(function *(subName) {
        const sub = subs[subName];
        const workdir = sub.workdir;
        const sha = shas[subName];

        // If the submodule isn't open (no workdir) or didn't exist on `commit`
        // (i.e., it had no sha there), skip it.

        if (null !== workdir && undefined !== sha) {
            const subRepo = yield SubmoduleUtil.getRepo(repo, subName);
            yield fetcher.fetchSha(subRepo, subName, sha);
            const subCommit = yield subRepo.getCommit(sha);
            const staged = Object.keys(workdir.status.staged);
            if (0 !== staged.length) {
                yield NodeGit.Reset.default(subRepo, subCommit, staged);
            }
        }
    }));
});

/**
 * Reset the state of the index of the specified `repo` for the specified
 * `paths` to their state in the specified `commit`; or throw a `UserError` if
 * any path is invalid.  Use the specified `cwd` to resolve relative paths.
 * Currently, the behavior is undefined unless `commit` is the head commit of
 * `repo`.
 * TODO: It's actually a somewhat more work to support the (presumably,
 * seldom-used) case of resetting only the index state of a file to what's in a
 * different commit.  Currently, I'm just looking at the staged files to see
 * what needs to be reset; this functionality comes for free with
 * `StatusUtil.getRepoStatus`.  I'll come back and extend this later.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             cwd
 * @param {NodeGit.Commit}     commit
 * @param {String []}          paths
 */
exports.resetPaths = co.wrap(function *(repo, cwd, commit, paths) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(cwd);
    assert.instanceOf(commit, NodeGit.Commit);
    assert.isArray(paths);

    const head = yield repo.getHeadCommit();
    if (head.id().tostrS() !== commit.id().tostrS()) {
        throw new UserError("Cannot reset files to a commit that is not HEAD");
    }

    const resolvedPaths = yield paths.map(filename => {
        return GitUtil.resolveRelativePath(repo.workdir(), cwd, filename);
    });
    yield SubmoduleUtil.cacheSubmodules(repo, () => {
        return resetPathsHelper(repo, commit, resolvedPaths);
    });
});
