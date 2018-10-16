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
const path    = require("path");

const GitUtilFast         = require("../../lib/util/git_util_fast");
const TestUtil            = require("../../lib/util/test_util");

describe("GitUtilFast", function () {
    describe("getRootGitDirectory", function () {
        let cwd;
        before(function () {
            cwd = process.cwd();
        });
        after(function () {
            process.chdir(cwd);
        });

        // This method is recursive, so we will check just three cases:
        // - failure case
        // - simple case
        // - one deep

        it("failure", co.wrap(function *() {
            const tempdir = yield TestUtil.makeTempDir();
            process.chdir(tempdir);
            const result = GitUtilFast.getRootGitDirectory();
            assert.isNull(result);
        }));

        it("successes", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const workdir = repo.workdir();
            process.chdir(workdir);
            const repoRoot = GitUtilFast.getRootGitDirectory(workdir);
            assert(yield TestUtil.isSameRealPath(workdir, repoRoot),
                   "trivial");
            const subdir = path.join(workdir, "sub");
            yield fs.mkdir(subdir);
            process.chdir(subdir);
            const subRoot = GitUtilFast.getRootGitDirectory(workdir);
            assert(yield TestUtil.isSameRealPath(workdir, subRoot), "trivial");
        }));
        it("with a non-submodule link", co.wrap(function *() {
            const tempdir = yield TestUtil.makeTempDir();
            process.chdir(tempdir);
            const gitLink = path.join(tempdir, ".git");
            yield fs.writeFile(gitLink, "gitdir: /foo/bar");
            const result = GitUtilFast.getRootGitDirectory();
            assert.isNotNull(result);
            assert(yield TestUtil.isSameRealPath(tempdir, result), result);
        }));
    });
});
