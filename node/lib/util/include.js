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
 * This module contains methods for including sub repositories.
 */

const co            = require("co");
const NodeGit       = require("nodegit");
const GitUtil       = require("./git_util");
const UserError     = require("./user_error");

/**
 * Add a submodule to the repository at the specified `url` rooted at the
 * specified `path`.
 *
 * @async
 * @param {String} url
 * @param {String} path
 */
exports.include = co.wrap(function* (repo, url, path) {

    // Setting up a new submodule is more involved than it should be.  We kick
    // things off with 'Submodule.addSetup' as you would expect, but then there
    // are a few unexpected manual and undocumented steps.  First, we need to
    // firgure out the name of the remote for the submodule and explicitly
    // fetch from it.

    let submodule;
    try {
        submodule = yield NodeGit.Submodule.addSetup(repo, url, path, 1);
    } catch (e) {
        throw new UserError(e.message);
    }

    const submoduleRepo = yield submodule.open();

    // Next, we have to explicitly connect to the origin.  I'm not exactly sure
    // what this does, except that subsequent commands will complain about
    // having never been connected to the origin otherwise.

    yield GitUtil.fetch(submoduleRepo, "origin");

    // Then, we need to figure out what the commit that the remote master is
    // pointing to.

    const remoteBranch = yield submoduleRepo.getBranch("origin/master");
    const commit = yield submoduleRepo.getBranchCommit(remoteBranch);

    // Set up HEAD and checkout.

    yield GitUtil.setHeadHard(submoduleRepo, commit);

    yield submodule.addFinalize();
});
