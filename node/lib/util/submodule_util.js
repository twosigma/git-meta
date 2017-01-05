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

const Submodule           = require("./submodule");
const SubmoduleConfigUtil = require("./submodule_config_util");

/**
 * Return the names of the submodules (visible or otherwise) for the index
 * in the specified `repo`.
 *
 * TODO: I wrote this function because the equivalent
 * `NodeGit.Repository.getSubmoduleNames` method is about 100X slower; we
 * should submit a patch to `libgit2` or `nodegit`.
 *
 * @param {NodeGit.Repository} repo
 * @return {String []}
 */
exports.getSubmoduleNames = co.wrap(function *(repo) {
    const index = yield repo.index();
    const subs = yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, index);
    return Object.keys(subs);
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
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    const map = yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo,
                                                                  commit);
    return Object.keys(map);
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
 * `submoduleNames` in the specified `index`.
 *
 * @param {NodeGit.Index} index
 * @param {String []}      submoduleNames
 * @return {String []}
 */
exports.getCurrentSubmoduleShas = function (index, submoduleNames) {
    assert.instanceOf(index, NodeGit.Index);
    assert.isArray(submoduleNames);
    submoduleNames.forEach(name => assert.isString(name));

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
};

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
 * Return an array containing a list of the currently open submodules of the
 * specified `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @return {String[]}
 */
exports.listOpenSubmodules = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);
    let text = null;
    const configPath = SubmoduleConfigUtil.getConfigPath(repo);
    try {
        // Sync to avoid race conditions
        text = fs.readFileSync(configPath, "utf8");
    }
    catch (e) {
        return [];                                                    // RETURN
    }

    // In at least one situation -- rebase -- Git will add a submodule to
    // the `.git/config` file without actually opening it, meaning that the
    // `.git/config` file cannot be used as the single source of truth and we
    // must verify with `isVisble`, which looks for a repositories `.git` file.

    const openInConfig = SubmoduleConfigUtil.parseOpenSubmodules(text);
    const visCheckers = openInConfig.map(sub => exports.isVisible(repo, sub));
    const visFlags = yield visCheckers;
    let result = [];
    openInConfig.forEach((name, i) => {
        if (visFlags[i]) {
            result.push(name);
        }
    });
    return result;
});

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

    const openArray = yield exports.listOpenSubmodules(repo);
    const openSet = new Set(openArray);

    const submoduleNames = yield exports.getSubmoduleNames(repo);
    const openers = submoduleNames.map(co.wrap(function *(name) {
        const isVisible = openSet.has(name);
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
 * Return a summary of the submodules changed by the specified `commitId` in
 * the specified `repo`.
 *
 * @asycn
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 * @return {Object}
 * @return {Set(String)}  return.added    paths to added submodules
 * @return {Set(String)}  return.changed  paths to changed submodule
 * @return {Set(String)}  return.removed  paths to removed submodules
 */
exports.getSubmoduleChanges = co.wrap(function *(repo, commit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);

    const currentSubs = yield exports.getSubmodulesForCommit(repo, commit);
    let lastSubs = {};
    if (0 !== commit.parentcount()) {
        const parents = yield commit.parents();
        const parentCommit = yield repo.getCommit(parents[0]);
        lastSubs = yield exports.getSubmodulesForCommit(repo, parentCommit);
    }
    let result = {
        added  : new Set(),
        changed: new Set(),
        removed: new Set(),
    };
    for (let name in currentSubs) {
        const last = lastSubs[name];
        if (undefined === last) {
            result.added.add(name);
        }
        else {
            const current = currentSubs[name];
            if (current.sha !== last.sha || current.url !== last.url) {
                result.changed.add(name);
            }
        }
    }
    for (let name in lastSubs) {
        if (!(name in currentSubs)) {
            result.removed.add(name);
        }
    }
    return result;
});

/**
 * Return the states of the submodules in the specified `commit` in the
 * specified `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 * @return {Object} map from submodule name to `Submodule` object
 */
exports.getSubmodulesForCommit = co.wrap(function *(repo, commit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    const urls =
               yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, commit);
    const names = Object.keys(urls);
    const shas = yield exports.getSubmoduleShasForCommit(repo, names, commit);
    let result = {};
    names.forEach(name => {
        result[name] = new Submodule(urls[name], shas[name]);
    });
    return result;
});
