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

/**
 * This module contains utility methods for working with submodules.
 */

const co      = require("co");
const NodeGit = require("nodegit");
const fs      = require("fs-promise");
const path    = require("path");

const modulesFileName = ".gitmodules";

/**
 * Return the names of the submodules stored in the specified `text` from a
 * `.gitmodules` file.
 *
 * @private
 * @param {String} text
 * @return {String []}
 */
function getSubmoduleNamesFromText(text) {
    const re = /\[submodule *"(.*)"]/;
    var result = new Set();
    const lines = text.split("\n");
    var parseResult;
    for (var i = 0; i < lines.length; ++i) {
        parseResult = re.exec(lines[i]);
        if (null !== parseResult) {
            result.add(parseResult[1]);
        }
    }
    return Array.from(result.values());
}

/**
 * Return the names of the submodules (visible or otherwise) for the HEAD
 * commit in the specified `repo`.
 *
 * TODO: I wrote this function because the equivalent
 * `NodeGit.Repository.getSubmoduleNames` method is about 100X slower; we
 * should submit a patch to `libgit2` or `nodegit`.
 *
 * @param {NodeGit.Repository} repo
 * @return {String []}
 */
exports.getSubmoduleNames = co.wrap(function *(repo) {
    const modulesPath = path.join(repo.workdir(), modulesFileName);
    const text = yield fs.readFile(modulesPath, {
        encoding: "utf8"
    });
    return getSubmoduleNamesFromText(text);
});

/**
 * Return the names of the submodules on the specified `commit`, in the
 * specified `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit} commit
 * @return {String []}
 */
exports.getSubmoduleNamesForCommit = co.wrap(function *(repo, commit) {
    // We're going to pull the '.gitmodules' file out of the repo for 'commit'.
    // It's a multi-part process.  First we have to get the tree for the
    // commit, then the entry for '.gitcmodules' from that tree.

    const tree = yield commit.getTree();
    var entry;

    // I don't know of any way to check for this file that doesn't result in an
    // exception.  If there is no '.gitmodules' file, there are not submodules.
    try {
        entry = yield tree.entryByPath(".gitmodules");
    }
    catch (e) {
        return [];
    }

    // Here, you might think you could call 'entry.getBlob', but it appears to
    // be broken, so we'll do what that method does: get the entry's oid and
    // request that from the repo.

    const oid = entry.oid();
    const blob = yield repo.getBlob(oid);

    // Then we'll grab the text from that file.  It's in the "standard" '.ini'
    // format, so we'll use the 'ini' module to parse it into JSON.

    const text = blob.toString();
    return getSubmoduleNamesFromText(text);
});

/**
 * Return the names of the submodules on the head of the branch having the
 * specified `branchName` specified `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             branchName
 * @return {String []}
 */
exports.getSubmoduleNamesForBranch = co.wrap(function *(repo, branchName) {

    // If the requested branch is the current branch, we can just ask the repo.
    // Otherwise, we have to do something much more complicated and expensive.

    const commit = yield repo.getBranchCommit(branchName);
    return yield exports.getSubmoduleNamesForCommit(repo, commit);
});

/**
 * Return a map from submodule name to string representing the expected sha1
 * for its repository in the specified `repo` on the branch having the
 * specified `branchName`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             branchName
 * @return {Object}
 */
exports.getSubmoduleShasInMetaRepo = co.wrap(function *(repo, branchName) {
    const commit = yield repo.getBranchCommit(branchName);
    const submoduleNames =
                    yield exports.getSubmoduleNamesForCommit(repo, commit);

    return yield exports.getSubmoduleShasForCommit(repo,
                                                   submoduleNames,
                                                   commit);
});

/**
 * Return a map from submodule name to string representing the expected sha1
 * for its repository in the specified `repo` on the specified `commit` for the
 * submodules whose names are in the specified `submoduleNames` array.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String[]}           submoduleNames
 * @param {NodeGit.Commit}     commit
 * @return {Object}
 */
exports.getSubmoduleShasForCommit =
    co.wrap(function *(repo, submoduleNames, commit) {
    // It's not straight-forward to do submodule operations on arbitrary
    // commits, as all the submodule routines in libgit2 deal with the repo in
    // its checked-out state.

    // We're going to have to grab the object for each submodule and ask
    // for its sha; this value happens to correspond to what the meta-repo
    // believes is the proper commit for that submodule.

    const tree = yield commit.getTree();
    const shaGetters = submoduleNames.map(co.wrap(function *(name) {
        const entry = yield tree.entryByPath(name);
        return entry.sha();
    }));
    const shas = yield shaGetters;
    var result = {};
    for (var i = 0; i < submoduleNames.length; ++i) {
        result[submoduleNames[i]] = shas[i];
    }
    return result;
});

/**
 * Return true if the submodule having the specified `submoduleName` in the
 * specified `repo` is visible and false otherwise.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             submoduleName
 */
exports.isVisible = co.wrap(function *(repo, submoduleName) {

    // From libgit2 submodule.h; otherwise not documented in nodegit or
    // libgit2.

    const GIT_SUBMODULE_STATUS_IN_WD = (1 << 3);
    const status = yield NodeGit.Submodule.status(repo, submoduleName, 0);

    return 0 !== (status & GIT_SUBMODULE_STATUS_IN_WD);
});

