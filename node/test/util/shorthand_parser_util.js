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

const RepoAST             = require("../../lib/util/repo_ast");
const RepoASTUtil         = require("../../lib/util/repo_ast_util");
const ShorthandParserUtil = require("../../lib/util/shorthand_parser_util");

const File = RepoAST.File;

describe("ShorthandParserUtil", function () {
    const SequencerState = RepoAST.SequencerState;
    const CommitAndRef = SequencerState.CommitAndRef;
    describe("parseCommitAndRef", function () {
        const cases = {
            "without ref": {
                input: "foo:",
                expected: new CommitAndRef("foo", null),
            },
            "with ref": {
                input: "bar:baz",
                expected: new CommitAndRef("bar", "baz"),
            },
        };
        Object.keys(cases).forEach(caseName => {
            it(caseName, function () {
                const c = cases[caseName];
                const result = ShorthandParserUtil.parseCommitAndRef(c.input);
                assert.instanceOf(result, CommitAndRef);
                assert.deepEqual(result, c.expected);
            });
        });
    });
    describe("findSeparator", function () {
        const cases = {
            missing: {
                char: ";",
                input: "",
                begin: 0,
                end: 0,
                expected: null,
            },
            simpleMatch: {
                char: ";",
                input: ";",
                begin: 0,
                end: 1,
                expected: {
                    begin: 0,
                    end: 1,
                },
            },
            "trailing out of scope": {
                char: ";",
                input: "; ",
                begin: 0,
                end: 1,
                expected: {
                    begin: 0,
                    end: 1,
                },
            },
            "trailing": {
                char: ";",
                input: "; ",
                begin: 0,
                end: 2,
                expected: {
                    begin: 0,
                    end: 2,
                },
            },
            "trailing and more": {
                char: ";",
                input: "; \n 3",
                begin: 0,
                end: 5,
                expected: {
                    begin: 0,
                    end: 4,
                },
            },
            "offset": {
                char: "|",
                input: "a b | \n  3",
                begin: 1,
                end: 8,
                expected: {
                    begin: 4,
                    end: 8,
                },
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = ShorthandParserUtil.findSeparator(c.input,
                                                                 c.char,
                                                                 c.begin,
                                                                 c.end);
                assert.deepEqual(result, c.expected);
            });
        });
    });
    describe("parseRepoShorthandRaw", function () {
        const Commit = RepoAST.Commit;
        const Conflict = RepoAST.Conflict;
        const Submodule = RepoAST.Submodule;
        function m(args) {
            let result = {
                type: args.type || "S",
                commits: {},
                branches: {},
                refs: {},
                remotes: {},
                index: {},
                notes: {},
                workdir: {},
                openSubmodules: {},
            };
            result = Object.assign(result, args);

            // If a 'null' type was specified, remove it -- this indicates that
            // the test case wants no type, not the default.

            if (null === result.type) {
                delete result.type;
            }
            return result;
        }
        const cases = {
            "just type": { i: "S", e: m({ type: "S"})},
            "sparse": { i: "%S", e: m({ type: "S", sparse: true}) },
            "just another type": { i: "B", e: m({ type: "B"})},
            "branch": { i: "S:Bm=2", e: m({
                branches: { m: new RepoAST.Branch("2", null), },
            })},
            "branch with tracking": {
                i: "S:Bm=2 foo/bar",
                e: m({
                    branches: {
                        m: new RepoAST.Branch("2", "foo/bar"),
                    },
                }),
            },
            "ref": { i: "S:Ffoo/bar=2", e: m({ refs: { "foo/bar": "2"}})},
            "null branch": { i: "S:Bm=", e: m({ branches: { m: null}})},
            "commit": { i: "S:C1-2", e: m({
                commits: {
                    "1": new Commit({
                        parents: ["2"],
                        changes: { "1": new File("1", false)},
                        message: "message\n",
                    }),
                }
            })},
            "empty commit": { i: "S:C1-2 ", e: m({
                commits: {
                    "1": new Commit({
                        parents: ["2"],
                        changes: {},
                        message: "message\n",
                    }),
                }
            })},
            "commit without a parent": {
                i: "S:C1 y=2",
                e: m({
                    commits: {
                        "1": new Commit({
                            parents: [],
                            changes: { y: new File("2", false) },
                            message: "message\n",
                        }),
                    },
                }),
            },
            "commit with message": { i: "S:Chello world#1-2", e: m({
                commits: {
                    "1": new Commit({
                        parents: ["2"],
                        changes: { "1": new File("1", false) },
                        message: "hello world",
                    }),
                }
            })},
            "commit with multiple parents": { i: "S:C3-1,2", e: m({
                commits: {
                    "3": new Commit({
                        parents: ["1","2"],
                        changes: { "3": new File("3", false) },
                        message: "message\n",
                    }),
                },
            })},
            "commit with everything": { i: "S:Chello#3-1,2 x=y,q=r", e: m({
                commits: {
                    "3": new Commit({
                        parents: ["1","2"],
                        changes: {
                            x: new File("y", false),
                            q: new File("r", false),
                        },
                        message: "hello",
                    }),
                },
            })},
            "commit with longer names": { i: "S:Cxxx2-yy", e: m({
                commits: {
                    "xxx2": new Commit({
                        parents: ["yy"],
                        changes: { "xxx2": new File("xxx2", false) },
                        message: "message\n",
                    }),
                }
            })},
            "commit with change": { i: "S:C1-2 foo=bar", e: m({
                commits: {
                    "1": new Commit({
                        parents: ["2"],
                        changes: { "foo": new File("bar", false) },
                        message: "message\n",
                    }),
                }
            })},
            "commit with empty change": { i: "S:C1-2 foo=", e: m({
                commits: {
                    "1": new Commit({
                        parents: ["2"],
                        changes: { "foo": new File("", false) },
                        message: "message\n",
                    }),
                }
            })},
            "commit with changes": { i: "S:C1-2 foo=bar,b=z", e: m({
                commits: {
                    "1": new Commit({
                        parents: ["2"],
                        changes: {
                            "foo": new File("bar", false),
                            "b": new File("z", false),
                        },
                        message: "message\n",
                    }),
                }
            })},
            "commit with changes and ws": { i: "S:C1-2 foo=bar,\n b=z", e: m({
                commits: {
                    "1": new Commit({
                        parents: ["2"],
                        changes: {
                            "foo": new File("bar", false),
                            "b": new File("z", false),
                        },
                        message: "message\n",
                    }),
                }
            })},
            "head": { i: "S:H=2", e: m({ head: "2"})},
            "no head": { i: "S:H=", e: m({ head: null })},
            "current branch": { i: "S:*=1", e: m({currentBranchName: "1"})},
            "no current branch": { i: "S:*=", e: m({currentBranchName: null})},
            "multiple overrides": {
                i: "S:Bm=;C1-2;*=1",
                e: m({
                    currentBranchName: "1",
                    commits: {
                        "1": new Commit({
                            parents: ["2"],
                            changes: { "1": new File("1", false) },
                            message: "message\n",
                    })},
                    branches: { m: null },
                }),
            },
            "multiple overrides with spaces": {
                i: "S:Bm=;\nC1-2;    *=1",
                e: m({
                    currentBranchName: "1",
                    commits: {
                        "1": new Commit({
                            parents: ["2"],
                            changes: { "1": new File("1", false) },
                            message: "message\n",
                    })},
                    branches: { m: null },
                }),
            },
            "multiple branches": {
                i: "S:Bm=1;By=2;Bz=",
                e: m({
                    branches: {
                        m: new RepoAST.Branch("1", null),
                        y: new RepoAST.Branch("2", null),
                        z: null,
                    },
                }),
            },
            "multiple commits": {
                i: "S:C1-2;C3-4",
                e: m({
                    commits: {
                        "1": new Commit({
                            parents: ["2"],
                            changes: { "1": new File("1", false) },
                            message: "message\n",
                        }),
                        "3": new Commit({
                            parents: ["4"],
                            changes: { "3": new File("3", false) },
                            message: "message\n",
                        }),
                    },
                }),
            },
            "remote": {
                i: "S:Rfoo=bar",
                e: m({
                    remotes: { foo: { url: "bar", branches: {}} },
                }),
            },
            "remote with a branch": {
                i: "S:Rfoo=bar origin=1",
                e: m({
                    remotes: {
                        foo: { url: "bar", branches: { origin: "1" }},
                    },
                }),
            },
            "remote with branches": {
                i: "S:Rfoo=bar origin=1,lame=2",
                e: m({
                    remotes: {
                        foo: {
                            url: "bar",
                            branches: { origin: "1", lame: "2", },
                        },
                    },
                }),
            },
            "remote with branches and spaces": {
                i: "S:Rfoo=bar origin=1,  \nlame=2",
                e: m({
                    remotes: {
                        foo: {
                            url: "bar",
                            branches: { origin: "1", lame: "2", },
                        },
                    },
                }),
            },
            "updated remote": {
                i: "S:Rfoo= origin=1,lame=2",
                e: m({
                    remotes: {
                        foo: {
                            url: null,
                            branches: { origin: "1", lame: "2", },
                        },
                    },
                }),
            },
            "type with data": {
                i: "Cfoo",
                e: m({
                    type: "C",
                    typeData: "foo",
                }),
            },
            "type with data and overrides": {
                i: "Cx x x:Bbaz=1",
                e: m({
                    type: "C",
                    typeData: "x x x",
                    branches: { baz: new RepoAST.Branch("1", null), },
                }),
            },
            "commit with submodule": {
                i: "S:C2-1 baz=S/foo.git:1",
                e: m({
                    type: "S",
                    commits: {
                        "2": new Commit({
                            parents: ["1"],
                            changes: { "baz": new Submodule("/foo.git", "1") },
                            message: "message\n",
                        }),
                    },
                }),
            },
            "commit with short submodule": {
                i: "S:C2-1 baz=So:1;Bmaster=2",
                e: m({
                    type: "S",
                    commits: {
                        "2": new Commit({
                            parents: ["1"],
                            changes: { "baz": new Submodule("o", "1") },
                            message: "message\n",
                        }),
                    },
                    branches: { master: new RepoAST.Branch("2", null), },
                }),
            },
            "index change": {
                i: "S:I x=y",
                e: m({
                    type: "S",
                    index: { x: new File("y", false) },
                }),
            },
            "index deletion and changes": {
                i: "S:I x=y,q,z=r",
                e: m({
                    type: "S",
                    index: {
                        x: new File("y", false),
                        q: null,
                        z: new File("r", false),
                    },
                }),
            },
            "index deletion and removal": {
                i: "S:I x=y,q=~,z=r",
                e: m({
                    type: "S",
                    index: {
                        x: new File("y", false),
                        q: undefined,
                        z: new File("r", false),
                    },
                }),
            },
            "index submodule change": {
                i: "S:I x=S/x:1",
                e: m({
                    type: "S",
                    index: { x: new Submodule("/x", "1") },
                }),
            },
            "index with conflict": {
                i: "S:I *a=x*y*S/x:2,b=q",
                e: m({
                    type: "S",
                     index: {
                         a: new Conflict(new File("x", false),
                                         new File("y", false),
                                         new Submodule("/x", "2")),
                         b: new File("q", false),
                     }
                }),
            },
            "index with conflict and nulls": {
                i: "S:I *a=*~*,b=q",
                e: m({
                    type: "S",
                     index: {
                         a: new Conflict(new File("", false),
                                         null,
                                         new File("", false)),
                         b: new File("q", false),
                     }
                }),
            },
            "workdir change": {
                i: "S:W x=y",
                e: m({
                    type: "S",
                    workdir: { x: new File("y", false) },
                }),
            },
            "workdir change, executable bit set": {
                i: "S:W x=+y",
                e: m({
                    type: "S",
                    workdir: { x: new File("y", true) },
                }),
            },
            "workdir deletion and changes": {
                i: "S:W x=y,q,z=r",
                e: m({
                    type: "S",
                    workdir: {
                        x: new File("y", false),
                        q: null,
                        z: new File("r", false),
                    },
                }),
            },
            "workdir removal and changes": {
                i: "S:W x=y,q=~,z=r",
                e: m({
                    type: "S",
                    workdir: {
                        x: new File("y", false),
                        q: undefined,
                        z: new File("r", false),
                    },
                }),
            },
            "workdir submodule change": {
                i: "S:W x=S/x:1",
                e: m({
                    type: "S",
                    workdir: { x: new Submodule("/x", "1") },
                }),
                fails: true,
            },
            "open submodule": {
                i: "S:Ox",
                e: m({
                    openSubmodules: { "x": m({ type: null}) },
                })
            },
            "open submodule one override": {
                i: "S:Oy Bmaster=foo",
                e: m({
                    openSubmodules: {
                        y: m({
                            type: null,
                            branches: {
                                master: new RepoAST.Branch("foo", null),
                            }
                        }),
                    },
                }),
            },
            "open submodule multiple overrides": {
                i: "S:Oy Bmaster=foo!W x=z",
                e: m({
                    openSubmodules: {
                        y: m({
                            type: null,
                            branches: {
                                master: new RepoAST.Branch("foo", null),
                            },
                            workdir: { x: new File("z", false) },
                        }),
                    },
                }),
            },
            "open submodule with head": {
                i: "S:I foo=Sa:1;Ofoo Bmaster=1!*=master",
                e: m({
                    index: {
                        foo: new RepoAST.Submodule("a", "1"),
                    },
                    openSubmodules: {
                        foo: m({
                            type: null,
                            currentBranchName: "master",
                            head: "1",
                            branches: {
                                master: new RepoAST.Branch("1", null),
                            },
                        }),
                    },
                }),
            },
            "remote override": {
                i: "S:Rorigin=a;H=2",
                e: m({
                    head: "2",
                    remotes: {
                        origin: {
                            url: "a",
                            branches: {},
                        },
                    },
                }),
            },

            "simple notes": {
                i: "S:C2-1;N refs/notes/morx 2=two",
                e: m({
                    commits: {
                        "2": new Commit({
                            parents: ["1"],
                            changes: { "2": new File("2", false) },
                            message: "message\n",
                        }),
                    },
                    notes: {
                        "refs/notes/morx": {
                            "2": "two"
                        },
                    },
                }),
            },
            "multiple notes refs, multiple commits": {
                i: "S:C2-1;N refs/notes/morx 1=one;N refs/notes/morx 2=two;" +
                "N refs/notes/fleem 1=fone;N refs/notes/fleem 2=ftwo",
                e: m({
                    commits: {
                        "2": new Commit({
                            parents: ["1"],
                            changes: { "2": new File("2", false) },
                            message: "message\n",
                        }),
                    },
                    notes: {
                        "refs/notes/fleem": {
                            "1": "fone",
                            "2": "ftwo",
                        },
                        "refs/notes/morx": {
                            "1": "one",
                            "2": "two",
                        },
                    },
                }),
            },
            "submodule with remote override": {
                i: "S:C2-1 a=Sa:1;Oa Rorigin=a;H=2",
                e: m({
                    commits: {
                        "2": new RepoAST.Commit({
                            parents: ["1"],
                            changes: {
                                a: new RepoAST.Submodule("a", "1"),
                            },
                            message: "message\n",
                        }),
                    },
                    head: "2",
                    openSubmodules: {
                        a: m({
                            type: null,
                            remotes: {
                                origin: {
                                    url: "a", 
                                    branches: {
                                    },
                                },
                            },
                        }),
                    },
                }),
            },
            "rebase": {
                i: "S:Emaster,1,2",
                e: m({
                    type: "S",
                    rebase: new RepoAST.Rebase("master", "1", "2"),
                }),
            },
            "rebase null": {
                i: "S:E",
                e: m({
                    type: "S",
                    rebase: null,
                }),
            },
            "sequencer null": {
                i: "S:Q",
                e: m({
                     type: "S",
                     sequencerState: null,
                }),
            },
            "sequencer with cherry": {
                i: "S:QC 1:foo 3: 2 a,b,c",
                e: m({
                     type: "S",
                     sequencerState: new SequencerState({
                        type: SequencerState.TYPE.CHERRY_PICK,
                        originalHead: new CommitAndRef("1", "foo"),
                        target: new CommitAndRef("3", null),
                        currentCommit: 2,
                        commits: ["a", "b", "c"],
                     }),
                }),
            },
            "sequencer with merge": {
                i: "S:QM 1:foo 3: 2 a,b,c",
                e: m({
                     type: "S",
                     sequencerState: new SequencerState({
                        type: SequencerState.TYPE.MERGE,
                        originalHead: new CommitAndRef("1", "foo"),
                        target: new CommitAndRef("3", null),
                        currentCommit: 2,
                        commits: ["a", "b", "c"],
                     }),
                }),
            },
            "sequencer with rebase": {
                i: "S:QR 1:foo 3: 2 a,b,c",
                e: m({
                     type: "S",
                     sequencerState: new SequencerState({
                        type: SequencerState.TYPE.REBASE,
                        originalHead: new CommitAndRef("1", "foo"),
                        target: new CommitAndRef("3", null),
                        currentCommit: 2,
                        commits: ["a", "b", "c"],
                     }),
                }),
            },
            "sequencer with message": {
                i: "S:Qhello world#R 1:foo 3: 2 a,b,c",
                e: m({
                     type: "S",
                     sequencerState: new SequencerState({
                        type: SequencerState.TYPE.REBASE,
                        originalHead: new CommitAndRef("1", "foo"),
                        target: new CommitAndRef("3", null),
                        currentCommit: 2,
                        commits: ["a", "b", "c"],
                        message: "hello world",
                     }),
                }),
            },
            "new submodule": {
                i: "S:I x=Sfoo:;Ox",
                e: m({
                    type: "S",
                    index: {
                        x: new Submodule("foo", null),
                    },
                    openSubmodules: {
                        x: m({ type: null }),
                    },
                }),
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                let r;
                try {
                    r = ShorthandParserUtil.parseRepoShorthandRaw(c.i);
                }
                catch (e) {
                    assert(c.fails, e.stack);
                    return;
                }
                assert(!c.fails);
                const e = c.e;
                assert.equal(r.type, e.type);
                assert.equal(r.typeData, e.typeData);
                assert.deepEqual(r.commits, e.commits);
                assert.deepEqual(r.branches, e.branches);
                assert.deepEqual(r.remotes, e.remotes);
                assert.deepEqual(r.index, e.index);
                assert.deepEqual(r.workdir, e.workdir);
                assert.equal(r.head, e.head);
                assert.equal(r.currentBranchName, e.currentBranchName);
                assert.deepEqual(r.openSubmodules, e.openSubmodules);
                assert.deepEqual(r.rebase, e.rebase);
                assert.deepEqual(r.sequencerState, e.sequencerState);
                assert.equal(r.sparse, e.sparse);
            });
        });
    });

    describe("parseRepoShorthand", function () {
        // Parsing is handled (and tested) by `parseRepoShorthandRaw`.  Here we
        // just need to test that subsequent assembly is correct.

        const Commit = RepoAST.Commit;
        const Remote = RepoAST.Remote;
        const B = ShorthandParserUtil.RepoType.B;
        const S = ShorthandParserUtil.RepoType.S;

        const cases = {
            "simple": {
                i: "S",
                e: S
            },
            "sparse": {
                i: "%S",
                e: S.copy({
                    sparse: true,
                }),
            },
            "null": {
                i: "N",
                e: new RepoAST(),
            },
            "current implies head": {
                i: "N:C1;Bx=1;*=x",
                e: new RepoAST({
                    commits: {
                        "1": new Commit({
                            changes: {
                                "1": new File("1", false),
                            },
                            message: "message\n",
                        }),
                    },
                    head: "1",
                    currentBranchName: "x",
                    branches: {
                        x: new RepoAST.Branch("1", null),
                    },
                }),
            },
            "simple trimmed": {
                i: "\n  S",
                e: S
            },
            "bare": {
                i: "B",
                e: B,
            },
            "bare with commit": {
                i: "B:C2-1;Bmaster=2",
                e: B.copy({
                    commits: {
                        "1": B.commits["1"],
                        "2": new Commit({
                            changes: { "2": new File("2", false) },
                            message: "message\n",
                            parents: ["1"],
                        }),
                    },
                    branches: {
                        "master": new RepoAST.Branch("2", null),
                    },
                    head: "2",
                }),
            },
            "A type": {
                i: "Axyz",
                e: new RepoAST({
                    commits: {
                        xyz: new Commit({
                            changes: {
                                xyz: new File("xyz", false),
                            },
                            message: "changed xyz",
                        }),
                    },
                    branches: {
                        master: new RepoAST.Branch("xyz", null),
                    },
                    head: "xyz",
                    currentBranchName: "master",
                }),
            },
            "noHead": {
                i: "S:H=",
                e: S.copy({ head: null, currentBranchName: null }),
            },
            "killMaster": {
                i: "S:Bmaster=;*=",
                e: S.copy({ branches: {}, currentBranchName: null }),
            },
            "newMaster": {
                i: "S:C2-1;Bmaster=2",
                e: S.copy({
                    head: "2",
                    branches: { master: new RepoAST.Branch("2", null), },
                    commits: (() => {
                        let commits = S.commits;
                        commits[2] = new Commit({
                            parents: ["1"],
                            changes: { "2": new File("2", false) },
                            message: "message\n",
                        });
                        return commits;
                    })(),
                }),
            },
            "switchCurrent": {
                i: "S:C2-1;Bfoo=2;*=foo",
                e: S.copy({
                    head: "2",
                    currentBranchName: "foo",
                    branches: {
                        master: new RepoAST.Branch("1", null),
                        foo: new RepoAST.Branch("2", null),
                    },
                    commits: (() => {
                        let commits = S.commits;
                        commits[2] = new Commit({
                            parents: ["1"],
                            changes: { "2": new File("2", false) },
                            message: "message\n",
                        });
                        return commits;
                    })(),
                }),
            },
            "remote": {
                i: "S:Ra=b",
                e: S.copy({
                    remotes: {
                        a: new Remote("b"),
                    }
                }),
            },
            "remote and branch": {
                i: "S:Ra=b q=1",
                e: S.copy({
                    remotes: {
                        a: new Remote("b", {
                            branches: { q: "1" },
                        }),
                    }
                }),
            },
            "index change": {
                i: "S:I a=b",
                e: S.copy({
                    index: {
                        a: new File("b", false),
                    }
                }),
            },
            "bad type data": {
                i: "S I max=maz",
                fails: true,
            },
            "bad: open submodule": {
                i: "S:Ox",
                fails: true,
            },
            "test U": {
                i: "S:Cadded 's'#2-1 s=Sa:1;Bmaster=2",
                e: ShorthandParserUtil.RepoType.U,
            },
            "rebase": {
                i: "S:Efoo,1,1",
                e: S.copy({
                    rebase: new RepoAST.Rebase("foo", "1", "1"),
                }),
            },
            "sequencer": {
                i: "S:QM 1:foo 1: 0 1",
                e: S.copy({
                     sequencerState: new SequencerState({
                        type: SequencerState.TYPE.MERGE,
                        originalHead: new CommitAndRef("1", "foo"),
                        target: new CommitAndRef("1", null),
                        currentCommit: 0,
                        commits: ["1"],
                     }),
                }),
            },
        };
        Object.keys(cases).forEach(caseName => {
            it(caseName, function () {
                const c = cases[caseName];
                let result;
                try {
                    result = ShorthandParserUtil.parseRepoShorthand(c.i);
                }
                catch (e) {
                    assert(c.fails, e.stack);
                    return;
                }
                assert(!c.fails);
                RepoASTUtil.assertEqualASTs(result, c.e);
            });
        });
    });

    describe("parseMultiRepoShorthand", function () {
        const AST = RepoAST;
        const Commit = AST.Commit;
        const Remote = AST.Remote;
        const Submodule = AST.Submodule;
        const B = ShorthandParserUtil.RepoType.B;
        const S = ShorthandParserUtil.RepoType.S;
        const U = ShorthandParserUtil.RepoType.U;
        const cases = {
            "simple": { i: "a=S", e: { a: "S"} },
            "bare with commit": {
                i: "a=B:C2-1;Bmaster=2",
                e: {
                    a: B.copy({
                        commits: {
                            "1": B.commits["1"],
                            "2": new Commit({
                                changes: { "2": new File("2", false) },
                                message: "message\n",
                                parents: ["1"],
                            }),
                        },
                        branches: {
                            "master": new RepoAST.Branch("2", null),
                        },
                        head: "2",
                    }),
                },
            },
            "simple trimmed": { i: "\n  a=S", e: { a: "S"} },
            "multiple": {
                i: "a=S|b=S:Bfoo=1",
                e: { a: "S", b: "S:Bfoo=1" }
            },
            "multiple with space": {
                i: "a=S|\n    b=S:Bfoo=1",
                e: { a: "S", b: "S:Bfoo=1" }
            },
            "external commit": {
                i: "a=S:Bfoo=2|b=S:C2-1;Bmaster=2",
                e: {
                    a: "S:C2-1;Bfoo=2",
                    b: "S:C2-1;Bmaster=2",
                },
            },
            "external commit from descendant": {
                i: "a=S:C3-2;C2-1;Bbar=3|b=S:Bbaz=3",
                e: {
                    a: "S:C3-2;C2-1;Bbar=3",
                    b: "S:C3-2;C2-1;Bbaz=3",
                }
            },
            "external ref'd from head": {
                i: "a=S:H=2|b=S:C2-1;Bmaster=2",
                e: {
                    a: "S:C2-1;H=2",
                    b: "S:C2-1;Bmaster=2",
                },
            },
            "external ref'd from remote": {
                i: "a=S:Ra=b m=2|b=S:C2-1;Bmaster=2",
                e: {
                    a: "S:C2-1;Ra=b m=2",
                    b: "S:C2-1;Bmaster=2",
                },
            },
            "simple clone": {
                i: "a=S|b=Ca",
                e: {
                    a: "S",
                    b: "S:Rorigin=a master=1;Bmaster=1 origin/master",
                },
            },
            "clone with overrides": {
                i: "a=S:C2-1;Bfoo=2;*=foo|b=Ca:Bg=1",
                e: {
                    a: "S:C2-1;Bfoo=2;*=foo",
                    b:
       "S:C2-1;Rorigin=a master=1,foo=2;*=foo;Bg=1;Bfoo=2 origin/foo;Bmaster=",
                },
            },
            "clone with remote update": {
                i: "a=S|b=Ca:Rorigin= baz=1",
                e: {
                    a: "S",
                    b: "S:Rorigin=a master=1,baz=1;Bmaster=1 origin/master",
                },
            },
            "clone with remote update deleting branch": {
                i: "a=S|b=Ca:Rorigin= master=",
                e: {
                    a: "S",
                    b: "S:Rorigin=a;Bmaster=1 origin/master",
                },
            },
            "bad type data": {
                i: "a=S I max=maz|b=S:C2-1 foo=Sa:1;Bmaster=2",
                fails: true,
            },
            "relative sub": {
                i: "a=B|x=S:C2-1 s=S../a:1;Bmaster=2",
                e: {
                    a: "B",
                    x: "S:C2-1 s=S../a:1;Bmaster=2",
                },
            },
            "simple open sub": {
                i: "a=S|b=S:I foo=Sa:1;Ofoo",
                e: {
                    a: "S",
                    b: S.copy({
                        index: { foo: new Submodule("a", "1") },
                        openSubmodules: {
                            foo: RepoASTUtil.cloneRepo(S, "a").copy({
                                branches: {},
                                currentBranchName: null,
                                remotes: { origin: new Remote("a") },
                            })
                        }
                    }),
                },
            },
            "open sub, missing url": {
                i: "b=S:I foo=S/a:;Ofoo",
                e: {
                    b: S.copy({
                        index: { foo: new Submodule("/a", null) },
                        openSubmodules: {
                            foo: RepoASTUtil.cloneRepo(
                                new RepoAST(), "/a").copy({
                                    branches: {},
                                    currentBranchName: null,
                                    remotes: { origin: new Remote("/a") },
                                })
                        }
                    }),
                },
            },
            "simple open sub with relative URL": {
                i: "a=S|b=S|x=Cb:I foo=S../a:1;Ofoo",
                e: {
                    a: "S",
                    b: "S",
                    x: RepoASTUtil.cloneRepo(S, "b").copy({
                        index: { foo: new Submodule("../a", "1") },
                        openSubmodules: {
                            foo: RepoASTUtil.cloneRepo(S, "a").copy({
                                branches: {},
                                currentBranchName: null,
                                remotes: { origin: new Remote("a") },
                            })
                        }
                    }),
                },
            },
            "open sub with branch": {
                i: "a=S|b=S:I foo=Sa:1;Ofoo Bm=1",
                e: {
                    a: "S",
                    b: S.copy({
                        index: { foo: new Submodule("a", "1") },
                        openSubmodules: {
                            foo: RepoASTUtil.cloneRepo(S, "a").copy({
                                branches: { m: new RepoAST.Branch("1", null) },
                                currentBranchName: null,
                                remotes: { origin: new Remote("a") },
                            })
                        }
                    }),
                },
            },
            "open sub with branch and new commit": {
                i: "a=S|b=S:I foo=Sa:1;Ofoo Bm=1!C2-1!Baa=2",
                e: {
                    a: "S",
                    b: S.copy({
                        index: { foo: new Submodule("a", "1") },
                        openSubmodules: {
                            foo: RepoASTUtil.cloneRepo(S, "a").copy({
                                commits: {
                                    "1": new Commit({
                                        changes: {
                                            "README.md": new File(
                                                                 "hello world",
                                                                  false),
                                        },
                                        message: "the first commit",
                                    }),
                                    "2": new Commit({
                                        parents: ["1"],
                                        changes: { "2": new File("2", false) },
                                        message: "message\n",
                                    }),
                                },
                                branches: {
                                    m: new RepoAST.Branch("1", null),
                                    aa: new RepoAST.Branch("2", null),
                                },
                                currentBranchName: null,
                                remotes: { origin: new Remote("a") },
                            })
                        }
                    }),
                },
            },
            "open sub with index and workdir": {
                i: "a=S|b=S:I foo=Sa:1;Ofoo I x=y!W u=2",
                e: {
                    a: "S",
                    b: S.copy({
                        index: { foo: new Submodule("a", "1") },
                        openSubmodules: {
                            foo: RepoASTUtil.cloneRepo(S, "a").copy({
                                branches: {},
                                index: { x: new File("y", false) },
                                workdir: { u: new File("2", false) },
                                currentBranchName: null,
                                remotes: { origin: new Remote("a") },
                            })
                        }
                    }),
                },
            },
            "sub with new commit": {
                i: "a=S|b=S:C2-1 s=Sa:3;Bmaster=2",
                e: {
                    a: "S",
                    b: new RepoAST({
                        currentBranchName: "master",
                        head: "2",
                        branches: {
                            master: new RepoAST.Branch("2", null),
                        },
                        commits: {
                            "1": new Commit({
                                changes: {
                                    "README.md": new File("hello world", false)
                                },
                                message: "the first commit",
                            }),
                            "2": new Commit({
                                parents: ["1"],
                                changes: {
                                    s: new Submodule("a","3"),
                                },
                                message: "message\n",
                            }),
                        },
                    }),
                },
            },
            "open sub with new commit": {
                i: "a=S|b=S:C2-1 s=Sa:3;Bmaster=2;Os C3-1!H=3",
                e: {
                    a: "S",
                    b: new RepoAST({
                        currentBranchName: "master",
                        head: "2",
                        branches: {
                            master: new RepoAST.Branch("2", null),
                        },
                        commits: {
                            "1": new Commit({
                                changes: {
                                    "README.md": new File("hello world", false)
                                },
                                message: "the first commit",
                            }),
                            "2": new Commit({
                                parents: ["1"],
                                changes: {
                                    s: new Submodule("a","3"),
                                },
                                message: "message\n",
                            }),
                        },
                        openSubmodules: {
                            s: ShorthandParserUtil.parseRepoShorthand(
                                "S:C3-1;H=3;Bmaster=;Rorigin=a"),
                        },
                    }),
                },
            },

            // crazy, but should work
            "commit defined in open sub referenced elsewhere": {
                i: "r=S:Bmax=2|a=S|b=S:I foo=Sa:1;Ofoo C2-1!Bx=2",
                e: {
                    a: "S",
                    r: "S:C2-1;Bmax=2",
                    b: S.copy({
                        index: { foo: new Submodule("a", "1") },
                        openSubmodules: {
                            foo: RepoASTUtil.cloneRepo(S, "a").copy({
                                commits: {
                                    "1": new Commit({
                                        changes: {
                                            "README.md": new File(
                                                                 "hello world",
                                                                  false),
                                        },
                                        message: "the first commit",
                                    }),
                                    "2": new Commit({
                                        parents: ["1"],
                                        changes: { "2": new File("2", false) },
                                        message: "message\n",
                                    }),
                                },
                                branches: {
                                    x: new RepoAST.Branch("2", null),
                                },
                                currentBranchName: null,
                                remotes: { origin: new Remote("a") },
                            })
                        }
                    }),
                },
            },
            "keeping an existing": {
                i: "a=S:Bfoo=1",
                existing: { b: S },
                e: {
                    a: S.copy({ branches: {
                        master: new RepoAST.Branch("1", null),
                        foo: new RepoAST.Branch("1", null),
                    }}),
                    b: S,
                },
            },
            "change from existing": {
                i: "a=E:*=foo",
                existing: {
                    a: ShorthandParserUtil.parseRepoShorthand("S:Bfoo=1"),
                },
                e: {
                    a: ShorthandParserUtil.parseRepoShorthand("S:Bfoo=1;*=foo")
                },
            },
            "with an A type for base of sub": {
                i: "a=Ax|b=S:C2-1 s=Sa:x;Bmaster=2",
                e: {
                    a: ShorthandParserUtil.parseRepoShorthand("Ax"),
                    b: new RepoAST({
                        commits: {
                            "1": new RepoAST.Commit({
                                changes: {
                                    "README.md": new File("hello world", false)
                                },
                                message: "the first commit",
                            }),
                            "2": new RepoAST.Commit({
                                parents: ["1"],
                                changes: {
                                    s: new RepoAST.Submodule("a","x"),
                                },
                                message: "message\n",
                            }),
                        },
                        branches: {
                            master: new RepoAST.Branch("2", null),
                        },
                        head: "2",
                        currentBranchName: "master",
                    }),
                },
            },
            "missing commits in open sub": {
                i: "a=B:C8-1;Bmaster=8|b=U:Os",
                e: {
                    a: B.copy({
                        commits: {
                            "1": new Commit({
                                changes: {
                                    "README.md": new File("hello world", false)
                                },
                                message: "the first commit",
                            }),
                            "8": new Commit({
                                parents: ["1"],
                                changes: { "8": new File("8", false) },
                                message: "message\n",
                            }),
                        },
                        branches: {
                            master: new RepoAST.Branch("8", null),
                        },
                        currentBranchName: "master",
                        head: "8",
                    }),
                    b: U.copy({
                        openSubmodules: {
                            s: RepoASTUtil.cloneRepo(S, "a").copy({
                                branches: {},
                                head: "1",
                                currentBranchName: null,
                                remotes: { origin: new Remote("a") },
                            })
                        },
                    }),
                },
            },
            "missing commits in rebase": {
                i: `
a=B:C8-1;C9-1;Bmaster=8;Bfoo=9|
x=S:Efoo,8,9`,
                e: {
                    a: B.copy({
                        commits: {
                            "1": new Commit({
                                changes: {
                                    "README.md": new File("hello world", false)
                                },
                                message: "the first commit",
                            }),
                            "8": new Commit({
                                parents: ["1"],
                                changes: { "8": new File("8", false) },
                                message: "message\n",
                            }),
                            "9": new Commit({
                                parents: ["1"],
                                changes: { "9": new File("9", false) },
                                message: "message\n",
                            }),
                        },
                        branches: {
                            master: new RepoAST.Branch("8", null),
                            foo: new RepoAST.Branch("9", null),
                        },
                        head: "8",
                    }),
                    x: S.copy({
                        commits: {
                            "1": new Commit({
                                changes: {
                                    "README.md": new File("hello world", false)
                                },
                                message: "the first commit",
                            }),
                            "8": new Commit({
                                parents: ["1"],
                                changes: { "8": new File("8", false) },
                                message: "message\n",
                            }),
                            "9": new Commit({
                                parents: ["1"],
                                changes: { "9": new File("9", false) },
                                message: "message\n",
                            }),
                        },
                        rebase: new RepoAST.Rebase("foo", "8", "9"),
                    }),
                }
            },
            "new open sub": {
                i: "a=B|x=S:I s=Sa:;Os",
                e: {
                    a: B,
                    x: S.copy({
                        index: {
                            s: new RepoAST.Submodule("a", null)
                        },
                        openSubmodules: {
                            s: new RepoAST({
                                remotes: {
                                    origin: new RepoAST.Remote("a"),
                                },
                            }),
                        },
                    }),
                },
            },
            "sub with '.' origin and parent having remote from base": {
                i: "a=B|x=Ca:I s=S.:;Os",
                e: {
                    a: B,
                    x: RepoASTUtil.cloneRepo(B, "a").copy({
                        index: {
                            s: new RepoAST.Submodule(".", null),
                        },
                        openSubmodules: {
                            s: new RepoAST({
                                remotes: {
                                    origin: new RepoAST.Remote("a"),
                                },
                            }),
                        },
                    }),
                },
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                let result;
                try {
                    result = ShorthandParserUtil.parseMultiRepoShorthand(
                                                                   c.i,
                                                                   c.existing);
                }
                catch (e) {
                    assert(c.fails, e.stack);
                    return;
                }
                assert(!c.fails);
                let expected = {};
                for (let name in c.e) {
                    let input = c.e[name];
                    if (!(input instanceof RepoAST)) {
                        input = ShorthandParserUtil.parseRepoShorthand(input);
                    }
                    expected[name] = input;
                }
                RepoASTUtil.assertEqualRepoMaps(result, expected);
            });
        });
    });
});
