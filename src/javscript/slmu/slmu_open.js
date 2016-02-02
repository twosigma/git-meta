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
 * This module contains methods for opening repositories.
 */

const GitUtil = require("./slmu_gitutil");
const SubmoduleUtil = require("./slmu_submoduleutil");

const NodeGit = require("nodegit");
const co      = require("co");

/**
 * Open the submodule having the specified `submoduleName` in the current
 * repository.
 *
 * @async
 * @param {String} submoduleName
 */
exports.open = co.wrap(function *(submoduleName) {

    const repo      = yield GitUtil.getCurrentRepo();
    const submodule = yield NodeGit.Submodule.lookup(repo, submoduleName);

    if (yield SubmoduleUtil.isVisible(repo, submoduleName)) {
        console.warn("Sub-repo '" + submoduleName + "' is already open.");
        return;                                                       // RETURN
    }

    yield submodule.init(1);

    const submoduleRepo = yield submodule.repoInit(1);

    yield SubmoduleUtil.fetchSubmodule(repo, submoduleRepo);

    const commitId = submodule.headId();

    // And we need to identify the branch name used by the parent repository.
    // We'll use this name as the branch to configure the new submodule with.

    const activeBranch = yield repo.getCurrentBranch();
    const branchName = activeBranch.shorthand();

    // Finally, we can create the branch.

    const branch = yield submoduleRepo.createBranch(branchName,
                                                    commitId,
                                                    0,
                                                    repo.defaultSignature(),
                                                    "slim submodule branch");

    // And check it out.

    yield submoduleRepo.checkoutBranch(branch);
});