/**
 * Return an array containing the submodules for the specified `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @return {NodeGit.Submodule []}
 */
exports.getSubmodules = co.wrap(function *(repo) {

    const submoduleNames = yield exports.getSubmoduleNames(repo);
    const openers = submoduleNames.map(name => {
        return NodeGit.Submodule.lookup(repo, name);
    });
    const submodules = yield openers;
    return submodules;
});

/**
 * Return an array containing the submodules and repositories of the visible
 * submodules in the specified `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @return {Object}
 * @return {NodeGit.Submodule}  return.submodule
 * @return {NodeGit.Repository} return.repo
 */
exports.getSubmoduleRepos = co.wrap(function *(repo) {

    const submoduleNames = yield exports.getSubmoduleNames(repo);
    const openers = submoduleNames.map(co.wrap(function *(name) {
        const isVisible = yield exports.isVisible(repo, name);
        if (!isVisible) {
            return null;
        }
        const submodule = yield NodeGit.Submodule.lookup(repo, name);
        const subRepo = yield submodule.open();
        return {
            submodule: submodule,
            repo     : subRepo,
        };
    }));
    const repos = yield openers;
    return repos.filter(x => x !== null);
});

/**
 * Fetch the specified `submoduleRpo` from the specified `metaRepo` and return
 * the name of the origin of this submodule.
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {NodeGit.Repository} submoduleRepo
 * @return {String}
 */
exports.fetchSubmodule  = co.wrap(function *(metaRepo, submoduleRepo) {

    const remotes = yield submoduleRepo.getRemotes({});
    const originName = remotes[0];

    // If we don't do the fetch, necessary refs are missing and we can't set up
    // the branch.

    yield submoduleRepo.fetch(originName, new NodeGit.FetchOptions());

    return originName;
});

/**
 * Return a summary of changes in submodules from the commit having the
 * specified `oldCommitId` to the commit having the specified `newCommitId` in
 * the specified `repo`.
 *
 * @asycn
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.OID}        oldCommitId
 * @param {NodeGit.OID}        newCommitId
 * @return {Object}
 * @return {Object}    return.added    map from added submodules to sha
 * @return {Object}    return.changed  map from changed submodule to sha
 * @return {String []} return.removed  list of removed submodules
 */
exports.getSubmoduleDiff = co.wrap(function *(repo, oldCommitId, newCommitId) {

    // First, we have to get from the commit ids to the respective tree
    // objects.

    const oldCommit = yield repo.getCommit(oldCommitId);
    const newCommit = yield repo.getCommit(newCommitId);
    const oldTree = yield oldCommit.getTree();
    const newTree = yield newCommit.getTree();

    // Next, we run the actual diff.  By 'ignoreSubmodules' we mean the
    // contents of the submodules, not their status in the meta-repo.

    var opts = new NodeGit.DiffOptions();
    opts.ignoreSubmodules = true;
    const diff = yield NodeGit.Diff.treeToTree(repo, oldTree, newTree, opts);

    // From libgit diff.h.  We use this flag to see if the file (repo) was
    // present or not.

    const GIT_DIFF_FLAG_EXISTS = 1 << 3;

    // Use 'submoduleNameSet' to determine whether or not paths in the diff are
    // submodules.

    const submoduleNames =
                     yield exports.getSubmoduleNamesForCommit(repo, newCommit);
    const submoduleNameSet = new Set(submoduleNames);


    var result = {
        added  : {},
        changed: {},
        removed: [],
    };

    const numDiffs = diff.numDeltas();
    for (var i = 0; i < numDiffs; ++i) {
        var delta = diff.getDelta(i);
        var newFile = delta.newFile();
        var path = newFile.path();
        if (submoduleNameSet.has(path)) {
            var inNew = 0 !== (newFile.flags() & GIT_DIFF_FLAG_EXISTS);
            if (!inNew) {
                result.removed.push(path);
            }
            else {
                var oldFile = delta.oldFile();
                var inOld = 0 !== (oldFile.flags() & GIT_DIFF_FLAG_EXISTS);
                if (!inOld) {
                    result.added[path] = newFile.id();
                }
                else {
                    result.changed[path] = newFile.id();
                }
            }
        }
    }
    return result;
});

/**
 * Force the submodules in the specified `metaRepo` to be checked out to the
 * commit indicated by HEAD.  Pull doww commits from the remote having the
 * specified `remoteName`.
 *
 * @asycn
 * @param {NodeGit.Repository} metaRepo
 * @param {String}             remoteName
 */
exports.syncSubmodules = co.wrap(function *(metaRepo, remoteName) {
    const syncSubmodule = co.wrap(function *(subName) {
        const vis = yield exports.isVisible(metaRepo, subName);
        if (!vis) {
            return;                                                   // RETURN
        }
        const sub = yield NodeGit.Submodule.lookup(metaRepo, subName);
        const repo = yield sub.open();
        yield repo.fetch(remoteName, new NodeGit.FetchOptions());
        var updateOptions = new NodeGit.SubmoduleUpdateOptions();
        yield sub.update(0, updateOptions);
    });

    const subNames = yield exports.getSubmoduleNames(metaRepo);
    const synchers = subNames.map(x => syncSubmodule(x));
    yield synchers;
});
