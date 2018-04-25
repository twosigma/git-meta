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
const NodeGit = require("nodegit");

const GitUtil             = require("./git_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const UserError           = require("./user_error");

/**
 * This class provides a way to fetch submodules from a specific commit in a
 * meta-repo that is simplified (meta-repo URL will be automatically derived)
 * and optimized (sub-repo URLs are read in one shot from configuration, only
 * if needed).
 */
class SubmoduleFetcher {

    /**
     * Create a `SubmoduleFetcher` object that can fetch shas for submodules in
     * the specified meta `repo` using URLs specified on the specified
     * `commit`.  Resolve submodule URLs against the specified `metaOriginUrl`,
     * if provided, or the URL of the remote named "origin" in `repo`
     * otherwise.  If `repo` has no remote named "origin", and `fetchSha` is
     * called for a submodule that has a relativre URL, throw a `UserError`.
     * If `null === commit`, no URLS are available.
     *
     * @param {NodeGit.Repository}  repo
     * @param {NodeGit.Commit|null} commit
     */
    constructor(repo, commit) {
        assert.instanceOf(repo, NodeGit.Repository);
        if (null !== commit) {
            assert.instanceOf(commit, NodeGit.Commit);
        }

        this.d_repo   = repo;
        this.d_commit = commit;

        if (null === commit) {
            this.d_urls = {};
        } else {
            this.d_urls = null;
        }

        // d_metaOrigin may have three types of values:
        // 1. undefined -- we haven't tried to access it yet
        // 2. null      -- no 'origin' for 'repo'
        // 3. <string>  -- the URL for the meta repo's origin remote

        this.d_metaOriginUrl = undefined;
    }

    /**
     * @param {NodeGit.Repository} repo meta-repo associated with this fetcher
     */
    get repo() {
        return this.d_repo;
    }

    /**
     * @param {NodeGit.Commit|null} commit commit associated with this fetcher
     */
    get commit() {
        return this.d_commit;
    }
}

/**
 * @async
 * Return the metaOriginUrl used to resolve relative sub URLs.
 * @return {String|null}
 */
SubmoduleFetcher.prototype.getMetaOriginUrl = co.wrap(function *() {
    // If we haven't computed the URL yet, it will be `undefined`.  Null
    // indicates that no URL was provided and there is no origin.

    if (undefined === this.d_metaOriginUrl) {
        this.d_metaOriginUrl = yield GitUtil.getOriginUrl(this.d_repo);
    }
    return this.d_metaOriginUrl;
});

/**
 * @async
 * Return the submodule URL configured in the meta-repo on the specified
 * commit for the submodule having the specified `name`.  Throw a user error if
 * the submodule does  not have a configured URL for `this.commit`.
 * @param {String} name
 */
SubmoduleFetcher.prototype.getSubmoduleUrl = co.wrap(function *(name) {
    assert.isString(name);
    if (null === this.d_urls) {
        this.d_urls = yield SubmoduleConfigUtil.getSubmodulesFromCommit(
                                                                this.d_repo,
                                                                this.d_commit);
    }
    if (!(name in this.d_urls)) {
        throw new UserError(`No configured url for submodule ${name}.`);
    }
    return this.d_urls[name];
});

/**
 *
 * Fetch the specified `sha` in the specified submodule `repo` having the
 * specified `name`.
 *
 * TODO: We may want to consider fetching from remotes other than `origin` if
 * the fetch from `origin` fails.
 *
 * @param {Nodegit.Repository} repo
 * @param {String}             name
 * @param {String}             sha
 */
SubmoduleFetcher.prototype.fetchSha = co.wrap(function *(repo, name, sha) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(name);
    assert.isString(sha);

    const subUrl = yield this.getSubmoduleUrl(name);
    const metaUrl = yield this.getMetaOriginUrl();
    const urlToFetch = SubmoduleConfigUtil.resolveSubmoduleUrl(metaUrl,
                                                               subUrl);
    yield GitUtil.fetchSha(repo, urlToFetch, sha);
});

module.exports = SubmoduleFetcher;
