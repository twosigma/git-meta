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

const Rebase              = require("../../lib/util/rebase");
const RepoAST             = require("../../lib/util/repo_ast");
const RepoASTTestUtil     = require("../../lib/util/repo_ast_test_util");
const RepoStatus          = require("../../lib/util/repo_status");
const Status              = require("../../lib/util/status");
const SubmoduleUtil       = require("../../lib/util/submodule_util");
const SubmoduleConfigUtil = require("../../lib/util/submodule_config_util");
const UserError           = require("../../lib/util/user_error");

// test utilities

/**
 * Return a new `RepoStatus` object having the same value as the specified
 * `status` but with all commit shas replaced by commits in the specified
 * `comitMap` and all urls replaced by the values in the specified `urlMap`.
 *
 * @param {RepoStatus} status
 * @param {Object}     commitMap
 * @param {Object}     urlMap
 * @return {RepoStatus}
 */
let remapRepoStatus;

/**
 * Return a new `RepoStatus.Submodule` object having the same value as the
 * specified `sub` but with all commit shas replaced by commits in the
 * specified `commitMap` and all urls replaced by the values in the specified
 * `urlMap`.
 *
 * @param {RepoStatus.Submodule} sub
 * @param {Object}               commitMap from sha to sha
 * @param {Object}               urlMap    from url to url
 * @return {RepoStatus.Submodule}
 */
function remapSubmodule(sub, commitMap, urlMap) {
    assert.instanceOf(sub, RepoStatus.Submodule);
    assert.isObject(commitMap);
    assert.isObject(urlMap);

    function mapSha(sha) {
        return sha && (commitMap[sha] || sha);
    }

    function mapUrl(url) {
        return url && (urlMap[url] || url);
    }

    return new RepoStatus.Submodule({
        indexStatus: sub.indexStatus,
        indexSha: mapSha(sub.indexSha),
        indexShaRelation: sub.indexShaRelation,
        indexUrl: mapUrl(sub.indexUrl),
        commitSha: mapSha(sub.commitSha),
        commitUrl: mapUrl(sub.commitUrl),
        workdirShaRelation: sub.workdirShaRelation,
        repoStatus: sub.repoStatus &&
                            remapRepoStatus(sub.repoStatus, commitMap, urlMap),
    });
}

/**
 * Return a new `Rebase` object having the same value as the specified `rebase`
 * but with commit shas being replaced by commits in the specified `commitMap`.
 *
 * @param {Rebase} rebase
 * @param {Object} commitMap from sha to sha
 */
function remapRebase(rebase, commitMap) {
    assert.instanceOf(rebase, Rebase);
    assert.isObject(commitMap);

    let originalHead = rebase.originalHead;
    let onto = rebase.onto;
    if (originalHead in commitMap) {
        originalHead = commitMap[originalHead];
    }
    if (onto in commitMap) {
        onto = commitMap[onto];
    }
    return new Rebase(rebase.headName, originalHead, onto);
}


remapRepoStatus = function (status, commitMap, urlMap) {
    assert.instanceOf(status, RepoStatus);
    assert.isObject(commitMap);
    assert.isObject(urlMap);

    function mapSha(sha) {
        return sha && (commitMap[sha] || sha);
    }

    let submodules = {};
    const baseSubmods = status.submodules;
    Object.keys(baseSubmods).forEach(name => {
        submodules[name] = remapSubmodule(baseSubmods[name],
                                          commitMap,
                                          urlMap);
    });

    return new RepoStatus({
        currentBranchName: status.currentBranchName,
        headCommit: mapSha(status.headCommit),
        staged: status.staged,
        submodules: submodules,
        workdir: status.workdir,
        rebase: status.rebase === null ? null : remapRebase(status.rebase,
                                                            commitMap),
    });
};

