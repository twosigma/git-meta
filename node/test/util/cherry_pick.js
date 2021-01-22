/*
 * Copyright (c) 2021, Two Sigma Open Source
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

const CherryPick      = require("../../lib/cmd/cherry_pick");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");

describe("isRange", function () {
    it("handles non-ranges", function () {
        assert(!CherryPick.isRange(""));
        assert(!CherryPick.isRange("branch"));
        assert(!CherryPick.isRange("refs/heads/branch"));
        assert(!CherryPick.isRange("HEAD^3"));
    });
    it("handles ranges", function () {
        assert(CherryPick.isRange("x..y"));
        assert(CherryPick.isRange("x...y"));
        assert(CherryPick.isRange("x^@"));
        assert(CherryPick.isRange("x^-1"));
        assert(CherryPick.isRange("x^!"));
        assert(CherryPick.isRange("^x"));
    });
});

describe("CherryPick", function () {
    it("handles some common cases", co.wrap(function *() {
        const start = `x=S:Cm1-1;Cm2-m1;Cm3-m2;Cm4-m3;Cm5-m4;Cm6-m5;
                       Bmaster=m6;Bm3=m3;Bm4=m4;Bm5=m5`;
        const repoMap = yield RepoASTTestUtil.createMultiRepos(start);
        const repo = repoMap.repos.x;
        const byNumber = {};
        for (let i = 1; i <= 6; i++) {
            byNumber[i] = yield repo.getCommit(
                repoMap.reverseCommitMap["m" + i]);
        }
        let actual = yield CherryPick.resolveRange(repo, ["m5"]);
        assert.deepEqual([byNumber[5]], actual);

        actual = yield CherryPick.resolveRange(repo, ["m4", "m5"]);
        assert.deepEqual([byNumber[4], byNumber[5]], actual);

        actual = yield CherryPick.resolveRange(repo, ["m3..m5"]);
        assert.deepEqual([byNumber[4], byNumber[5]], actual);

        actual = yield CherryPick.resolveRange(repo, ["^m3", "m5"]);
        assert.deepEqual([byNumber[4], byNumber[5]], actual);

        actual = yield CherryPick.resolveRange(repo, ["m5^!"]);
        assert.deepEqual([byNumber[5]], actual);

        actual = yield CherryPick.resolveRange(repo, ["m5^-"]);
        assert.deepEqual([byNumber[5]], actual);

        assert.throws(() => CherryPick.resolveRange(repo, ["m5^@"]).done());
    }));
});
