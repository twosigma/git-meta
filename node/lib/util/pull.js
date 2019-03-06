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

const assert  = require("chai").assert;
const co      = require("co");
const colors  = require("colors");
const NodeGit = require("nodegit");

const ConfigUtil    = require("./config_util");
const GitUtil       = require("./git_util");
const RebaseUtil    = require("./rebase_util");
const StatusUtil    = require("./status_util");
const UserError     = require("./user_error");

/**
 * Pull the specified `source` branch from the remote having the specified
 * `remoteName` into the specified `metaRepo`.
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {String}             remoteName
 * @param {String}             source
 */
exports.pull = co.wrap(function *(metaRepo, remoteName, source) {
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.isString(remoteName);
    assert.isString(source);

    // First do some sanity checking on the repos to see if they have a remote
    // with `remoteName` and are clean.

    const validRemote = yield GitUtil.isValidRemoteName(metaRepo, remoteName);

    if (!validRemote) {
        throw new UserError(`Invalid remote name ${colors.red(remoteName)}.`);
    }

    const status = yield StatusUtil.getRepoStatus(metaRepo);

    // Just fetch the meta-repo; rebase will trigger necessary fetches in
    // sub-repos.

    yield GitUtil.fetchBranch(metaRepo, remoteName, source);
    const remoteBranch = yield GitUtil.findRemoteBranch(metaRepo,
                                                        remoteName,
                                                        source);
    if (null === remoteBranch) {
        throw new UserError(`The meta-repo does not have a branch named \
${colors.red(source)} in the remote ${colors.yellow(remoteName)}.`);
    }

    const remoteCommitId = remoteBranch.target();
    const remoteCommit = yield NodeGit.Commit.lookup(metaRepo, remoteCommitId);

    const result = yield RebaseUtil.rebase(metaRepo, remoteCommit, status);
    if (null !== result.errorMessage) {
        throw new UserError(result.errorMessage);
    }
});



/**
 * Return true if the user has requested a rebase (explicitly or via config).
 *
 * @param {Object} args
 * @param {Boolean} args.rebase
 * @param {Nodegit.Repository} repo
 * @param {NodeGit.Branch} branch
 * @async
 * @return bool
 */
exports.userWantsRebase = co.wrap(function*(args, repo, branch) {
    if (args.rebase !== undefined && args.rebase !== null) {
        return args.rebase;
    }

    const branchVar = `branch.${branch.shorthand()}.rebase`;
    const branchVal = yield ConfigUtil.configIsTrue(repo, branchVar);
    if (null !== branchVal) {
        return branchVal;
    }
    return (yield ConfigUtil.configIsTrue(repo, "pull.rebase")) || false;
});
