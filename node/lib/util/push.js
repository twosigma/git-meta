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
 * This module contains methods for pushing.
 */

const assert  = require("chai").assert;
const co      = require("co");
const colors  = require("colors");
const NodeGit = require("nodegit");

const GitUtil             = require("./git_util");
const SubmoduleUtil       = require("./submodule_util");
const SyntheticBranchUtil = require("./synthetic_branch_util");
const UserError           = require("./user_error");

/**
 * For each open submodule that exists in the commit indicated by the specified
 * `source`, push a synthetic-meta-ref for the `source` commit.
 * If all sub-repo pushes succeed, push `source` to
 * to the specified `target` branch in `remoteName`.  If any pushes fail, throw
 * a `UserError` object.
 *
 * Note that this strategy is naive: it does not handle the following
 * situations:
 *
 * - closed submodules with commits that need to be pushed
 * - submodules that do not exist in the `source` commit, but did previously
 *   and need synthetic-meta-refs
 * - submodules with divergent histories, i.e., the commit we create the
 *   synthetic-meta-ref for doesn't contain one or more commits that need to be
 *   pushed in its history
 *
 * Addressing these situations would have a performance impact, requiring
 * calculation and traversal of all meta-repo commits being pushed.  We should
 * probably add a way to do an "exhaustive" push.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             remoteName
 * @param {String}             source
 * @param {String}             target
 */
exports.push = co.wrap(function *(repo, remoteName, source, target) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(remoteName);
    assert.isString(source);
    assert.isString(target);

    // First, push the submodules.

    let errorMessage = "";
    const subRepos = yield SubmoduleUtil.getSubmoduleRepos(repo);
    const shas = yield SubmoduleUtil.getSubmoduleShasForBranch(repo, source);
    yield subRepos.map(co.wrap(function *(sub) {
        const subName = sub.name;

        // If no commit for a submodule on this branch, skip it.
        if (!(subName in shas)) {
            return;                                                   // RETURN
        }

        // Push to a synthetic branch; first, calculate name.

        const sha = shas[subName];
        const syntheticName =
                          SyntheticBranchUtil.getSyntheticBranchForCommit(sha);
        const subRepo = sub.repo;

        const pushResult = yield GitUtil.push(subRepo,
                                              remoteName,
                                              sha,
                                              syntheticName);
        if (null !== pushResult) {
            errorMessage +=
           `Failed to push submodule ${colors.yellow(subName)}: ${pushResult}`;
        }
    }));

    // Throw an error if there were any problems pushing submodules; don't push
    // the meta-repo.

    if ("" !== errorMessage) {
        throw new UserError(errorMessage);
    }

    // Finally, push the meta-repo and throw on failure.

    const result = yield GitUtil.push(repo, remoteName, source, target);
    if (null !== result) {
        throw new UserError(`Failed to push meta-repo: ${result}`);
    }
});
