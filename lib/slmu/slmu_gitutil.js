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
    for (var i = 0; i < references.length; ++i) {
        var refName = references[i];
        var ref = yield NodeGit.Reference.lookup(repo, refName);
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

    return  NodeGit.Repository.open(exports.getRootGitDirectory());
};

/**
 * Return a list containing the specified `commitId` and the ids of all of its
 * ancestor commits in the specified `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.OID}        commitId
 * @return {NodeGit.OID []}
 */
exports.getCommits = co.wrap(function *(repo, commitId) {
    var revWalk = repo.createRevWalk();
    revWalk.push(commitId);
    return yield revWalk.fastWalk(10000000);
});

/**
 * Return true if the commit identified by the specified `ancestorCommitId` is
 * an ancestor of the commit identified by the specified `descendentCommitId`
 * and false otherwise in the specified `repo`.  Note that a commit is
 * considered to be an ancestor of itself.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.OID}        descendentCommitId
 * @param {NodeGit.OID}        ancestorCommitId
 * @return {Boolean}
 */
exports.isAncestor =
    co.wrap(function *(repo, descendentCommitId, ancestorCommitId) {
    // TODO: find a more optimal way to do this.  You can walk the tree, but
    // the problem is that to get the parents for a commit id you have to get
    // the commit, which requires going through a promise.  Doing a promise for
    // every commit in a large repo is too slow (aroung 8s for the git repo of
    // git).  Looking through all the commits in the git repo for git takes
    // less than a second, so I think this is acceptable for the time being.
    // One possibility would be to deduce this information from the `Merge`

    // Get all the commits that are ancestors of the descendent commit and
    // search.

    const ancestorCommits = yield exports.getCommits(repo, descendentCommitId);
    return ancestorCommits.find(x => x.equal(ancestorCommitId)) !== undefined;
});

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
    const rem = yield NodeGit.Remote.lookup(repo, remote);
    const refspec = "refs/heads/" + source + ":" + "refs/heads/" + target;
    try {
        yield rem.push([refspec]);
        return null;
    }
    catch (e) {
        return e.message;
    }
});
