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

const co      = require("co");
const colors  = require("colors");
const NodeGit = require("nodegit");

const GitUtil       = require("../util/git_util");
const Rebase        = require("../util/rebase");
const Status        = require("../util/status");
const SubmoduleUtil = require("../util/submodule_util");

/**
 * Fail and log if the specified `metaRepo` or any of the specefied
 * `submodules` cannot be pulled.  A repository cannot be pulled if:
 *
 * - it has unstaged changes
 * - it has staged, uncommitted changes
 * - it does not have a remote with the specified `remoteName`
 *
 * @private
 * @async
 * @param {NodeGit.Repository} repo
 * @param {Object}             submodules
 * @param {NodeGit.Submodules} submodules.submodule
 * @param {NodeGit.Repository} submodules.repo
 * @param {String}             remoteName
 */
const validateRepos = co.wrap(function *(metaRepo, submodules, remoteName) {

    let allGood = true;
    const checker = co.wrap(function *(repo, description) {

        const validRemote = yield GitUtil.isValidRemoteName(repo, remoteName);
        if (!validRemote) {
            allGood = false;
            console.error(description + " does not have a remote named '" +
                          remoteName + "'.");
        }
    });
    let checkers = submodules.map(sub => {
        checker(sub.repo, `The sub-repo ${colors.red(sub.name)}`);
    });
    checkers.push(checker(metaRepo, "The meta-repo"));
    yield checkers;
    if (!allGood) {
        process.exit(-1);
    }
});

/**
 * Pull the specified `source` branch from the remote having the specified
 * `remoteName` into the specified `metaRepo`.  If the specified `any` is true,
 * attempt to pull from all repositories that do not have local changes.
 * Otherwise, fail if any visible repositories or the meta repository has
 * uncommitted changes.
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {Boolean}            any
 * @param {String}             remoteName
 * @param {String}             source
 */
exports.pull = co.wrap(function *(metaRepo, remoteName, source) {
    // 1. Validate that no repos have local modifications and that they all
    //    have the remote with the name `remoteName`.
    // 2. Fetch the meta-repo and all sub-repos.
    // 3. Perform a rebase.

    // First do some sanity checking on the repos to see if they have a remote
    // with `remoteName` and are clean.

    yield Status.ensureCleanAndConsistent(metaRepo);

    // Fetch and validate the sub-repos.

    const submodules = yield SubmoduleUtil.getSubmoduleRepos(metaRepo);
    const subFetchers = submodules.map(sub =>
                                       GitUtil.fetch(sub.repo, remoteName));
    yield subFetchers;
    yield validateRepos(metaRepo, submodules, remoteName);

    // Next, fetch the meta-repo and check to see if it needs to be rebased.

    yield GitUtil.fetch(metaRepo, remoteName);
    const remoteBranch = yield GitUtil.findRemoteBranch(metaRepo,
                                                        remoteName,
                                                        source);
    if (null === remoteBranch) {
        console.error("The meta-repo does not have a branch named '" +
                      source + "' in the remote '" + remoteName + "'.");
        process.exit(-1);
    }

    const remoteCommitId = remoteBranch.target();
    const remoteCommit = yield NodeGit.Commit.lookup(metaRepo, remoteCommitId);

    yield Rebase.rebase(metaRepo, remoteCommit);
});
