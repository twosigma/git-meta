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
 * This module contains routines for working with branches.
 */

const GitUtil       = require("./git_util");
const SubmoduleUtil = require("./submodule_util");
const UserError     = require("./user_error");

const co      = require("co");
const colors  = require("colors");
const NodeGit = require("nodegit");

/**
 * Create a branch having the specified `branchName` in the specified
 * `metaRepo` and its subRepos.  Fail if any repo already has a branch 
 * named 'branchName'.  If `any` is true, successfully create the branch 
 * in any repository without the named `branchName`.
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {String}             branchName
 * @param {Boolean}            any
 */
exports.createBranch = co.wrap(function *(metaRepo, branchName, any) {

    const validateRepo = co.wrap(function *(repo, description) {
        const branch = yield GitUtil.findBranch(repo, branchName);
        if (null !== branch) {
            throw new UserError(description + " already has a branch named '" +
                branchName + "'.");
        }
        return 0;
    });

    const submodules = yield SubmoduleUtil.getSubmoduleRepos(metaRepo);

    // If 'any' is not passed, ensure none of the repos already have a 
    // branch by 'branchName'.

    if (!any) {
        let validators = submodules.map(sub =>
            validateRepo(sub.repo, `The sub repo ${colors.red(sub.name)}`)
        );
        validators.push(validateRepo(metaRepo, "The meta repo"));
        yield validators;
    }

    const makeBrancher = co.wrap(function *(repo) {
        // If we're doing "any" repos, we need to see if the branch 
        // already exists and exit if it does. Otherwise, we don't 
        // need to check to see if the branch exists -- we've already 
        // done so.

        if (any) {
            const branch = yield GitUtil.findBranch(repo, branchName);
            if (null !== branch) {
                return;                                               // RETURN
            }
        }
        yield GitUtil.createBranchFromHead(repo, branchName);
    });

    let branchers = submodules.map(sub => makeBrancher(sub.repo));
    branchers.push(makeBrancher(metaRepo));
    yield branchers;
});

/**
 * Delete the branch having the specified `branchName` in the specified
 * `metaRepo` and its subRepos.  Fail if any repo does not have a branch
 * named `branchName`. If `any` is true, successfully delete the branch
 * in any repository with the name `branchName`.

 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {String}  branchName
 * @param {Boolean} any
 */
exports.deleteBranch = co.wrap(function *(metaRepo, branchName, any) {

    const validateRepo = co.wrap(function *(repo, description) {
        const currentBranch = yield repo.getCurrentBranch();
        if (currentBranch.shorthand() === branchName) {
            throw new UserError(description + " has '" + branchName +
                "' as its active branch.");
        }
        if (!any) {
            const branch = yield GitUtil.findBranch(repo, branchName);
            if (null === branch) {
                throw new UserError(description + 
                    " does not have a branch named '" + branchName + "'.");
            }
        }
    });

    const submodules = yield SubmoduleUtil.getSubmoduleRepos(metaRepo);

    let validators = submodules.map(sub =>
        validateRepo(sub.repo, `The sub-repo ${colors.red(sub.name)}`)
    );
    validators.push(validateRepo(metaRepo, "The meta-repo"));

    yield validators;

    const deleteBranch = co.wrap(function *(repo) {
        const branch = yield GitUtil.findBranch(repo, branchName);
        if (null !== branch) {
            NodeGit.Branch.delete(branch);
        }
    });

    let deleters = submodules.map(sub => deleteBranch(sub.repo));
    deleters.push(deleteBranch(metaRepo));
    yield deleters;
});
