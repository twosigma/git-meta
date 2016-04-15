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
"use strict";

const assert  = require("chai").assert;
const co      = require("co");
const NodeGit = require("nodegit");
const path    = require("path");

const TestUtil = require("../../lib/slmu/slmu_testutil");

describe("createSimpleRepository", function () {
    after(function () {
        TestUtil.cleanup();
    });

    it("createSimpleRepository", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        assert.instanceOf(repo, NodeGit.Repository);

        // Check repo is not in merging, rebase, etc. state

        assert(repo.isDefaultState());

        // Check that the index has an entry in it for "README.md"

        const index = yield repo.index();
        assert.equal(1, index.entryCount());
        const entry = index.getByPath("README.md");
        assert(entry);

        // Check that the repo has clean index and workdir

        const status = yield repo.getStatus();
        assert(0 === status.length);
    }));
});

describe("pathExists", function () {
    after(function () {
        TestUtil.cleanup();
    });
    it("pathExists", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        const repoDir = repo.workdir();
        const repoPathExists = yield TestUtil.pathExists(repoDir);
        assert(repoPathExists);
        const fakePath = path.join(repoDir, "not-a-path-in-the-repo");
        const fakeExists = yield TestUtil.pathExists(fakePath);
        assert.isFalse(fakeExists);
    }));
});

describe("cleanup", function () {
    it("cleanup", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        const repoPath = repo.workdir();
        yield TestUtil.cleanup();
        const exists = yield TestUtil.pathExists(repoPath);
        assert.isFalse(exists, "repo not removed");
    }));
});
