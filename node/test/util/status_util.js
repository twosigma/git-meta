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
const StatusUtil          = require("../../lib/util/status_util");
const SubmoduleUtil       = require("../../lib/util/submodule_util");
const SubmoduleConfigUtil = require("../../lib/util/submodule_config_util");

// test utilities

describe("StatusUtil", function () {
    const FILESTATUS       = RepoStatus.FILESTATUS;
    const RELATION         = RepoStatus.Submodule.COMMIT_RELATION;
    const Submodule        = RepoStatus.Submodule;
 
    describe("remapSubmodule", function () {
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
                const result = StatusUtil.remapSubmodule(c.input,
                                                         c.commitMap,
                                                         c.urlMap);
                assert.deepEqual(result, c.expected);
            });
        });
    });

    describe("remapRepoStatus", function () {
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
                const result =
                    StatusUtil.remapRepoStatus(c.input, c.commitMap, c.urlMap);
                assert.deepEqual(result, c.expected);
            });
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
                const result = yield StatusUtil.getSubmoduleStatus(
                                                                "s",
                                                                repo,
                                                                indexUrl,
                                                                commitUrl,
                                                                index,
                                                                commitTree,
                                                                isVisible,
                                                                getRepoStatus);
                assert.instanceOf(result, RepoStatus.Submodule);
                const mappedResult = StatusUtil.remapSubmodule(result,
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
                const result = yield StatusUtil.getRepoStatus(w.repos.x,
                                                              c.options);
                assert.instanceOf(result, RepoStatus);
                const mappedResult = StatusUtil.remapRepoStatus(result,
                                                                w.commitMap,
                                                                w.urlMap);
                assert.deepEqual(mappedResult, c.expected);
            }));
        });
    });
});
