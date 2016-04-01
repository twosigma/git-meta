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
 * This module contains methods for doing checkouts.
 */
const co = require("co");
const NodeGit = require("nodegit");

const GitUtil       = require("./slmu_gitutil");
const SubmoduleUtil = require("./slmu_submoduleutil");

/**
 * Checkout the branch having the specified `branchName` in the specified
 * `metaRepo` and all visible sub-repos.  If the specified `create` is "all"
 * then the behavior is undefined if any repo already has a branch named
 * `branchName`.  If `create` is "none" then the behavior is undefined unless
 * all repos have a branch named `branchName`.  The behavior is undefined
 * unless `create === "none" || create === "some" || create === "all"`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             branchName
 * @param {String}             create
 */
exports.checkout = co.wrap(function *(metaRepo, branchName, create) {

    /**
     * Checkout the branch in the specified `repo`.  Create it if it can't be
     * found.
     */
    const checkout = co.wrap(function *(repo) {
        let branch = yield GitUtil.findBranch(repo, branchName);
        if (null === branch) {
            branch = yield GitUtil.createBranchFromHead(repo, branchName);
        }
        // Do a force because (a) we've already validated that there are no
        // changes and (b) it won't change the branch in the meta repo
        // otherwise.

        let opts = new NodeGit.CheckoutOptions();
        opts.checkoutStrategy = NodeGit.Checkout.STRATEGY.FORCE;
        yield repo.checkoutBranch(branch, opts);
    });

    /**
     * Validate the specified `repo` and fail using the specified `description`
     * if `repo` is not in the correct state according to the `create`
     * parameter.
     */
    const validate = co.wrap(function *(repo, description) {
        const branch = yield GitUtil.findBranch(repo, branchName);
        if (null !== branch && create === "all") {
            console.error(description + " already has a branch named '" +
                          branchName + "'.");
            process.exit(-1);
        }
        if (null === branch && create === "none") {
            console.error(description + " does not have a branch named '" +
                          branchName + "'.");
            process.exit(-1);
        }
    });

    const submodules = yield SubmoduleUtil.getSubmoduleRepos(metaRepo);

    // Skip validation if `"some" === create` because every configuration is
    // valid in that case.

    if ("some" !== create) {
        let validators = submodules.map(sub => validate(sub.repo, sub.name));
        validators.push(validate(metaRepo, "The meta-repo"));
        yield validators;
    }

    // Run checkouts in parallel.

    let checkers = submodules.map(sub => checkout(sub.repo));
    checkers.push(checkout(metaRepo));
    yield checkers;
});
