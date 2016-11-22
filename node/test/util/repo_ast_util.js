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

const assert = require("chai").assert;

const RepoAST     = require("../../lib/util/repo_ast");
const RepoASTUtil = require("../../lib/util/repo_ast_util");

describe("RepoAstUtil", function () {

    describe("assertEqualCommits", function () {
        const Commit = RepoAST.Commit;
        const cases = {
            "trivial": {
                actual: new Commit(),
                expected: new Commit(),
            },
            "with data": {
                actual: new Commit({
                    parents: ["1"],
                    changes: { foo: "bar" },
                    message: "foo",
                }),
                expected: new Commit({
                    parents: ["1"],
                    changes: { foo: "bar" },
                    message: "foo",
                }),
            },
            "bad parents": {
                actual: new Commit({
                    parents: ["1"],
                    changes: { foo: "bar" },
                }),
                expected: new Commit({
                    parents: ["2"],
                    changes: { foo: "bar" },
                }),
                fails: true,
            },
            "wrong change": {
                actual: new Commit({
                    parents: ["1"],
                    changes: { foo: "bar" },
                }),
                expected: new Commit({
                    parents: ["2"],
                    changes: { foo: "z" },
                }),
                fails: true,
            },
            "extra change": {
                actual: new Commit({
                    parents: ["1"],
                    changes: { foo: "bar", z: "q" },
                }),
                expected: new Commit({
                    parents: ["2"],
                    changes: { foo: "bar" },
                }),
                fails: true,
            },
            "missing change": {
                actual: new Commit({
                    parents: ["1"],
                    changes: { foo: "bar" },
                }),
                expected: new Commit({
                    parents: ["1"],
                    changes: { foo: "bar", k: "z" },
                }),
                fails: true,
            },
            "bad message": {
                actual: new Commit({
                    message: "foo",
                }),
                expected: new Commit({
                    message: "bar",
                }),
                fails: true,
            },
        };
        Object.keys(cases).forEach((caseName) => {
            const c = cases[caseName];
            it(caseName, function () {
                try {
                    RepoASTUtil.assertEqualCommits(c.actual, c.expected);
                }
                catch (e) {
                    assert(c.fails, e.stack);
                    return;                                           // RETURN
                }
                assert(!c.fails);
            });
        });
    });

    describe("assertEqualASTs", function () {
        const AST = RepoAST;
        const Commit = AST.Commit;
        const Remote = AST.Remote;
        const Submodule = AST.Submodule;

        const aCommit = new Commit({ changes: { x: "y" } });
        const aRemote = new Remote("/z");
        const aSubmodule = new Submodule("/y", "1");
        const anAST = new RepoAST({
            commits: { "2": aCommit },
            head: "2",
        });

        // We know that for comparison of maps this method uses the same
        // underlying routine as `assertEqualCommits`.  We will do basic
        // validation that every member is checked.

        const cases = {
            "trivial": {
                actual: new AST(),
                expected: new AST(),
            },
            "everything there": {
                actual: new AST({
                    commits: { "1": aCommit},
                    branches: { master: "1" },
                    refs: { "a/b": "1" },
                    head: "1",
                    currentBranchName: "master",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: anAST },
                }),
                expected: new AST({
                    commits: { "1": aCommit},
                    branches: { master: "1" },
                    refs: { "a/b": "1" },
                    head: "1",
                    currentBranchName: "master",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: anAST },
                }),
            },
            "wrong commit": {
                actual: new AST({
                    commits: {
                        "1": new Commit({ changes: { x: "z" } }),
                    },
                    branches: { master: "1" },
                    head: "1",
                    currentBranchName: "master",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: anAST },
                }),
                expected: new AST({
                    commits: { "1": aCommit},
                    branches: { master: "1" },
                    head: "1",
                    currentBranchName: "master",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: anAST },
                }),
                fails: true,
            },
            "missing branch": {
                actual: new AST({
                    commits: { "1": aCommit},
                    branches: { master: "1" },
                    head: "1",
                    currentBranchName: "master",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: anAST },
                }),
                expected: new AST({
                    commits: { "1": aCommit},
                    branches: { master: "1", foo: "1" },
                    head: "1",
                    currentBranchName: "master",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: anAST },
                }),
                fails: true,
            },
            "missing ref": {
                actual: new AST({
                    commits: { "1": aCommit},
                    branches: { master: "1" },
                    refs: { "a/b": "1" },
                    head: "1",
                    currentBranchName: "master",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: anAST },
                }),
                expected: new AST({
                    commits: { "1": aCommit},
                    branches: { master: "1" },
                    refs: { "a/b": "1", "e/d": "1" },
                    head: "1",
                    currentBranchName: "master",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: anAST },
                }),
                fails: true,
            },
            "wrong head": {
                actual: new AST({
                    commits: { "1": aCommit, "2": aCommit },
                    branches: { master: "1", bar: "2" },
                    head: "2",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: anAST },
                }),
                expected: new AST({
                    commits: { "1": aCommit, "2": aCommit },
                    branches: { master: "1", bar: "2" },
                    head: "1",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: anAST },
                }),
                fails: true,
            },
            "no current branch": {
                actual: new AST({
                    commits: { "1": aCommit},
                    branches: { master: "1" },
                    head: "1",
                    currentBranchName: "master",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: anAST },
                }),
                expected: new AST({
                    commits: { "1": aCommit},
                    branches: { master: "1" },
                    head: "1",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: anAST },
                }),
                fails: true,
            },
            "extra remote": {
                actual: new AST({
                    commits: { "1": aCommit},
                    branches: { master: "1" },
                    head: "1",
                    currentBranchName: "master",
                    remotes: { origin: aRemote, yyyy: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: anAST },
                }),
                expected: new AST({
                    commits: { "1": aCommit},
                    branches: { master: "1" },
                    head: "1",
                    currentBranchName: "master",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: anAST },
                }),
                fails: true,
            },
            "wrong index": {
                actual: new AST({
                    commits: { "1": aCommit},
                    branches: { master: "1" },
                    head: "1",
                    currentBranchName: "master",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule, x: "xxxx" },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: anAST },
                }),
                expected: new AST({
                    commits: { "1": aCommit},
                    branches: { master: "1" },
                    head: "1",
                    currentBranchName: "master",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: anAST },
                }),
                fails: true,
            },
            "bad workdir": {
                actual: new AST({
                    commits: { "1": aCommit},
                    branches: { master: "1" },
                    head: "1",
                    currentBranchName: "master",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: anAST },
                }),
                expected: new AST({
                    commits: { "1": aCommit},
                    branches: { master: "1" },
                    head: "1",
                    currentBranchName: "master",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { oo: "bar" },
                    openSubmodules: { y: anAST },
                }),
                fails: true,
            },
            "missing open sub": {
                actual: new AST({
                    commits: { "1": aCommit},
                    branches: { master: "1" },
                    head: "1",
                    currentBranchName: "master",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                }),
                expected: new AST({
                    commits: { "1": aCommit},
                    branches: { master: "1" },
                    head: "1",
                    currentBranchName: "master",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: anAST },
                }),
                fails: true,
            },
            "different open sub": {
                actual: new AST({
                    commits: { "1": aCommit},
                    branches: { master: "1" },
                    head: "1",
                    currentBranchName: "master",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: anAST },
                }),
                expected: new AST({
                    commits: { "1": aCommit},
                    branches: { master: "1" },
                    head: "1",
                    currentBranchName: "master",
                    remotes: { origin: aRemote },
                    index: { y: aSubmodule },
                    workdir: { foo: "bar" },
                    openSubmodules: { y: new AST({
                        commits: { "4": aCommit },
                        head: "4",
                    })},
                }),
                fails: true,
            },
        };
        Object.keys(cases).forEach((caseName) => {
            const c = cases[caseName];
            it(caseName, function () {
                try {
                    RepoASTUtil.assertEqualASTs(c.actual, c.expected);
                }
                catch (e) {
                    assert(c.fails, e.stack);
                    return;
                }
                assert(!c.fails);
            });
        });
    });

    describe("mapCommitsAndUrls", function () {
        const Commit = RepoAST.Commit;
        const c1 = new Commit({ message: "foo" });
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
            "refs": {
                i: new RepoAST({
                    commits: { "1": c1 },
                    refs: { "aaa": "1"},
                }),
                m: { "1": "2"},
                e: new RepoAST({
                    commits: { "2": c1 },
                    refs: { "aaa": "2"},
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
            "workdir, unchanged": {
                i: new RepoAST({
                    commits: { "1": c1 },
                    head: "1",
                    remotes: {
                        foo: new RepoAST.Remote("my-url"),
                    },
                    workdir: { foo: "bar" },
                }),
                m: { "1": "2"},
                e: new RepoAST({
                    commits: { "2": c1 },
                    head: "2",
                    remotes: {
                        foo: new RepoAST.Remote("my-url"),
                    },
                    workdir: { foo: "bar" },
                }),
            },
            "submodule with changes": {
                i: new RepoAST({
                    commits: { "1": c1 },
                    head: "1",
                    index: { x: new RepoAST.Submodule("x","y") },
                    openSubmodules: { x: new RepoAST({
                        commits: { "1": c1 },
                        head: "1",
                        remotes: {
                            origin: new RepoAST.Remote("x"),
                        }
                    })},
                }),
                m: { "1": "2" },
                u: { "x": "z" },
                e: new RepoAST({
                    commits: { "2": c1 },
                    head: "2",
                    index: { x: new RepoAST.Submodule("z","y") },
                    openSubmodules: { x: new RepoAST({
                        commits: { "2": c1 },
                        head: "2",
                        remotes: {
                            origin: new RepoAST.Remote("z"),
                        }
                    })},
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

    describe("clone", function () {
        const AST = RepoAST;
        const Commit = AST.Commit;
        const Remote = AST.Remote;
        const c1 = new Commit({ changes: { foo: "bar" } });
        const c2 = new Commit({ changes: { baz: "bam" } });
        const child = new Commit({ parents: ["1"] });
        const cases = {
            "sipmlest": {
                original: new AST(),
                url: "foo",
                expected: new AST({
                    remotes: { origin: new Remote("foo") },
                }),
            },
            "with branches and commits": {
                original: new AST({
                    commits: { "1": c1, "2": c2 },
                    branches: { x: "1", y: "2" },
                }),
                url: "foo",
                expected: new AST({
                    commits: { "1": c1, "2": c2 },
                    remotes: {
                        origin: new Remote("foo", {
                            branches: {
                                x: "1",
                                y: "2",
                            },
                        }),
                    },
                }),
            },
            "with refs": {
                original: new AST({
                    commits: { "1": c1, "2": c2 },
                    branches: { x: "1", y: "2" },
                    refs: { q: "1", r: "2" },
                }),
                url: "foo",
                expected: new AST({
                    commits: { "1": c1, "2": c2 },
                    remotes: {
                        origin: new Remote("foo", {
                            branches: {
                                x: "1",
                                y: "2",
                            },
                        }),
                    },
                }),
            },
            "lost commit": {
                original: new AST({
                    commits: { "1": c1 },
                    remotes: {
                        foo: new Remote("lala", {
                            branches: { baz: "1" },
                        })
                    },
                }),
                url: "foo",
                expected: new AST({
                    remotes: { origin: new Remote("foo") },
                }),
            },
            "commit from head": {
                original: new AST({
                    commits: { "1": c1 },
                    head: "1",
                }),
                url: "foo",
                expected: new AST({
                    commits: { "1": c1 },
                    remotes: { origin: new Remote("foo") },
                    head: "1",
                }),
            },
            "current branch setup": {
                original: new AST({
                    commits: { "1": c1 },
                    head: "1",
                    branches: { foo: "1" },
                    currentBranchName: "foo"
                }),
                url: "foo",
                expected: new AST({
                    commits: { "1": c1 },
                    remotes: {
                        origin: new Remote("foo", {
                            branches: { foo: "1" },
                        })
                    },
                    branches: { foo: "1" },
                    currentBranchName: "foo",
                    head: "1",
                }),
            },
            "child commit": {
                original: new AST({
                    commits: {
                        "1": c1,
                        "2": child,
                    },
                    head: "2",
                }),
                url: "foo",
                expected: new AST({
                    commits: {
                        "1": c1,
                        "2": child,
                    },
                    head: "2",
                    remotes: { origin: new Remote("foo") },
                }),
            },
            "from bare": {
                original: new AST({
                    commits: { "1": c1 },
                    branches: { master: "1" },
                    currentBranchName: "master",
                    head: null,
                }),
                url: "foo",
                expected: new AST({
                    commits: { "1": c1 },
                    branches: { master: "1" },
                    currentBranchName: "master",
                    head: "1",
                    remotes: {
                        origin: new Remote("foo", {
                            branches: {
                                master: "1",
                            },
                        }),
                    },
                }),
            },
        };
        Object.keys(cases).forEach((caseName) => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = RepoASTUtil.cloneRepo(c.original, c.url);
                RepoASTUtil.assertEqualASTs(result, c.expected);
            });
        });
    });
});