describe("Status", function () {
    const FILESTATUS       = RepoStatus.FILESTATUS;
    const RELATION         = RepoStatus.Submodule.COMMIT_RELATION;
    const StatusDescriptor = Status.StatusDescriptor;
    const Submodule        = RepoStatus.Submodule;
 
    describe("test.remapSubmodule", function () {
        const Submodule = RepoStatus.Submodule;
        const RELATION  = Submodule.COMMIT_RELATION;
        const FILESTATUS = RepoStatus.FILESTATUS;
        const cases = {
            "all": {
                input: new Submodule({
                    indexSha: "1",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                }),
                commitMap: { "1": "2" },
                urlMap: { "a": "b" },
                expected: new Submodule({
                    indexSha: "2",
                    indexShaRelation: RELATION.SAME,
                    indexUrl: "b",
                    commitSha: "2",
                    commitUrl: "b",
                }),
            },
            "some skipped": {
                input: new Submodule({
                    indexStatus: FILESTATUS.ADDED,
                    indexSha: "1",
                    indexUrl: "x",
                }),
                commitMap: { "1": "2" },
                urlMap: { "x": "y" },
                expected: new Submodule({
                    indexStatus: FILESTATUS.ADDED,
                    indexSha: "2",
                    indexUrl: "y",
                }),
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = remapSubmodule(c.input,
                                              c.commitMap,
                                              c.urlMap);
                assert.deepEqual(result, c.expected);
            });
        });
    });

    describe("test.remapRepoStatus", function () {
        const FILESTATUS = RepoStatus.FILESTATUS;
        const Submodule = RepoStatus.Submodule;
        const RELATION = Submodule.COMMIT_RELATION;
        const cases = {
            trivial: {
                input: new RepoStatus(),
                commitMap: {},
                urlMap: {},
                expected: new RepoStatus(),
            },
            "all fields but submodules": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "1",
                    staged: { x: RepoStatus.FILESTATUS.ADDED },
                    workdir: { y: RepoStatus.FILESTATUS.ADDED },
                    rebase: new Rebase("foo", "1", "1"),
                }),
                commitMap: { "1": "3"},
                urlMap: {},
                expected: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "3",
                    staged: { x: RepoStatus.FILESTATUS.ADDED },
                    workdir: { y: RepoStatus.FILESTATUS.ADDED },
                    rebase: new Rebase("foo", "3", "3"),
                }),
            },
            "with a sub": {
                input: new RepoStatus({
                    submodules: {
                        s: new Submodule({
                            indexSha: "1",
                            indexShaRelation: RELATION.SAME,
                            indexUrl: "a",
                            commitSha: "1",
                            commitUrl: "a",
                        }),
                    },
                }),
                commitMap: { "1": "2" },
                urlMap: { "a": "b" },
                expected: new RepoStatus({
                    submodules: {
                        s: new Submodule({
                            indexSha: "2",
                            indexShaRelation: RELATION.SAME,
                            indexUrl: "b",
                            commitSha: "2",
                            commitUrl: "b",
                        }),
                    },
                }),
            },
            "with a sub having a repo": {
                input: new RepoStatus({
                    submodules: {
                        s: new Submodule({
                            indexSha: "1",
                            indexUrl: "a",
                            indexStatus: FILESTATUS.ADDED,
                            workdirShaRelation: RELATION.SAME,
                            repoStatus: new RepoStatus({
                                headCommit: "1",
                            }),
                        }),
                    },
                }),
                commitMap: { "1": "2" },
                urlMap: { "a": "b" },
                expected: new RepoStatus({
                    submodules: {
                        s: new Submodule({
                            indexSha: "2",
                            indexUrl: "b",
                            workdirShaRelation: RELATION.SAME,
                            indexStatus: FILESTATUS.ADDED,
                            repoStatus: new RepoStatus({
                                headCommit: "2",
                            }),
                        }),
                    },
                }),
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = remapRepoStatus(c.input, c.commitMap, c.urlMap);
                assert.deepEqual(result, c.expected);
            });
        });
    });

    describe("StatusDescriptor", function () {
        describe("constructor", function () {
            it("breathing", function () {
                const descriptor = new StatusDescriptor(FILESTATUS.ADDED,
                                                        "foo",
                                                        "bar");
                assert.equal(descriptor.status, FILESTATUS.ADDED);
                assert.equal(descriptor.path, "foo");
                assert.equal(descriptor.detail, "bar");
            });
        });
        describe("print", function () {
            const cases = {
                "basic": {
                    des: new StatusDescriptor(FILESTATUS.ADDED, "foo", "bar"),
                    check: /foo.*bar/,
                },
                "added": {
                    des: new StatusDescriptor(FILESTATUS.ADDED, "x", "y"),
                    check: /^new file/,
                },
                "modified": {
                    des: new StatusDescriptor(FILESTATUS.MODIFIED, "x", "y"),
                    check: /^modified/,
                },
                "deleted": {
                    des: new StatusDescriptor(FILESTATUS.REMOVED, "x", "y"),
                    check: /^deleted/,
                },
                "conflicted": {
                    des: new StatusDescriptor(FILESTATUS.CONFLICTED, "x", "y"),
                    check: /^conflicted/,
                },
                "renamed": {
                    des: new StatusDescriptor(FILESTATUS.RENAMED, "x", "y"),
                    check: /^renamed/,
                },
                "type changed": {
                    des: new StatusDescriptor(FILESTATUS.TYPECHANGED,
                                              "x",
                                              "y"),
                    check: /^type changed/,
                },
                "with color": {
                    des: new StatusDescriptor(FILESTATUS.TYPECHANGED,
                                              "x",
                                              "y"),
                    color: text => `RED${text}RED`,
                    check: /RED.*RED/,
                },
                "with cwd": {
                    des: new StatusDescriptor(FILESTATUS.ADDED, "x", "y"),
                    cwd: "q",
                    check: /\.\.\/x/,
                },
            };
            Object.keys(cases).forEach(caseName => {
                const c = cases[caseName];
                it(caseName, function () {
                    let color = c.color;
                    if (undefined === color) {
                        color = x => x;
                    }
                    let cwd = c.cwd;
                    if (undefined === cwd) {
                        cwd = "";
                    }
                    const result = c.des.print(color, cwd);
                    assert.match(result, c.check);
                });
            });
        });
    });

    describe("sortDescriptorsByPath", function () {
        const cases = {
            "trivial": {
                input: [],
                expected: [],
            },
            "one": {
                input: [new StatusDescriptor(FILESTATUS.ADDED, "x", "y")],
                expected: [new StatusDescriptor(FILESTATUS.ADDED, "x", "y")],
            },
            "a few": {
                input: [
                    new StatusDescriptor(FILESTATUS.ADDED, "b", "b"),
                    new StatusDescriptor(FILESTATUS.ADDED, "a", "a"),
                    new StatusDescriptor(FILESTATUS.ADDED, "z", "z"),
                    new StatusDescriptor(FILESTATUS.ADDED, "y", "y"),
                    new StatusDescriptor(FILESTATUS.ADDED, "q", "q"),
                    new StatusDescriptor(FILESTATUS.ADDED, "s", "s"),
                ],
                expected: [
                    new StatusDescriptor(FILESTATUS.ADDED, "a", "a"),
                    new StatusDescriptor(FILESTATUS.ADDED, "b", "b"),
                    new StatusDescriptor(FILESTATUS.ADDED, "q", "q"),
                    new StatusDescriptor(FILESTATUS.ADDED, "s", "s"),
                    new StatusDescriptor(FILESTATUS.ADDED, "y", "y"),
                    new StatusDescriptor(FILESTATUS.ADDED, "z", "z"),
                ],
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = Status.sortDescriptorsByPath(c.input);
                assert.deepEqual(result, c.expected);
            });
        });
    });

    describe("printStatusDescriptors", function () {
        // This function is implemented in terms of `StatusDescriptor.print`,
        // so we just need to test a few things: basic function, sorting, and
        // coloring.

        const cases = {
            "trivial": {
                descriptors: [],
                check: /^$/
            },
            "one": {
                descriptors: [
                    new StatusDescriptor(FILESTATUS.ADDED, "x", "y"),
                ],
                check: /new.*x.*y.*\n$/,
            },
            "color": {
                descriptors: [
                    new StatusDescriptor(FILESTATUS.ADDED, "x", "y"),
                ],
                color: x => `BLUE${x}BLUE`,
                check: /BLUE/,
            },
            "order": {
                descriptors: [
                    new StatusDescriptor(FILESTATUS.ADDED, "Z", "y"),
                    new StatusDescriptor(FILESTATUS.ADDED, "X", "y"),
                ],
                check: /X.*\n.*Z/,
            },
            "cwd": {
                descriptors: [
                    new StatusDescriptor(FILESTATUS.ADDED, "Z/q", "y"),
                ],
                cwd: "Z",
                check: /\sq/,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const color = c.color || (x => x);
                const cwd = c.cwd || "";
                const result = Status.printStatusDescriptors(c.descriptors,
                                                             color,
                                                             cwd);
                assert.match(result, c.check);
            });
        });
    });

    describe("printUntrackedFiles", function () {
        const cases = {
            "trivial": {
                input: [],
                check: /^$/,
            },
            "one": {
                input: ["foo"],
                check: /\tfoo\n/,
            },
            "two": {
                input: ["foo", "bar"],
                check: /\tbar\n\tfoo\n/,
            },
            "in color": {
                input: ["foo"],
                color: (x => `a${x}b`),
                check: /\tafoob\n/,
            },
            "relative": {
                input: ["foo"],
                cwd: "bar",
                check: /\t\.\.\/foo\n/,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const cwd = c.cwd || "";
                const color = c.color || (x => x);
                const result = Status.printUntrackedFiles(c.input, color, cwd);
                assert.match(result, c.check);
            });
        });
    });

    describe("listSubmoduleDescriptors", function () {
        const cases = {
            "trivial": {
                status: new RepoStatus(),
            },
            "deleted": {
                status: new RepoStatus({
                    submodules: {
                        x: new RepoStatus.Submodule({
                            commitUrl: "a",
                            commitSha: "1",
                            indexStatus: FILESTATUS.REMOVED,
                        }),
                    },
                }),
                staged: [
                    new StatusDescriptor(FILESTATUS.REMOVED, "x", "submodule"),
                ],
            },
            "new url": {
                status: new RepoStatus({
                    submodules: {
                        x: new RepoStatus.Submodule({
                            indexSha: "y",
                            commitSha: "y",
                            indexShaRelation: RELATION.SAME,
                            commitUrl: "a",
                            indexUrl: "b",
                        }),
                    },
                }),
                staged: [
                    new StatusDescriptor(FILESTATUS.MODIFIED,
                                         "x",
                                         "submodule, new url"),
                ],
            },
            "new commits in index and new url": {
                status: new RepoStatus({
                    submodules: {
                        x: new RepoStatus.Submodule({
                            indexSha: "y",
                            commitSha: "z",
                            indexShaRelation: RELATION.AHEAD,
                            commitUrl: "a",
                            indexUrl: "b",
                        }),
                    },
                }),
                staged: [
                    new StatusDescriptor(FILESTATUS.MODIFIED,
                                         "x",
                                         "submodule, new commits, new url"),
                ],
            },
            "new commits in index": {
                status: new RepoStatus({
                    submodules: {
                        x: new RepoStatus.Submodule({
                            indexSha: "y",
                            commitSha: "z",
                            indexShaRelation: RELATION.AHEAD,
                            commitUrl: "a",
                            indexUrl: "a",
                        }),
                    },
                }),
                staged: [
                    new StatusDescriptor(FILESTATUS.MODIFIED,
                                         "x",
                                         "submodule, new commits"),
                ],
            },
            "new commits in workdir": {
                status: new RepoStatus({
                    submodules: {
                        x: new RepoStatus.Submodule({
                            indexSha: "y",
                            commitSha: "y",
                            indexShaRelation: RELATION.SAME,
                            commitUrl: "a",
                            indexUrl: "a",
                            workdirShaRelation: RELATION.AHEAD,
                            repoStatus: new RepoStatus({
                                head: "z",
                            }),
                        }),
                    },
                }),
                staged: [
                    new StatusDescriptor(FILESTATUS.MODIFIED,
                                         "x",
                                         "submodule, new commits"),
                ],
            },
            "behind in index": {
                status: new RepoStatus({
                    submodules: {
                        x: new RepoStatus.Submodule({
                            indexSha: "y",
                            commitSha: "z",
                            indexShaRelation: RELATION.BEHIND,
                            commitUrl: "a",
                            indexUrl: "a",
                        }),
                    },
                }),
                staged: [
                    new StatusDescriptor(FILESTATUS.MODIFIED,
                                         "x",
                                         "submodule, on old commit"),
                ],
            },
            "unrelated in index": {
                status: new RepoStatus({
                    submodules: {
                        x: new RepoStatus.Submodule({
                            indexSha: "y",
                            commitSha: "z",
                            indexShaRelation: RELATION.UNRELATED,
                            commitUrl: "a",
                            indexUrl: "a",
                        }),
                    },
                }),
                staged: [
                    new StatusDescriptor(FILESTATUS.MODIFIED,
                                         "x",
                                         "submodule, on unrelated commit"),
                ],
            },
            "unknown in index": {
                status: new RepoStatus({
                    submodules: {
                        x: new RepoStatus.Submodule({
                            indexSha: "y",
                            commitSha: "z",
                            indexShaRelation: RELATION.UNKNOWN,
                            commitUrl: "a",
                            indexUrl: "a",
                        }),
                    },
                }),
                staged: [
                    new StatusDescriptor(FILESTATUS.MODIFIED,
                                         "x",
                                         "submodule, on unknown commit"),
                ],
            },
            "new sub, no commit": {
                status: new RepoStatus({
                    submodules: {
                        x: new RepoStatus.Submodule({
                            indexStatus: FILESTATUS.ADDED,
                        }),
                    },
                }),
                workdir: [
                    new StatusDescriptor(
                                  FILESTATUS.ADDED,
                                  "x",
                                  "submodule, create commit or stage changes"),
                ],
            },
            "new sub, no commit, open": {
                status: new RepoStatus({
                    submodules: {
                        x: new RepoStatus.Submodule({
                            indexStatus: FILESTATUS.ADDED,
                            repoStatus: new RepoStatus(),
                        }),
                    },
                }),
                workdir: [
                    new StatusDescriptor(
                                  FILESTATUS.ADDED,
                                  "x",
                                  "submodule, create commit or stage changes"),
                ],
            },
            "new sub, no commit but staged": {
                status: new RepoStatus({
                    submodules: {
                        x: new RepoStatus.Submodule({
                            indexStatus: FILESTATUS.ADDED,
                            repoStatus: new RepoStatus({
                                staged: { foo: FILESTATUS.ADDED },
                            }),
                        }),
                    },
                }),
                staged: [
                    new StatusDescriptor(
                                  FILESTATUS.ADDED,
                                  "x",
                                  "submodule, newly created"),
                ],
            },
//            "new sub staged and good": {
//                status
//            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const staged = c.staged || [];
                const workdir = c.workdir || [];
                const untracked = c.untracked || [];
                const result = Status.listSubmoduleDescriptors(c.status);
                assert.deepEqual(result, {
                    staged: staged,
                    workdir: workdir,
                    untracked: untracked,
                });
            });
        });
    });

    describe("accumulateStatus", function () {
        const Desc = StatusDescriptor;
        const cases = {
            "trivial": {
                input: new RepoStatus(),
                expected: {
                    staged: [],
                    workdir: [],
                    untracked: [],
                },
            },
            "staged": {
                input: new RepoStatus({
                    staged: { x: FILESTATUS.REMOVED },
                }),
                expected: {
                    staged: [ new Desc(FILESTATUS.REMOVED, "x", "") ],
                    workdir: [],
                    untracked: [],
                },
            },
            "workdir": {
                input: new RepoStatus({
                    workdir: { x: FILESTATUS.MODIFIED},
                }),
                expected: {
                    staged: [],
                    workdir: [new Desc(FILESTATUS.MODIFIED, "x", "")],
                    untracked: [],
                },
            },
            "untracked": {
                input: new RepoStatus({
                    workdir: { x: FILESTATUS.ADDED},
                }),
                expected: {
                    staged: [],
                    workdir: [],
                    untracked: ["x"],
                },
            },
            "all": {
                input: new RepoStatus({
                    staged: { x: FILESTATUS.REMOVED },
                    workdir: { 
                        y: FILESTATUS.MODIFIED,
                        z: FILESTATUS.ADDED,
                    },
                }),
                expected: {
                    staged: [ new Desc(FILESTATUS.REMOVED, "x", "") ],
                    workdir: [new Desc(FILESTATUS.MODIFIED, "y", "")],
                    untracked: ["z"],
                },
            },
            "submodule-specific": {
                input: new RepoStatus({
                    submodules: {
                        s: new Submodule({
                            commitUrl: "foo",
                            commitSha: "a",
                            indexUrl: "bar",
                        }),
                    },
                }),
                expected: {
                    staged: [
                        new Desc(FILESTATUS.MODIFIED,
                                 "s",
                                 "submodule, new url"),
                    ],
                    workdir: [],
                    untracked: [],
                },
            },
            "submodule rollup": {
                input: new RepoStatus({
                    submodules: {
                        s: new Submodule({
                            commitUrl: "1",
                            commitSha: "2",
                            repoStatus: new RepoStatus({
                                staged: { x: FILESTATUS.REMOVED },
                                workdir: { 
                                    y: FILESTATUS.MODIFIED,
                                    z: FILESTATUS.ADDED,
                                },
                            }),
                        }),
                    },
                }),
                expected: {
                    staged: [ new Desc(FILESTATUS.REMOVED, "s/x", "") ],
                    workdir: [new Desc(FILESTATUS.MODIFIED, "s/y", "")],
                    untracked: ["s/z"],
                },
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = Status.accumulateStatus(c.input);
                const sort = Status.sortDescriptorsByPath;
                const sortedResult = {
                    staged: sort(result.staged),
                    workdir: sort(result.workdir),
                    untracked: result.untracked.sort(),
                };
                assert.deepEqual(sortedResult, c.expected);
            });
        });
    });

    describe("printRebase", function () {
        const cases = {
            "basic": {
                input: new Rebase("master", "xxx", "ffffffffffffffff"),
                check: /rebase in progress/
            },
            "branch": {
                input: new Rebase("master", "xxx", "ffffffffffffffff"),
                check: /master/
            },
            "sha": {
                input: new Rebase("master", "xxx", "ffffffffffffffff"),
                check: /ffff/,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = Status.printRebase(c.input);
                assert.match(result, c.check);
            });
        });
    });

    describe("printCurrentBranch", function () {
        const cases = {
            "normal": {
                input: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "aaaaaaaaaaaaaaaa",
                }),
                check: /master/,
            },
            "detached": {
                input: new RepoStatus({
                    headCommit: "aaaaaaaaaaaaaaaa",
                }),
                check: /aaaa/,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = Status.printCurrentBranch(c.input);
                assert.match(result, c.check);
            });
        });
    });

    describe("printRepoStatus", function () {
        // Most of the logic for this method is implemented in terms of
        // other methods that are already tested; we just need to validate that
        // the results are chained together.

        // TODO: more testing here

        // We'll use repo `x` for printing.

        const cases = {
            "trivial": {
                input: new RepoStatus({
                    currentBranchName: "master",
                }),
                regex: /On branch.*master.*\n.*nothing to commit.*/,
            },
            "rebase": {
                input: new RepoStatus({
                    currentBranchName: "master",
                    rebase: new Rebase("x", "y", "z"),
                }),
                regex: /rebas/,
            },
            "detached": {
                input: new RepoStatus({
                    headCommit: "ffffaaaaffffaaaa",
                }),
                regex: /detached/,
            },
            "dirty meta": {
                input: new RepoStatus({
                    currentBranchName: "master",
                    staged: {
                        qrst: FILESTATUS.ADDED,
                    },
                }),
                regex: /.*qrst/,
            },
            "dirty sub": {
                input: new RepoStatus({
                    currentBranchName: "master",
                    submodules: {
                        qrst: new Submodule({
                            repoStatus: new RepoStatus({
                                staged: {
                                    "x/y/z": FILESTATUS.MODIFIED,
                                },
                            }),
                        }),
                    },
                }),
                regex: /qrst\/x\/y\/z/,
            },
            "cwd": {
                input: new RepoStatus({
                    currentBranchName: "master",
                    staged: {
                        qrst: FILESTATUS.ADDED,
                    },
                }),
                cwd: "u/v",
                regex: /\.\.\/\.\.\/qrst/,
            },
            "untracked": {
                input: new RepoStatus({
                    currentBranchName: "master",
                    workdir: { foo: FILESTATUS.ADDED },
                }),
                regex: /foo/,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const cwd = c.cwd || "";
                const result = Status.printRepoStatus(c.input, cwd);
                if (c.inverse) {
                    assert.notMatch(result, c.regex);
                }
                else {
                    assert.match(result, c.regex);
                }
            });
        });
    });

    describe("getChanges", function () {
        const cases = {
            "trivial": {
                state: "x=S",
            },
            "index - modified": {
                state: "x=S:I README.md=hhh",
                staged: { "README.md": FILESTATUS.MODIFIED },
            },
            "index - modified deep": {
                state: "x=S:C2 x/y/z=a;I x/y/z=b;H=2",
                staged: { "x/y/z": FILESTATUS.MODIFIED },
            },
            "index - added": {
                state: "x=S:I x=y",
                staged: { x: FILESTATUS.ADDED },
            },
            "index - added deep": {
                state: "x=S:I x/y=y",
                staged: { "x/y": FILESTATUS.ADDED },
            },
            "index - removed": {
                state: "x=S:I README.md",
                staged: { "README.md": FILESTATUS.REMOVED},
            },
            "index - removed deep": {
                state: "x=S:C2 x/y/z=a;I x/y/z;H=2",
                staged: { "x/y/z": FILESTATUS.REMOVED},
            },
            "workdir - modified": {
                state: "x=S:W README.md=hhh",
                workdir: { "README.md": FILESTATUS.MODIFIED },
            },
            "workdir - modified deep": {
                state: "x=S:C2 x/y/z=a;W x/y/z=b;H=2",
                workdir: { "x/y/z": FILESTATUS.MODIFIED },
            },
            "workdir - added": {
                state: "x=S:W x=y",
                workdir: { x: FILESTATUS.ADDED },
            },
            "workdir - added deep": {
                state: "x=S:W x/y=y",
                workdir: { "x/": FILESTATUS.ADDED },
            },
            "workdir - added deep all untracked": {
                state: "x=S:W x/y=y",
                allUntracked: true,
                workdir: { "x/y": FILESTATUS.ADDED },
            },
            "workdir - removed": {
                state: "x=S:W README.md",
                workdir: { "README.md": FILESTATUS.REMOVED},
            },
            "workdir - removed deep": {
                state: "x=S:C2 x/y/z=a;W x/y/z;H=2",
                workdir: { "x/y/z": FILESTATUS.REMOVED},
            },
            "modified workdir and index": {
                state: "x=S:I README.md=aaa;W README.md=bbb",
                staged: { "README.md": FILESTATUS.MODIFIED },
                workdir: { "README.md": FILESTATUS.MODIFIED },
            },
            "index path restriction": {
                state: "x=S:I README.md=aaa,foo=a",
                paths: [ "foo" ],
                staged: { foo: FILESTATUS.ADDED },
            },
            "index dir path": {
                state: "x=S:I x/y/z=foo,x/r/z=bar,README.md",
                paths: [ "x" ],
                staged: {
                    "x/y/z": FILESTATUS.ADDED,
                    "x/r/z": FILESTATUS.ADDED
                },
            },
            "index dir paths": {
                state: "x=S:I x/y/z=foo,x/r/z=bar,README.md",
                paths: [ "x/y", "x/r" ],
                staged: {
                    "x/y/z": FILESTATUS.ADDED,
                    "x/r/z": FILESTATUS.ADDED
                },
            },
            "index all paths": {
                state: "x=S:I x/y/z=foo,x/r/z=bar,README.md",
                paths: [ "x/y/z", "x/r/z", "README.md" ],
                staged: {
                    "x/y/z": FILESTATUS.ADDED,
                    "x/r/z": FILESTATUS.ADDED,
                    "README.md": FILESTATUS.REMOVED,
                },
            },
            "workdir path restriction": {
                state: "x=S:W README.md=aaa,foo=a",
                paths: [ "foo" ],
                workdir: { foo: FILESTATUS.ADDED },
            },
            "workdir dir path": {
                state: "x=S:W x/y/z=foo,x/r/z=bar,README.md",
                paths: [ "x" ],
                allUntracked: true,
                workdir: {
                    "x/y/z": FILESTATUS.ADDED,
                    "x/r/z": FILESTATUS.ADDED
                },
            },
            "workdir dir paths": {
                state: "x=S:W x/y/z=foo,x/r/z=bar,README.md",
                paths: [ "x/y", "x/r" ],
                allUntracked: true,
                workdir: {
                    "x/y/z": FILESTATUS.ADDED,
                    "x/r/z": FILESTATUS.ADDED
                },
            },
            "workdir all paths": {
                state: "x=S:W x/y/z=foo,x/r/z=bar,README.md",
                paths: [ "x/y/z", "x/r/z", "README.md" ],
                allUntracked: true,
                workdir: {
                    "x/y/z": FILESTATUS.ADDED,
                    "x/r/z": FILESTATUS.ADDED,
                    "README.md": FILESTATUS.REMOVED,
                },
            },
            "many changes": {
                state: `
x=S:C2 a/b=c,a/c=d,t=u;H=2;I a/b,a/q=r,f=x;W a/b=q,a/c=f,a/y=g,f`,
                allUntracked: true,
                workdir: {
                    "a/b": FILESTATUS.ADDED,
                    "a/c": FILESTATUS.MODIFIED,
                    "a/y": FILESTATUS.ADDED,
                    "f": FILESTATUS.REMOVED,
                },
                staged: {
                    "a/b": FILESTATUS.REMOVED,
                    "a/q": FILESTATUS.ADDED,
                    "f": FILESTATUS.ADDED,
                },
            },
            "many changes with path": {
                state: `
x=S:C2 a/b=c,a/c=d,t=u;H=2;I a/b,a/q=r,f=x;W a/b=q,a/c=f,a/y=g,f`,
                allUntracked: true,
                paths: ["f"],
                workdir: {
                    "f": FILESTATUS.REMOVED,
                },
                staged: {
                    "f": FILESTATUS.ADDED,
                },
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const w = yield RepoASTTestUtil.createMultiRepos(c.state);
                const repo = w.repos.x;
                const paths = c.paths || [];
                const allUntracked = c.allUntracked || false;
                const result = yield Status.getChanges(repo,
                                                       paths,
                                                       allUntracked);
                const expected = {
                    staged: c.staged || {},
                    workdir: c.workdir || {},
                };
                assert.deepEqual(result, expected);
            }));
        });
    });

    describe("getSubmoduleStatus", function () {
        // We will use `x` for the repo name and `s` for the submodule name.

        /**
         * We're going to cheat here.  We know that `getSubmoduleStatus` will
         * call this method to get repo status.  We just need to make sure that
         * it does so, and that it correctly uses the `headCommit` field, which
         * is all we need to load to do so.
         */
        const getRepoStatus = co.wrap(function *(repo) {
            const head = yield repo.getHeadCommit();
            return new RepoStatus({
                headCommit: head.id().tostrS(),
            });
        });

        const FILESTATUS = RepoStatus.FILESTATUS;
        const Submodule = RepoStatus.Submodule;
        const RELATION = Submodule.COMMIT_RELATION;

        const cases = {
            "unchanged": {
                state: "a=S|x=S:C2-1 s=Sa:1;Bmaster=2",
                expected: new Submodule({
                    indexSha: "1",
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                    indexShaRelation: RELATION.SAME,
                }),
            },
            "added": {
                state: "a=S|x=S:I s=Sa:1",
                expected: new Submodule({
                    indexSha: "1",
                    indexUrl: "a",
                    indexStatus: FILESTATUS.ADDED,
                })
            },
            "removed": {
                state: "a=S|x=S:C2-1 s=Sa:1;Bmaster=2;I s",
                expected: new Submodule({
                    commitSha: "1",
                    commitUrl: "a",
                    indexStatus: FILESTATUS.REMOVED,
                }),
            },
            "new commit": {
                state: "a=S:C3-1;Bfoo=3|x=S:C2-1 s=Sa:1;I s=Sa:3;Bmaster=2",
                expected: new Submodule({
                    indexSha: "3",
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                    indexStatus: FILESTATUS.MODIFIED,
                    indexShaRelation: RELATION.UNKNOWN,
                }),
            },
            "new commit -- known": {
                state: "a=S:C3-1;Bfoo=3|x=S:C2-1 s=Sa:1;I s=Sa:3;Bmaster=2;Os",
                expected: new Submodule({
                    indexSha: "3",
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                    indexStatus: FILESTATUS.MODIFIED,
                    indexShaRelation: RELATION.AHEAD,
                    workdirShaRelation: RELATION.SAME,
                    repoStatus: new RepoStatus({
                        headCommit: "3",
                    }),
                }),
            },
            "new url": {
                state: "a=S|x=S:C2-1 s=Sa:1;I s=Sb:1;Bmaster=2",
                expected: new Submodule({
                    indexSha: "1",
                    indexUrl: "b",
                    commitSha: "1",
                    commitUrl: "a",
                    indexStatus: FILESTATUS.MODIFIED,
                    indexShaRelation: RELATION.SAME,
                }),
            },
            "unchanged open": {
                state: "a=S|x=S:C2-1 s=Sa:1;Bmaster=2;Os",
                expected: new Submodule({
                    indexSha: "1",
                    indexUrl: "a",
                    commitSha: "1",
                    commitUrl: "a",
                    indexShaRelation: RELATION.SAME,
                    workdirShaRelation: RELATION.SAME,
                    repoStatus: new RepoStatus({
                        headCommit: "1",
                    }),
                }),
            },
            "new in open": {
                state: "a=S:C2-1;Bb=2|x=S:I s=Sa:1;Os H=2",
                expected: new Submodule({
                    indexSha: "1",
                    indexUrl: "a",
                    indexStatus: FILESTATUS.ADDED,
                    workdirShaRelation: RELATION.AHEAD,
                    repoStatus: new RepoStatus({
                        headCommit: "2",
                    }),
                }),
            },
            "missing commit in open": {
                state: "a=S:C2-1;Bb=2|x=S:I s=Sa:2;Os H=1",
                expected: new Submodule({
                    indexSha: "2",
                    indexUrl: "a",
                    indexStatus: FILESTATUS.ADDED,
                    workdirShaRelation: RELATION.UNKNOWN,
                    repoStatus: new RepoStatus({
                        headCommit: "1",
                    }),
                }),
            },
            "old in open": {
                state: "a=S:C2-1;Bb=2|x=S:I s=Sa:2;Os H=1!Bf=2",
                expected: new Submodule({
                    indexSha: "2",
                    indexUrl: "a",
                    indexStatus: FILESTATUS.ADDED,
                    workdirShaRelation: RELATION.BEHIND,
                    repoStatus: new RepoStatus({
                        headCommit: "1",
                    }),
                }),
            },
            "unrelated in open": {
                state: "a=S:C2-1;C3-1;Bb=2;Bc=3|x=S:I s=Sa:2;Os H=3!Bf=2",
                expected: new Submodule({
                    indexSha: "2",
                    indexUrl: "a",
                    indexStatus: FILESTATUS.ADDED,
                    workdirShaRelation: RELATION.UNRELATED,
                    repoStatus: new RepoStatus({
                        headCommit: "3",
                    }),
                }),
            }
        };

        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const w = yield RepoASTTestUtil.createMultiRepos(c.state);
                const repo = w.repos.x;
                const index = yield repo.index();
                const indexUrls =
                 yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, index);
                const commit = yield repo.getHeadCommit();
                const commitUrls =
                     yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo,
                                                                       commit);
                const indexUrl = indexUrls.s || null;
                const commitUrl = commitUrls.s || null;
                const commitTree = yield commit.getTree();
                const isVisible = yield SubmoduleUtil.isVisible(repo, "s");
                const result = yield Status.getSubmoduleStatus("s",
                                                               repo,
                                                               indexUrl,
                                                               commitUrl,
                                                               index,
                                                               commitTree,
                                                               isVisible,
                                                               getRepoStatus);
                assert.instanceOf(result, RepoStatus.Submodule);
                const mappedResult = remapSubmodule(result,
                                                    w.commitMap,
                                                    w.urlMap);
                assert.deepEqual(mappedResult, c.expected);
            }));
        });
    });

    describe("getRepoStatus", function () {
        // The logic for reading individual files is tested by `getChanges`, so
        // we don't need to do exhaustive testing on that here.
        //
        // We will get the status of the repo named `x`.

       const cases = {
            "trivial": {
                state: "x=S",
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "1",
                }),
            },
            "bare": {
                state: "x=B",
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "1",
                }),
            },
            "empty": {
                state: { x: new RepoAST()},
                expected: new RepoStatus(),
            },
            "rebase": {
                state: "x=S:C2-1;C3-1;Bfoo=3;Bmaster=2;Erefs/heads/master,2,3",
                expected: new RepoStatus({
                    headCommit: "3",
                    rebase: new Rebase("master", "2", "3"),
                }),
            },
            "staged change": {
                state: "x=S:I README.md=whoohoo",
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "1",
                    staged: { "README.md": FILESTATUS.MODIFIED },
                }),
            },
            "show all untracked": {
                state: "x=S:W x/y/z=foo,x/y/q=bar",
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "1",
                    workdir: {
                        "x/y/z": FILESTATUS.ADDED,
                        "x/y/q": FILESTATUS.ADDED,
                    },
                }),
                options: { showAllUntracked: true, },
            },
            "ignore meta": {
                state: "x=S:I README.md=whoohoo",
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "1",
                    staged: {},
                }),
                options: { showMetaChanges: false },
            },

            // The logic for filtering is tested earlier; here, we just need to
            // validate that the option is propagated properly.

            "path filtered out in meta": {
                state: "x=S:I x/y=a,README.md=sss",
                options: {
                    paths: ["README.md"],
                },
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "1",
                    staged: { "README.md": FILESTATUS.MODIFIED },
                }),
            },

            // Submodules are tested earlier, but we need to test a few
            // concerns:
            //
            // - make sure that they're included, even if they have been
            //   removed in the index or added in the index
            // - `showAllUntracked` propagates
            // - path filtering works

            "sub no show all added": {
                state: "a=S|x=U:Os W x/y=z",
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "2",
                    submodules: {
                        "s": new Submodule({
                            indexSha: "1",
                            indexUrl: "a",
                            indexShaRelation: RELATION.SAME,
                            commitSha: "1",
                            commitUrl: "a",
                            workdirShaRelation: RELATION.SAME,
                            repoStatus: new RepoStatus({
                                headCommit: "1",
                                workdir: {
                                    "x/": FILESTATUS.ADDED,
                                },
                            }),
                        }),
                    },
                }),
            },
            "sub show all added": {
                state: "a=S|x=U:Os W x/y=z",
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "2",
                    submodules: {
                        "s": new Submodule({
                            indexSha: "1",
                            indexUrl: "a",
                            indexShaRelation: RELATION.SAME,
                            commitSha: "1",
                            commitUrl: "a",
                            workdirShaRelation: RELATION.SAME,
                            repoStatus: new RepoStatus({
                                headCommit: "1",
                                workdir: {
                                    "x/y": FILESTATUS.ADDED,
                                },
                            }),
                        }),
                    },
                }),
                options: { showAllUntracked: true, },
            },
            "sub added to index": {
                state: "a=S|x=S:I s=Sa:1",
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "1",
                    submodules: {
                        "s": new Submodule({
                            indexStatus: FILESTATUS.ADDED,
                            indexSha: "1",
                            indexUrl: "a",
                        }),
                    },
                }),
            },
            "sub removed from index": {
                state: "a=S|x=S:C2-1 s=Sa:1;I s;Bmaster=2",
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "2",
                    submodules: {
                        "s": new Submodule({
                            indexStatus: FILESTATUS.REMOVED,
                            commitSha: "1",
                            commitUrl: "a",
                        }),
                    },
                }),
            },
            "sub changed in workdir": {
                state: "a=S:C2-1;Bfoo=2|x=S:I s=Sa:1;Os H=2!W x=q",
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "1",
                    submodules: {
                        "s": new Submodule({
                            indexStatus: FILESTATUS.ADDED,
                            indexSha: "1",
                            indexUrl: "a",
                            workdirShaRelation: RELATION.AHEAD,
                            repoStatus: new RepoStatus({
                                headCommit: "2",
                                workdir: {
                                    x: FILESTATUS.ADDED,
                                },
                            }),
                        }),
                    },
                }),
            },
            "show root untracked": {
                state: "x=S:W x/y/z=foo,x/y/q=bar",
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "1",
                    workdir: {
                        "x/": FILESTATUS.ADDED,
                    },
                }),
            },
            "filtered out": {
                state: "a=B|x=U",
                options: {
                    paths: ["README.md"],
                },
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "2",
                }),
            },
            "filtered in": {
                state: "a=B|x=U",
                options: {
                    paths: ["s"],
                },
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "2",
                    submodules: {
                        s: new Submodule({
                            commitSha: "1",
                            commitUrl: "a",
                            indexSha: "1",
                            indexUrl: "a",
                            indexShaRelation: RELATION.SAME,
                        }),
                    },
                }),
            },
            "deep filter": {
                state: `a=B|x=S:C2-1 s=Sa:1,t=Sa:1;Os I a/b/c=x,a/d/c=y;H=2`,
                options: {
                    paths: ["s/a/b"],
                },
                expected: new RepoStatus({
                    headCommit: "2",
                    submodules: {
                        s: new Submodule({
                            commitSha: "1",
                            commitUrl: "a",
                            indexSha: "1",
                            indexUrl: "a",
                            indexShaRelation: RELATION.SAME,
                            repoStatus: new RepoStatus({
                                headCommit: "1",
                                staged: {
                                    "a/b/c": FILESTATUS.ADDED,
                                },
                            }),
                            workdirShaRelation: RELATION.SAME,
                        }),
                    },
                }),
            },
       };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const w = yield RepoASTTestUtil.createMultiRepos(c.state);
                const result = yield Status.getRepoStatus(w.repos.x,
                                                          c.options);
                assert.instanceOf(result, RepoStatus);
                const mappedResult = remapRepoStatus(result,
                                                     w.commitMap,
                                                     w.urlMap);
                assert.deepEqual(mappedResult, c.expected);
            }));
        });
    });

    describe("ensureClean", function () {
        // We don't need to test the `isClean` functionality; it's already
        // tested, just that it's called propertly.
        // TODO: regex on error message.

        // We will check the repo named `x`.
        const cases = {
            "trivial": {
                state: "x=S",
                fails: false,
            },
            "and a clean submodule": {
                state: "a=S|x=S:C2-1 s=Sa:1;Bmaster=2;Os",
                fails: false,
            },
            "dirty meta": {
                state: "x=S:I foo=bar",
                fails: true,
            },
            "and a dirty sub": {
                state: "a=S|x=S:C2-1 s=Sa:1;Bmaster=2;Os W README.md=aaa",
                fails: true,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const w = yield RepoASTTestUtil.createMultiRepos(c.state);
                const x = w.repos.x;
                const xStat = yield Status.getRepoStatus(x);
                try {
                    Status.ensureClean(xStat);
                    assert.equal(c.fails, false);
                    return;                                           // RETURN
                }
                catch (e) {
                    if (!(e instanceof UserError)) {
                        throw e;
                    }
                }
                assert(c.fails);
            }));
        });
    });

    describe("ensureConsistent", function () {
        // TODO: check formatting of error message.

        // We'll be checking the consistency of the repo named `x`.
        const cases = {
            "trivial": {
                state: "x=S",
                fails: false,
            },
            "good sub": {
                state: "a=S|x=S:C2-1 s=Sa:1;Bmaster=2",
                fails: false,
            },
            "sub with staged change": {
                state: "a=S|x=S:I s=Sa:1",
                fails: true,
            },
            "good open sub": {
                state: "a=S|x=S:C2-1 s=Sa:1;Bmaster=2;Os Bmaster=1!*=master",
                fails: false,
            },
            "sub with new commit in open repo": {
                state: "a=S|x=S:C2-1 s=Sa:1;Bmaster=2;Os Bmaster=2!*=master",
                fails: true,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const w = yield RepoASTTestUtil.createMultiRepos(c.state);
                const x = w.repos.x;
                const xStat = yield Status.getRepoStatus(x);
                let error = "";
                try {
                    Status.ensureConsistent(xStat);
                    assert.equal(c.fails, false);
                    return;                                           // RETURN
                }
                catch (e) {
                    if (!(e instanceof UserError)) {
                        throw e;
                    }
                    error = e.stack;
                }
                assert(c.fails, error);
            }));
        });
    });

    describe("ensureCleanAndConsistent", function () {
        // We don't have to test much here; this method defers to `ensureClean`
        // and `ensureConsistent`.

        // Ensure the repo `x`.
        const cases = {
            "trivial": {
                state: "x=S",
                fails: false,
            },
            "unclean": {
                state: "x=S:I foo=bar",
                fails: true,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const w = yield RepoASTTestUtil.createMultiRepos(c.state);
                const x = w.repos.x;
                let error = "";
                const status = yield Status.getRepoStatus(x);
                try {
                    Status.ensureCleanAndConsistent(status);
                    assert.equal(c.fails, false);
                    return;                                           // RETURN
                }
                catch (e) {
                    if (!(e instanceof UserError)) {
                        throw e;
                    }
                    error = e.stack;
                }
                assert(c.fails, error);
            }));
        });
    });
});
