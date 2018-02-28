/*
 * Copyright (c) 2017, Two Sigma Open Source
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
const NodeGit = require("nodegit");
const co      = require("co");
const colors  = require("colors");

const DeinitUtil      = require("../util/deinit_util");
const Hook            = require("../util/hook");
const StatusUtil      = require("../util/status_util");
const SubmoduleUtil   = require("../util/submodule_util");
const UserError       = require("../util/user_error");


/**
 * Close the submodules contained in the specified `paths`, resolved from the
 * specified `cwd`, in the specified `repo`.  If one or more submodules has
 * modifications to its index or working directory, and the specified `force`
 * is false, do not close those submodules and throw a `UserError`.  Note that
 * all submodules that can be closed will be whether `force` is true or not.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             cwd
 * @param {String []}          paths
 * @param {Boolean}            force
 */
exports.close = co.wrap(function *(repo, cwd, paths, force) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(cwd);
    assert.isArray(paths);
    assert.isBoolean(force);

    const workdir = repo.workdir();
    const subs    = yield SubmoduleUtil.getSubmoduleNames(repo);
    const subsToClose = yield SubmoduleUtil.resolveSubmoduleNames(workdir,
                                                                  cwd,
                                                                  subs,
                                                                  paths);

    const repoStatus = yield StatusUtil.getRepoStatus(repo, {
        paths: subsToClose,
    });
    const subStats = repoStatus.submodules;
    let errorMessage = "";
    let subsClosedSuccessfully = [];

    const closers = subsToClose.map(co.wrap(function *(name) {
        const sub = subStats[name];
        if (undefined === sub || null === sub.workdir) {
            return;                                                   // RETURN
        }
        const subWorkdir = sub.workdir;
        const subRepo = subWorkdir.status;
        if (!force) {
            // Determine if there are any uncommited changes:
            // 1) Clean (no staged or unstaged changes)
            // 2) new files

            if (!subRepo.isClean() ||
                                   0 !== Object.keys(subRepo.workdir).length) {
                errorMessage += `\
Could not close ${colors.cyan(name)} because it is not clean.
Pass ${colors.magenta("--force")} to close it anyway.
`;
                return;                                               // RETURN
            }
        }
        yield DeinitUtil.deinit(repo, name);
        subsClosedSuccessfully.push(name);
    }));
    yield closers;

    // Run post-close-submodule hook with submodules which closed successfully.
    yield Hook.execHook("post-close-submodule", subsClosedSuccessfully);
    if ("" !== errorMessage) {
        throw new UserError(errorMessage);
    }
});
