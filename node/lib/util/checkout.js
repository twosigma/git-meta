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
 * This module contains methods for doing checkouts.
 */
const assert  = require("chai").assert;
const co      = require("co");
const colors  = require("colors");
const NodeGit = require("nodegit");

const GitUtil          = require("./git_util");
const SubmoduleFetcher = require("./submodule_fetcher");
const SubmoduleUtil    = require("./submodule_util");
const UserError        = require("./user_error");

/**
 * Checkout the commit identified by the specified `committish` in the specified
 * `metaRepo`, and update all open submodules to be on the indicated commit,
 * fetching it if necessary.  If `committish` identifies a branch, set that as
 * the current branch.  Throw a `UserError` if `committish` cannot be resolved.
 * Throw a `UserError` if one of the submodules or the meta-repo cannot be
 * checked out.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             committish
 */
exports.checkout = co.wrap(function *(metaRepo, committish) {
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.isString(committish);

    const annotated = yield GitUtil.resolveCommitish(metaRepo, committish);
    if (null === annotated) {
        throw new UserError(`Could not resolve ${colors.red(committish)}.`);
    }
    const commit = yield metaRepo.getCommit(annotated.id());


    const open = yield SubmoduleUtil.listOpenSubmodules(metaRepo);
    const names = yield SubmoduleUtil.getSubmoduleNamesForCommit(metaRepo,
                                                                 commit);
    const shas = yield SubmoduleUtil.getSubmoduleShasForCommit(metaRepo,
                                                               names,
                                                               commit);
    const subFetcher = new SubmoduleFetcher(metaRepo, commit);

    // First, do dry runs.

    let errors = [];

    /**
     * If it is possible to check out the specified `commit` in the specified
     * `repo`, return `null`; otherwise, return an error message.
     */
    const dryRun = co.wrap(function *(repo, commit) {
        try {
            yield NodeGit.Checkout.tree(repo, commit, {
                checkoutStrategy: NodeGit.Checkout.STRATEGY.NONE,
            });
            return null;                                              // RETURN
        }
        catch(e) {
            return e.message;                                         // RETURN
        }
    });

    // Check meta

    const metaError = yield dryRun(metaRepo, commit);
    if (null !== metaError) {
        errors.push(`Unable to check out meta-repo: ${metaError}.`);
    }

    // Try the submodules; store the opened repos and loaded commits for use
    // in the actual checkout later.

    let subRepos = [];     // will contain a list of repositories for sub-repos
    let subCommits = [];   // will contain a list of commits to checkout

    yield open.map(co.wrap(function *(name) {
        // Open repo but not alive on this commit.

        if (!(name in shas)) {
            return; // RETURN
        }

        const repo = yield SubmoduleUtil.getRepo(metaRepo, name);
        const sha = shas[name];
        yield subFetcher.fetchSha(repo, name, sha);
        const commit = yield repo.getCommit(sha);
        subRepos.push(repo);
        subCommits.push(commit);
        const error = yield dryRun(repo, commit);
        if (null !== error) {
            errors.push(
             `Unable to checkout submodule ${colors.yellow(name)}: ${error}.`);
        }
    }));

    // Throw an error if any dry-runs failed.

    if (0 !== errors.length) {
        throw new UserError(errors.join("\n"));
    }

    /**
     * Checkout and set as head the specified `commit` in the specified `repo`.
     */
    const doCheckout = co.wrap(function *(repo, commit) {
        yield NodeGit.Checkout.tree(repo, commit, {
            checkoutStrategy: NodeGit.Checkout.STRATEGY.SAFE,
        });
        repo.setHeadDetached(commit);
    });

    // Now do the actual checkouts.

    yield doCheckout(metaRepo, commit);

    yield open.map(co.wrap(function *(name, index) {
        // Open repo but not alive on this commit.

        if (!(name in shas)) {
            return; // RETURN
        }

        const repo = subRepos[index];
        const commit = subCommits[index];
        yield doCheckout(repo, commit);
    }));

    // if 'committish' is a branch,  make it current

    const branch = yield GitUtil.findBranch(metaRepo, committish);
    if (null !== branch) {
        yield metaRepo.checkoutBranch(branch);
    }
});
