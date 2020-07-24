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
const fs      = require("fs-promise");
const mkdirp  = require("mkdirp");
const NodeGit = require("nodegit");
const path    = require("path");

const DoWorkQueue         = require("./do_work_queue");
const GitUtil             = require("./git_util");
const Open                = require("./open");
const SparseCheckoutUtil  = require("./sparse_checkout_util");
const StatusUtil          = require("./status_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const SubmoduleFetcher    = require("./submodule_fetcher");
const SubmoduleUtil       = require("./submodule_util");
const UserError           = require("./user_error");

const TYPE = {
    SOFT: "SOFT",
    MIXED: "MIXED",
    HARD: "HARD",
    MERGE: "MERGE",
};
Object.freeze(TYPE);
exports.TYPE = TYPE;

/**
 * Return the `NodeGit.Reset.TYPE` value from the specified `type`.
 * @param {TYPE} type
 * @return {NodeGit.Reset.TYPE}
 */
function getType(type) {
    assert.property(TYPE, type);
    switch (type) {
        case TYPE.SOFT : return NodeGit.Reset.TYPE.SOFT;
        case TYPE.MIXED: return NodeGit.Reset.TYPE.MIXED;
        case TYPE.HARD : return NodeGit.Reset.TYPE.HARD;

        // TODO: real implementation of `reset --merge`.  For now, this behaves
        // just like `HARD` except that we ignore the check for modified open
        // submodules.

        case TYPE.MERGE: return NodeGit.Reset.TYPE.HARD;
    }
}

/**
 * Reset the specified `repo` of having  specified `index` to have the contents
 * of the tree of the specified `commit`.  Update the `.gitmodules` file in the
 * worktree to haave the same contents as in the index.  If the repo is not in
 * sparse mode, create empty directories for added submodules and remove the
 * directories of deleted submodules as indicated in the specified `changes`.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Index}      index
 * @param {NodeGit.Commit}     commit
 * @param {Object}             changes     from path to `SubmoduleChange`
 * @param {Boolean}            mixed       do not change the working tree
 */
exports.resetMetaRepo = co.wrap(function *(repo, index, commit, changes,
                                          mixed) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(index, NodeGit.Index);
    assert.instanceOf(commit, NodeGit.Commit);
    assert.isObject(changes);

    const tree = yield commit.getTree();
    yield index.readTree(tree);

    if (mixed) {
        return;
    }

    // Render modules file

    const modulesFileName = SubmoduleConfigUtil.modulesFileName;
    const modulesPath = path.join(repo.workdir(), modulesFileName);
    const modulesEntry = index.getByPath(modulesFileName);
    if (undefined !== modulesEntry) {
        const oid = modulesEntry.id;
        const blob = yield repo.getBlob(oid);
        const data = blob.toString();
        yield fs.writeFile(modulesPath, data);
    } else {
        // If it's not in the index, remove it.
        try {
            yield fs.unlink(modulesPath);
        } catch (e) {
            if ("ENOENT" !== e.code) {
                throw e;
            }
        }
    }

    // Tidy up directories when not in sparse mode.  We don't need to do this
    // when in sparse mode because in sparse mode we have a directory for a
    // submodule iff it's open.  Thus, when a new submodule comes into
    // existence we do not need to make a directory for it.  When a submodule
    // is deleted and it's not open, there's no directory to clean up; when it
    // is open, we don't want to remove the directory anyway -- this is a
    // behavior that libgit2 gets wrong.

    if (!(yield SparseCheckoutUtil.inSparseMode(repo))) {
        const tidySub = co.wrap(function *(name) {
            const change = changes[name];
            if (null === change.oldSha) {
                mkdirp.sync(path.join(repo.workdir(), name));
            } else if (null === change.newSha) {
                try {
                    yield fs.rmdir(path.join(repo.workdir(), name));
                } catch (e) {
                    // If we can't remove the directory, it's OK.  Git warns
                    // here, but I think that would just be noise as most of
                    // the time this happens when someone rebases a change that
                    // created a submodule.
                }
            }
        });
        yield DoWorkQueue.doInParallel(Object.keys(changes), tidySub);
    }
});

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
    assert.property(TYPE, type);

    const head = yield repo.getHeadCommit();
    const changedSubs = yield SubmoduleUtil.getSubmoduleChanges(repo,
                                                                commit,
                                                                head,
                                                                false);

    // Prep the opener to open submodules on HEAD; otherwise, our resets will
    // be noops.

    const opener = new Open.Opener(repo, null);
    const fetcher = yield opener.fetcher();
    const openSubsSet = yield opener.getOpenSubs();

    yield GitUtil.updateHead(repo, commit, `reset`);
    const index = yield repo.index();

    // With a soft reset we don't need to do anything to the meta-repo.  We're
    // not going to touch the index or the `.gitmodules` file.

    if (TYPE.SOFT !== type) {
        yield exports.resetMetaRepo(repo, index, commit, changedSubs,
                                   TYPE.MIXED === type);
    }

    const resetType = getType(type);

    const removedSubmodules = [];

    const resetSubmodule = co.wrap(function *(name) {
        const change = changedSubs[name];

        // Nothing to do if the change was an addition or deletion.

        if (undefined !== change &&
            (null === change.oldSha || null === change.newSha)) {
            return;                                                   // RETURN
        }

        // When doing a hard or merge reset, we don't need to open closed
        // submodules because we would be throwing away the changes anyway.

        if ((TYPE.HARD === type || TYPE.MERGE === type) &&
            !openSubsSet.has(name)) {
            return;                                                   // RETURN
        }

        // Open the submodule and fetch the sha of the commit to which we're
        // resetting in case we don't have it.

        const subRepo =
            yield opener.getSubrepo(name,
                                    Open.SUB_OPEN_OPTION.FORCE_OPEN);

        let subCommitSha;

        if (undefined === change) {
            // If there's no change, use what's been configured in the index.

            const entry = index.getByPath(name);
            // It is possible that this submodule exists in
            // .gitmodules but not in the index.  Probably this is
            // because it is newly-created, but not yet git-added.
            if (undefined === entry) {
                removedSubmodules.push(name);
                return;
            }

            subCommitSha = entry.id.tostrS();
        } else {
            subCommitSha = change.newSha;
        }

        yield fetcher.fetchSha(subRepo, name, subCommitSha);
        const subCommit = yield subRepo.getCommit(subCommitSha);

        // We've already put the meta-repo index on the right commit; read it
        // and reset to it.

        yield NodeGit.Reset.reset(subRepo, subCommit, resetType);

        // Set the index to have the commit to which we just set the submodule;
        // otherwise, Git will see a staged change and worktree modifications
        // for the submodule.

        yield index.addByPath(name);
    });

    // Make a list of submodules to reset, including all that have been changed
    // between HEAD and 'commit', and all that are open.
    const openSubs = Array.from(openSubsSet);
    const changedSubNames = Object.keys(changedSubs);
    const subsToTry = Array.from(new Set(changedSubNames.concat(openSubs)));
    yield DoWorkQueue.doInParallel(subsToTry, resetSubmodule);

    // remove added submodules from .gitmodules
    const modules = yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo,
                                                                     index);
    for (const file of removedSubmodules) {
        delete modules[file];
    }

    yield SubmoduleConfigUtil.writeUrls(repo, index, modules,
                                        type === TYPE.MIXED);

    // Write the index in case we've had to stage submodule changes.

    yield SparseCheckoutUtil.setSparseBitsAndWriteIndex(repo, index);
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

    const resolvedPaths = paths.map(filename => {
        return GitUtil.resolveRelativePath(repo.workdir(), cwd, filename);
    });

    const status = yield StatusUtil.getRepoStatus(repo, {
        paths: resolvedPaths,
    });

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
