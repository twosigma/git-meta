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

/**
 * This module contains methods for opening repositories.
 */
const assert  = require("chai").assert;
const NodeGit = require("nodegit");
const co      = require("co");

const SubmoduleConfigUtil = require("./submodule_config_util");
const SubmoduleUtil       = require("./submodule_util");

/**
 * Open the submodule having the specified `submoduleName` in the specified
 * `repo`; configure it to be checked out on the specified `branchName` on the
 * specified `commitSha`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             submoduleName
 * @param {String}             url
 * @param {String}             branchName
 * @param {String}             commitSha
 * @return {NodeGit.Repository}
 */
exports.openBranchOnCommit = co.wrap(function *(repo,
                                                submoduleName,
                                                url,
                                                branchName,
                                                commitSha) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(submoduleName);
    assert.isString(url);
    assert.isString(branchName);
    assert.isString(commitSha);

    const submoduleRepo = yield SubmoduleConfigUtil.initSubmoduleAndRepo(
                                                                repo.workdir(),
                                                                submoduleName,
                                                                url);

    yield SubmoduleUtil.fetchSubmodule(repo, submoduleRepo);

    const branch = yield submoduleRepo.createBranch(branchName,
                                                    commitSha,
                                                    0,
                                                    repo.defaultSignature(),
                                                    "git-meta branch");

    // And check it out.

    yield submoduleRepo.checkoutBranch(branch);
    return submoduleRepo;
});

/**
 * Open the submodule having the specified `submoduleName` in the specified
 * `repo`.  Return an object containing the submodule and its repository.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             submoduleName
 * @param {String}             url
 * @return {NodeGit.Repository}
 */
exports.open = co.wrap(function *(repo, submoduleName, url) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(submoduleName);
    assert.isString(url);

    const shas = yield SubmoduleUtil.getCurrentSubmoduleShas(repo,
                                                             [submoduleName]);
    const sha = shas[0];

    // Identify the branch name used by the parent repository.  We'll use this
    // name as the branch to configure the new submodule with.

    const activeBranch = yield repo.getCurrentBranch();
    const branchName = activeBranch.shorthand();

    return yield exports.openBranchOnCommit(repo,
                                            submoduleName,
                                            url,
                                            branchName,
                                            sha);
});
