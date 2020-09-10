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
const fs      = require("fs-promise");
const path    = require("path");
const NodeGit = require("nodegit");

const GitUtil             = require("./git_util");
const Hook                = require("../util/hook");
const SparseCheckoutUtil  = require("./sparse_checkout_util");
const SubmoduleUtil       = require("./submodule_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const SubmoduleFetcher    = require("./submodule_fetcher");

/**
 * @enum {SUB_OPEN_OPTION}
 * Flags that describe whether to open a submodule if it is part of a merge.
 */
const SUB_OPEN_OPTION = {
    FORCE_OPEN    : 0, // non-bare repo and open sub if it is part of a merge
    ALLOW_BARE    : 1, // non-bare repo, do not open submodule unless have to
    FORCE_BARE    : 2, // bare repo, open submodule is not allowed
};
exports.SUB_OPEN_OPTION = SUB_OPEN_OPTION;

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

/**
 * Open the submodule having the specified `submoduleName` in the meta-repo
 * associated with the specified `fetcher`; fetch the specified `submoduleSha`
 * using `fetcher` and set HEAD to point to it.  Configure the "origin" remote
 * to the `url` configured in the meta-repo.  If the specified `templatePath`
 * is provided, use it to configure the newly-opened submodule's repository.
 *
 * Note that after opening one or more submodules,
 * `SparseCheckoutUtil.setSparseBitsAndWriteIndex` must be called so that
 * `SKIP_WORKTREE` is *unset*; since this operation is expensive, we cannot do
 * it automatically each time a submodule is opened.
 *
 * @async
 * @param {SubmoduleFetcher} fetcher
 * @param {String}           submoduleName
 * @param {String}           submoduleSha
 * @param {String|null}      templatePath
 * @param {boolean}          bare
 * @return {NodeGit.Repository}
 */
exports.openOnCommit = co.wrap(function *(fetcher,
                                          submoduleName,
                                          submoduleSha,
                                          templatePath, 
                                          bare) {
    assert.instanceOf(fetcher, SubmoduleFetcher);
    assert.isString(submoduleName);
    assert.isString(submoduleSha);
    assert.isBoolean(bare);
    if (null !== templatePath) {
        assert.isString(templatePath);
    }

    const metaRepoUrl = yield fetcher.getMetaOriginUrl();
    const metaRepo = fetcher.repo;
    const submoduleUrl = yield fetcher.getSubmoduleUrl(submoduleName);


    const wasOpen = new Opener(metaRepo, null).isOpen(submoduleName);

    // Set up the submodule.

    const submoduleRepo = yield SubmoduleConfigUtil.initSubmoduleAndRepo(
                                                                metaRepoUrl,
                                                                metaRepo,
                                                                submoduleName,
                                                                submoduleUrl,
                                                                templatePath, 
                                                                bare);

    // Turn off GC for the submodule
    const config = yield submoduleRepo.config();
    config.setInt64("gc.auto", 0);

    if (bare) {
        return submoduleRepo;                                        // RETURN
    }
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

    if (!wasOpen) {
        // Run post-open-submodule hook with successfully-opened submodules
        yield Hook.execHook(metaRepo, "post-open-submodule", [submoduleName]);
    }

    return submoduleRepo;
});

Opener.prototype._initialize = co.wrap(function *() {
    if (null === this.d_commit) {
        this.d_commit = yield this.d_repo.getHeadCommit();
    }

    // d_cachedSubs: normal subrepo opened and cached by this object
    // d_cachedAbsorbedSubs: absorbed subrepo opened and cached by this object
    // d_openSubs: subs that were open when this object was created
    // d_absorbedSubs: subs that were half open when this object was created
    this.d_cachedSubs = {};
    this.d_cachedAbsorbedSubs = {};
    this.d_openSubs = new Set();
    if (!this.d_repo.isBare()) {
        const openSubsList
            = yield SubmoduleUtil.listOpenSubmodules(this.d_repo);
        this.d_openSubs = new Set(openSubsList);    
    }
    const absorbedSubsList 
        = yield SubmoduleUtil.listAbsorbedSubmodules(this.d_repo);
    this.d_absorbedSubs = new Set(absorbedSubsList);
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
    const subs = Object.keys(this.d_cachedSubs);
    return subs.filter(name => !this.d_openSubs.has(name));
});

/**
 * Opener caches all repos that have previously been gotten, this method
 * removes the sub repo from the absorbed cache given its name. Useful when
 * the repo was previously opened as bare repo, and later need to be
 * opened as a normal submodule.
 * 
 * @param subName
 */
Opener.prototype.clearAbsorbedCache = function (subName) {
    delete this.d_cachedAbsorbedSubs[subName];
};

/**
 * Return true if the submodule having the specified `subName` is fully 
 * openable, return false otherwise.
 *
 * @param {String} subName
 * @return {Boolean}
 */
Opener.prototype.isOpen = function (subName) {
    if (this.d_initialized) {
        return this.d_openSubs.has(subName) || (subName in this.d_cachedSubs);
    } else {
        const modulesDir = path.join(this.d_repo.path(), "modules");
        const submodulePath = path.join(modulesDir, subName);
        const headPath = path.join(submodulePath, "HEAD");
        if (!fs.existsSync(headPath)) {
            return false;
        }
        const gitlinkPath = path.join(this.d_repo.workdir(), subName, ".git");
        return fs.existsSync(gitlinkPath);
    }
};

/**
 * Return true if the submodule is opened nor half opened.
 *
 * @async
 * @param {String} subName
 * @return {Boolean}
 */
Opener.prototype.isAtLeastHalfOpen = co.wrap(function *(subName) {
    if (!this.d_initialized) {
        yield this._initialize();
    }
    return this.d_absorbedSubs.has(subName) ||
        this.d_openSubs.has(subName) ||
        (subName in this.d_cachedSubs) ||
        (subName in this.d_cachedAbsorbedSubs);
});

/**
 * Return true if the submodule is opened as a bare or absorbed repo.
 * 
 * @async
 * @param {String} subName
 * @return {Boolean}
 */
Opener.prototype.isHalfOpened = co.wrap(function *(subName) {
    if (!this.d_initialized) {
        yield this._initialize();
    }
    return (subName in this.d_cachedAbsorbedSubs);
});

/**
 * Get sha of a submodule and open the submodule on that sha
 * 
 * @param {String} subName
 * @returns {NodeGit.Repository} sub repo that is opened.
 */
Opener.prototype.fullOpen = co.wrap(function *(subName) {
    const entry = yield this.d_tree.entryByPath(subName);
    const sha = entry.sha();
    console.log(`\
Opening ${colors.blue(subName)} on ${colors.green(sha)}.`);
    return yield exports.openOnCommit(this.d_fetcher,
                                      subName,
                                      sha,
                                      this.d_templatePath, 
                                      false);
});

/**
 * Return the repository for the specified `submoduleName`, opening it if
 * necessary based on the expected working directory type:
 *  1. FORCE_BARE
 *      - directly return opened absorbed sub if there is one
 *      - open bare repo otherwise
 *  2. ALLOW_BARE
 *      - directly return opened sub if there is one
 *      - directly return opened absorbed sub if there is one
 *      - open absorbed sub
 *  3. FORCE_OPEN
 *      - directly return opened sub if there is one
 *      - open normal repo otherwise
 *
 * Note that after opening one or more submodules,
 * `SparseCheckoutUtil.setSparseBitsAndWriteIndex` must be called so that
 * `SKIP_WORKTREE` is *unset*; since this operation is expensive, we cannot do
 * it automatically each time a submodule is opened.
 *
 * @param {String}  subName
 * @param {SUB_OPEN_OPTION}  openOption
 * @return {NodeGit.Repository}
 */
Opener.prototype.getSubrepo = co.wrap(function *(subName, openOption) {
    if (!this.d_initialized) {
        yield this._initialize();
    }
    let subRepo = this.d_cachedSubs[subName];
    if (undefined !== subRepo) {
        return subRepo;  // it was found
    }
    if (SUB_OPEN_OPTION.FORCE_OPEN !== openOption) {
        subRepo = this.d_cachedAbsorbedSubs[subName];
        if (undefined !== subRepo) {
            return subRepo;
        }
    }
    const openable = this.isOpen(subName);
    const halfOpenable = yield this.isAtLeastHalfOpen(subName);

    switch (openOption) {
        case SUB_OPEN_OPTION.FORCE_BARE:
            subRepo = halfOpenable ?
                yield SubmoduleUtil.getBareRepo(this.d_repo, subName) :
                yield exports.openOnCommit(this.d_fetcher,
                                           subName,
                                           "",
                                           this.d_templatePath, 
                                           true);
            this.d_cachedAbsorbedSubs[subName] = subRepo;
            break;
        case SUB_OPEN_OPTION.ALLOW_BARE:
            if (openable) {
                subRepo = yield SubmoduleUtil.getRepo(this.d_repo, subName);
                this.d_cachedSubs[subName] = subRepo;
            } else {
                subRepo = halfOpenable ?
                    yield SubmoduleUtil.getBareRepo(this.d_repo, subName) :
                    yield exports.openOnCommit(this.d_fetcher,
                                              subName,
                                               "",
                                               this.d_templatePath, 
                                               true);
                this.d_cachedAbsorbedSubs[subName] = subRepo;
            }
            break;
        default:
            subRepo = openable ? 
                yield SubmoduleUtil.getRepo(this.d_repo, subName) :
                yield this.fullOpen(subName);
            this.d_cachedSubs[subName] = subRepo;
            break;
    }
    return subRepo;
});
exports.Opener = Opener;
