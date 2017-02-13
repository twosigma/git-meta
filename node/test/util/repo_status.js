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

const Rebase     = require("../../lib/util/rebase");
const RepoStatus = require("../../lib/util/repo_status");

describe("RepoStatus", function () {
    const FILESTATUS = RepoStatus.FILESTATUS;
    const Submodule = RepoStatus.Submodule;
    const RELATION = Submodule.COMMIT_RELATION;

    describe("Submodule", function () {
        function m(args) {
            const result = {
                indexStatus: null,
                indexSha: null,
                indexUrl: null,
                commitSha: null,
                commitUrl: null,
                repoStatus: null,
            };
            Object.assign(result, args);
            return result;
        }

        const cases = {
            "no changes": {
                args: {
                    indexSha: "1",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                },
                expected: m({
                    indexSha: "1",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                }),
            },
            "added": {
                args: {
                    indexStatus: FILESTATUS.ADDED,
                    indexUrl: "a",
                    indexSha: "1",
                },
                expected: m({
                    indexStatus: FILESTATUS.ADDED,
                    indexUrl: "a",
                    indexSha: "1",
                }),
            },
            "removed": {
                args: {
                    indexStatus: FILESTATUS.REMOVED,
                    commitUrl: "a",
                    commitSha: "1",
                },
                expected: m({
                    indexStatus: FILESTATUS.REMOVED,
                    commitUrl: "a",
                    commitSha: "1",
                }),
            },
            "changeg url": {
                args: {
                    indexStatus: FILESTATUS.MODIFIED,
                    indexSha: "2",
                    indexUrl: "a",
                    indexShaRelation: RELATION.SAME,
                    commitSha: "2",
                    commitUrl: "b",
                },
                expected: m({
                    indexStatus: FILESTATUS.MODIFIED,
                    indexSha: "2",
                    indexUrl: "a",
                    indexShaRelation: RELATION.SAME,
                    commitSha: "2",
                    commitUrl: "b",
                }),
            },
            "modified": {
                args: {
                    indexStatus: FILESTATUS.MODIFIED,
                    indexSha: "2",
                    indexShaRelation: RELATION.AHEAD,
                    indexUrl: "2",
                    commitUrl: "a",
                    commitSha: "1",
                },
                expected: m({
                    indexStatus: FILESTATUS.MODIFIED,
                    indexSha: "2",
                    indexShaRelation: RELATION.AHEAD,
                    indexUrl: "2",
                    commitUrl: "a",
                    commitSha: "1",
                }),
            },
            "repo status": {
                args: {
                    repoStatus: new RepoStatus({
                        workdir: { foo: FILESTATUS.ADDED },
                    }),
                    indexSha: "2",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "2",
                    commitUrl: "2",
                    commitSha: "2",
                },
                expected: m({
                    repoStatus: new RepoStatus({
                        workdir: { foo: FILESTATUS.ADDED },
                    }),
                    indexSha: "2",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "2",
                    commitUrl: "2",
                    commitSha: "2",
                }),
            },
            "repo status with head commit": {
                args: {
                    repoStatus: new RepoStatus({
                        workdir: { foo: FILESTATUS.ADDED },
                        headCommit: "2",
                    }),
                    indexSha: "2",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "2",
                    commitUrl: "2",
                    commitSha: "2",
                    workdirShaRelation: RELATION.SAME,
                },
                expected: m({
                    repoStatus: new RepoStatus({
                        workdir: { foo: FILESTATUS.ADDED },
                        headCommit: "2",
                    }),
                    indexSha: "2",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "2",
                    commitUrl: "2",
                    commitSha: "2",
                    workdirShaRelation: RELATION.SAME,
                }),
            },
            "repo status with different head commit": {
                args: {
                    repoStatus: new RepoStatus({
                        workdir: { foo: FILESTATUS.ADDED },
                        headCommit: "3",
                    }),
                    indexSha: "2",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "2",
                    commitUrl: "2",
                    commitSha: "2",
                    workdirShaRelation: RELATION.BEHIND,
                },
                expected: m({
                    repoStatus: new RepoStatus({
                        workdir: { foo: FILESTATUS.ADDED },
                        headCommit: "3",
                    }),
                    indexSha: "2",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "2",
                    commitUrl: "2",
                    commitSha: "2",
                    workdirShaRelation: RELATION.BEHIND,
                }),
            },
        };

        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = new Submodule(c.args);
                assert.instanceOf(result, Submodule);
                assert.isFrozen(result);
                const e = c.expected;
                assert.equal(result.indexStatus, e.indexStatus);
                assert.equal(result.indexSha, e.indexSha);
                assert.equal(result.indexUrl, e.indexUrl);
                assert.equal(result.commitSha, e.commitSha);
                assert.equal(result.commitUrl, e.commitUrl);
                assert.deepEqual(result.repoStatus, e.repoStatus);
            });
        });
    });

    describe("Submodule.isIndexClean", function () {
        const cases = {
            "no changes": {
                input: new Submodule({
                    indexSha: "1",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                }),
                expected: true,
            },
            "changed files in open repo": {
                input: new Submodule({
                    indexSha: "1",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                    repoStatus: new RepoStatus({
                        workdir: {
                            "foo": FILESTATUS.MODIFIED,
                        },
                    }),
                }),
                expected: true,
            },
            "new commit in open repo": {
                input: new Submodule({
                    indexSha: "1",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                    workdirShaRelation: RELATION.BEHIND,
                    repoStatus: new RepoStatus({
                        headCommit: "2",
                    }),
                }),
                expected: false,
            },
            "new commit in open repo, new sub": {
                input: new Submodule({
                    indexStatus: FILESTATUS.ADDED,
                    indexUrl: "a",
                    repoStatus: new RepoStatus({
                        headCommit: "2",
                    }),
                }),
                expected: false,
            },
            "change in index": {
                input: new Submodule({
                    indexSha: "1",
                    indexUrl: "a",
                    indexStatus: FILESTATUS.ADDED,
                }),
                expected: false,
            },
            "different commit": {
                input: new Submodule({
                    indexSha: "2",
                    indexShaRelation: RELATION.BEHIND,
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
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
                    indexSha: "1",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                }),
                expected: true,
            },
            "new files in open repo": {
                input: new Submodule({
                    indexSha: "1",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                    repoStatus: new RepoStatus({
                        workdir: {
                            "foo": FILESTATUS.ADDED,
                        },
                    }),
                }),
                expected: true,
            },
            "changed files in open repo": {
                input: new Submodule({
                    indexSha: "1",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                    repoStatus: new RepoStatus({
                        workdir: {
                            "foo": FILESTATUS.MODIFIED,
                        },
                    }),
                }),
                expected: false,
            },
            "new commit in open repo": {
                input: new Submodule({
                    indexSha: "1",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                    workdirShaRelation: RELATION.BEHIND,
                    repoStatus: new RepoStatus({
                        headCommit: "2",
                    }),
                }),
                expected: true,
            },
            "closed": {
                input: new Submodule({
                    indexSha: "1",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                    workdirShaRelation: RELATION.BEHIND,
                    repoStatus: null,
                }),
                expected: true,
            },
        };

        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = c.input.isWorkdirClean();
                assert.equal(result, c.expected);
            });
        });
    });

    describe("Submodule.isClean", function () {
        const cases = {
            "no changes": {
                input: new Submodule({
                    indexSha: "1",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                }),
                expected: true,
            },
            "changed files in open repo": {
                input: new Submodule({
                    indexSha: "1",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                    repoStatus: new RepoStatus({
                        workdir: {
                            "foo": FILESTATUS.MODIFIED,
                        },
                    }),
                }),
                expected: false,
            },
            "new commit in open repo": {
                input: new Submodule({
                    indexSha: "1",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                    workdirShaRelation: RELATION.BEHIND,
                    repoStatus: new RepoStatus({
                        headCommit: "2",
                    }),
                }),
                expected: false,
            },
        };

        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = c.input.isClean();
                assert.equal(result, c.expected);
            });
        });
    });

    describe("Submodule.isNew", function () {
        const cases = {
            "not new": {
                input: new Submodule({
                    indexStatus: FILESTATUS.MODIFIED,
                }),
                expected: false,
            },
            "new": {
                input: new Submodule({
                    indexStatus: FILESTATUS.ADDED,
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
                    indexStatus: FILESTATUS.MODIFIED,
                }),
                expected: true,
            },
            "new but staged commit": {
                input: new Submodule({
                    indexStatus: FILESTATUS.ADDED,
                    indexSha: "3",
                }),
                expected: true,
            },
            "new but new commit in repo": {
                input: new Submodule({
                    indexStatus: FILESTATUS.ADDED,
                    repoStatus: new RepoStatus({
                        headCommit: "3"
                    }),
                }),
                expected: true,
            },
            "new but staged file": {
                input: new Submodule({
                    indexStatus: FILESTATUS.ADDED,
                    repoStatus: new RepoStatus({
                        staged: {
                            foo: FILESTATUS.ADDED,
                        },
                    }),
                }),
                expected: true,
            },
            "new and no good": {
                input: new Submodule({
                    indexStatus: FILESTATUS.ADDED,
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
            indexStatus: RepoStatus.FILESTATUS.ADDED,
            indexSha: "1",
            indexShaRelation: RepoStatus.Submodule.COMMIT_RELATION.SAME,
            indexUrl: "/a",
            commitSha: "2",
            commitUrl: "/b",
            workdirShaRelation: RepoStatus.Submodule.COMMIT_RELATION.AHEAD,
            repoStatus: new RepoStatus({ headCommit: "3"}),
        });
        const anotherSub = new Submodule({
            indexStatus: RepoStatus.FILESTATUS.REMOVED,
            indexSha: "2",
            indexShaRelation: RepoStatus.Submodule.COMMIT_RELATION.AHEAD,
            indexUrl: "/c",
            commitSha: "4",
            commitUrl: "/e",
            workdirShaRelation: RepoStatus.Submodule.COMMIT_RELATION.BEHIND,
            repoStatus: new RepoStatus({ headCommit: "5"}),
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
                indexStatus: anotherSub.indexStatus,
                indexSha: anotherSub.indexSha,
                indexShaRelation: anotherSub.indexShaRelation,
                indexUrl: anotherSub.indexUrl,
                commitSha: anotherSub.commitSha,
                commitUrl: anotherSub.commitUrl,
                workdirShaRelation: anotherSub.workdirShaRelation,
                repoStatus: anotherSub.repoStatus,
            });
            assert.deepEqual(newSub, anotherSub);
        });
    });

    describe("Submodule.open", function () {
        it("breathing", function () {
            const sub = new Submodule({
                commitSha: "1",
            });
            const opened = sub.open();
            assert.deepEqual(opened, new Submodule({
                commitSha: "1",
                indexSha: "1",
                indexShaRelation: RELATION.SAME,
                workdirShaRelation: RELATION.SAME,
                repoStatus: new RepoStatus({
                    headCommit: "1",
                }),
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
                            indexSha: "1",
                            indexShaRelation: RELATION.SAME,
                            indexUrl: "a",
                            commitSha: "1",
                            commitUrl: "a",
                        }),
                    },
                    rebase: new Rebase("foo", "1", "2"),
                },
                e: m({
                    currentBranchName: "foo",
                    headCommit: "1",
                    staged: { "x/y": FILESTATUS.MODIFIED },
                    workdir: { "x/z": FILESTATUS.REMOVED },
                    submodules: {
                        "a": new Submodule({
                            indexSha: "1",
                            indexShaRelation: RELATION.SAME,
                            indexUrl: "a",
                            commitSha: "1",
                            commitUrl: "a",
                        }),
                    },
                    rebase: new Rebase("foo", "1", "2"),
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
                            indexSha: "1",
                            indexShaRelation: RELATION.SAME,
                            indexUrl: "a",
                            commitSha: "1",
                            commitUrl: "a",
                            repoStatus: {
                                workdir: { x: "y"},
                                staged: { q: "r"},
                            },
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
                            indexSha: "1",
                            indexShaRelation: RELATION.SAME,
                            indexUrl: "a",
                            commitSha: "1",
                            commitUrl: "a",
                            repoStatus: new RepoStatus({
                                workdir: { x: FILESTATUS.ADDED },
                                staged: { q: FILESTATUS.MODIFIED },
                            }),
                        }),
                    },
                }),
                expected: true,
            },
            "workdir": {
                input: new RepoStatus({
                    workdir: { x: FILESTATUS.MODIFIED },
                }),
                expected: false,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = c.input.isWorkdirClean();
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
                            indexSha: "1",
                            indexShaRelation: RELATION.SAME,
                            indexUrl: "a",
                            commitSha: "1",
                            commitUrl: "a",
                            repoStatus: new RepoStatus({
                                workdir: { foo: FILESTATUS.MODIFIED },
                            }),
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
                            indexSha: "1",
                            indexShaRelation: RELATION.SAME,
                            indexUrl: "a",
                            commitSha: "1",
                            commitUrl: "a",
                            repoStatus: new RepoStatus({
                                staged: { x: FILESTATUS.ADDED },
                            }),
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
                            indexSha: "1",
                            indexShaRelation: RELATION.SAME,
                            indexUrl: "a",
                            commitSha: "1",
                            commitUrl: "a",
                        }),
                    },
                }),
                expected: true,
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
                            indexSha: "1",
                            indexShaRelation: RELATION.SAME,
                            indexUrl: "a",
                            commitSha: "1",
                            commitUrl: "a",
                            repoStatus: new RepoStatus({
                                workdir: { x: FILESTATUS.MODIFIED },
                            }),
                        }),
                    },
                }),
                expected: false,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = c.input.isWorkdirDeepClean();
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
                        x: new RepoStatus.Submodule(),
                    },
                }),
                expected: false,
            },
            "bad sub": {
                input: new RepoStatus({
                    submodules: {
                        x: new RepoStatus.Submodule({
                            indexStatus: FILESTATUS.ADDED,
                        }),
                    },
                }),
                expected: true,
            },
            "added but staged": {
                input: new RepoStatus({
                    submodules: {
                        x: new RepoStatus.Submodule({
                            indexStatus: FILESTATUS.ADDED,
                            repoStatus: new RepoStatus({
                                staged: { x: FILESTATUS.ADDED },
                            }),
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
                            indexSha: "1",
                            indexShaRelation: RELATION.SAME,
                            indexUrl: "a",
                            commitSha: "1",
                            commitUrl: "a",
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
                expected: false,
            },
            "dirty sub workdir": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    workdir: { foo: FILESTATUS.ADDED },
                    submodules: {
                        "a": new Submodule({
                            indexSha: "1",
                            indexShaRelation: RELATION.SAME,
                            indexUrl: "a",
                            commitSha: "1",
                            commitUrl: "a",
                            repoStatus: new RepoStatus({
                                workdir: { x: FILESTATUS.MODIFIED },
                            }),
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
                            indexSha: "1",
                            indexShaRelation: RELATION.SAME,
                            indexUrl: "a",
                            commitSha: "1",
                            commitUrl: "a",
                            repoStatus: new RepoStatus({
                                staged: { x: FILESTATUS.MODIFIED },
                            }),
                        }),
                    },
                }),
                expected: false,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = c.input.isDeepClean();
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
                s: new RepoStatus.Submodule({ "indexSha": "3", }),
            },
            workdir: { x: FILESTATUS.MODIFIED },
            rebase: new Rebase("2", "4", "b"),
        });
        const anotherStat = new RepoStatus({
            currentBranchName: "fo",
            headCommit: "2",
            staged: { foo: FILESTATUS.MODIFIED },
            submodules: {
                s: new RepoStatus.Submodule({ "indexSha": "4", }),
            },
            workdir: { x: FILESTATUS.ADDED },
            rebase: new Rebase("a", "4", "b"),
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
            });
            assert.deepEqual(newStat, anotherStat);
        });
    });
});
