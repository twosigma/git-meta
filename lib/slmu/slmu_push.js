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
 * This module contains methods for pushing.
 */

const co = require("co");
const colors = require("colors");
const NodeGit = require("nodegit");

const SubmoduleUtil = require("../slmu/slmu_submoduleutil");
const GitUtil       = require("../slmu/slmu_gitutil");

/**
 * Check the state of the specified meta `repo` against the specified
 * `remoteName`.  For the local branch having the specified `source` name and
 * the remote branch having the specified `target` name.  If it is capable of
 * fast-forward, determine which submodule have changed and return a map from
 * their names to expected shas.
 *
 * @private
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             remoteName
 * @param {String}             source
 * @param {String}             target
 */
const validateAndDiffMetaWithOrigin =
    co.wrap(function *(repo, remoteName, source, target) {

    // Fetch the remote meta-repo.


    /*
    const commits = yield GitUtil.listUnpushedCommits(repo,
                                                      remoteName,
                                                      localCommitId.tostrS());


    if (localCommitId.equal(remoteCommitId)) {
        console.warn("No changes to meta-repo");
        process.exit(0);
    }

    // See if we would be able to fast-forward the meta-repo.  We can
    // fast-forward if the head of the remote branch is an ancestor of the head
    // of the local branch.

    const canFF =
         yield NodeGit.Graph.descendantOf(repo, localCommitId, remoteCommitId);

    if (!canFF) {
        console.error("Cannot fast-forward the meta-repository; please pull.");
        process.exit(-1);
    }

    // Now, let's identify the *changed* sub-modules and their (new) shas.

    const submoduleDiff = yield SubmoduleUtil.getSubmoduleDiff(repo,
                                                               remoteCommitId,
                                                               localCommitId);
    // This is a little cheaty; should clone `add`.

    let result = submoduleDiff.changed;
    for (let name in submoduleDiff.added) {
        result[name] = submoduleDiff.added[name];
    }
    return result;
    */
});

/**
 * Push the specified `source` branch from the specified `submodules` in to
 * specified `target` branch in the remote with the specified `remote` name.
 *
 * @param {Object} submodules     map from submodule name to its repo
 * @param {String} remote
 * @param {String} source
 * @param {String} target
 */
const pushSubmodules = co.wrap(function *(submodules, remote, source, target) {

    let allGood = true;
    const pusher = co.wrap(function *(name, repo) {
        const isValidRemote = yield GitUtil.isValidRemoteName(repo, remote);
        if (!isValidRemote) {
            console.error("The sub-repo '" + name +
                          "' does not have a remote named '" + remote + "'.");
            allGood = false;
            return;                                                   // RETURN
        }
        const result = yield GitUtil.push(repo, remote, source, target);
        if (null !== result) {
            console.error("Failed to push sub-repo '" + name + "' : " +
                          result);
            allGood = false;
        }
    });
    let pushers = [];
    for (let name in submodules) {
        pushers.push(pusher(name, submodules[name]));
    }
    yield pushers;
    if (!allGood) {
        process.exit(-1);
    }
});

/**
 * Validate that each sub-repo is visible, and has the specified 'source'
 * branch pointing to the correct commit indicated in the specified 'commits'
 * map in the specified 'repo'.  Return a map from submodule name to its
 * repository.
 *
 * @private
 * @async
 * @param {NodeGit.Repository} repo
 * @param {Object}             commits from sub-repo name to expected commit
 * @param {String}             source  branch name
 * @return {Object}  map from submodule name to repo
 */
const validateSubmoduleCommits = co.wrap(function *(repo, commits, source) {

    let allSubmodulesGood = true;
    let result = {};

    // Then, verify that each submodule that has been added or changed is
    // visible and pointing to the right commit.

    const verifySubmodule = co.wrap(function *(name, expectedCommitId) {
        const isVis = yield SubmoduleUtil.isVisible(repo, name);
        if (!isVis) {
            console.error("Changes have been recorded for the sub-repo '" +
                          name + "', but it is not visible.");
            allSubmodulesGood = false;
            return;                                                   // RETURN
        }
        const subRepo = yield SubmoduleUtil.getRepo(repo, name);
        const branch = yield GitUtil.findBranch(subRepo, source);
        if (!branch) {
            console.error("Sub-repo '" + name + "' has no branch named '" +
                          source + "'.");
            allSubmodulesGood = false;
            return;                                                   // RETURN
        }

        // In the future, we could probably relax this to be OK as long as the
        // commit on the branch had the expected commit as an ancestor.

        const branchCommitId = branch.target();
        if (!branchCommitId.equal(expectedCommitId)) {
            console.error("Expected sub-repo '" + name +
                          "' to be on the commit: '" +
                          expectedCommitId.tostrS() + "' for branch '" +
                          source + "' but it is on: '" +
                          branchCommitId.tostrS() + "'.");
            allSubmodulesGood = false;
            return;                                                   // RETURN
        }
        result[name] = subRepo;
    });


    let verifiers = [];
    for (let name in commits) {
        verifiers.push(verifySubmodule(name, commits[name]));
    }

    yield verifiers;

    if (!allSubmodulesGood) {
        process.exit(-1);
    }
    return result;
});

