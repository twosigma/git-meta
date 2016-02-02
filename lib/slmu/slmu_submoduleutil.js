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
 * This module contains utility methods for working with submodules.
 */

const co      = require("co");
const NodeGit = require("nodegit");

/**
 * Return true if the submodule having the specified `submoduleName` in the
 * specified `repo` is visible and false otherwise.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             submoduleName
 */
exports.isVisible = co.wrap(function *(repo, submoduleName) {

    // From libgit2 submodule.h; otherwise not documented in nodegit or
    // libgit2.

    const GIT_SUBMODULE_STATUS_IN_WD = (1 << 3);
    const status = yield NodeGit.Submodule.status(repo, submoduleName, 0);

    return 0 !== (status & GIT_SUBMODULE_STATUS_IN_WD);
});

/**
 * Return an array containing the submodules for the specified `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @return {NodeGit.Submodule []}
 */
exports.getSubmodules = co.wrap(function *(repo) {

    const submoduleNames = yield repo.getSubmoduleNames();
    const openers = submoduleNames.map(name => {
        return NodeGit.Submodule.lookup(repo, name);
    });
    const submodules = yield openers;
    return submodules;
});

/**
 * Return an array containing the submodules and repositories of the visible
 * submodules in the specified `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @return {Object}
 * @return {NodeGit.Submodule}  return.submodule
 * @return {NodeGit.Repository} return.repo
 */
exports.getSubmoduleRepos = co.wrap(function *(repo) {

    const submoduleNames = yield repo.getSubmoduleNames();
    const openers = submoduleNames.map(co.wrap(function *(name) {
        const isVisible = yield exports.isVisible(repo, name);
        if (!isVisible) {
            return null;
        }
        const submodule = yield NodeGit.Submodule.lookup(repo, name);
        const subRepo = yield submodule.open();
        return {
            submodule: submodule,
            repo     : subRepo,
        };
    }));
    const repos = yield openers;
    return repos.filter(x => x !== null);
});

/**
 * Fetch the specified `submoduleRpo` from the specified `metaRepo` and return
 * the name of the origin of this submodule.
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {NodeGit.Repository} submoduleRepo
 * @return {String}
 */
exports.fetchSubmodule  = co.wrap(function *(metaRepo, submoduleRepo) {

    const remotes = yield submoduleRepo.getRemotes({});
    const originName = remotes[0];

    // If we don't do the fetch, necessary refs are missing and we can't set up
    // the branch.

    yield submoduleRepo.fetch(originName, new NodeGit.FetchOptions());

    return originName;
});
