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
 * This module contains utility methods for working with submodules.
 */

const assert  = require("chai").assert;
const co      = require("co");
const colors  = require("colors");
const NodeGit = require("nodegit");
const fs      = require("fs-promise");
const path    = require("path");

const GitUtil             = require("../util/git_util");
const SubmoduleConfigUtil = require("../util/submodule_config_util");

/**
 * Return the names of the submodules stored in the specified `text` from a
 * `.gitmodules` file.
 *
 * @private
 * @param {String} text
 * @return {String []}
 */
function getSubmoduleNamesFromText(text) {
    const map = SubmoduleConfigUtil.parseSubmoduleConfig(text);
    return Object.keys(map);
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
exports.getSubmoduleNames = function (repo) {
    assert.instanceOf(repo, NodeGit.Repository);
    const modulesPath = path.join(repo.workdir(),
                                  SubmoduleConfigUtil.modulesFileName);
    return fs.readFile(modulesPath, {
        encoding: "utf8"
    })
    .then(text => {
        return getSubmoduleNamesFromText(text);
    })
    .catch(() => {
        // No modules file; return empty array.
        return [];
    });
};

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
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    // We're going to pull the '.gitmodules' file out of the repo for 'commit'.
    // It's a multi-part process.  First we have to get the tree for the
    // commit, then the entry for '.gitcmodules' from that tree.

    const tree = yield commit.getTree();
    let entry;

    // I don't know of any way to check for this file that doesn't result in an
    // exception.  If there is no '.gitmodules' file, there are not submodules.
    try {
        entry = yield tree.entryByPath(SubmoduleConfigUtil.modulesFileName);
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
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(branchName);

    // If the requested branch is the current branch, we can just ask the repo.
    // Otherwise, we have to do something much more complicated and expensive.

    const commit = yield repo.getBranchCommit(branchName);
    return yield exports.getSubmoduleNamesForCommit(repo, commit);
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
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isArray(submoduleNames);
    submoduleNames.forEach(name => assert.isString(name));
    assert.instanceOf(commit, NodeGit.Commit);
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
    let result = {};
    for (let i = 0; i < submoduleNames.length; ++i) {
        result[submoduleNames[i]] = shas[i];
    }
    return result;
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
exports.getSubmoduleShasForBranch = co.wrap(function *(repo, branchName) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(branchName);
    const commit = yield repo.getBranchCommit(branchName);
    const submoduleNames =
                    yield exports.getSubmoduleNamesForCommit(repo, commit);

    return yield exports.getSubmoduleShasForCommit(repo,
                                                   submoduleNames,
                                                   commit);
});

/**
 * Return an array of the expected shas for the submodules having the specified
 * `submoduleNames` in the specified `repo`.
 *
 * @asyn
 * @param {NodeGit.Repository} repo
 * @param {String []}          submoduleNames
 * @return {String []}
 */
exports.getCurrentSubmoduleShas = co.wrap(function *(repo, submoduleNames) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isArray(submoduleNames);
    submoduleNames.forEach(name => assert.isString(name));

    const index = yield repo.index();
    let result = [];
    let entry;
    for (let i = 0; i < submoduleNames.length; ++i) {
        entry = index.getByPath(submoduleNames[i]);
        if (entry) {
            result.push(entry.id.tostrS());
        } else {
            result.push(`${colors.red("missing entry")}`);
        }
    }
    return result;
});

/**
 * Return true if the submodule having the specified `submoduleName` in the
 * specified `repo` is visible and false otherwise.
 *
 * TODO: `NodeGit.Submodule.status` is way too slow; takes about 40s for 4k
 * repos.  Should submit a patch to fix.

 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             submoduleName
 */
exports.isVisible = function (repo, submoduleName) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(submoduleName);

    const submoduleGitPath = path.join(repo.workdir(), submoduleName, ".git");
    return fs.access(submoduleGitPath, fs.R_OK)
    .then(() => true)
    .catch(() => false);
};

/**
 * Return the `Repository` for the submodule having the specified `name` in the
 * specified `metaRepo`.
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {String}             name
 * @return {NodeGit.Repository}
 */
exports.getRepo = function (metaRepo, name) {
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.isString(name);

    const submodulePath = path.join(metaRepo.workdir(), name);
    return NodeGit.Repository.open(submodulePath);
};

