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
const fs      = require("fs-promise");
const path    = require("path");
const NodeGit = require("nodegit");

const DeinitUtil         = require("../../lib/util/deinit_util");
const SparseCheckoutUtil = require("../../lib/util/sparse_checkout_util");
const TestUtil           = require("../../lib/util/test_util");

describe("deinit_util", function () {

    // Going to do a simple test here to verify that after closing a submodule:
    //
    // - the submodule dir contains only the `.git` line file.
    // - the git repo is in a clean state

    it("breathing", co.wrap(function *() {

        // Create and set up repos.

        const repo = yield TestUtil.createSimpleRepository();
        const baseSubRepo = yield TestUtil.createSimpleRepository();
        const baseSubPath = baseSubRepo.workdir();
        const subHead = yield baseSubRepo.getHeadCommit();

        // Set up the submodule.

        const sub = yield NodeGit.Submodule.addSetup(repo,
                                                     baseSubPath,
                                                     "x/y",
                                                     1);
        const subRepo = yield sub.open();
        const origin = yield subRepo.getRemote("origin");
        yield origin.connect(NodeGit.Enums.DIRECTION.FETCH,
                             new NodeGit.RemoteCallbacks(),
                             function () {});
                             yield subRepo.fetch("origin", {});
        subRepo.setHeadDetached(subHead.id().tostrS());
        yield sub.addFinalize();

        // Commit the submodule it.

        yield TestUtil.makeCommit(repo, ["x/y", ".gitmodules"]);

        // Verify that the status currently indicates a visible submodule.

        const addedStatus = yield NodeGit.Submodule.status(repo, "x/y", 0);
        const WD_UNINITIALIZED = (1 << 7);  // means "closed"
        assert(!(addedStatus & WD_UNINITIALIZED));

        // Then close it and recheck status.

        yield DeinitUtil.deinit(repo, "x/y");
        const closedStatus = yield NodeGit.Submodule.status(repo, "x/y", 0);
        assert(closedStatus & WD_UNINITIALIZED);
    }));
    it("sparse mode", co.wrap(function *() {

        // Create and set up repos.

        const repo = yield TestUtil.createSimpleRepository();
        const baseSubRepo = yield TestUtil.createSimpleRepository();
        const baseSubPath = baseSubRepo.workdir();
        const subHead = yield baseSubRepo.getHeadCommit();

        // Set up the submodule.

        const sub = yield NodeGit.Submodule.addSetup(repo,
                                                     baseSubPath,
                                                     "x/y",
                                                     1);
        const subRepo = yield sub.open();
        const origin = yield subRepo.getRemote("origin");
        yield origin.connect(NodeGit.Enums.DIRECTION.FETCH,
                             new NodeGit.RemoteCallbacks(),
                             function () {});
                             yield subRepo.fetch("origin", {});
        subRepo.setHeadDetached(subHead.id().tostrS());
        yield sub.addFinalize();

        // Commit the submodule it.

        yield TestUtil.makeCommit(repo, ["x/y", ".gitmodules"]);

        yield SparseCheckoutUtil.setSparseMode(repo);
        yield DeinitUtil.deinit(repo, "x/y");

        // Verify that directory is gone
        const subPath = path.join(repo.workdir(), "x", "y");
        let failed = false;
        try {
            yield fs.readdir(subPath);
        } catch (e) {
            failed = true;
        }
        assert(failed);
    }));
});
