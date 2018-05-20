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
const co      = require("co");
const colors  = require("colors");
const NodeGit = require("nodegit");

const GitUtil             = require("./git_util");
const SparseCheckoutUtil  = require("./sparse_checkout_util");
const SubmoduleUtil       = require("./submodule_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const SubmoduleFetcher    = require("./submodule_fetcher");

/**
 * Open the submodule having the specified `submoduleName` in the meta-repo
 * associated with the specified `fetcher`; fetch the specified `submoduleSha`
 * using `fetcher` and set HEAD to point to it.  Configure the "origin" remote
 * to the `url` configured in the meta-repo.  If the specified `templatePath`
 * is provided, use it to configure the newly-opened submodule's repository.
 *
 * Note that after opening one or more submodules,
 * `SparseCheckoutUtil.writeMetaIndex` must be called so that `SKIP_WORKTREE`
 * is *unset*; since this operation is expensive, we cannot do it automatically
 * each time a submodule is opened.
 *
 * @async
 * @param {SubmoduleFetcher} fetcher
 * @param {String}           submoduleName
 * @param {String}           submoduleSha
 * @param {String|null}      templatePath
 * @return {NodeGit.Repository}
 */
exports.openOnCommit = co.wrap(function *(fetcher,
                                          submoduleName,
                                          submoduleSha,
                                          templatePath) {
    assert.instanceOf(fetcher, SubmoduleFetcher);
    assert.isString(submoduleName);
    assert.isString(submoduleSha);
    if (null !== templatePath) {
        assert.isString(templatePath);
    }
    const metaRepoUrl = yield fetcher.getMetaOriginUrl();
    const metaRepo = fetcher.repo;
    const submoduleUrl = yield fetcher.getSubmoduleUrl(submoduleName);

    // Set up the submodule.

    const submoduleRepo = yield SubmoduleConfigUtil.initSubmoduleAndRepo(
                                                                metaRepoUrl,
                                                                metaRepo,
                                                                submoduleName,
                                                                submoduleUrl,
                                                                templatePath);

    // Fetch the needed sha.  Close if the fetch fails; otherwise, the
    // repository ends up in a state where it things the submodule is open, but
    // it's actually not.

    try {
        yield fetcher.fetchSha(submoduleRepo, submoduleName, submoduleSha);
    }
    catch (e) {
        yield SubmoduleConfigUtil.deinit(metaRepo, [submoduleName]);
        throw e;
    }

    // Check out HEAD

    const commit = yield submoduleRepo.getCommit(submoduleSha);
    yield GitUtil.setHeadHard(submoduleRepo, commit);

    // If we're in sparse mode, we need to add a submodule to the
    // `.git/info/sparse-checkout` file so that it's "visible".

    if (yield SparseCheckoutUtil.inSparseMode(metaRepo)) {
        yield SparseCheckoutUtil.addToSparseCheckoutFile(metaRepo,
                                                         submoduleName);
    }
    return submoduleRepo;
});

/**
 * @class {Opener}
 * class for opening and retrieving submodule repositories on-demand
 */
class Opener {
    /**
     * Create a new object for retreiving submodule repositories on-demand in
     * the specified `repo`.
     *
     * @param {NodeGit.Repository} repo
     * @param {NodeGit.Commit}     commit
     */
    constructor(repo, commit) {
        assert.instanceOf(repo, NodeGit.Repository);
        if (null !== commit) {
            assert.instanceOf(commit, NodeGit.Commit);
        }
        this.d_repo = repo;
        this.d_commit = commit;
        this.d_initialized = false;
    }

    /**
     * @property {NodeGit.Repository} the repo associated with this object
     */
    get repo() {
        return this.d_repo;
    }
}

Opener.prototype._initialize = co.wrap(function *() {
    if (null === this.d_commit) {
        this.d_commit = yield this.d_repo.getHeadCommit();
    }
    this.d_subRepos = {};
    const openSubsList = yield SubmoduleUtil.listOpenSubmodules(this.d_repo);
    this.d_openSubs = new Set(openSubsList);
    this.d_templatePath =
                        yield SubmoduleConfigUtil.getTemplatePath(this.d_repo);
    this.d_fetcher = new SubmoduleFetcher(this.d_repo, this.d_commit);
    this.d_initialized = true;
    this.d_tree = yield this.d_commit.getTree();
});

Opener.prototype.fetcher = co.wrap(function *() {
    if (!this.d_initialized) {
        yield this._initialize();
    }
    return this.d_fetcher;
});

/**
 * Return the set of names of the submodules that were open when this object
 * was created.
 *
 * @return {Set}
 */
Opener.prototype.getOpenSubs = co.wrap(function*() {
    if (!this.d_initialized) {
        yield this._initialize();
    }
    return this.d_openSubs;
});

/**
 * Return an array containing the names of submodules opened by this object.
 *
 * @return {Set}
 */
Opener.prototype.getOpenedSubs = co.wrap(function*() {
    if (!this.d_initialized) {
        yield this._initialize();
    }
    const subs = Object.keys(this.d_subRepos);
    return subs.filter(name => !this.d_openSubs.has(name));
});

/**
 * Return true if the submodule having the specified `subName` is open and
 * false otherwise.
 *
 * @param {String} subName
 * @return {Boolean}
 */
Opener.prototype.isOpen = co.wrap(function *(subName) {
    if (!this.d_initialized) {
        yield this._initialize();
    }
    return this.d_openSubs.has(subName) || (subName in this.d_subRepos);
});

/**
 * Return the repository for the specified `submoduleName`, opening it if
 * necessary.
 *
 * Note that after opening one or more submodules,
 * `SparseCheckoutUtil.writeMetaIndex` must be called so that `SKIP_WORKTREE`
 * is *unset*; since this operation is expensive, we cannot do it automatically
 * each time a submodule is opened.
 *
 * @param {String} subName
 * @return {NodeGit.Repository}
 */
Opener.prototype.getSubrepo = co.wrap(function *(subName) {
    if (!this.d_initialized) {
        yield this._initialize();
    }
    let subRepo = this.d_subRepos[subName];
    if (undefined !== subRepo) {
        return subRepo;  // it was found
    }
    if (this.d_openSubs.has(subName)) {
        subRepo = yield SubmoduleUtil.getRepo(this.d_repo, subName);
    }
    else {
        const entry = yield this.d_tree.entryByPath(subName);
        const sha = entry.sha();
        console.log(`\
Opening ${colors.blue(subName)} on ${colors.green(sha)}.`);
        subRepo = yield exports.openOnCommit(this.d_fetcher,
                                             subName,
                                             sha,
                                             this.d_templatePath);
    }
    this.d_subRepos[subName] = subRepo;
    return subRepo;
});
exports.Opener = Opener;
