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
const path    = require("path");
const NodeGit = require("nodegit");

const Open            = require("../../lib/util/open");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");
const TestUtil        = require("../../lib/util/test_util");

describe("openBranchOnCommit", function () {
    const cases = {
        "breathing": {
            initial: "a=Aa|x=U",
            subName: "s",
            url: "a",
            branchName: "foo",
            commitSha: "a",
            expected: "x=E:Os Bfoo=a!*=foo",
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const manipulator = co.wrap(function *(repos, maps) {
                assert.property(maps.reverseMap, c.commitSha);
                assert.property(maps.reverseUrlMap, c.url);
                const commit = maps.reverseMap[c.commitSha];
                const url = maps.reverseUrlMap[c.url];
                const result = yield Open.openBranchOnCommit(repos.x,
                                                             c.subName,
                                                             url,
                                                             c.branchName,
                                                             commit);
                assert.instanceOf(result, NodeGit.Repository);
            });
            yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                           c.expected,
                                                           manipulator);
        }));
    });
});

describe("open", function () {
    // We'll open from repo `x`.

    function opener(submoduleName, url) {
        return co.wrap(function *(repos, maps) {
            const x = repos.x;
            let realUrl;
            for (let newUrl in maps.urlMap) {
                if (url === maps.urlMap[newUrl]) {
                    realUrl = newUrl;
                }
            }
            const result = yield Open.open(x, submoduleName, realUrl);
            assert.instanceOf(result, NodeGit.Repository);
            const expectedDir = path.join(x.workdir(), submoduleName);
            assert(TestUtil.isSameRealPath(result.workdir(), expectedDir));
        });
    }

    // Not any boundary conditions yet; I'll set up the `cases` format for now
    // as I presume more complexity will arise as this method becomes more
    // robust.

    const cases = {
        "breathing": {
            input: "a=S|x=U",
            manipulator: opener("s", "a"),
            expected: "x=U:Os Bmaster=1!*=master",
        },
    };

    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                           c.expected,
                                                           c.manipulator);
        }));
    });
});