/**
 * Return true if the specified 'localCommitId' branch in the specified 'repo'
 * is up-to-date with the specified 'target' branch in the remote having the
 * specified 'remoteName'; otherwise, return false.  Exit in failure if the
 * 'source' is not the valid name for a local branch or if its current commit
 * is not a descendant of the current commit of 'target'.
 *
 * @private
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             remoteName
 * @param {String}             localCommitId
 * @param {String}             target
 */
const seeIfRemoteUpToDate =
                  co.wrap(function *(repo, remoteName, localCommitId, target) {

    const remoteBranch = yield GitUtil.findRemoteBranch(repo,
                                                        remoteName,
                                                        target);

    // If no remote branch, we are not up-to-date.

    if (!remoteBranch) {
        return false;
    }

    const remoteCommitId = remoteBranch.target();

    if (localCommitId.equal(remoteCommitId)) {
        return true;                                                  // RETURN
    }

    // See if we would be able to fast-forward the meta-repo.  We can
    // fast-forward if the head of the remote branch is an ancestor of the head
    // of the local branch.

    const canFF =
         yield NodeGit.Graph.descendantOf(repo, localCommitId, remoteCommitId);

    if (!canFF) {
        console.error(colors.red(
                     "Cannot fast-forward the meta-repository; please pull."));
        process.exit(-1);
    }

    return false;
});

/**
 * Push commits from the specified slim `repo` to the remote having the
 * specified `remoteName` on the specified `source` branch to the specified
 * `target` branch.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             remoteName
 * @param {String}             source
 * @param {String}             target
 */
exports.push = co.wrap(function *(repo, remoteName, source, target) {
    // We are going to do some validations client-side, though final sanity
    // checking can really only be done server-side.
    // 1. See if the remote branch may already be up-to-date.
    // 2. Determine which commits have to be pushed from the meta-repo.
    // 3. Determine which submodules have been changed in those commits.
    // 4. Try to push all open submodules.
    // 5. Stop unless all submodules that have changes in the meta-repo
    //    commits that need to be pushed are successfully pushed.
    // 6. Push the meta-repo.

    const localBranch = yield GitUtil.findBranch(repo, source);
    const localCommitId = localBranch.target();

    const upToDate =
            yield seeIfRemoteUpToDate(repo, remoteName, localCommitId, target);

    if (upToDate) {
        console.warn(colors.yellow("No changes to meta-repo"));
        return;                                                       // RETURN
    }

    if (!localBranch) {
        console.error(`Meta-repo has no local branch named \
${colors.magenta(source)}`);
        process.exit(-1);
    }

    // Get a list of unpushed commits, then calculate all the submodules
    // affected in those commits.

    const unpushedCommits = yield GitUtil.listUnpushedCommits(
                                                       repo,
                                                       remoteName,
                                                       localCommitId.tostrS());

    const changedSubmodules = new Set();

    const unpushedChecker = co.wrap(function *(commitId) {
        const changes =
                       yield SubmoduleUtil.getSubmoduleChanges(repo, commitId);
        changes.added.forEach(name => changedSubmodules.add(name));
        changes.changed.forEach(name => changedSubmodules.add(name));
    });

    // TODO: reject a set of changes where a submodule is removed after it is
    // added or changes are made to it.

    const unpushedCheckers = unpushedCommits.map(unpushedChecker);

    yield unpushedCheckers;

    let good = true;

    // Try to push all submodules.  If a submodule with chagnes cannot be
    // pushed, fail.  For other submodules, just warn.

    const subs = yield SubmoduleUtil.getSubmoduleRepos(repo);

    const subPusher = co.wrap(function *(sub) {
        const name = sub.name;
        const subRepo = sub.repo;
        const result = yield GitUtil.push(subRepo, remoteName, source, target);
        if (null === result) {
            changedSubmodules.delete(name);
            return;                                                   // RETURN
        }
        const message = `Failed to push sub-repo ${colors.cyan(name)}.`;
        if (changedSubmodules.has(name)) {
            changedSubmodules.delete(name);
            console.error(message);
            console.error(result);
            good = false;
        }
        else {
            console.error(message);
            console.error(result);
        }
    });

    const subPushers = subs.map(subPusher);
    yield subPushers;

    changedSubmodules.forEach(name => {
        good = false;
        console.error(`Sub-repo ${colors.cyan(name)} has changed in the \
meta-repo but is not open.`);
    });

    // Finally, if everything is good, push the meta-repo.

    if (!good) {
        const text = `One or more submodules with changes could not be \
pushed, not pushing the meta-repo.`;
        console.error(colors.red(text));
        process.exit(-1);
    }

    yield GitUtil.push(repo, remoteName, source, target);
});
