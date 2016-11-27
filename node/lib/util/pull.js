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
const RebaseUtil    = require("../util/rebase_util");
const Status        = require("../util/status");
const UserError     = require("../util/user_error");

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

    const validRemote = yield GitUtil.isValidRemoteName(metaRepo, remoteName);

    if (!validRemote) {
        throw new UserError(`Invalid remote name ${colors.red(remoteName)}.`);
    }

    const status = yield Status.getRepoStatus(metaRepo);
    Status.ensureCleanAndConsistent(status);

    // Just fetch the meta-repo; rebase will trigger necessary fetches in
    // sub-repos.

    yield GitUtil.fetch(metaRepo, remoteName);
    const remoteBranch = yield GitUtil.findRemoteBranch(metaRepo,
                                                        remoteName,
                                                        source);
    if (null === remoteBranch) {
        throw new UserError(`The meta-repo does not have a branch named \
${colors.red(source)} in the remote ${colors.yellow(remoteName)}.`);
    }

    const remoteCommitId = remoteBranch.target();
    const remoteCommit = yield NodeGit.Commit.lookup(metaRepo, remoteCommitId);

    yield RebaseUtil.rebase(metaRepo, remoteCommit, status);
});