/**
 * Return an array containing the submodule names  and repositories of the
 * visible submodules in the specified `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @return {Object []}
 * @return {String}             return.name
 * @return {NodeGit.Repository} return.repo
 */
exports.getSubmoduleRepos = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const submoduleNames = yield exports.getSubmoduleNames(repo);
    const openers = submoduleNames.map(co.wrap(function *(name) {
        const isVisible = yield exports.isVisible(repo, name);
        if (!isVisible) {
            return null;
        }
        const subRepo = yield exports.getRepo(repo, name);
        return {
            name: name,
            repo: subRepo,
        };
    }));
    const repos = yield openers;
    return repos.filter(x => x !== null);
});

/**
 * Fetch the specified `submoduleRpo` from the specified `metaRepo` and return
 * the name of the origin of this submodule.  The behavior is undefined if
 * remotes have been added or removed; it should be used only immediately after
 * the submodule is opened.
 *
 * TODO: This method was written with the assumption that the origin name might
 * somehow be different than "origin", yet that there would always be one.  I
 * think this assumption should be checked and this function eliminated.
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {NodeGit.Repository} submoduleRepo
 * @return {String}
 */
exports.fetchSubmodule  = co.wrap(function *(metaRepo, submoduleRepo) {
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.instanceOf(submoduleRepo, NodeGit.Repository);

    const remotes = yield submoduleRepo.getRemotes({});
    const originName = remotes[0];

    // If we don't do the fetch, necessary refs are missing and we can't set up
    // the branch.

    yield GitUtil.fetch(submoduleRepo, originName);

    return originName;
});

/**
 * Return a summary of the submodules changed by the specified `commitId` in
 * the specified `repo`.
 *
 * @asycn
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.OID}        commitId
 * @return {Object}
 * @return {Set(String)}  return.added    map from added submodules to sha
 * @return {Set(String)}  return.changed  map from changed submodule to sha
 * @return {Set(String)}  return.removed  list of removed submodules
 */
exports.getSubmoduleChanges = co.wrap(function *(repo, commitId) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commitId, NodeGit.Oid);

    // TODO: as found in test case, removal of submodules is not detected.
    // BROKEN

    const commit = yield repo.getCommit(commitId);
    const diffs = yield commit.getDiffWithOptions({
        ignoreSubmodules: true
    });
    const submoduleNames =
                        yield exports.getSubmoduleNamesForCommit(repo, commit);
    const submoduleNameSet = new Set(submoduleNames);

    const GIT_DIFF_FLAG_EXISTS = 1 << 3;

    let result = {
        added  : new Set(),
        changed: new Set(),
        removed: new Set(),
    };

    diffs.forEach(diff => {
        const numDiffs = diff.numDeltas();
        for (let i = 0; i < numDiffs; ++i) {
            let delta = diff.getDelta(i);
            let newFile = delta.newFile();
            let path = newFile.path();
            if (submoduleNameSet.has(path)) {
                let inNew = 0 !== (newFile.flags() & GIT_DIFF_FLAG_EXISTS);
                if (!inNew) {
                    result.removed.add(path);
                }
                else {
                    let oldFile = delta.oldFile();
                    let inOld = 0 !== (oldFile.flags() & GIT_DIFF_FLAG_EXISTS);
                    if (!inOld) {
                        result.added.add(path);
                    }
                    else {
                        result.changed.add(path);
                    }
                }
            }
        }
    });
    return result;
});

/**
 * Force the submodules in the specified `metaRepo` to be checked out to the
 * commit indicated by HEAD.
 *
 * @asycn
 * @param {NodeGit.Repository} metaRepo
 */
exports.syncSubmodules = co.wrap(function *(metaRepo) {
    assert.instanceOf(metaRepo, NodeGit.Repository);

    const subs = yield exports.getSubmoduleRepos(metaRepo);
    const names = subs.map(x => x.name);
    const shas = yield exports.getCurrentSubmoduleShas(metaRepo, names);
    const syncSubmodule = co.wrap(function *(sub, i) {
        const repo = sub.repo;
        const commit = yield NodeGit.Commit.lookup(repo, shas[i]);
        repo.detachHead();
        yield NodeGit.Reset.reset(repo,
                                  commit,
                                  NodeGit.Reset.TYPE.HARD,
                                  new NodeGit.CheckoutOptions());
    });
    const synchers = subs.map(syncSubmodule);
    yield synchers;
});
