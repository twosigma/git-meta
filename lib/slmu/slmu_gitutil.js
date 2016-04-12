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
"use strict";

/**
 * This module contains common git utility methods.
 */

const NodeGit = require("nodegit");
const path    = require("path");
const fs      = require("fs");
const co      = require("co");

const exec = require("child-process-promise").exec;

/**
 * If the directory identified by the specified `dir` contains a ".git"
 * directory, return it.  Otherwise, return the first parent directory of `dir`
 * containing a `.git` directory.  If no such directory exists, return `None`.
 *
 * @private
 * @param {String} dir
 * @return {String}
 */
function getContainingGitDir(dir) {

    const gitDir = path.join(dir, ".git");
    if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
        return dir;                                                   // RETURN
    }

    const base = path.dirname(dir);

    if ("" === base) {
        return null;                                                  // RETURN
    }

    return getContainingGitDir(base);
}

/**
 * Create a branch having the specified `branchName` in the specified `repo`
 * pointing to the current head.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String} branchName
 * @return {NodeGit.Branch}
 */
exports.createBranchFromHead = co.wrap(function *(repo, branchName) {

    const head = yield repo.getHeadCommit();
    return yield repo.createBranch(branchName,
                                   head,
                                   0,
                                   repo.defaultSignature(),
                                   "slim brach");
});

/**
 * Return the branch having the specified local `branchName` in the specified
 * `repo`, or null if `repo` does not contain a branch with that name.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String} branchName
 */
exports.findBranch = co.wrap(function *(repo, branchName) {
    // TODO: need to find a way to avoid a linear search of branch names.

    const references = yield NodeGit.Reference.list(repo);
    for (let i = 0; i < references.length; ++i) {
        let refName = references[i];
        let ref = yield NodeGit.Reference.lookup(repo, refName);
        if (ref.isBranch() && branchName === ref.shorthand()) {
            return ref;
        }
    }
    return null;
});

/**
 * Return true if the specified `repo` has a remote with the specified `name`
 * and false otherwise.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             name
 * @return {Boolean}
 */
exports.isValidRemoteName = co.wrap(function *(repo, name) {
    const remotes = yield repo.getRemotes();
    return remotes.find(x => x === name) !== undefined;
});

/** Return the remote branch having the specified local `branchName` in the
 * remote having the specified `remoteName` in the specified `repo`, or null if
 * no such branch exists.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             remoteName
 * @param {String}             branchName
 */
exports.findRemoteBranch = co.wrap(function *(repo, remoteName, branchName) {
    // TODO: need to find a way to avoid a linear search of branch names.

    const shorthand = remoteName + "/" + branchName;
    const references = yield NodeGit.Reference.list(repo);
    for (let i = 0; i < references.length; ++i) {
        let refName = references[i];
        let ref = yield NodeGit.Reference.lookup(repo, refName);
        if (ref.isRemote() && shorthand === ref.shorthand()) {
            return ref;
        }
    }
    return null;
});


/**
 * Return the root of the repository in which the specified `path` is located.
 * The behavior is undefined unless `path` is in a Git repository.
 *
 * @return {String}
 */
exports.getRootGitDirectory = function () {

    return getContainingGitDir(process.cwd());
};

/**
 * Return the current repository (as located from the current working
 * directory).
 *
 * @async
 * @return {NodeGit.Repository}
 */
exports.getCurrentRepo = function () {

    return NodeGit.Repository.open(exports.getRootGitDirectory());
};

/**
 * Push the specified `source` branch in the specified `repo` to the specified
 * `target` branch in the specified `remote` repository.  Return null if the
 * push succeeded and string containing an error message if the push failed.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             remote
 * @param {String}             source
 * @param {String}             target
 * @return {String} [return]
 */
exports.push = co.wrap(function *(repo, remote, source, target) {
    // TODO: this is an awful hack because I can't yet figure out how to get
    // nodegit to work with kerberos.  For now, will shell out and use the
    // 'git' command.

    const execString = `\
cd ${repo.workdir()}
git push ${remote} ${source}:${target}
`;
    try {
        yield exec(execString);
        return null;
    }
    catch (e) {
        return e.message;
    }
});

/**
 * Return the name of the current branch in the specified `repo` or null if
 * there is no current branch.
 */
exports.getCurrentBranchName = co.wrap(function *(repo) {
    if (1 !== repo.headDetached()) {
        const branch = yield repo.getCurrentBranch();
        return branch.shorthand();
    }
    return null;
});

/**
 * Return the commit for the specified `commitish` in the specified `repo` or
 * null if `commitish` cannot be resolved.  Generally, `commitish` may be the
 * name of a branch or a partial commit SHA.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             commitish
 * @return {NodeGit.AnnotatedCommit|null}
 */
exports.resolveCommitish = co.wrap(function *(repo, commitish) {
    try {
        return yield NodeGit.AnnotatedCommit.fromRevspec(repo, commitish);
    }
    catch (e) {
        return null;
    }
});

/**
 * Return a shortened version of the specified `sha`.
 *
 * @param {String} sha
 * @return {String}
 */
exports.shortSha = function (sha) {
    return sha.substr(0, 6);
};

/**
 * Fetch the remote having the specified `remoteName in the specified `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             remoteName
 */
exports.fetch = function (repo, remoteName) {
    // TODO: this is an awful hack because I can't yet figure out how to get
    // nodegit to work with kerberos.  For now, will shell out and use the
    // 'git' command.

    const execString = `\
cd ${repo.workdir()}
git fetch ${remoteName}
`;
    return exec(execString);
};
