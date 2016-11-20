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

const co     = require("co");

const Checkout        = require("../../lib/util/checkout");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");

describe("checkout", function () {
    // We will operate on the repository `x`.
    const cases = {
        "bad branch name": {
            input: "x=S",
            branchName: "foo",
            fails: true,
        },
        "simple branch switch": {
            input: "x=S:Bfoo=1",
            branchName: "foo",
            expected: "x=E:*=foo",
        },
        "committish": {
            input: "x=S:C2-1;Bfoo=2",
            commit: "2",
            expected: "x=E:H=2",
        },
        "sub closed": {
            input: "a=S|x=U:Bfoo=2",
            branchName: "foo",
            expected: "x=E:*=foo",
        },
        "sub closed, but different commit": {
            input: "a=S:C4-1;Bmeh=4|x=U:C3-2 s=Sa:4;Bfoo=3",
            branchName: "foo",
            expected: "x=E:*=foo",
        },
        "open sub but no change": {
            input: "a=S|x=U:Os;Bfoo=1",
            branchName: "foo",
            expected: "x=E:*=foo",
        },
        "open sub but no change to sub": {
            input: "a=S|x=U:C4-2;Os;Bfoo=4",
            branchName: "foo",
            expected: "x=E:*=foo;Os",
        },
        "sub open, different commit": {
            input: "a=S:C4-1;Bmeh=4|x=U:C3-2 s=Sa:4;Bfoo=3;Os",
            branchName: "foo",
            expected: "x=E:*=foo;Os H=4",
        },
    };
    function checkout(branchName, commit) {
        return co.wrap(function *(repos, mapping) {
            const x = repos.x;
            if (undefined !== branchName) {
                return yield Checkout.checkout(x, branchName);
            }
            else {
                const realCommit = mapping.reverseMap[commit];
                return yield Checkout.checkout(x, realCommit);
            }
        });
    }
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const manipulator = checkout(c.branchName, c.commit);
            yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                           c.expected,
                                                           manipulator,
                                                           c.fails);
        }));
    });
});
