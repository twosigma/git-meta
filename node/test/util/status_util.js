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
const path    = require("path");
const NodeGit = require("nodegit");

const DiffUtil            = require("../../lib/util/diff_util");
const Rebase              = require("../../lib/util/rebase");
const RepoAST             = require("../../lib/util/repo_ast");
const RepoASTTestUtil     = require("../../lib/util/repo_ast_test_util");
const RepoStatus          = require("../../lib/util/repo_status");
const SequencerState      = require("../../lib/util/sequencer_state");
const StatusUtil          = require("../../lib/util/status_util");
const SubmoduleUtil       = require("../../lib/util/submodule_util");
const SubmoduleConfigUtil = require("../../lib/util/submodule_config_util");
const UserError           = require("../../lib/util/user_error");

// test utilities

describe("StatusUtil", function () {
    const CommitAndRef     = SequencerState.CommitAndRef;
    const TYPE             = SequencerState.TYPE;
    const FILEMODE         = NodeGit.TreeEntry.FILEMODE;
    const BLOB             = FILEMODE.BLOB;
    const FILESTATUS       = RepoStatus.FILESTATUS;
    const RELATION         = RepoStatus.Submodule.COMMIT_RELATION;
    const Submodule        = RepoStatus.Submodule;
    const Commit           = Submodule.Commit;
    const Index            = Submodule.Index;
    const Workdir          = Submodule.Workdir;

    describe("remapSubmodule", function () {
        const cases = {
            "all": {
                input: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                }),
                commitMap: { "1": "2" },
                urlMap: { "a": "b" },
                expected: new Submodule({
                    commit: new Commit("2", "b"),
                    index: new Index("2", "b", RELATION.SAME),
                }),
            },
            "some skipped": {
                input: new Submodule({
                    commit: new Commit("3", "z"),
                    index: new Index("1", "x", RELATION.BEHIND),
                }),
                commitMap: { "1": "2" },
                urlMap: { "x": "y" },
                expected: new Submodule({
                    commit: new Commit("3", "z"),
                    index: new Index("2", "y", RELATION.BEHIND),
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
                    sequencerState: new SequencerState({
                        type: TYPE.MERGE,
                        originalHead: new CommitAndRef("1", null),
                        target: new CommitAndRef("1", "baz"),
                        commits: ["1"],
                        currentCommit: 0,
                    }),
                }),
                commitMap: { "1": "3"},
                urlMap: {},
                expected: new RepoStatus({
                    currentBranchName: "foo",
                    headCommit: "3",
                    staged: { x: RepoStatus.FILESTATUS.ADDED },
                    workdir: { y: RepoStatus.FILESTATUS.ADDED },
                    rebase: new Rebase("foo", "3", "3"),
                    sequencerState: new SequencerState({
                        type: TYPE.MERGE,
                        originalHead: new CommitAndRef("3", null),
                        target: new CommitAndRef("3", "baz"),
                        commits: ["3"],
                        currentCommit: 0,
                    }),
                }),
            },
            "with a sub": {
                input: new RepoStatus({
                    submodules: {
                        s: new Submodule({
                            commit: new Commit("1", "a"),
                            index: new Index("1", "a", RELATION.SAME),
                        }),
                    },
                }),
                commitMap: { "1": "2" },
                urlMap: { "a": "b" },
                expected: new RepoStatus({
                    submodules: {
                        s: new Submodule({
                            commit: new Commit("2", "b"),
                            index: new Index("2", "b", RELATION.SAME),
                        }),
                    },
                }),
            },
            "with a sub having a repo": {
                input: new RepoStatus({
                    submodules: {
                        s: new Submodule({
                            index: new Index("1", "a", null),
                            workdir: new Workdir(new RepoStatus({
                                headCommit: "1",
                            }), RELATION.SAME),
                        }),
                    },
                }),
                commitMap: { "1": "2" },
                urlMap: { "a": "b" },
                expected: new RepoStatus({
                    submodules: {
                        s: new Submodule({
                            index: new Index("2", "b", null),
                            workdir: new Workdir(new RepoStatus({
                                headCommit: "2",
                            }), RELATION.SAME),
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

    describe("getRelation", function () {
        const sha1 = "aa48dbe570caf481d41da6aa674afe05f8db534b";
        const sha2 = "72c6d7cbcac84e6ebc569fec4b1d08bfee5ac4c3";
        const RELATION = RepoStatus.Submodule.COMMIT_RELATION;
        const cases = {
            "both null": {
                state: "S",
                from: null,
                to: null,
                expected: null,
            },
            "from null": {
                state: "S",
                from: null,
                to: sha1,
                expected: null,
            },
            "to null": {
                state: "S",
                from: sha1,
                to: null,
                expected: null,
            },
            "same": {
                state: "S",
                from: sha1,
                to: sha1,
                expected: RELATION.SAME,
            },
            "ahead": {
                state: "S:C2-1;Bmaster=2",
                from: "1",
                to: "2",
                expected: RELATION.AHEAD,
            },
            "behind": {
                state: "S:C2-1;Bmaster=2",
                from: "2",
                to: "1",
                expected: RELATION.BEHIND,
            },
            "unknown": {
                state: "S",
                from: sha1,
                to: sha2,
                expected: RELATION.UNKNOWN,
            },
            "unknown (from known)": {
                state: "S",
                from: "1",
                to: sha2,
                expected: RELATION.UNKNOWN,
            },
            "unknown (to known)": {
                state: "S",
                from: sha1,
                to: "1",
                expected: RELATION.UNKNOWN,
            },
            "unrelated": {
                state: "S:C2;Bfoo=2",
                from: "2",
                to: "1",
                expected: RELATION.UNRELATED,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written = yield RepoASTTestUtil.createRepo(c.state);
                const repo = written.repo;
                const commitMap = written.oldCommitMap;
                function mapSha(sha) {
                    const mapped = commitMap[sha];
                    return (undefined === mapped) ? sha : mapped;
                }
                const from = mapSha(c.from);
                const to = mapSha(c.to);
                const result = yield StatusUtil.getRelation(repo, from, to);
                assert.equal(result, c.expected);
            }));
        });
    });

    describe("getSubmoduleStatus", function () {
        // We will use `x` for the repo name and `s` for the submodule name.

        const cases = {
            "unchanged": {
                state: "a=S|x=S:C2-1 s=Sa:1;Bmaster=2",
                expected: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                }),
            },
            "added": {
                state: "a=S|x=S:I s=Sa:1",
                expected: new Submodule({
                    index: new Index("1", "a", null),
                })
            },
            "added and open": {
                state: "a=S|x=S:I s=Sa:;Os",
                expected: new Submodule({
                    index: new Index(null, "a", null),
                    workdir: new Workdir(new RepoStatus({
                    }), null),
                }),
            },
            "added with commit in workdir but not index": {
                state: "a=S|x=S:C2-1;I s=Sa:;Os H=2;Bfoo=2",
                expected: new Submodule({
                    index: new Index("2", "a", null),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "2",
                    }), RELATION.SAME),
                }),
            },
            "removed": {
                state: "a=S|x=S:C2-1 s=Sa:1;Bmaster=2;I s",
                expected: new Submodule({
                    commit: new Commit("1", "a"),
                }),
            },
            "new commit": {
                state: "a=S:C3-1;Bfoo=3|x=S:C2-1 s=Sa:1;I s=Sa:3;Bmaster=2",
                expected: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("3", "a", RELATION.UNKNOWN),
                }),
            },
            "new commit -- known": {
                state: "a=S:C3-1;Bfoo=3|x=S:C2-1 s=Sa:1;I s=Sa:3;Bmaster=2;Os",
                expected: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("3", "a", RELATION.AHEAD),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "3",
                    }), RELATION.SAME),
                }),
            },
            "new url": {
                state: "a=S|x=S:C2-1 s=Sa:1;I s=Sb:1;Bmaster=2",
                expected: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("1", "b", RELATION.SAME),
                }),
            },
            "unchanged open": {
                state: "a=S|x=S:C2-1 s=Sa:1;Bmaster=2;Os",
                expected: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "1",
                    }), RELATION.SAME),
                }),
            },
            "new in open": {
                state: "a=S:C2-1;Bb=2|x=S:I s=Sa:1;Os H=2",
                expected: new Submodule({
                    index: new Index("2", "a", null),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "2",
                    }), RELATION.SAME),
                }),
            },
            "missing commit in open": {
                state: "a=S:C2-1;Bb=2|x=S:I s=Sa:2;Os H=1",
                expected: new Submodule({
                    index: new Index("1", "a", null),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "1",
                    }), RELATION.SAME),
                }),
            },
            "old in open": {
                state: "a=S:C2-1;Bb=2|x=S:I s=Sa:2;Os H=1!Bf=2",
                expected: new Submodule({
                    index: new Index("1", "a", null),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "1",
                    }), RELATION.SAME),
                }),
            },
            "unrelated in open": {
                state: "a=S:C2-1;C3-1;Bb=2;Bc=3|x=S:I s=Sa:2;Os H=3!Bf=2",
                expected: new Submodule({
                    index: new Index("3", "a", null),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "3",
                    }), RELATION.SAME),
                }),
            },
            "reset from workdir": {
                state: "a=S:Ca-1;Bmaster=a|x=U:I s=Sa:a;Os H=1",
                expected: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "1",
                    }), RELATION.SAME),
                }),
            },
            "unchanged from workdir": {
                state: "a=S:Ca-1;Bmaster=a|x=U:I s=Sa:a;Os H=a",
                expected: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("a", "a", RELATION.AHEAD),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "a",
                    }), RELATION.SAME),
                }),
            },
            "behind from workdir": {
                state: `
a=S:Ca-1;Cb-a;Bmaster=b|
x=S:C2-1 s=Sa:a;I s=Sa:b;Bmaster=2;Os H=1!Bfoo=b`,
                expected: new Submodule({
                    commit: new Commit("a", "a"),
                    index: new Index("1", "a", RELATION.BEHIND),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "1",
                    }), RELATION.SAME),
                }),
            },
            "behind from workdir (missing commit)": {
                state: `
a=S:Ca-1;Cb-a;Bmaster=b|
x=S:C2-1 s=Sa:a;I s=Sa:b;Bmaster=2;Os H=1`,
                expected: new Submodule({
                    commit: new Commit("a", "a"),
                    index: new Index("1", "a", RELATION.UNKNOWN),
                    workdir: new Workdir(new RepoStatus({
                        headCommit: "1",
                    }), RELATION.SAME),
                }),
            },
            "headless": {
                state: "a=S|x=U:Os H=",
                expected: new Submodule({
                    commit: new Commit("1", "a"),
                    index: new Index("1", "a", RELATION.SAME),
                    workdir: new Workdir(new RepoStatus({}), null),
                }),
            },
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
                let indexSha = null;
                const entry = index.getByPath("s");
                if (entry) {
                    indexSha = entry.id.tostrS();
                }
                let commitSha = null;
                if (commitUrl) {
                    const commitTree = yield commit.getTree();
                    commitSha = (yield commitTree.entryByPath("s")).sha();
                }
                const isVisible = yield SubmoduleUtil.isVisible(repo, "s");
                let subRepo = null;
                let subStatus = null;
                if (isVisible) {
                    subRepo = yield SubmoduleUtil.getRepo(repo, "s");
                    const head = yield subRepo.getHeadCommit();
                    const headCommit = head && head.id().tostrS();
                    subStatus = new RepoStatus({
                        headCommit: headCommit,
                    });
                }
                const result = yield StatusUtil.getSubmoduleStatus(subRepo,
                                                                   subStatus,
                                                                   indexUrl,
                                                                   commitUrl,
                                                                   indexSha,
                                                                   commitSha);
                assert.instanceOf(result, Submodule);
                const mappedResult = StatusUtil.remapSubmodule(result,
                                                               w.commitMap,
                                                               w.urlMap);
                assert.deepEqual(mappedResult, c.expected);
            }));
        });
        it("misconfigured", co.wrap(function *() {
            const result = yield StatusUtil.getSubmoduleStatus(null,
                                                               null,
                                                               null,
                                                               null,
                                                               null,
                                                               null);
            assert.isUndefined(result);
        }));
    });

    describe("readConflicts", function () {
        const Conflict = RepoStatus.Conflict;
        const FILEMODE = NodeGit.TreeEntry.FILEMODE;
        const BLOB = FILEMODE.BLOB;
        const cases = {
            "trivial": {
                state: "S",
                expected: {},
            },
            "a conflict": {
                state: "S:I *README.md=a*b*c,foo=bar",
                expected: {
                    "README.md": new Conflict(BLOB, BLOB, BLOB),
                },
            },
            "missing ancestor": {
                state: "S:I *README.md=~*a*c",
                expected: {
                    "README.md": new Conflict(null, BLOB, BLOB),
                },
            },
            "missing our": {
                state: "S:I *README.md=a*~*c",
                expected: {
                    "README.md": new Conflict(BLOB, null, BLOB),
                },
            },
            "missing their": {
                state: "S:I *README.md=a*a*~",
                expected: {
                    "README.md": new Conflict(BLOB, BLOB, null),
                },
            },
            "submodule": {
                state: "S:I *README.md=a*a*S:1",
                expected: {
                    "README.md": new Conflict(BLOB, BLOB, FILEMODE.COMMIT),
                },
            },
            "ignore submodule sha conflict": {
                state: "S:I *README.md=a*S:1*S:1",
                expected: {},
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written = yield RepoASTTestUtil.createRepo(c.state);
                const repo = written.repo;
                const index = yield repo.index();
                const result = StatusUtil.readConflicts(index, []);
                assert.deepEqual(result, c.expected);
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
            "sequencer": {
                state: "x=S:C2-1;C3-1;Bfoo=3;Bmaster=2;QM 1: 2:foo 1 2,3",
                expected: new RepoStatus({
                    headCommit: "2",
                    currentBranchName: "master",
                    sequencerState: new SequencerState({
                        type: TYPE.MERGE,
                        originalHead: new CommitAndRef("1", null),
                        target: new CommitAndRef("2", "foo"),
                        commits: ["2", "3"],
                        currentCommit: 1,
                    }),
                }),
            },
            "staged change": {
                state: "x=S:I README.md=whoohoo",
                options: {
                    showMetaChanges: true,
                },
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
                options: {
                    untrackedFilesOption: DiffUtil.UNTRACKED_FILES_OPTIONS.ALL,
                    showMetaChanges: true
                },
            },
            "ignore meta": {
                state: "x=S:I README.md=whoohoo",
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "1",
                    staged: {},
                }),
            },

            // The logic for filtering is tested earlier; here, we just need to
            // validate that the option is propagated properly.

            "path filtered out in meta": {
                state: "x=S:I x/y=a,README.md=sss,y=foo",
                options: {
                    paths: ["README.md"],
                    showMetaChanges: true,
                },
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "1",
                    staged: { "README.md": FILESTATUS.MODIFIED },
                }),
            },
            "path resolved with cwd": {
                state: "x=S:I x/y=a,README.md=sss,y=foo",
                options: {
                    cwd: "x",
                    paths: ["y"],
                    showMetaChanges: true,
                },
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "1",
                    staged: { "x/y": FILESTATUS.ADDED },
                }),
            },

            // Submodules are tested earlier, but we need to test a few
            // concerns:
            //
            // - make sure that they're included, even if they have been
            //   removed in the index or added in the index
            // - `untrackedFilesOption` propagates
            // - path filtering works

            "sub no show all added": {
                state: "a=S|x=U:Os W x/y=z",
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "2",
                    submodules: {
                        "s": new Submodule({
                            commit: new Commit("1", "a"),
                            index: new Index("1", "a", RELATION.SAME),
                            workdir: new Workdir(new RepoStatus({
                                headCommit: "1",
                                workdir: {
                                    "x/": FILESTATUS.ADDED,
                                },
                            }), RELATION.SAME),
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
                            commit: new Commit("1", "a"),
                            index: new Index("1", "a", RELATION.SAME),
                            workdir: new Workdir(new RepoStatus({
                                headCommit: "1",
                                workdir: {
                                    "x/y": FILESTATUS.ADDED,
                                },
                            }), RELATION.SAME),
                        }),
                    },
                }),
                options: {
                    untrackedFilesOption: DiffUtil.UNTRACKED_FILES_OPTIONS.ALL,
                },
            },
            "sub added to index": {
                state: "a=S|x=S:I s=Sa:1",
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "1",
                    submodules: {
                        "s": new Submodule({
                            index: new Index("1", "a", null),
                        }),
                    },
                    staged: {
                        ".gitmodules": FILESTATUS.ADDED,
                    }
                }),
            },
            "sub removed from index": {
                state: "a=S|x=S:C2-1 s=Sa:1;I s;Bmaster=2",
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "2",
                    submodules: {
                        "s": new Submodule({
                            commit: new Commit("1", "a"),
                        }),
                    },
                    staged: {
                        ".gitmodules": FILESTATUS.REMOVED,
                    }
                }),
            },
            "sub changed in workdir": {
                state: "a=S:C2-1;Bfoo=2|x=S:I s=Sa:1;Os H=2!W x=q",
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "1",
                    submodules: {
                        "s": new Submodule({
                            index: new Index("2", "a", null),
                            workdir: new Workdir(new RepoStatus({
                                headCommit: "2",
                                workdir: {
                                    x: FILESTATUS.ADDED,
                                },
                            }), RELATION.SAME),
                        }),
                    },
                    staged: {
                        ".gitmodules": FILESTATUS.ADDED,
                    }
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
                options: { showMetaChanges: true, },
            },
            "no changes, ingored": {
                state: "a=B|x=U",
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "2",
                }),
            },
            "filtered out": {
                state: "a=B:Ca-1;Ba=a|x=U:I s=Sa:a",
                options: {
                    paths: ["README.md"],
                },
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "2",
                }),
            },
            "filtered in": {
                state: "a=B:Ca-1;Ba=a|x=U:I s=Sa:a",
                options: {
                    paths: ["README.md"],
                },
                expected: new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "2",
                    submodules: {},
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
                            commit: new Commit("1", "a"),
                            index: new Index("1", "a", RELATION.SAME),
                            workdir: new Workdir(new RepoStatus({
                                headCommit: "1",
                                staged: {
                                    "a/b/c": FILESTATUS.ADDED,
                                },
                            }), RELATION.SAME),
                        }),
                    },
                }),
            },
           "ignore index": {
               state: "x=S:I a=b;W a",
               options: {
                   ignoreIndex: true,
               },
               expected: new RepoStatus({
                   headCommit: "1",
                   currentBranchName: "master",
               }),
           },
           "ignore index in sub": {
               state: "a=B|x=U:Os I a=b",
               options: {
                   ignoreIndex: true,
               },
               expected: new RepoStatus({
                   headCommit: "2",
                   currentBranchName: "master",
                   submodules: {
                       s: new Submodule({
                           commit: new Commit("1", "a"),
                           index: new Index("1", "a", RELATION.SAME),
                           workdir: new Workdir(new RepoStatus({
                               headCommit: "1",
                               workdir: {
                                   a: FILESTATUS.ADDED,
                               },
                           }), RELATION.SAME),
                       }),
                   },
               }),
           },
           "new with staged": {
               state: "a=B|x=S:I s=Sa:;Os I q=r",
               expected: new RepoStatus({
                   headCommit: "1",
                   currentBranchName: "master",
                   staged: {
                        ".gitmodules": FILESTATUS.ADDED,
                    },
                   submodules: {
                       s: new Submodule({
                           commit: null,
                           index: new Index(null, "a", null),
                           workdir: new Workdir(new RepoStatus({
                               headCommit: null,
                               staged: {
                                   q: FILESTATUS.ADDED,
                               },
                           }), null),
                       }),
                   },
               }),
           },
           "conflict": {
               state: "x=S:I *foo=~*ff*~",
               expected: new RepoStatus({
                   currentBranchName: "master",
                   headCommit: "1",
                   staged: {
                       foo: new RepoStatus.Conflict(null, BLOB, null),
                   },
               }),
           },
       };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const w = yield RepoASTTestUtil.createMultiRepos(c.state);
                const options = c.options || {};
                if (undefined !== options.cwd) {
                    options.cwd = path.join(w.repos.x.workdir(),
                                            options.cwd);
                }
                const result = yield StatusUtil.getRepoStatus(w.repos.x,
                                                              options);
                assert.instanceOf(result, RepoStatus);
                const mappedResult = StatusUtil.remapRepoStatus(result,
                                                                w.commitMap,
                                                                w.urlMap);
                assert.deepEqual(mappedResult, c.expected);
            }));
        });
    });

    describe("ensureReady", function () {
        const cases = {
            "ready": {
                input: new RepoStatus(),
                fails: false,
            },
            "rebase": {
                input: new RepoStatus({
                    rebase: new Rebase("foo", "bart", "baz"),
                }),
                fails: true,
            },
            "sequencer": {
                input: new RepoStatus({
                    sequencerState: new SequencerState({
                        type: TYPE.MERGE,
                        originalHead: new CommitAndRef("1", null),
                        target: new CommitAndRef("1", "baz"),
                        commits: ["1"],
                        currentCommit: 0,
                    }),
                }),
                fails: true,
            },
        };
        Object.keys(cases).forEach(caseName => {
            it(caseName, function () {
                const c = cases[caseName];
                let exception;
                try {
                    StatusUtil.ensureReady(c.input);
                } catch (e) {
                    exception = e;
                }
                if (undefined === exception) {
                    assert.equal(c.fails, false);
                } else {
                    if (!(exception instanceof UserError)) {
                        throw exception;
                    }
                    assert.equal(c.fails, true);
                }
            });
        });
    });
});
