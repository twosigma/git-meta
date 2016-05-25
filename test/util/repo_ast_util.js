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

const RepoAST     = require("../../lib/util/repo_ast");
const RepoASTUtil = require("../../lib/util/repo_ast_util");

describe("RepoAstUtil", function () {
    describe("mapCommitsAndUrls", function () {
        const Commit = RepoAST.Commit;
        const c1 = new Commit();
        const cases = {
            "trivial": { i: new RepoAST(), m: {}, e: new RepoAST() },
            "just head": {
                i: new RepoAST({
                    commits: { "1": c1 },
                    head: "1",
                    remotes: {
                        foo: new RepoAST.Remote("my-url"),
                    }
                }),
                m: { "1": "2"},
                e: new RepoAST({
                    commits: { "2": c1 },
                    head: "2",
                    remotes: {
                        foo: new RepoAST.Remote("my-url"),
                    }
                }),
            },
            "just head unmapped": {
                i: new RepoAST({
                    commits: { "1": c1 },
                    head: "1",
                    remotes: {
                        foo: new RepoAST.Remote("my-url"),
                    }
                }),
                m: {},
                e: new RepoAST({
                    commits: { "1": c1 },
                    head: "1",
                    remotes: {
                        foo: new RepoAST.Remote("my-url"),
                    }
                }),
            },
            "parents": {
                i: new RepoAST({
                    commits: {
                        "1": c1 ,
                        "2": new Commit({
                            parents: ["1"],
                        })
                    },
                    head: "2",
                }),
                m: { "1": "8", "2": "20"},
                e: new RepoAST({
                    commits: {
                        "8": c1 ,
                        "20": new Commit({
                            parents: ["8"],
                        })
                    },
                    head: "20",
                }),
            },
            "branches": {
                i: new RepoAST({
                    commits: { "1": c1 },
                    branches: { "aaa": "1"},
                }),
                m: { "1": "2"},
                e: new RepoAST({
                    commits: { "2": c1 },
                    branches: { "aaa": "2"},
                }),
            },
            "current branch": {
                i: new RepoAST({
                    commits: { "1": c1 },
                    branches: { "aaa": "1"},
                    head: "1",
                    currentBranchName: "aaa",
                }),
                m: { "1": "2"},
                e: new RepoAST({
                    commits: { "2": c1 },
                    branches: { "aaa": "2"},
                    head: "2",
                    currentBranchName: "aaa",
                }),
            },
            "remote": {
                i: new RepoAST({
                    commits: { "1": c1 },
                    remotes: {
                        foo: new RepoAST.Remote("foo", {
                            branches: { baz: "1" }
                        })
                    }
                }),
                m: { "1": "2"},
                e: new RepoAST({
                    commits: { "2": c1 },
                    remotes: {
                        foo: new RepoAST.Remote("foo", {
                            branches: { baz: "2" }
                        })
                    }
                }),
            },
            "url remap": {
                i: new RepoAST({
                    commits: { "2": c1 },
                    remotes: {
                        foo: new RepoAST.Remote("a", {
                            branches: { baz: "2" }
                        })
                    }
                }),
                m: { "2": "1" },
                u: { a: "b" },
                e: new RepoAST({
                    commits: { "1": c1 },
                    remotes: {
                        foo: new RepoAST.Remote("b", {
                            branches: { baz: "1" }
                        })
                    }
                }),
            },
            "url submodule remap": {
                i: new RepoAST({
                    commits: {
                        "2": new RepoAST.Commit({
                            changes: { foo: new RepoAST.Submodule("x", "y") },
                        }),
                    },
                    head: "2",
                }),
                u: { x: "z" },
                e: new RepoAST({
                    commits: {
                        "2": new RepoAST.Commit({
                            changes: { foo: new RepoAST.Submodule("z", "y") },
                        }),
                    },
                    head: "2",
                }),
            },
            "url commit remap": {
                i: new RepoAST({
                    commits: {
                        "2": new RepoAST.Commit({
                            changes: { foo: new RepoAST.Submodule("x", "3") },
                        }),
                    },
                    head: "2",
                }),
                m: { "3": "4" },
                e: new RepoAST({
                    commits: {
                        "2": new RepoAST.Commit({
                            changes: { foo: new RepoAST.Submodule("x", "4") },
                        }),
                    },
                    head: "2",
                }),
            },
            "url and commit submodule remap": {
                i: new RepoAST({
                    commits: {
                        "2": new RepoAST.Commit({
                            changes: { foo: new RepoAST.Submodule("x", "3") },
                        }),
                    },
                    head: "2",
                }),
                m: { "3": "4" },
                u: { x: "z" },
                e: new RepoAST({
                    commits: {
                        "2": new RepoAST.Commit({
                            changes: { foo: new RepoAST.Submodule("z", "4") },
                        }),
                    },
                    head: "2",
                }),
            },
            "unchanged sub": {
                i: new RepoAST({
                    commits: {
                        "2": new RepoAST.Commit({
                            changes: { foo: new RepoAST.Submodule("x", "3") },
                        }),
                    },
                    head: "2",
                }),
                m: { "8": "4" },
                u: { r: "z" },
                e: new RepoAST({
                    commits: {
                        "2": new RepoAST.Commit({
                            changes: { foo: new RepoAST.Submodule("x", "3") },
                        }),
                    },
                    head: "2",
                }),
            },
            "index, unchanged": {
                i: new RepoAST({
                    commits: { "1": c1 },
                    head: "1",
                    remotes: {
                        foo: new RepoAST.Remote("my-url"),
                    },
                    index: { foo: "bar" },
                }),
                m: { "1": "2"},
                e: new RepoAST({
                    commits: { "2": c1 },
                    head: "2",
                    remotes: {
                        foo: new RepoAST.Remote("my-url"),
                    },
                    index: { foo: "bar" },
                }),
            },
            "index unchanged submodule": {
                i: new RepoAST({
                    commits: { "1": c1 },
                    head: "1",
                    remotes: {
                        foo: new RepoAST.Remote("my-url"),
                    },
                    index: {
                        foo: "bar",
                        baz: new RepoAST.Submodule("x", "y"),
                    },
                }),
                m: { "1": "2"},
                u: { "q": "z"},
                e: new RepoAST({
                    commits: { "2": c1 },
                    head: "2",
                    remotes: {
                        foo: new RepoAST.Remote("my-url"),
                    },
                    index: {
                        foo: "bar",
                        baz: new RepoAST.Submodule("x", "y"),
                    },
                }),
            },
            "index changed submodule": {
                i: new RepoAST({
                    commits: { "1": c1 },
                    head: "1",
                    remotes: {
                        foo: new RepoAST.Remote("my-url"),
                    },
                    index: {
                        foo: "bar",
                        baz: new RepoAST.Submodule("q", "1"),
                    },
                }),
                m: { "1": "2"},
                u: { "q": "z"},
                e: new RepoAST({
                    commits: { "2": c1 },
                    head: "2",
                    remotes: {
                        foo: new RepoAST.Remote("my-url"),
                    },
                    index: {
                        foo: "bar",
                        baz: new RepoAST.Submodule("z", "2"),
                    },
                }),
            },
        };
        Object.keys(cases).forEach(caseName => {
            it(caseName, function () {
                const c = cases[caseName];
                const commitMap = c.m || {};
                const urlMap = c.u || {};
                const result = RepoASTUtil.mapCommitsAndUrls(c.i,
                                                             commitMap,
                                                             urlMap);
                RepoASTUtil.assertEqualASTs(result, c.e);
            });
        });
    });
});
