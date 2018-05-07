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

const RepoAST = require("../../lib/util/repo_ast");

describe("RepoAST", function () {
const File = RepoAST.File;
const SequencerState = RepoAST.SequencerState;
const CommitAndRef = SequencerState.CommitAndRef;
const REBASE = SequencerState.TYPE.REBASE;

    describe("Branch", function () {
        it("breath", function () {
            const b = new RepoAST.Branch("name", "upstream");
            assert.isFrozen(b);
            assert.equal(b.sha, "name");
            assert.equal(b.tracking, "upstream");
        });
        it("null tracking", function () {
            const b = new RepoAST.Branch("name", null);
            assert.isNull(b.tracking);
        });
    });

    describe("File", function () {
        it("breath", function () {
            const f = new RepoAST.File("foo", true);
            assert.equal(f.contents, "foo");
            assert.equal(f.isExecutable, true);
        });
    });

    describe("Submodule", function () {
        it("breath", function () {
            const s = new RepoAST.Submodule("foo", "bar");
            assert.instanceOf(s, RepoAST.Submodule);
            assert.isFrozen(s);
            assert.equal(s.url, "foo");
            assert.equal(s.sha, "bar");
        });
        it("null sha", function () {
            const s = new RepoAST.Submodule("foo", null);
            assert.isNull(s.sha);
        });
        it("equal", function () {
            const Submodule = RepoAST.Submodule;
            const cases = {
                "same": {
                    lhs: new Submodule("foo", "bar"),
                    rhs: new Submodule("foo", "bar"),
                    expected: true,
                },
                "diff url": {
                    lhs: new Submodule("boo", "bar"),
                    rhs: new Submodule("foo", "bar"),
                    expected: false,
                },
                "diff sha": {
                    lhs: new Submodule("foo", "bar"),
                    rhs: new Submodule("foo", "baz"),
                    expected: false,
                },
            };
            Object.keys(cases).forEach(caseName => {
                const c = cases[caseName];
                assert.equal(c.lhs.equal(c.rhs), c.expected);
            });
        });
    });

    describe("Conflict", function () {
        it("breath", function () {
            const c = new RepoAST.Conflict(new File("foo", false),
                                           new File("bar", true),
                                           new File("baz", false));
            assert.equal(c.ancestor.contents, "foo");
            assert.equal(c.our.contents, "bar");
            assert.equal(c.their.contents, "baz");
        });
        it("nulls", function () {
            const c = new RepoAST.Conflict(null, null, null);
            assert.equal(c.ancestor, null);
            assert.equal(c.our, null);
            assert.equal(c.their, null);
        });
        it("subs", function () {
            const s0 = new RepoAST.Submodule("foo", null);
            const s1 = new RepoAST.Submodule("bar", null);
            const s2 = new RepoAST.Submodule("baz", null);
            const c = new RepoAST.Conflict(s0, s1, s2);
            assert.deepEqual(c.ancestor, s0);
            assert.deepEqual(c.our, s1);
            assert.deepEqual(c.their, s2);
        });
        it("equal", function () {
            const Conflict = RepoAST.Conflict;
            const foo = new File("foo", false);
            const bam = new File("bam", false);
            const bar = new File("bar", false);
            const baz = new File("baz", false);
            const food = new File("food", true);
            const bark = new File("bark", false);
            const cases = {
                "same": {
                    lhs: new Conflict(foo, bar, baz),
                    rhs: new Conflict(new File("foo", false),
                                      new File("bar", false),
                                      new File("baz", false)),
                    expected: true,
                },
                "diff ancestor": {
                    lhs: new Conflict(foo, bar, baz),
                    rhs: new Conflict(food, bar, baz),
                    expected: false,
                },
                "diff ours": {
                    lhs: new Conflict(foo, bar, baz),
                    rhs: new Conflict(foo, bark, baz),
                    expected: false,
                },
                "diff theirs": {
                    lhs: new Conflict(foo, bar, baz),
                    rhs: new Conflict(foo, bar, bam),
                    expected: false,
                },
            };
            Object.keys(cases).forEach(caseName => {
                const c = cases[caseName];
                assert.equal(c.lhs.equal(c.rhs), c.expected);
            });
        });
    });

    describe("Commit", function () {

        // Basically just testing that the constructor and accessors perform.

        const cases = {
            "trivial": {
                input: undefined,
                eparents: [],
                echanges: {},
                emessage: "",
            },
            "simple": {
                input: {
                    parents: ["foo"],
                    changes: { a: new File("b", true) },
                    message: "bam",
                },
                eparents: ["foo"],
                echanges: { a: new File("b", true) },
                emessage: "bam",
            },
            "delete change": {
                input: {
                    changes: { b: null },
                },
                eparents: [],
                echanges: { b: null, },
                emessage: "",
            },
            "add a submodule": {
                input: {
                    changes: { b: new RepoAST.Submodule("x", "y") },
                },
                eparents: [],
                echanges: { b: new RepoAST.Submodule("x", "y"), },
                emessage: "",
            },
        };
        Object.keys(cases).forEach(caseName => {
            it(caseName, function () {
                const c = cases[caseName];
                const obj = new RepoAST.Commit(c.input);
                assert.isFrozen(obj);

                // Check that result is expected, and not same as input object.

                assert.deepEqual(obj.parents, c.eparents);
                assert.deepEqual(obj.changes, c.echanges);
                assert.equal(obj.message, c.emessage);

                if (c.input) {
                    assert.notEqual(obj.parents, c.input.parent);
                    assert.notEqual(obj.changes, c.input.change);
                }
            });
        });
    });
    describe("Remote", function () {

        // Basically just testing that the constructor and accessors perform.

        const cases = {
            "trivial": {
                iurl: "x",
                args: undefined,
                eurl: "x",
                ebranches: {},
            },
            "branches": {
                iurl: "y",
                args: { branches: { x: "y", q: "r" } },
                eurl: "y",
                ebranches: { x: "y", q: "r" },
            },
        };
        Object.keys(cases).forEach(caseName => {
            it(caseName, function () {
                const c = cases[caseName];
                const obj = new RepoAST.Remote(c.iurl, c.args);
                assert.isFrozen(obj);

                // Check that result is expected, and not same as input object.

                assert.equal(obj.url, c.eurl);
                assert.deepEqual(obj.branches, c.ebranches);
                assert.deepEqual(obj.changes, c.echanges);

                if (c.args && c.args.branches) {
                    assert.notEqual(obj.branches, c.args.branches);
                }
            });
        });
    });

    describe("AST", function () {

        describe("constructor", function () {
            // Basically just testing that the constructor and accessors
            // perform.

            const Commit = RepoAST.Commit;
            const Rebase = RepoAST.Rebase;
            const Remote = RepoAST.Remote;

            const c1       = new Commit();
            const cWithPar = new Commit({ parents: ["1"] });
            const cWithSubmodule = new Commit({
                changes: { x: new RepoAST.Submodule("foo", "bar") }
            });

            function m(input,
                       expected,
                       fails) {
                expected = expected || {};
                return {
                    input   : input,
                    ebare   : ("bare" in expected) ? expected.bare : false,
                    ecommits: ("commits" in expected) ? expected.commits: {},
                    ebranches:
                        ("branches" in expected) ? expected.branches : {},
                    erefs:
                        ("refs" in expected) ? expected.refs : {},
                    ehead   : ("head" in expected) ? expected.head : null,
                    ebranch : ("branch" in expected) ? expected.branch : null,
                    eremotes: ("remotes" in expected) ? expected.remotes : {},
                    eindex  : ("index" in expected) ? expected.index : {},
                    eworkdir: ("workdir" in expected) ? expected.workdir : {},
                    eopenSubmodules: ("openSubmodules" in expected) ?
                                                  expected.openSubmodules : {},
                    erebase: ("rebase" in expected) ?  expected.rebase : null,
                    esequencerState: ("sequencerState" in expected) ?
                        expected.sequencerState : null,
                    esparse   : ("sparse" in expected) ?
                                                       expected.sparse : false,
                    fails   : fails,
                };
            }

            const barFile = new File("bar", true);
            const yFile = new File("y", true);
            const aConflict = new RepoAST.Conflict(new File("foo", false),
                                                   new File("bar", true),
                                                   new File("baz", false));
            const cases = {
                "trivial": m(undefined, undefined, false),
                "simple" : m(
                    {
                        commits: {},
                        branches: {},
                        head: null,
                        currentBranchName: null,
                        rebase: null,
                        sequencerState: null,
                        bare: false,
                        sparse: false,
                    },
                    undefined,
                    false),
                "with bare": m({ bare: true }, { bare: true} , false),
                "bad bare with index": m({
                    bare: true,
                    index: { foo: barFile },
                    commits: {"1": c1 },
                    head: "1",
                }, undefined, true),
                "bad bare with workdir": m({
                    bare: true,
                    workdir: { foo: barFile },
                    commits: {"1": c1 },
                    head: "1",
                }, undefined, true),
                "bad bare with rebase": m({
                    bare: true,
                    rebase: new Rebase("foo", "1", "1"),
                    commits: {"1": c1 },
                    head: "1",
                }, undefined, true),
                "bad bare with sequencer": m({
                    bare: true,
                    sequencerState: new SequencerState({
                        type: REBASE,
                        originalHead: new CommitAndRef("1", null),
                        target: new CommitAndRef("1", null),
                        commits: ["1"],
                        currentCommit: 0,
                    }),
                    commits: {"1": c1 },
                    head: "1",
                }, undefined, true),
                "branchCommit": m({
                    commits: {"1":c1, "2": cWithPar},
                    branches: {"master": new RepoAST.Branch("2", null) },
                    head: "1",
                    currentBranchName: null,
                }, {
                    commits: {"1":c1, "2": cWithPar},
                    branches: {"master": new RepoAST.Branch("2", null) },
                    head: "1",
                }, false),
                "refCommit": m({
                    commits: {"1":c1, "2": cWithPar},
                    refs: {"foo/bar": "2"},
                    currentBranchName: null,
                }, {
                    commits: {"1":c1, "2": cWithPar},
                    refs: {"foo/bar": "2"},
                }, false),
                "refIsBranch": m({
                    commits: {"1":c1, "2": cWithPar},
                    refs: {"heads/bar": "2"},
                    currentBranchName: null,
                }, {
                }, true),
                "refIsRemote": m({
                    commits: {"1":c1, "2": cWithPar},
                    refs: {"remotes/bar": "2"},
                    currentBranchName: null,
                }, {
                }, true),
                "with submodule": m({
                    commits: {"1":cWithSubmodule, "2": cWithPar},
                    branches: {"master": new RepoAST.Branch("2", null) },
                    head: "1",
                    currentBranchName: null,
                }, {
                    commits: {"1":cWithSubmodule, "2": cWithPar},
                    branches: {"master": new RepoAST.Branch("2", null) },
                    head: "1",
                }, false),
                "remotes": m({
                    remotes: {
                        foo: new Remote("my-url"),
                    }
                }, {
                    remotes: { foo: new Remote("my-url") },
                }, false),
                "badParent": m({ commits: { "2": cWithPar }},
                               undefined,
                               true),
                "badBranch": m({
                    branches: { "master": new RepoAST.Branch("3", null) },
                }, undefined, true),
                "badRef": m({ refs: { "a/b": "3"}}, undefined, true),
                "badHead": m({ head: "3"}, undefined, true),
                "branch": m({
                    commits: {"1": c1},
                    branches: {"master": new RepoAST.Branch("1", null) },
                    head: "1",
                    currentBranchName: "master",
                }, {
                    commits: {"1": c1},
                    branches: {"master": new RepoAST.Branch("1", null) },
                    head: "1",
                    branch: "master",
                }, false),
                "ref": m({
                    commits: {"1": c1},
                    refs: {"a/b": "1"},
                }, {
                    commits: {"1": c1},
                    refs: {"a/b": "1"},
                }, false),
                "currentBranchIsRef": m({
                    commits: {"1": c1},
                    refs: {"a/b": "1"},
                    head: "1",
                    currentBranchName: "a/b",
                }, {
                }, true),
                "badBranch with good commit": m({
                    commits: {"1": c1},
                    branches: {"aster": new RepoAST.Branch("1", null) },
                    head: null,
                    currentBranchName: "master",
                }, undefined, true),
                "unreachable": m({ commits: {"1": c1} }, undefined, true),
                "reachedByHead": m({
                    commits: {"1": c1},
                    head: "1",
                }, {
                    commits: {"1": c1},
                    head: "1",
                }, false),
                "reachedByRemote": m({
                    commits: {"1": c1},
                    remotes: {
                        bar: new Remote("foo", { branches: { "bar": "1"}, }),
                    },
                }, {
                    commits: {"1": c1},
                    remotes: {
                        bar: new Remote("foo", { branches: { "bar": "1"}, }),
                    },
                }, false),
                "bare with current branch": m({
                    commits: {"1":c1, "2": cWithPar},
                    branches: {"master": new RepoAST.Branch("2", null) },
                    head: null,
                    currentBranchName: "master",
                }, {
                    commits: {"1":c1, "2": cWithPar},
                    branches: {"master": new RepoAST.Branch("2", null) },
                    branch: "master",
                    head: null,
                }, false),
                "index": m({
                    commits: { "1": c1},
                    head: "1",
                    index: { foo: barFile },
                }, {
                    commits: { "1": c1},
                    head: "1",
                    index: { foo: barFile },
                }, false),
                "index without head": m({
                    commits: { "1": c1},
                    head: null,
                    index: { foo: barFile },
                }, {
                    commits: { "1": c1},
                    head: "1",
                    index: { foo: barFile},
                }, true),
                "index with submodule": m({
                    commits: { "1": c1},
                    head: "1",
                    index: { foo: new RepoAST.Submodule("z", "a") },
                }, {
                    commits: { "1": c1},
                    head: "1",
                    index: { foo: new RepoAST.Submodule("z", "a") },
                }, false),
                "index with conflict": m({
                    commits: { "1": c1},
                    head: "1",
                    index: { foo: aConflict },
                    workdir: { foo: barFile },
                }, {
                    commits: { "1": c1},
                    head: "1",
                    index: { foo: aConflict },
                    workdir: { foo: barFile },
                }, false),
                "workdir": m({
                    commits: { "1": c1},
                    head: "1",
                    workdir: { foo: barFile },
                }, {
                    commits: { "1": c1},
                    head: "1",
                    workdir: { foo: barFile },
                }, false),
                "workdir without head": m({
                    commits: { "1": c1},
                    head: null,
                    workdir: { foo: barFile },
                }, {
                    commits: { "1": c1},
                    head: "1",
                    workdir: { foo: barFile },
                }, true),
                "openSubmodules": m({
                    commits: { "1": cWithSubmodule },
                    head: "1",
                    openSubmodules: { x: new RepoAST() },
                }, {
                    commits: { "1": cWithSubmodule },
                    head: "1",
                    openSubmodules: { x: new RepoAST() },
                }, false),
                "bad path openSubmodules": m({
                    commits: { "1": cWithSubmodule },
                    head: "1",
                    openSubmodules: { y: new RepoAST() },
                }, {
                }, true),
                "bad commit change": m({
                    commits: {
                        "1": new Commit({ changes: { x: yFile }}),
                        "2": new Commit({
                            parents: ["1"],
                            changes: { x: yFile },
                        }),
                    },
                    head: "2",
                }, {}, true),
                "bad commit change from ancestor": m({
                    commits: {
                        "1": new Commit({ changes: { x: yFile }}),
                        "2": new Commit({
                            parents: ["1"],
                            changes: { y: yFile },
                        }),
                        "3": new Commit({
                            parents: ["2"],
                            changes: { x: yFile },
                        }),
                    },
                    head: "2",
                }, {}, true),
                "ok commit duplicting right-hand ancestory": m({
                    commits: {
                        "1": new Commit({ changes: { x: yFile }}),
                        "2": new Commit({ changes: { y: yFile }, }),
                        "3": new Commit({
                            parents: ["1","2"],
                            changes: { y: yFile },
                        }),
                    },
                    head: "3",
                }, {
                    commits: {
                        "1": new Commit({ changes: { x: yFile }}),
                        "2": new Commit({ changes: { y: yFile }, }),
                        "3": new Commit({
                            parents: ["1","2"],
                            changes: { y: yFile },
                        }),
                    },
                    head: "3",
                }, false),
                "bad commit deletion": m({
                    commits: {
                        "1": new Commit({ changes: { x: null } }),
                    },
                    head: "1",
                }, {}, true),
                "with rebase": m({
                    commits: {
                        "1": new Commit(),
                    },
                    head: "1",
                    rebase: new Rebase("fff", "1", "1"),
                }, {
                    commits: {
                        "1": new Commit(),
                    },
                    head: "1",
                    rebase: new Rebase("fff", "1", "1"),
                }),
                "with rebase specific commits": m({
                    commits: {
                        "1": new Commit(),
                        "2": new Commit(),
                    },
                    head: "1",
                    rebase: new Rebase("fff", "2", "2"),
                }, {
                    commits: {
                        "1": new Commit(),
                        "2": new Commit(),
                    },
                    head: "1",
                    rebase: new Rebase("fff", "2", "2"),
                }),
                "bad rebase": m({
                    rebase: new Rebase("fff", "1", "1"),
                }, undefined, true),
                "with sequencer state": m({
                    commits: {
                        "1": new Commit(),
                        "2": new Commit(),
                        "3": new Commit(),
                    },
                    head: "1",
                    sequencerState: new SequencerState({
                        type: REBASE,
                        originalHead: new CommitAndRef("3", null),
                        target: new CommitAndRef("3", null),
                        commits: ["2", "1"],
                        currentCommit: 1,
                    }),
                }, {
                    commits: {
                        "1": new Commit(),
                        "2": new Commit(),
                        "3": new Commit(),
                    },
                    head: "1",
                    sequencerState: new SequencerState({
                        type: REBASE,
                        originalHead: new CommitAndRef("3", null),
                        target: new CommitAndRef("3", null),
                        commits: ["2", "1"],
                        currentCommit: 1,
                    }),
                }),
                "with sequencer specific commits": m({
                    commits: {
                        "1": new Commit(),
                        "2": new Commit(),
                        "3": new Commit(),
                    },
                    head: "1",
                    sequencerState: new SequencerState({
                        type: REBASE,
                        originalHead: new CommitAndRef("3", null),
                        target: new CommitAndRef("3", null),
                        commits: ["2", "1"],
                        currentCommit: 1,
                    }),
                }, {
                    commits: {
                        "1": new Commit(),
                        "2": new Commit(),
                        "3": new Commit(),
                    },
                    head: "1",
                    sequencerState: new SequencerState({
                        type: REBASE,
                        originalHead: new CommitAndRef("3", null),
                        target: new CommitAndRef("3", null),
                        commits: ["2", "1"],
                        currentCommit: 1,
                    }),
                }),
                "bad sequencer": m({
                    sequencerState: new SequencerState({
                        type: REBASE,
                        originalHead: new CommitAndRef("foo", null),
                        target: new CommitAndRef("bar", null),
                        commits: ["2", "1"],
                        currentCommit: 1,
                    }),
                }, undefined, true),
                "with sparse": m({ sparse: true }, { sparse: true} , false),
            };
            Object.keys(cases).forEach(caseName => {
                it(caseName, function () {
                    const c = cases[caseName];
                    if (c.fails) {
                        // `fails` indicates that it throws due to out of
                        // contract.  We don't document what type of error is
                        // thrown on contract violation.

                        assert.throws(() => new RepoAST(c.input), "");
                        return;                                       // RETURN
                    }
                    const obj = new RepoAST(c.input);
                    assert.deepEqual(obj.commits, c.ecommits);
                    assert.deepEqual(obj.branches, c.ebranches);
                    assert.deepEqual(obj.refs, c.erefs);
                    assert.equal(obj.head, c.ehead);
                    assert.equal(obj.currentBranchName, c.ebranch);
                    assert.deepEqual(obj.index, c.eindex);
                    assert.deepEqual(obj.workdir, c.eworkdir);
                    assert.deepEqual(obj.openSubmodules, c.eopenSubmodules);
                    assert.deepEqual(obj.rebase, c.erebase);
                    assert.deepEqual(obj.sequencerState, c.esequencerState);
                    assert.equal(obj.bare, c.ebare);
                    assert.equal(obj.sparse, c.esparse);

                    if (c.input) {
                        assert.notEqual(obj.commits, c.input.commits);
                        assert.notEqual(obj.branches, c.input.branches);
                        assert.notEqual(obj.refs, c.input.refs);
                        assert.notEqual(obj.remotes, c.input.remotes);
                        assert.notEqual(obj.workdir, c.input.workdir);
                        assert.notEqual(obj.openSubmodules,
                                        c.input.openSubmodules);
                    }
                });
            });
        });

        describe("accumulateDirChanges", function () {
            const cases = {
                "trivial": {
                    dest: {},
                    changes: {},
                    expected: {}
                },
                "add": {
                    dest: {},
                    changes: { foo: "bar" },
                    expected: { foo: "bar" },
                },
                "overwrite": {
                    dest: { foo: "bar", baz: "bam" },
                    changes: { a: "b", foo: "3" },
                    expected: { foo: "3", baz: "bam", a: "b" },
                },
                "delete": {
                    dest: { foo: "bar", baz: "bam" },
                    changes: { foo: null },
                    expected: { baz: "bam" },
                },
            };
            Object.keys(cases).forEach(caseName => {
                const c = cases[caseName];
                it(caseName, function () {
                    RepoAST.accumulateDirChanges(c.dest, c.changes);
                    assert.deepEqual(c.dest, c.expected);
                });
            });
        });

        const barFile = new File("bar", false);
        const bazFile = new File("baz", false);

        describe("renderCommit", function () {
            const Commit = RepoAST.Commit;
            const c1 = new Commit({ changes: { foo: barFile }});
            const deleter = new Commit({
                parents: ["1"],
                changes: { foo: null }
            });
            const submodule = new RepoAST.Submodule("x", "y");
            const subCommit = new Commit({
                parents: ["1"],
                changes: { baz: submodule },
            });
            const cases = {
                "one": {
                    commits: { "1": c1},
                    from: "1",
                    expected: { foo: barFile },
                    ecache: {
                        "1": { foo: barFile },
                    },
                },
                "deletion": {
                    commits: { "1": c1, "2": deleter },
                    from: "2",
                    expected: {},
                    ecache: {
                        "1": c1.changes,
                        "2": {}
                    },
                },
                "with sub": {
                    commits: { "1": c1, "2": subCommit },
                    from: "2",
                    expected: { foo: barFile, baz: submodule },
                    ecache: {
                        "1": c1.changes,
                        "2": { foo: barFile, baz: submodule },
                    },
                },
                "use the cache": {
                    commits: { "1": c1 },
                    from: "1",
                    cache: { "1": { foo: bazFile } },
                    expected: { foo: bazFile },
                    ecache: { "1": { foo: bazFile }, },
                },
            };
            Object.keys(cases).forEach(caseName => {
                const c = cases[caseName];
                it(caseName, function () {
                    let cache = c.cache || {};
                    const result =
                                RepoAST.renderCommit(cache, c.commits, c.from);
                    assert.deepEqual(result,
                                     c.expected,
                                     JSON.stringify(result));
                    assert.deepEqual(cache, c.ecache, JSON.stringify(cache));
                });
            });
        });

        describe("AST.copy", function () {
            const Rebase = RepoAST.Rebase;
            const barFile = new File("bar", false);
            const base = new RepoAST({
                commits: { "1": new RepoAST.Commit()},
                branches: { "master": new RepoAST.Branch("1", null) },
                refs: { "a/b": "1"},
                head: "1",
                currentBranchName: "master",
                index: { foo: barFile },
                workdir: { foo: barFile },
                rebase: new Rebase("hello", "1", "1"),
                sequencerState: new SequencerState({
                    type: REBASE,
                    originalHead: new CommitAndRef("1", null),
                    target: new CommitAndRef("1", null),
                    commits: ["1"],
                    currentCommit: 0,
                }),
                bare: false,
                sparse: false,
            });
            const newArgs = {
                commits: { "2": new RepoAST.Commit()},
                branches: { "foo": new RepoAST.Branch("2", null) },
                refs: { "foo/bar": "2" },
                head: "2",
                currentBranchName: "foo",
                remotes: { "foo": new RepoAST.Remote("meeeee") },
                index: { foo: barFile },
                workdir: { foo: barFile },
                rebase: new Rebase("hello world", "2", "2"),
                sequencerState: new SequencerState({
                    type: REBASE,
                    originalHead: new CommitAndRef("2", "refs/heads/master"),
                    target: new CommitAndRef("2", null),
                    commits: ["2"],
                    currentCommit: 0,
                }),
                bare: false,
                sparse: false,
            };
            const cases = {
                "trivial": {
                    i: undefined,
                    e: base,
                },
                "all": {
                    i: newArgs,
                    e: new RepoAST(newArgs),
                },
                "bare": {
                    i: {
                        bare: true,
                        index: {},
                        workdir: {},
                        rebase: null,
                        sequencerState: null,
                    },
                    e: new RepoAST({
                        commits: { "1": new RepoAST.Commit()},
                        branches: { "master": new RepoAST.Branch("1", null) },
                        refs: { "a/b": "1"},
                        head: "1",
                        currentBranchName: "master",
                        bare: true,
                    }),
                },
                "sparse": {
                    i: {
                        sparse: true,
                        index: {},
                        workdir: {},
                        rebase: null,
                        sequencerState: null,
                    },
                    e: new RepoAST({
                        commits: { "1": new RepoAST.Commit()},
                        branches: { "master": new RepoAST.Branch("1", null) },
                        refs: { "a/b": "1"},
                        head: "1",
                        currentBranchName: "master",
                        sparse: true,
                    }),
                },
            };
            Object.keys(cases).forEach(caseName => {
                it(caseName, function () {
                    const c = cases[caseName];
                    const obj = base.copy(c.i);
                    assert.deepEqual(obj.commits, c.e.commits);
                    assert.deepEqual(obj.branches, c.e.branches);
                    assert.deepEqual(obj.refs, c.e.refs);
                    assert.deepEqual(obj.remotes, c.e.remotes);
                    assert.equal(obj.head, c.e.head);
                    assert.equal(obj.currentBranchName, c.e.currentBranchName);
                    assert.deepEqual(obj.index, c.e.index);
                    assert.deepEqual(obj.workdir, c.e.workdir);
                    assert.deepEqual(obj.openSubmodules, c.e.openSubmodules);
                    assert.deepEqual(obj.rebase, c.e.rebase);
                    assert.deepEqual(obj.sequencerState, c.e.sequencerState);
                    assert.equal(obj.bare, c.e.bare);
                    assert.equal(obj.sparse, c.e.sparse);
                });
            });
        });

        describe("renderIndex", function () {

            // This method is implemented in terms of `renderCommit` and
            // `accumulateChanges`.  We just need to make sure they're put
            // together properly.

            const bbFile = new File("bb", false);
            const fooFile = new File("foo", false);
            const barFile = new File("bar", true);
            const zFile = new File("z", false);
            const Commit = RepoAST.Commit;
            const Conflict = RepoAST.Conflict;
            const c1 = new Commit({ changes: { foo: barFile }});
            const cases = {
                "no index": {
                    commits: { "1": c1},
                    from: "1",
                    expected: { foo: barFile },
                },
                "with index": {
                    commits: { "1": c1},
                    from: "1",
                    index: { y: zFile },
                    expected: { foo: barFile, y: zFile },
                },
                "ignore conflict": {
                    commits: { "1": c1},
                    from: "1",
                    index: {
                        y: zFile,
                        foo: new Conflict(fooFile, barFile, bbFile),
                    },
                    expected: { foo: barFile, y: zFile },
                },
            };
            Object.keys(cases).forEach(caseName => {
                const c = cases[caseName];
                it(caseName, function () {
                    const index = c.index || {};
                    const result = RepoAST.renderIndex(c.commits,
                                                       c.from,
                                                       index);
                    assert.deepEqual(result,
                                     c.expected,
                                     JSON.stringify(result));
                });
            });
        });

    });
});
