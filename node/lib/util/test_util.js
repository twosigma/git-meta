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
 * This module contains methods used in testing other git-meta components.
 */

const ConfigUtil          = require("./config_util");

const assert  = require("chai").assert;
const co      = require("co");
const fs      = require("fs-promise");
const path    = require("path");
const NodeGit = require("nodegit");
const temp    = require("temp").track();

/**
 * Return the path to a newly-created temporary directory.
 *
 * @async
 * @return {String}
 */
exports.makeTempDir = co.wrap(function *() {
    const path = yield (new Promise(function (fullfill, reject) {
        temp.mkdir("git-meta-test", function (err, path) {
            if (err) {
                reject(err);
            }
            else {
                fullfill(path);
            }
        });
    }));
    return yield fs.realpath(path);
});

/**
 * Return true if the specified `firstPath` and `secondPath` refer to the same
 * real path, e.g., two different symlinks to the same underlying file.  The
 * behavior is undefined unless 'firstPath' and 'secondPath' refer to actual
 * files or directories.
 *
 * @async
 * @param {String} firstPath
 * @param {String} secondPath
 * @return {Boolean}
 */
exports.isSameRealPath = co.wrap(function *(firstPath, secondPath) {
    assert(yield exports.pathExists(firstPath));
    assert(yield exports.pathExists(secondPath));

    const firstRealPath = yield fs.realpath(firstPath);
    const secondRealPath = yield fs.realpath(secondPath);
    return firstRealPath === secondRealPath;
});

/**
 * If the specified `path` is provided, create and return repo in `path`,
 * otherwise, create it in an unspecified temp directory.
 * The returned repository will be in the specified state:
 * - not-bare
 * - contains at least one commit
 * - contains the file "README.md"
 * - on branch 'master'
 * - working directory and index are clean
 *
 * @async
 * @param {String} [path]
 * @return {NodeGit.Repository}
 */
exports.createSimpleRepository = co.wrap(function *(repoPath) {
    if (undefined === repoPath) {
        repoPath = yield exports.makeTempDir();
    }
    else {
        assert.isString(repoPath);
    }
    const repo = yield NodeGit.Repository.init(repoPath, 0);
    const fileName = "README.md";
    const filePath = path.join(repoPath, fileName);
    yield fs.writeFile(filePath, "");
    const sig = yield ConfigUtil.defaultSignature(repo);
    yield repo.createCommitOnHead([fileName], sig, sig, "first commit");
    return repo;
});

/**
 * Return a non-bare repository hosted in a temporary directory in the
 * following state:
 * - not-bare
 * - has two branches, 'master' and branchName
 * - content is identical in two branches
 * - contains at least one commit
 * - contains the file "README.md"
 * - on branch branchName
 * - working directory and index are clean
 *
 * @async
 * @param {String} branchName
 * @return {NodeGit.Repository}
 */
exports.createSimpleRepositoryOnBranch = co.wrap(function *(branchName) {
    const repo = yield exports.createSimpleRepository();

    const commit = yield repo.getHeadCommit();
    const publicBranch = yield repo.createBranch(branchName, commit, 0);
    yield repo.setHead(publicBranch.name());

    return repo;
});

/**
 * Return true if the specified 'path' exists and false otherwise.
 *
 * @async
 * @param {String} path
 * @return {Boolean}
 */
exports.pathExists = co.wrap(function *(path) {
    assert.isString(path);
    try {
        yield fs.stat(path);
        return true;
    }
    catch (e) {
        return false;
    }
});

/**
 * Return a simple repository (as returned by 'createSimpleRepository' and a
 * bare remote of which it is a clone.
 *
 * @async
 * @return {Object}
 * @return {NodeGit.Repository} return.bare
 * @return {NodeGit.Repository} return.clone
 */
exports.createRepoAndRemote = co.wrap(function *() {
    const firstSimple = yield exports.createSimpleRepository();
    const barePath = yield exports.makeTempDir();
    const bare = yield NodeGit.Clone.clone(firstSimple.workdir(), barePath, {
        bare: 1
    });
    const clonePath = yield exports.makeTempDir();
    const clone = yield NodeGit.Clone.clone(barePath, clonePath);
    return {
        bare: bare,
        clone: clone,
    };
});

/**
 * Remove the files backing the specified `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 */
exports.cleanup = function () {
    return new Promise((fullfill, reject) => {
        temp.cleanup(function (err, stats) {
            if (err) {
                reject(err);
            }
            else {
                fullfill(stats);
            }
        });
    });
};

/**
 * Create and return a new commit on the head of the specified `repo`, adding
 * the specified `files`, with an aribtrary commit message.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String []}          files
 * @return {NodeGit.Commit}
 */
exports.makeCommit = co.wrap(function *(repo, files) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isArray(files);
    files.forEach((name, i) => assert.isString(name, i));

    const sig = yield ConfigUtil.defaultSignature(repo);
    const commitId = yield repo.createCommitOnHead(files,
                                                   sig,
                                                   sig,
                                                   "message\n");
    return yield repo.getCommit(commitId);
});

/**
 * Create and return a new commit on the head of the specified `repo` by
 * appending data to the "README.md" file in its root.
 *
 * @param {NodeGit.Repository} repo
 * @return {NodeGit.Commit}
 */
exports.generateCommit = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const readmePath = path.join(repo.workdir(), "README.md");
    yield fs.appendFile(readmePath, "data");
    return yield exports.makeCommit(repo, ["README.md"]);
});

/**
 * Return a repo that is a bare copy of the specified `repo`, but that
 * otherwise has no relationshipt to it (i.e., no remote), into the specified
 * `path`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             path
 * @return {NodeGit.Repository}
 */
exports.makeBareCopy = co.wrap(function *(repo, path) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(path);

    const bare = yield NodeGit.Clone.clone(repo.workdir(), path, {
        bare: 1
    });

    // Record the branches that exist in the bare repo.

    let existingBranches = {};
    const bareRefs = yield bare.getReferences();
    bareRefs.forEach(r => existingBranches[r.shorthand()] = true);

    // Then create all the branches that weren't copied initially.

    const refs = yield repo.getReferences();
    const sig = yield ConfigUtil.defaultSignature(bare);
    for (let i = 0; i < refs.length; ++i) {
        const ref = refs[i];
        const shorthand = ref.shorthand();
        if (ref.isBranch() && !(shorthand in existingBranches)) {
            yield bare.createBranch(ref.shorthand(),
                                    ref.target(),
                                    1,
                                    sig,
                                    "i made a branch");
        }
    }

    // And then remove the original remote.

    yield NodeGit.Remote.delete(bare, "origin");
    return bare;
});
