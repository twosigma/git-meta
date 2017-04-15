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

const GitUtil             = require("./git_util");
const DeinitUtil          = require("./deinit_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const SubmoduleFetcher    = require("./submodule_fetcher");

/**
 * Open the submodule having the specified `submoduleName` in the meta-repo
 * associated with the specified `fetcher`; fetch the specified `submoduleSha`
 * using `fetcher` and set HEAD to point to it.  Configure the "origin" remote
 * to the `url` configured in the meta-repo.  If the specified `templatePath`
 * is provided, use it to configure the newly-opened submodule's repository.
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
        yield DeinitUtil.deinit(metaRepo, submoduleName);
        throw e;
    }

    // Check out HEAD

    const commit = yield submoduleRepo.getCommit(submoduleSha);
    yield GitUtil.setHeadHard(submoduleRepo, commit);

    return submoduleRepo;
});
