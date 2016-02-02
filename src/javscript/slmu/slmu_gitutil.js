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
 * This module contains common git utility methods.
 */

const NodeGit = require("nodegit");
const path    = require("path");
const fs      = require("fs");
const co      = require("co");

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
 * Return the branch having the specified `branchName` in the specified `repo`,
 * or null if `repo` does not contain a branch with that name.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String} branchName
 */
exports.findBranch = co.wrap(function *(repo, branchName) {

    const references = yield NodeGit.Reference.list(repo);
    for (var i = 0; i < references.length; ++i) {
        var refName = references[i];
        var ref = yield NodeGit.Reference.lookup(repo, refName);
        if (ref.isBranch() && branchName === ref.shorthand()) {
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

    return  NodeGit.Repository.open(exports.getRootGitDirectory());
};
