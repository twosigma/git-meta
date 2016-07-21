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
 * This module contains common git utility methods.
 */

const assert  = require("chai").assert;
const co      = require("co");
const colors  = require("colors");
const exec    = require("child-process-promise").exec;
const fs      = require("fs");
const NodeGit = require("nodegit");
const path    = require("path");

const UserError = require("../util/user_error");

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

    if ("" === base || "/" === base) {
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
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(branchName);

    const head = yield repo.getHeadCommit();
    return yield repo.createBranch(branchName,
                                   head,
                                   0,
                                   repo.defaultSignature(),
                                   "git-meta branch");
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
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(branchName);

    try {
        return yield repo.getBranch(branchName);
    }
    catch (e) {
        return null;
    }
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
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(name);

    const remotes = yield repo.getRemotes();
    return remotes.find(x => x === name) !== undefined;
});

/**
 * Return the remote branch having the specified local `branchName` in the
 * remote having the specified `remoteName` in the specified `repo`, or null if
 * no such branch exists.  The behavior is undefined unless 'remoteName' refers
 * to a remote in 'repo'.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             remoteName
 * @param {String}             branchName
 */
exports.findRemoteBranch = co.wrap(function *(repo, remoteName, branchName) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(remoteName);
    assert.isString(branchName);

    // TODO: need to find a way to avoid a linear search of branch names.

    const shorthand = remoteName + "/" + branchName;
    return yield exports.findBranch(repo, shorthand);
});


/**
 * Return the root of the repository in which the current working directory
 * resides, or null if the working directory contains no git repository.
 *
 * @return {String|null}
 */
exports.getRootGitDirectory = function () {
    return getContainingGitDir(process.cwd());
};

/**
 * Return the current repository (as located from the current working
 * directory) or throw a `UserError` exception if no git repository can be
 * located from the current directory.
 *
 * @async
 * @return {NodeGit.Repository}
 */
exports.getCurrentRepo = function () {
    const path = exports.getRootGitDirectory();
    if (null === path) {
        throw new UserError(
            `Could not find Git directory from ${colors.red(process.cwd())}.`);
    }
    return NodeGit.Repository.open(path);
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

    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(remote);
    assert.isString(source);
    assert.isString(target);

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
 *
 * @param {NodeGit.Repository} repo
 */
exports.getCurrentBranchName = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

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
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(commitish);

    try {
        return yield NodeGit.AnnotatedCommit.fromRevspec(repo, commitish);
    }
    catch (e) {
        return null;
    }
});

/**
 * Return a git note for the specified commit and ref, or null if the
 * commit has no note on that ref.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             notesRef
 * @param {String}             oid
 * @return {NodeGit.Note|null}
 */
exports.readNote = co.wrap(function *(repo, notesRef, oid) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(notesRef);
    assert(typeof(oid) === "string" || oid instanceof NodeGit.Oid);

    try {
        return yield NodeGit.Note.read(repo, notesRef, oid);
    }
    catch (e) {
        return null;
    }
});

/**
 * Return a shortened version of the specified `sha`, or `sha` if it is already
 * short enough.
 *
 * @param {String} sha
 * @return {String}
 */
exports.shortSha = function (sha) {
    assert.isString(sha);
    return sha.substr(0, 6);
};

/**
 * Fetch the remote having the specified `remoteName in the specified `repo`.
 * Throw a `UserError` object if the repository cannot be fetched.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             remoteName
 */
exports.fetch = co.wrap(function *(repo, remoteName) {
    // TODO: this is an awful hack because I can't yet figure out how to get
    // nodegit to work with kerberos.  For now, will shell out and use the
    // 'git' command.

    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(remoteName);

    const execString = `\
cd '${repo.workdir()}'
git fetch -q '${remoteName}'
`;
    try {
        return yield exec(execString);
    }
    catch (e) {
        throw new UserError(e.message);
    }
});

/**
 * Return a list the shas of commits in the history of the specified `commit`
 * not present in the history of the specified `remote` in the specified
 * `repo`.  Note that this command does not do a *fetch*; the check is made
 * against what commits are locally known.
 *
 * async
 * @param {NodeGit.Repository} repo
 * @param {String}             remote
 * @param {String}             commit
 * @return {NodeGit.Oid []}
 */
exports.listUnpushedCommits = co.wrap(function *(repo, remote, commit) {
    // I wish there were a simpler way to do this.  Our algorithm:
    // 1. List all the refs for 'remote'.
    // 2. Compute the list of different commits between each the head of each
    //    matching remote ref.
    // 3. Return the shortest list.
    // 4. If no matching refs return a list of all commits that are in the
    //    history of 'commit'.

    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(remote);
    assert.isString(commit);

    const refs = yield repo.getReferenceNames(NodeGit.Reference.TYPE.LISTALL);

    const commitId = NodeGit.Oid.fromString(commit);

    let bestResult = null;

    const regex = new RegExp(`^refs/remotes/${remote}/`);

    //  The `fastWalk` method takes a max count for the number of items it will
    //  return.  We should investigate why some time because I don't think it
    //  should be necessary.  My guess is that they are creating a fixed size
    //  array to populate with the commits; an exponential growth algorithm
    //  like that used by `std::vector` would provide the same (amortized)
    //  performance.  See http://www.nodegit.org/api/revwalk/#fastWalk.
    //
    //  For now, I'm choosing the value 1000000 as something not big enough to
    //  blow out memory but more than large enough for any repo we're likely to
    //  encounter.

    const MAX_COMMIT_COUNT = 1000000;

    const checkRef = co.wrap(function *(name) {

        // If we've already matched the commit, no need to do any checking.

        if ([] === bestResult) {
            return;                                                   // RETURN
        }

        // Check to see if the name of the ref indicates that it is for
        // 'remote'.

        const nameResult = regex.exec(name);
        if (!nameResult) {
            return;                                                   // RETURN
        }

        const refHeadCommit = yield repo.getReferenceCommit(name);
        const refHead = refHeadCommit.id();

        // Use 'RevWalk' to generate the list of commits different between the
        // head of the remote branch and our commit.

        let revWalk = repo.createRevWalk();
        revWalk.pushRange(`${refHead}..${commit}`);
        const commitDiff = yield revWalk.fastWalk(MAX_COMMIT_COUNT);

        // If this list is shorter than the current best list (or there is no
        // current best), store it as the best so far.

        if (null === bestResult || bestResult.length > commitDiff.length) {
            bestResult = commitDiff;
        }
    });

    const refCheckers = refs.map(checkRef);

    yield refCheckers;

    // If we found no results (no branches for 'remote', return a list
    // containing 'commit' and all its history.

    if (null === bestResult) {
        let revWalk = repo.createRevWalk();
        revWalk.push(commitId);
        return yield revWalk.fastWalk(MAX_COMMIT_COUNT);              // RETURN
    }

    return bestResult;
});

/**
 * Return true if the specified `source` commit is up-to-date with the
 * specified `target` commit in the specified `repo`.  A commit is up-to-date
 * with `target` if it is the same commit, or if it is descended from `target`.
 *
 * @private
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             source
 * @param {String}             target
 * @return {Boolean}
 */
exports.isUpToDate = co.wrap(function *(repo, source, target) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(source);
    assert.isString(target);
    if (source === target) {
        return true;                                                  // RETURN
    }
    return yield NodeGit.Graph.descendantOf(repo, source, target);
});
