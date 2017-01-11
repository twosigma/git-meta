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

const co = require("co");

const Add             = require("../../lib/util/add");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");

describe("add", function () {
    describe("stagePaths", function () {
        const cases = {
            "trivial": {
                initial: "x=S",
                paths: [],
            },
            "nothing to add": {
                initial: "x=S",
                paths: [""],
            },
            "missed modified file": {
                initial: "x=S:I x/y/z=foo;W x/q/z=bar",
                paths: ["x/y"],
            },
            "simple mod": {
                initial: "x=S:W README.md=foo",
                paths: ["README.md"],
                expected: "x=S:I README.md=foo",
            },
            "deep from root": {
                initial: "x=S:W x/y/z=meh",
                paths: [""],
                expected: "x=S:I x/y/z=meh",
            },
            "multiple from root": {
                initial: "x=S:W x/y/z=meh,x/a/c=foo",
                paths: [""],
                expected: "x=S:I x/y/z=meh,x/a/c=foo",
            },
            "multiple from root dir": {
                initial: "x=S:W x/y/z=meh,x/a/c=foo",
                paths: ["x"],
                expected: "x=S:I x/y/z=meh,x/a/c=foo",
            },
            "single from root": {
                initial: "x=S:W x/y/z=meh,x/a/c=foo",
                paths: ["x/y"],
                expected: "x=S:I x/y/z=meh;W x/a/c=foo",
            },
            "single from root, direct": {
                initial: "x=S:W x/y/z=meh,x/a/c=foo",
                paths: ["x/y/z"],
                expected: "x=S:I x/y/z=meh;W x/a/c=foo",
            },
            "multiple from sub dirs": {
                initial: "x=S:W x/y/z=meh,x/a/c=foo",
                paths: ["x/y", "x/a"],
                expected: "x=S:I x/y/z=meh,x/a/c=foo",
            },
            "bad path": {
                initial: "x=S",
                paths: ["foo"],
                fails: true,
            },
            "sub included by root": {
                initial: "a=B|x=U:Os W README.md=foo",
                paths: [""],
                expected: "x=E:Os I README.md=foo",
            },
            "sub direct": {
                initial: "a=B|x=U:Os W README.md=foo",
                paths: ["s"],
                expected: "x=E:Os I README.md=foo",
            },
            "sub included in path": {
                initial: `
a=B|x=S:C2-1 x/y/z=Sa:1;W x/r/z=foo;Ox/y/z W m/r=z;Bmaster=2`,
                paths: ["x"],
                expected: `
x=E:I x/r/z=foo;W x/r/z=~;Ox/y/z I m/r=z`,
            },
            "multiple in sub": {
                initial: "a=B|x=U:Os W README.md=foo,q/r=z",
                paths: ["s"],
                expected: "x=E:Os I README.md=foo,q/r=z",
            },
            "direct in sub": {
                initial: "a=B|x=U:Os W README.md=foo",
                paths: ["s/README.md"],
                expected: "x=E:Os I README.md=foo",
            },
            "directory in nested sub": {
                initial: `
a=B|x=S:C2-1 a/b=Sa:1;Oa/b W x/y/z=a,x/r/z=b;Bmaster=2`,
                paths: ["a/b/x"],
                expected: `x=E:Oa/b I x/y/z=a,x/r/z=b`,
            },
            "multiple paths in nested sub": {
                initial: `
a=B|x=S:C2-1 a/b=Sa:1;Oa/b W x/y/z=a,x/r/z=b;Bmaster=2`,
                paths: ["a/b/x/y", "a/b/x/r"],
                expected: `x=E:Oa/b I x/y/z=a,x/r/z=b`,
            }
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const doAdd = co.wrap(function *(repos) {
                    const repo = repos.x;
                    yield Add.stagePaths(repo, c.paths);
                });
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               c.expected,
                                                               doAdd,
                                                               c.fails);
            }));
        });
    });
});
