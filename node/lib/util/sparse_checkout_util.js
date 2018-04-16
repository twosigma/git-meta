/*
 * Copyright (c) 2018, Two Sigma Open Source
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
const fs      = require("fs-promise");
const NodeGit = require("nodegit");
const path    = require("path");

const ConfigUtil = require("./config_util");

/**
 * This module contains methods for interacting with Git's sparse checkout
 * facility, that is not supported by libgit2.
 */

/**
 * Return the path to the sparse checkout file for the specified `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @return {String}
 */
exports.getSparseCheckoutPath = function (repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    return path.join(repo.path(), "info", "sparse-checkout");
};

/**
 * Return true if the specified `repo` is in sparse mode and false otherwise.
 * A repo is in sparse mode iff: `core.sparsecheckout` is true and the contents
 * of `.git/info/sparse-checkout` is exactly ".gitmodules\n".  We can do
 * something more general purpose later if we deem it useful.
 *
 * @param {NodeGit.Repository} repo
 * @return {Bool}
 */
exports.inSparseMode = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    if (!(yield ConfigUtil.configIsTrue(repo, "core.sparsecheckout"))) {
        return false;
    }
    let content;
    try {
        content = yield fs.readFile(exports.getSparseCheckoutPath(repo),
                                    "utf8");
    } catch (e) {
        return false;                                                 // RETURN
    }
    return content === ".gitmodules\n";
});

/**
 * Configure the specified `repo` to be in sparse-checkout mode --
 * specifically, our sparse checkout mode where everything but `.gitmodules` is
 * excluded.
 *
 * @param {NodeGit.Repository} repo
 */
exports.setSparseMode = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const config = yield repo.config();
    yield config.setString("core.sparsecheckout", "true");
    yield fs.writeFile(exports.getSparseCheckoutPath(repo), ".gitmodules\n");
});
