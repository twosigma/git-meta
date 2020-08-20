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

const Include       = require("../../lib/util/include");
const TestUtil      = require("../../lib/util/test_util");
const UserError     = require("../../lib/util/user_error");

describe("include", function () {
    describe("includeNonExistingRepo", function () {
        let repo;
        beforeEach(co.wrap(function *() {
            repo = yield TestUtil.createSimpleRepository();
        }));

        it("fails with an invalid path", co.wrap(function *() {
            const url = repo.workdir();
            const path = "";
            try {
                yield Include.include(repo, url, path);
            } 
            catch (e) {
                assert.instanceOf(e, UserError);
                return;
            }
            assert(false, "didn't throw error");
        }));

        it("fails with an invalid url", co.wrap(function *() {
            const url = "non/existing/path";
            const path = "foo";
            try {
                yield Include.include(repo, url, path);
            } 
            catch (e) {
                assert.instanceOf(e, UserError);
                return;
            }
            assert(false, "didn't throw error");
        }));
    });

    describe("includeExistingRepo", function () {
        // for these tests, "externalRepo" represents the repository to be 
        // included and "submoduleRepo" represents the submodule once it 
        // has been included inside "repo"  

        let repo, externalRepo, path;
        before(co.wrap(function *() {
            repo = yield TestUtil.createSimpleRepository();
            externalRepo = yield TestUtil.createSimpleRepository();
            path = "foo";
            yield Include.include(repo, externalRepo.workdir(), path);
        }));

        it("should include in the correct path", co.wrap(function *() {
            const pathExists = 
                yield TestUtil.pathExists(repo.workdir() + path);
            assert(pathExists, "path should exist");

            const submoduleRepo = 
                yield NodeGit.Repository.open(repo.workdir() + path);
            assert(submoduleRepo.workdir(), "repository should be created");
        }));

        it("should point to the correct commit", co.wrap(function *() {
            const externalHead = yield externalRepo.getHeadCommit();
            const submoduleRepo = 
                yield NodeGit.Repository.open(repo.workdir() + path);
            const submoduleHead = yield submoduleRepo.getHeadCommit();

            assert(externalHead.id().equal(submoduleHead.id()), 
                "head commits should be equal");
        }));

        it("current should be head and detached", co.wrap(function *() {
            const submoduleRepo =
                          yield NodeGit.Repository.open(repo.workdir() + path);
            const submoduleBranch = yield submoduleRepo.getCurrentBranch();

            assert.equal(submoduleBranch.shorthand(), "HEAD");
            assert.equal(submoduleRepo.headDetached(), 1);
        }));

        it("should have signature of the current repo", co.wrap(function *() {
            const repoSignature = yield repo.defaultSignature();
            const submoduleRepo = 
                yield NodeGit.Repository.open(repo.workdir() + path);
            const submoduleSignature = yield submoduleRepo.defaultSignature();

            assert.equal(repoSignature.toString(), 
                submoduleSignature.toString());
        }));
    });
});
