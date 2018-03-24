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

const Rebase         = require("../../lib/util/rebase");
const RepoStatus     = require("../../lib/util/repo_status");
const SequencerState = require("../../lib/util/sequencer_state");

describe("RepoStatus", function () {
const CommitAndRef = SequencerState.CommitAndRef;
const MERGE = SequencerState.TYPE.MERGE;

    const FILESTATUS = RepoStatus.FILESTATUS;
    const Submodule = RepoStatus.Submodule;
    const Commit = Submodule.Commit;
    const Index = Submodule.Index;
    const Workdir = Submodule.Workdir;
    const RELATION = Submodule.COMMIT_RELATION;

    describe("Submodule.Commit", function () {
        it("breathing", function () {
            const commit = new Commit("aaa", "/a");
            assert.equal(commit.sha, "aaa");
            assert.equal(commit.url, "/a");
        });
    });

    describe("Submodule.Index", function () {
        it("breathing", function () {
            const index = new Index("aaa", "/a", RELATION.AHEAD);
            assert.equal(index.sha, "aaa");
            assert.equal(index.url, "/a");
            assert.equal(index.relation, RELATION.AHEAD);
        });
    });

    describe("Submodule.Workdir", function () {
        const status = new RepoStatus({ headCommit: "3" });
        const workdir = new Workdir(status, RELATION.BEHIND);
        assert.deepEqual(workdir.status, status);
        assert.equal(workdir.relation, RELATION.BEHIND);
    });

    describe("Submodule", function () {
        function m(args) {
            const result = {
                commit: null,
                index: null,
                workdir: null,
            };
            Object.assign(result, args);
            return result;
        }

        const cases = {
            "new and open": {
                args: {
                    index: new Index("1", "a", null),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "1",
                    }), RELATION.SAME),
                },
                expected: m({
                    index: new Index("1", "a", null),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "1",
                    }), RELATION.SAME),
                }),
            },
            "no changes": {
                args: {
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                },
                expected: m({
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                }),
            },
            "no changes open": {
                args: {
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "1",
                    }), RELATION.SAME),
                },
                expected: m({
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "1",
                    }), RELATION.SAME),
                }),
            },
            "deleted": {
                args: {
                    commit: new Commit("1", "b"),
                },
                expected: m({
                    commit: new Commit("1", "b"),
                }),
            },
        };

        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = new Submodule(c.args);
                const e = c.expected;
                assert.deepEqual(result.commit, e.commit);
                assert.deepEqual(result.index, e.index);
                assert.deepEqual(result.workdir, e.workdir);
            });
        });
    });

    describe("Submodule.isIndexClean", function () {
        const cases = {
            "no changes": {
                input: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                }),
                expected: true,
            },
            "changed files in open repo": {
                input: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "1",
                        workdir: {
                            "foo": FILESTATUS.MODIFIED,
                        },
                    }), RELATION.SAME),
                }),
                expected: true,
            },
            "new commit in open repo": {
                input: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "2",
                    }), RELATION.AHEAD),
                }),
                expected: false,
            },
            "new commit in open repo, new sub": {
                input: new Submodule({
                    index: new Index("1", "a", null),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "2"
                    }), RELATION.AHEAD),
                }),
                expected: false,
            },
            "new sub": {
                input: new Submodule({
                    index: new Index("1", "a", null),
                }),
                expected: false,
            },
            "different commit": {
                input: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("2", "a", RELATION.BEHIND),
                }),
                expected: false,
            },
        };

        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = c.input.isIndexClean();
                assert.equal(result, c.expected);
            });
        });
    });

    describe("Submodule.isWorkdirClean", function () {
        const cases = {
            "no changes": {
                input: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                }),
                expected: true,
            },
            "new files in open repo": {
                input: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "1",
                        workdir: {
                            foo: FILESTATUS.ADDED,
                        },
                    }), RELATION.SAME),
                }),
                expected: true,
            },
            "new files in open repo, but all": {
                input: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "1",
                        workdir: {
                            foo: FILESTATUS.ADDED,
                        },
                    }), RELATION.SAME),
                }),
                all: true,
                expected: false,
            },
            "changed files in open repo": {
                input: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "1",
                        workdir: {
                            "foo": FILESTATUS.MODIFIED,
                        },
                    }), RELATION.SAME),
                }),
                expected: false,
            },
            "new commit in open repo": {
                input: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "0",
                    }), RELATION.BEHIND),
                }),
                expected: true,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const all = c.all || false;
                const result = c.input.isWorkdirClean(all);
                assert.equal(result, c.expected);
            });
        });
    });

    describe("Submodule.isIndexClean", function () {
        const cases = {
            "no changes": {
                input: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                }),
                expected: true,
            },
            "changed files in open repo": {
                input: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "1",
                        workdir: {
                            "foo": FILESTATUS.MODIFIED,
                        },
                    }), RELATION.SAME),
                }),
                expected: true,
            },
            "new commit in index": {
                input: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("2", "a", RELATION.AHEAD),
                }),
                expected: false,
            },
            "deleted": {
                input: new Submodule({
                    commit: new Commit("1", "a"),
                }),
                expected: false,
            },
            "new sub": {
                input: new Submodule({
                    index: new Index(null, "a", null),
                }),
                expected: false,
            },
            "new commit in open repo": {
                input: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "0"
                    }), RELATION.BEHIND),
                }),
                expected: false,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = c.input.isIndexClean();
                assert.equal(result, c.expected);
            });
        });
    });

    describe("Submodule.isNew", function () {
        const cases = {
            "not new": {
                input: new Submodule({
                    commit: new Commit("1", "2"),
                }),
                expected: false,
            },
            "new": {
                input: new Submodule({
                    index: new Index(null, "a", null),
                }),
                expected: true,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = c.input.isNew();
                assert.equal(result, c.expected);
            });
        });
    });

    describe("Submodule.isCommittable", function () {
        const cases = {
            "not new": {
                input: new Submodule({
                    commit: new Commit("1", "a"),
                }),
                expected: true,
            },
            "new but staged commit": {
                input: new Submodule({
                    index: new Index("1", "a", null),
                }),
                expected: true,
            },
            "new but new commit in repo": {
                input: new Submodule({
                    index: new Index(null, "a", null),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "3",
                    }), null),
                }),
                expected: true,
            },
            "new but staged file": {
                input: new Submodule({
                    index: new Index(null, "a", null),
                    workdir: new Workdir(new RepoStatus({
                        staged: {
                            foo: FILESTATUS.ADDED,
                        },
                    }), null),
                }),
                expected: true,
            },
            "new, open, and no good": {
                input: new Submodule({
                    index: new Index(null, "a", null),
                    workdir: new Workdir(new RepoStatus(), null),
                }),
                expected: false,
            },
            "new and no good": {
                input: new Submodule({
                    index: new Index(null, "a", null),
                }),
                expected: false,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = c.input.isCommittable();
                assert.equal(result, c.expected);
            });
        });
    });

    describe("Submodule.copy", function () {
        const sub = new Submodule({
            commit: new Commit("2", "/b"),
            index: new Index("1", "/a", FILESTATUS.ADDED),
            workdir: new Workdir(new RepoStatus({ headCommit: "3"}),
                                 RELATION.AHEAD),
        });
        const anotherSub = new Submodule({
            commit: new Commit("4", "/d"),
            index: new Index("2", "/q", FILESTATUS.REMOVED),
            workdir: new Workdir(new RepoStatus({ headCommit: "1"}),
                                 RELATION.BEHIND),
        });
        it("simple, no args", function () {
            const newSub = sub.copy();
            assert.deepEqual(newSub, sub);
        });
        it("simple, empty args", function () {
            const newSub = sub.copy({});
            assert.deepEqual(newSub, sub);
        });
        it("copy it all", function () {
            const newSub = sub.copy({
                commit: anotherSub.commit,
                index: anotherSub.index,
                workdir: anotherSub.workdir,
            });
            assert.deepEqual(newSub, anotherSub);
        });
    });

    describe("Submodule.open", function () {
        it("breathing", function () {
            const sub = new Submodule({
                commit: new Commit("1", "/a"),
                index: new Index("1", "/a", RELATION.SAME),
            });
            const opened = sub.open();
            assert.deepEqual(opened, new Submodule({
                commit: sub.commit,
                index: sub.index,
                workdir: new Workdir(new RepoStatus({
                    headCommit: "1",
                }), RELATION.SAME),
            }));
        });
    });

    describe("RepoStatus", function () {
        function m(args) {
            let result = {
                currentBranchName: null,
                headCommit: null,
                staged: {},
                workdir: {},
                submodules: {},
                rebase: null,
                sequencerState: null,
            };
            return Object.assign(result, args);
        }
        const cases = {
            "trivial, undefined": {
                args: undefined,
                e: m({}),
            },
            "all defaults": {
                args:  m({}),
                e: m({}),
            },
            "all specified": {
                args: {
                    currentBranchName: "foo",
                    headCommit: "1",
                    staged: { "x/y": FILESTATUS.MODIFIED },
                    workdir: { "x/z": FILESTATUS.REMOVED },
                    submodules: {
                        "a": new Submodule({
                            commit: new Commit("1", "a"),
                            index: new Index("1", "a", RELATION.SAME),
                        }),
                    },
                    rebase: new Rebase("foo", "1", "2"),
                    sequencerState: new SequencerState({
                        type: MERGE,
                        originalHead: new CommitAndRef("foo", null),
                        target: new CommitAndRef("bar", "baz"),
                        commits: ["2", "1"],
                        currentCommit: 1,
                    }),
                },
                e: m({
                    currentBranchName: "foo",
                    headCommit: "1",
                    staged: { "x/y": FILESTATUS.MODIFIED },
                    workdir: { "x/z": FILESTATUS.REMOVED },
                    submodules: {
                        "a": new Submodule({
                            commit: new Commit("1", "a"),
                            index: new Index("1", "a", RELATION.SAME),
                        }),
                    },
                    rebase: new Rebase("foo", "1", "2"),
                    sequencerState: new SequencerState({
                        type: MERGE,
                        originalHead: new CommitAndRef("foo", null),
                        target: new CommitAndRef("bar", "baz"),
                        commits: ["2", "1"],
                        currentCommit: 1,
                    }),
                }),
            }
        };

        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            const result = new RepoStatus(c.args);
            assert.instanceOf(result, RepoStatus);
            assert.isFrozen(result);
            assert.equal(result.currentBranchName, c.e.currentBranchName);
            assert.equal(result.headCommit, c.e.headCommit);
            assert.deepEqual(result.staged, c.e.staged);
            assert.deepEqual(result.workdir, c.e.workdir);
            assert.deepEqual(result.submodules, c.e.submodules);
            assert.deepEqual(result.rebase, c.e.rebase);
            assert.deepEqual(result.sequencerState, c.e.sequencerState);
        });
    });

    describe("isIndexClean", function () {
        const cases = {
            "trivial": {
                input: new RepoStatus(),
                expected: true,
            },
            "all possible and still clean": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    workdir: {
                        foo: FILESTATUS.ADDED,
                        bar: FILESTATUS.MODIFIED,
                    },
                    submodules: {
                        "a": new Submodule({
                            commit: new Commit("1", "a"),
                            index: new Index("1", "a", RELATION.SAME),
                            workdir: new Workdir(new RepoStatus({
                                headCommit: "1",
                                staged: { q: FILESTATUS.MODIFIED },
                                workdir: { x: FILESTATUS.MODIFIED },
                            }), RELATION.SAME),
                        }),
                    },
                }),
                expected: true,
            },
            "staged": {
                input: new RepoStatus({
                    staged: { x: FILESTATUS.ADDED },
                }),
                expected: false,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = c.input.isIndexClean();
                assert.equal(result, c.expected);
            });
        });
    });

    describe("isWorkdirClean", function () {
        const cases = {
            "trivial": {
                input: new RepoStatus(),
                expected: true,
            },
            "all possible and still clean": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    workdir: { foo: FILESTATUS.ADDED },
                    staged: { x: FILESTATUS.MODIFIED },
                    submodules: {
                        "a": new Submodule({
                            commit: new Commit("1", "a"),
                            index: new Index("1", "a", RELATION.SAME),
                            workdir: new Workdir(new RepoStatus({
                                headCommit: "1",
                                workdir: { x: FILESTATUS.ADDED },
                                staged: { q: FILESTATUS.MODIFIED },
                            }), RELATION.SAME),
                        }),
                    },
                }),
                expected: true,
            },
            "all": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    workdir: { foo: FILESTATUS.ADDED },
                    staged: { x: FILESTATUS.MODIFIED },
                    submodules: {
                        "a": new Submodule({
                            commit: new Commit("1", "a"),
                            index: new Index("1", "a", RELATION.SAME),
                            workdir: new Workdir(new RepoStatus({
                                headCommit: "1",
                                workdir: { x: FILESTATUS.ADDED },
                                staged: { q: FILESTATUS.MODIFIED },
                            }), RELATION.SAME),
                        }),
                    },
                }),
                all: true,
                expected: false,
            },
            "workdir": {
                input: new RepoStatus({
                    workdir: { x: FILESTATUS.MODIFIED },
                }),
                expected: false,
            },
            "workdir all": {
                input: new RepoStatus({
                    workdir: { x: FILESTATUS.MODIFIED },
                }),
                all: true,
                expected: false,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const all = c.all || false;
                const result = c.input.isWorkdirClean(all);
                assert.equal(result, c.expected);
            });
        });
    });

    describe("isIndexDeepClean", function () {
        const cases = {
            "trivial": {
                input: new RepoStatus(),
                expected: true,
            },
            "all possible and still clean": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    workdir: { foo: FILESTATUS.MODIFIED },
                    submodules: {
                        "a": new Submodule({
                            commit: new Commit("1", "a"),
                            index: new Index("1", "a", RELATION.SAME),
                            workdir: new Workdir(new RepoStatus({
                                headCommit: "1",
                                workdir: { foo: FILESTATUS.ADDED },
                            }), RELATION.SAME),
                        }),
                    },
                }),
                expected: true,
            },
            "staged": {
                input: new RepoStatus({
                    staged: { x: FILESTATUS.ADDED },
                }),
                expected: false,
            },
            "workdir": {
                input: new RepoStatus({
                    workdir: { x: FILESTATUS.MODIFIED },
                }),
                expected: true,
            },
            "dirty sub": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    workdir: { foo: FILESTATUS.ADDED },
                    submodules: {
                        "a": new Submodule({
                            commit: new Commit("1", "a"),
                            index: new Index("1", "a", RELATION.SAME),
                            workdir: new Workdir(new RepoStatus({
                                headCommit: "1",
                                staged: { x: FILESTATUS.ADDED },
                            }), RELATION.SAME),
                        }),
                    },
                }),
                expected: false,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = c.input.isIndexDeepClean();
                assert.equal(result, c.expected);
            });
        });
    });

    describe("isWorkdirDeepClean", function () {
        const cases = {
            "trivial": {
                input: new RepoStatus(),
                expected: true,
            },
            "all possible and still clean": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    workdir: { foo: FILESTATUS.ADDED },
                    submodules: {
                        "a": new Submodule({
                            commit: new Commit("1", "a"),
                            index: new Index("1", "a", RELATION.SAME),
                        }),
                    },
                }),
                expected: true,
            },
            "all possible and still clean, but all": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    workdir: { foo: FILESTATUS.ADDED },
                    submodules: {
                        "a": new Submodule({
                            commit: new Commit("1", "a"),
                            index: new Index("1", "a", RELATION.SAME),
                        }),
                    },
                }),
                all: true,
                expected: false,
            },
            "staged": {
                input: new RepoStatus({
                    staged: { x: FILESTATUS.ADDED },
                }),
                expected: true,
            },
            "workdir": {
                input: new RepoStatus({
                    workdir: { x: FILESTATUS.MODIFIED },
                }),
                expected: false,
            },
            "dirty sub": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    workdir: { foo: FILESTATUS.ADDED },
                    submodules: {
                        "a": new Submodule({
                            commit: new Commit("1", "a"),
                            index: new Index("1", "a", RELATION.SAME),
                            workdir: new Workdir(new RepoStatus({
                                headCommit: "1",
                                workdir: { x: FILESTATUS.MODIFIED },
                            }), RELATION.SAME),
                        }),
                    },
                }),
                expected: false,
            },
            "dirty sub with all": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    submodules: {
                        "a": new Submodule({
                            commit: new Commit("1", "a"),
                            index: new Index("1", "a", RELATION.SAME),
                            workdir: new Workdir(new RepoStatus({
                                headCommit: "1",
                                workdir: { x: FILESTATUS.ADDED },
                            }), RELATION.SAME),
                        }),
                    },
                }),
                all: true,
                expected: false,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const all = c.all || false;
                const result = c.input.isWorkdirDeepClean(all);
                assert.equal(result, c.expected);
            });
        });
    });

    describe("areUncommittableSubmodules", function () {
        const cases = {
            "trivial": {
                input: new RepoStatus(),
                expected: false,
            },
            "good sub": {
                input: new RepoStatus({
                    submodules: {
                        x: new Submodule({
                            commit: new Commit("1", "a"),
                        }),
                    },
                }),
                expected: false,
            },
            "bad sub": {
                input: new RepoStatus({
                    submodules: {
                        x: new Submodule({
                            index: new Index(null, "a", null),
                        }),
                    },
                }),
                expected: true,
            },
            "added but staged": {
                input: new RepoStatus({
                    submodules: {
                        x: new Submodule({
                            index: new Index(null, "a", null),
                            workdir: new Workdir(new RepoStatus({
                                staged: { x: FILESTATUS.ADDED },
                            }), null),
                        }),
                    },
                }),
                expected: false,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = c.input.areUncommittableSubmodules();
                assert.equal(result, c.expected);
            });
        });
    });

    describe("isConflicted", function () {
        const cases = {
            "trivial": {
                input: new RepoStatus(),
                expected: false,
            },
            "with files and submodules": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    staged: { bar: FILESTATUS.MODIFIED },
                    workdir: { foo: FILESTATUS.ADDED },
                    submodules: {
                        "a": new Submodule({
                            commit: new Commit("1", "a"),
                            staged: new Index("1", "a", RELATION.SAME),
                            workdir: new Workdir(new RepoStatus({
                                headCommit: "1",
                            }), RELATION.SAME),
                        }),
                    },
                }),
                expected: false,
            },
            "conflict in meta": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    staged: { bar: new RepoStatus.Conflict(null, null, null) },
                    workdir: { foo: FILESTATUS.ADDED },
                    submodules: {
                        "a": new Submodule({
                            commit: new Commit("1", "a"),
                            staged: new Index("1", "a", RELATION.SAME),
                            workdir: new Workdir(new RepoStatus({
                                headCommit: "1",
                            }), RELATION.SAME),
                        }),
                    },
                }),
                expected: true,
            },
            "conflict in sub": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    staged: { bar: FILESTATUS.MODIFIED },
                    workdir: { foo: FILESTATUS.ADDED },
                    submodules: {
                        "a": new Submodule({
                            commit: new Commit("1", "a"),
                            staged: new Index("1", "a", RELATION.SAME),
                            workdir: new Workdir(new RepoStatus({
                                staged: {
                                    meh: new RepoStatus.Conflict(1, 1, 1),
                                },
                                headCommit: "1",
                            }), RELATION.SAME),
                        }),
                    },
                }),
                expected: true,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = c.input.isConflicted();
                assert.equal(result, c.expected);
            });
        });
    });

    describe("isDeepClean", function () {
        const cases = {
            "trivial": {
                input: new RepoStatus(),
                expected: true,
            },
            "all possible and still clean": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    workdir: { foo: FILESTATUS.ADDED },
                    submodules: {
                        "a": new Submodule({
                            commit: new Commit("1", "a"),
                            index: new Index("1", "a", RELATION.SAME),
                        }),
                    },
                }),
                expected: true,
            },
            "all": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    workdir: { foo: FILESTATUS.ADDED },
                    submodules: {
                        "a": new Submodule({
                            commit: new Commit("1", "a"),
                            index: new Index("1", "a", RELATION.SAME),
                        }),
                    },
                }),
                all: true,
                expected: false,
            },
            "staged": {
                input: new RepoStatus({
                    staged: { x: FILESTATUS.ADDED },
                }),
                expected: false,
            },
            "workdir": {
                input: new RepoStatus({
                    workdir: { x: FILESTATUS.MODIFIED },
                }),
                expected: false,
            },
            "dirty sub workdir": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    workdir: { foo: FILESTATUS.ADDED },
                    submodules: {
                        "a": new Submodule({
                            commit: new Commit("1", "a"),
                            index: new Index("1", "a", RELATION.SAME),
                            workdir: new Workdir(new RepoStatus({
                                headCommit: "1",
                                workdir: { x: FILESTATUS.MODIFIED },
                            }), RELATION.SAME),
                        }),
                    },
                }),
                expected: false,
            },
            "dirty sub index": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    workdir: { foo: FILESTATUS.ADDED },
                    submodules: {
                        "a": new Submodule({
                            commit: new Commit("1", "a"),
                            index: new Index("1", "a", RELATION.SAME),
                            workdir: new Workdir(new RepoStatus({
                                headCommit: "1",
                                staged: { x: FILESTATUS.MODIFIED },
                            }), RELATION.SAME),
                        }),
                    },
                }),
                expected: false,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const all = c.all || false;
                const result = c.input.isDeepClean(all);
                assert.equal(result, c.expected);
            });
        });
    });

    describe("copy", function () {
        const stat = new RepoStatus({
            currentBranchName: "foo",
            headCommit: "1",
            staged: { foo: FILESTATUS.ADDED },
            submodules: {
                s: new Submodule({ commit: new Commit("1", "2") }),
            },
            workdir: { x: FILESTATUS.MODIFIED },
            rebase: new Rebase("2", "4", "b"),
            sequencerState: new SequencerState({
                type: MERGE,
                originalHead: new CommitAndRef("foo", null),
                target: new CommitAndRef("bar", "baz"),
                commits: ["2", "1"],
                currentCommit: 1,
            }),
        });
        const anotherStat = new RepoStatus({
            currentBranchName: "fo",
            headCommit: "2",
            staged: { foo: FILESTATUS.MODIFIED },
            submodules: {
                s: new Submodule({ commit: new Commit("3", "4") }),
            },
            workdir: { x: FILESTATUS.ADDED },
            rebase: new Rebase("a", "4", "b"),
            sequencerState: new SequencerState({
                type: MERGE,
                originalHead: new CommitAndRef("foo", null),
                target: new CommitAndRef("flim", "flam"),
                commits: ["3", "4"],
                currentCommit: 1,
            }),
        });
        it("simple, no args", function () {
            const newStat = stat.copy();
            assert.deepEqual(newStat, stat);
        });
        it("simple, empty args", function () {
            const newStat = stat.copy({});
            assert.deepEqual(newStat, stat);
        });
        it("copy it all", function () {
            const newStat = stat.copy({
                currentBranchName: anotherStat.currentBranchName,
                headCommit: anotherStat.headCommit,
                staged: anotherStat.staged,
                submodules: anotherStat.submodules,
                workdir: anotherStat.workdir,
                rebase: anotherStat.rebase,
                sequencerState: anotherStat.sequencerState,
            });
            assert.deepEqual(newStat, anotherStat);
        });
    });
});
