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
const Status          = require("../../lib/util/status");

describe("checkout", function () {
    // We will operate on the repository `x`.
    const cases = {
        "simple -- branch doesn't exist -- all": {
            input: "x=S",
            branchName: "foo",
            create: "all",
            expected: "x=S:Bfoo=1;*=foo",
        },
        "simple -- branch doesn't exist -- some": {
            input: "x=S",
            branchName: "foo",
            create: "some",
            expected: "x=S:Bfoo=1;*=foo",
        },
        "simple -- branch doesn't exist -- none": {
            input: "x=S",
            branchName: "foo",
            create: "none",
            expected: "x=S:Bfoo=1;*=foo",
            fails: true,
        },
        "simple -- branch exists -- all": {
            input: "x=S:Bfoo=1",
            branchName: "foo",
            create: "all",
            expected: "x=S:Bfoo=1;*=foo",
            fails: true,
        },
        "simple -- branch exists -- some": {
            input: "x=S:Bfoo=1",
            branchName: "foo",
            create: "some",
            expected: "x=S:Bfoo=1;*=foo",
        },
        "simple -- branch exists -- none": {
            input: "x=S:Bfoo=1",
            branchName: "foo",
            create: "none",
            expected: "x=S:Bfoo=1;*=foo",
        },
        "one sub closed": {
            input: "a=S|x=U",
            branchName: "foo",
            create: "all",
            expected: "a=S|x=U:Bfoo=2;*=foo",
        },
        "one sub -- branch doesn't exist -- all": {
            input: "a=S|x=U:Os",
            branchName: "foo",
            create: "all",
            expected: "a=S|x=U:Bfoo=2;*=foo;Os Bfoo=1!*=foo",
        },
        "one sub -- branch doesn't exist -- some": {
            input: "a=S|x=U:Os",
            branchName: "foo",
            create: "some",
            expected: "a=S|x=U:Bfoo=2;*=foo;Os Bfoo=1!*=foo",
        },
        "one sub -- branch doesn't exist -- none": {
            input: "a=S|x=U:Bfoo=1;Os",
            branchName: "foo",
            create: "none",
            fails: true,
        },
        "one sub -- branch exists -- all": {
            input: "a=S|x=U:Os Bfoo=1",
            branchName: "foo",
            create: "all",
            expected: "a=S|x=U:Bfoo=2;*=foo;Os Bfoo=1!*=foo",
            fails: true,
        },
        "one sub -- branch exists -- some ": {
            input: "a=S|x=U:Os Bfoo=1",
            branchName: "foo",
            create: "some",
            expected: "a=S|x=U:Bfoo=2;*=foo;Os Bfoo=1!*=foo",
        },
        "one sub -- branch exists and is current -- some": {
            input: "a=S|x=U:Os Bfoo=1!*=foo",
            branchName: "foo",
            create: "some",
            expected: "a=S|x=U:Bfoo=2;*=foo;Os Bfoo=1!*=foo",
        },
        // Basic checking of multiple-subs; we know the codepaths are not
        // different when more than one.
        "two subs, all": {
            input: "a=S|b=S|x=U:C3-2 t=Sb:1;Bmaster=3;Os;Ot",
            branchName: "foo",
            create: "all",
            expected: "x=E:Bfoo=3;*=foo;Os Bfoo=1!*=foo;Ot Bfoo=1!*=foo",
        },
        "two subs, none": {
            input:
                "a=S|b=S|x=U:C3-2 t=Sb:1;Bmaster=3;Bfoo=3;Os Bfoo=1;Ot Bfoo=1",
            branchName: "foo",
            create: "none",
            expected: "x=E:*=foo;Os Bfoo=1!*=foo;Ot Bfoo=1!*=foo",
        },
    };
    function checkout(branchName, create) {
        return co.wrap(function *(repos) {
            const x = repos.x;
            const status = yield Status.getRepoStatus(x);
            return yield Checkout.checkout(repos.x,
                                           status,
                                           branchName,
                                           create);
        });
    }
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const manipulator = checkout(c.branchName, c.create);
            yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                           c.expected,
                                                           manipulator,
                                                           c.fails);
        }));
    });
});
