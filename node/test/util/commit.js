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
const NodeGit = require("nodegit");
const path    = require("path");

const Commit          = require("../../lib/util/commit");
const GitUtil         = require("../../lib/util/git_util");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");
const RepoStatus      = require("../../lib/util/repo_status");
const StatusUtil      = require("../../lib/util/status_util");
const SubmoduleUtil   = require("../../lib/util/submodule_util");
const TestUtil        = require("../../lib/util/test_util");
const UserError       = require("../../lib/util/user_error");


function mapCommitResult(commitResult) {
    // Return a map from physical to computed logical sha for the commit ids in
    // the specified `commitResul` (as returned by `Commit.commit` and
    // `Commit.doCommitCommand`), s.t. the meta-repo commit is named "x" and
    // the submodules commits are named after their submodule.

    let commitMap = {};
    if (null !== commitResult.metaCommit) {
        commitMap[commitResult.metaCommit] = "x";
    }
    Object.keys(commitResult.submoduleCommits).forEach(subName => {
        const newCommit = commitResult.submoduleCommits[subName];
        commitMap[newCommit] = subName;
    });
    return commitMap;
}

// We'll always commit the repo named 'x'.  If a new commit is created ni the
// meta-repo, it will be named 'x'.  New commits created in sub-repos will be
// identified as their submodule name.

const committer = co.wrap(function *(doAll, message, repos, subMessages) {
    const x = repos.x;
    const status = yield Commit.getCommitStatus(x,
                                                x.workdir(), {
        showMetaChanges: true,
        all: doAll,
    });
    const result = yield Commit.commit(x, doAll, status, message, subMessages);
    return {
        commitMap: mapCommitResult(result),
    };
});

describe("Commit", function () {
    const FILESTATUS = RepoStatus.FILESTATUS;
    const Submodule  = RepoStatus.Submodule;
    const RELATION   = RepoStatus.Submodule.COMMIT_RELATION;
    const SAME       = RELATION.SAME;
    describe("CommitMetaData", function () {
        it("breathing", function () {
            const message = "hello";
            const sig = NodeGit.Signature.now("me", "me@me");
            const data = new Commit.CommitMetaData(sig, message);
            assert.equal(data.signature, sig);
            assert.equal(data.message, message);
        });
        describe("equivalent", function () {
            const cases = {
                "same": {
                    xName: "foo",
                    xEmail: "foo@bar",
                    xMessage: "because",
                    yName: "foo",
                    yEmail: "foo@bar",
                    yMessage: "because",
                    expected: true,
                },
                "diff name": {
                    xName: "baz",
                    xEmail: "foo@bar",
                    xMessage: "because",
                    yName: "foo",
                    yEmail: "foo@bar",
                    yMessage: "because",
                    expected: false,
                },
                "diff email": {
                    xName: "foo",
                    xEmail: "foo@baz",
                    xMessage: "because",
                    yName: "foo",
                    yEmail: "foo@bar",
                    yMessage: "because",
                    expected: false,
                },
                "diff message": {
                    xName: "foo",
                    xEmail: "foo@bar",
                    xMessage: "because",
                    yName: "foo",
                    yEmail: "foo@bar",
                    yMessage: "why",
                    expected: false,
                },
                "all different": {
                    xName: "bar",
                    xEmail: "bam@bar",
                    xMessage: "because",
                    yName: "foo",
                    yEmail: "foo@bar",
                    yMessage: "why",
                    expected: false,
                },
            };
            Object.keys(cases).forEach(caseName => {
                const c = cases[caseName];
                it(caseName, function () {
                    const xSig = NodeGit.Signature.now(c.xName, c.xEmail);
                    const x = new Commit.CommitMetaData(xSig, c.xMessage);
                    const ySig = NodeGit.Signature.now(c.yName, c.yEmail);
                    const y = new Commit.CommitMetaData(ySig, c.yMessage);
                    const result = x.equivalent(y);
                    assert.equal(result, c.expected);
                });
            });
        });
    });



    describe("stageChange", function () {
        const cases = {
            "one modified": {
                initial: "x=S:W README.md=99",
                path: "README.md",
                change: FILESTATUS.MODIFIED,
                expected: "x=S:I README.md=99",
            },
            "already staged but ok": {
                initial: "x=S:I README.md=99",
                path: "README.md",
                change: FILESTATUS.MODIFIED,
                expected: "x=S:I README.md=99",
            },
            "one removed": {
                initial: "x=S:W README.md",
                path: "README.md",
                change: FILESTATUS.REMOVED,
                expected: "x=S:I README.md",
            },
            "one already removed": {
                initial: "x=S:I README.md",
                path: "README.md",
                change: FILESTATUS.REMOVED,
                expected: "x=S:I README.md",
            },
            "added and modded": {
                initial: "x=S:I x=a;W x=b",
                path: "x",
                change: FILESTATUS.ADDED,
                expected: "x=S:I x=b",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            const manipulator = co.wrap(function *(repos) {
                const repo = repos.x;
                const index = yield repo.index();
                yield Commit.stageChange(index, c.path, c.change);
                yield index.write();
            });
            it(caseName, co.wrap(function *() {
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               c.expected,
                                                               manipulator,
                                                               c.fails);
            }));
        });
    });

    describe("prefixWithPound", function () {
        const cases = {
            "empty": {
                input: "",
                expected: "",
            },
            "one line": {
                input: "a\n",
                expected: "# a\n",
            },
            "one blank": {
                input: "\n",
                expected: "#\n",
            },
            "mixed": {
                input: `\

a

b

`,
                expected: `\
#
# a
#
# b
#
`
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = Commit.prefixWithPound(c.input);
                assert.equal(result, c.expected);
            });
        });
    });

    describe("formatStatus", function () {
        const cases = {
            "nothing": {
                status: new RepoStatus(),
                expected: "",
            },
            "workdir": {
                status: new RepoStatus({
                    currentBranchName: "master",
                    staged: {
                        "foo": FILESTATUS.ADDED,
                    },
                    workdir: {
                        "bar": FILESTATUS.MODIFIED,
                    },
                }),
                expected: `\
Changes to be committed:
\tnew file:     foo

Changes not staged for commit:
\tmodified:     bar
`,
            },
            "untracked": {
                status: new RepoStatus({
                    currentBranchName: "master",
                    staged: {
                        "foo": FILESTATUS.ADDED,
                    },
                    workdir: {
                        "bar": FILESTATUS.ADDED,
                    },
                }),
                expected: `\
Changes to be committed:
\tnew file:     foo

Untracked files:
\tbar
`,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const cwd = c.cwd || "";
                const result = Commit.formatStatus(c.status, cwd);
                const resultLines = result.split("\n");
                const expectedLines = c.expected.split("\n");
                assert.deepEqual(resultLines, expectedLines);
            });
        });
    });
    describe("formatEditorPrompt", function () {
        // Most of the work in this method is pass-through; just need to check
        // that it's all wired up.

        const cases = {
            "one change": {
                status: new RepoStatus({
                    currentBranchName: "master",
                    staged: {
                        "foo": FILESTATUS.ADDED,
                    },
                }),
                expected: `\

# Please enter the commit message for your changes. Lines starting
# with '#' will be ignored, and an empty message aborts the commit.
# On branch master.
# Changes to be committed:
# \tnew file:     foo
#
`,
            },
            "detached head": {
                status: new RepoStatus({
                    currentBranchName: null,
                    headCommit: "afafafafafafafafafafafafaf",
                    staged: {
                        "foo": FILESTATUS.ADDED,
                    },
                }),
                expected: `\

# Please enter the commit message for your changes. Lines starting
# with '#' will be ignored, and an empty message aborts the commit.
# On detached head afafaf.
# Changes to be committed:
# \tnew file:     foo
#
`,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const cwd = c.cwd || "";
                const all = c.all || false;
                const result = Commit.formatEditorPrompt(c.status, cwd, all);
                const resultLines = result.split("\n");
                const expectedLines = c.expected.split("\n");
                assert.deepEqual(resultLines, expectedLines);
            });
        });
    });

    describe("shouldCommit", function () {
        const cases = {
            "trivial": {
                status: new RepoStatus(),
                skipMeta: false,
                subMessages: {},
                expected: false,
            },
            "staged meta": {
                status: new RepoStatus({
                    staged: {
                        foo: FILESTATUS.ADDED,
                    },
                }),
                skipMeta: false,
                subMessages: {},
                expected: true,
            },
            "skip meta: staged meta": {
                status: new RepoStatus({
                    staged: {
                        foo: FILESTATUS.ADDED,
                    },
                }),
                skipMeta: true,
                subMessages: {},
                expected: false,
            },
            "unchanged sub": {
                status: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                        }),
                    },
                }),
                skipMeta: false,
                subMessages: {},
                expected: false,
            },
            "unchanged open sub": {
                status: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(new RepoStatus({
                                headCommit: "1",
                            }), RELATION.SAME),
                        }),
                    },
                }),
                skipMeta: false,
                subMessages: {},
                expected: false,
            },
            "index commit change in sub": {
                status: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("2",
                                                       "/a",
                                                       RELATION.AHEAD),
                        }),
                    },
                }),
                skipMeta: false,
                subMessages: {},
                expected: true,
            },
            "skip meta: index commit change in sub": {
                status: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("2",
                                                       "/a",
                                                       RELATION.AHEAD),
                        }),
                    },
                }),
                skipMeta: true,
                subMessages: {},
                expected: false,
            },
            "index url change in sub": {
                status: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/b",
                                                       RELATION.SAME),
                        }),
                    },
                }),
                skipMeta: false,
                subMessages: {},
                expected: true,
            },
            "skip meta: index url change in sub": {
                status: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/b",
                                                       RELATION.SAME),
                        }),
                    },
                }),
                skipMeta: true,
                subMessages: {},
                expected: false,
            },
            "deleted sub in index": {
                status: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: null,
                        }),
                    },
                }),
                skipMeta: false,
                subMessages: {},
                expected: true,
            },
            "skip meta: deleted sub in index": {
                status: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: null,
                        }),
                    },
                }),
                skipMeta: true,
                subMessages: {},
                expected: false,
            },
            "new sub": {
                status: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: null,
                            index: new Submodule.Index("1", "/a", null),
                        }),
                    },
                }),
                skipMeta: false,
                subMessages: {},
                expected: true,
            },
            "skip meta: new sub": {
                status: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: null,
                            index: new Submodule.Index("1", "/a", null),
                        }),
                    },
                }),
                skipMeta: true,
                subMessages: {},
                expected: false,
            },
            "new workdir commit": {
                status: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(new RepoStatus({
                                headCommit: "2",
                            }), RELATION.AHEAD),
                        }),
                    },
                }),
                skipMeta: false,
                subMessages: {},
                expected: true,
            },
            "skip meta: new workdir commit": {
                status: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(new RepoStatus({
                                headCommit: "2",
                            }), RELATION.AHEAD),
                        }),
                    },
                }),
                skipMeta: true,
                subMessages: {},
                expected: false,
            },
            "skip meta: staged workdir change": {
                status: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(new RepoStatus({
                                headCommit: "1",
                                staged: {
                                    foo: FILESTATUS.ADDED,
                                },
                            }), RELATION.SAME),
                        }),
                    },
                }),
                skipMeta: true,
                subMessages: {
                    "foo": "meh",
                },
                expected: true,
            },
            "staged workdir change -- undefined subMessages": {
                status: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(new RepoStatus({
                                headCommit: "1",
                                staged: {
                                    foo: FILESTATUS.ADDED,
                                },
                            }), RELATION.SAME),
                        }),
                    },
                }),
                skipMeta: false,
                subMessages: undefined,
                expected: true,
            },
            "staged workdir change -- missing from subMessages": {
                status: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(new RepoStatus({
                                headCommit: "1",
                                staged: {
                                    foo: FILESTATUS.ADDED,
                                },
                            }), RELATION.SAME),
                        }),
                    },
                }),
                skipMeta: false,
                subMessages: {},
                expected: false,
            },
            "unstaged workdir change": {
                status: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(new RepoStatus({
                                headCommit: "1",
                                workdir: {
                                    foo: FILESTATUS.ADDED,
                                },
                            }), RELATION.SAME),
                        }),
                    },
                }),
                skipMeta: false,
                subMessages: {
                    "foo": "meh",
                },
                expected: false,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = Commit.shouldCommit(c.status,
                                                   c.skipMeta,
                                                   c.subMessages);
                assert.equal(result, c.expected);
            });
        });
    });

    describe("getCommitStatus", function () {
        // We don't need to test the raw status reading operations here; those
        // are tested elsewhere.  We just need to test that all the arguments
        // are read and handled properly.

        const base = new RepoStatus({
            currentBranchName: "master",
            headCommit: "1",
        });

        const cases = {
            "trivial": {
                state: "x=S",
                expected: base,
            },
            "trivial with options": {
                state: "x=S",
                expected: base,
                options: {
                    all: false,
                    showMetaChanges: true,
                    paths: [],
                },
            },
            "no meta": {
                state: "x=S:W foo=bar",
                expected: base,
            },
            "with meta": {
                state: "x=S:W foo=bar",
                options: {
                    showMetaChanges: true,
                },
                expected: base.copy({
                    workdir: { foo: FILESTATUS.ADDED },
                }),
            },
            "staged": {
                state: "x=S:I a=b",
                options: {
                    showMetaChanges: true,
                    all: true,
                },
                expected: base.copy({
                    staged: {
                        a: FILESTATUS.ADDED,
                    },
                }),
            },
            "without paths": {
                state: "x=S:I foo=bar,baz=bam",
                options: {
                    showMetaChanges: true,
                },
                expected: base.copy({
                    staged: {
                        foo: FILESTATUS.ADDED,
                        baz: FILESTATUS.ADDED,
                    },
                }),
            },
            "with paths": {
                state: "x=S:I foo/bar=bar,baz=bam",
                options: {
                    showMetaChanges: true,
                    paths: [ "foo" ],
                },
                expected: base.copy({
                    staged: {
                        "foo/bar": FILESTATUS.ADDED,
                    },
                    workdir: {
                        "baz": FILESTATUS.ADDED,
                    },
                }),
            },
            "without relative path": {
                state: "x=S:I foo/bar=bar,bar=bam",
                options: {
                    showMetaChanges: true,
                    paths: [ "bar" ],
                },
                expected: base.copy({
                    staged: {
                        "bar": FILESTATUS.ADDED,
                    },
                    workdir: {
                        "foo/bar": FILESTATUS.ADDED,
                    },
                }),
            },
            "with relative path": {
                state: "x=S:I foo/bar=bar,bar=bam",
                options: {
                    showMetaChanges: true,
                    paths: [ "bar" ],
                },
                workdir: "foo",
                expected: base.copy({
                    staged: {
                        "foo/bar": FILESTATUS.ADDED,
                    },
                    workdir: {
                        "bar": FILESTATUS.ADDED,
                    },
                }),
            },
            "without all": {
                state: "x=S:W README.md=88",
                options: {
                    showMetaChanges: true,
                },
                expected: base.copy({
                    workdir: {
                        "README.md": FILESTATUS.MODIFIED,
                    },
                }),
            },
            "with all": {
                state: "x=S:W README.md=88",
                options: {
                    showMetaChanges: true,
                    all: true,
                },
                expected: base.copy({
                    staged: {
                        "README.md": FILESTATUS.MODIFIED,
                    },
                }),
            },
            "sub staged": {
                state: "a=B|x=U:C3-2;Bmaster=3;Os I a=b",
                options: {
                    all: true,
                },
                expected:  new RepoStatus({
                    currentBranchName: "master",
                    headCommit: "3",
                    submodules: {
                        s: new Submodule({
                            commit: new Submodule.Commit("1", "a"),
                            index: new Submodule.Index("1", "a", SAME),
                            workdir: new Submodule.Workdir(new RepoStatus({
                                headCommit: "1",
                                staged: {
                                    a: FILESTATUS.ADDED,
                                },
                            }), SAME),
                        }),
                    },
                }),
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const w = yield RepoASTTestUtil.createMultiRepos(c.state);
                const x = w.repos.x;
                let  workdir = x.workdir();
                if (undefined !== c.workdir) {
                    workdir = path.join(workdir, c.workdir);
                }
                const result = yield Commit.getCommitStatus(x,
                                                            workdir,
                                                            c.options);
                assert.instanceOf(result, RepoStatus);
                const mappedResult = StatusUtil.remapRepoStatus(result,
                                                                w.commitMap,
                                                                w.urlMap);
                assert.deepEqual(mappedResult, c.expected);
            }));
        });
    });

    describe("commit", function () {
        function makeCommitter(doAll, message, subMessages) {
            return function (repos) {
                return committer(doAll, message, repos, subMessages);
            };
        }
        const cases = {
            "staged addition": {
                initial: "x=S:I a=b",
                doAll: true,
                message: "hello",
                expected: "x=S:Chello#x-1 a=b;Bmaster=x",
            },
            "staged addition, unstaged modification but all": {
                initial: "x=S:I a=b;W a=c",
                doAll: true,
                message: "message",
                expected: "x=S:Cx-1 a=c;Bmaster=x",
            },
            "staged deletion": {
                initial: "x=S:I README.md",
                doAll: true,
                message: "message",
                expected: "x=S:Cx-1 README.md;Bmaster=x",
            },
            "staged modification": {
                initial: "x=S:I README.md=yyy",
                doAll: false,
                message: "message",
                expected: "x=S:Cx-1 README.md=yyy;Bmaster=x",
            },
            "unstaged deletion, auto-stage": {
                initial: "x=S:W README.md",
                message: "message",
                doAll: true,
                expected: "x=S:Cx-1 README.md;Bmaster=x",
            },
            "unstaged modification, auto-stage": {
                initial: "x=S:W README.md=foo",
                message: "message",
                doAll: true,
                expected: "x=S:Cx-1 README.md=foo;Bmaster=x",
            },
            "new submodule": {
                initial: "a=S|x=S:I s=Sa:1",
                message: "message",
                doAll: false,
                expected: "x=S:Cx-1 s=Sa:1;Bmaster=x",
            },
            "deleted submodule": {
                initial: "a=S|x=U:I s",
                message: "message",
                doAll: false,
                expected: "x=U:Cx-2 s;Bmaster=x",
            },
            "changed submodule url": {
                initial: "b=Aq|a=S|x=U:I s=Sb:q",
                message: "message",
                doAll: false,
                expected: "x=U:Cx-2 s=Sb:q;Bmaster=x",
            },
            "staged change in submodule": {
                initial: "a=S|x=U:Os I u=v",
                doAll: false,
                message: "message",
                expected:
                    "x=U:Cx-2 s=Sa:s;Os Cs-1 u=v!H=s;Bmaster=x",
            },
            "wd change in submodule -- auto-stage": {
                initial: "a=S|x=U:Os W README.md=bar",
                message: "message",
                doAll: true,
                expected: `
x=U:Cx-2 s=Sa:s;Os Cs-1 README.md=bar!H=s;Bmaster=x`,
            },

            // Note that Git will put the first commit on branch `master`
            // without being asked to.  I don't think this behavior is onerous
            // enought to code around it; instead, we will account for it in
            // our test case.

            "new sub no commits, stage": {
                initial: "a=B|x=S:I s=Sa:;Os I q=r",
                doAll: false,
                message: "message",
                expected: `
x=E:Cx-1 s=Sa:s;I s=~;Os Cs q=r!*=master!Bmaster=s;Bmaster=x`,
            },
            "new sub with commits": {
                initial: "a=B|x=Ca:I s=S.:;Os Cz!H=z",
                doAll: false,
                message: "message",
                expected: `x=E:Cx-1 s=S.:z;Bmaster=x origin/master;I s=~`,
            },
            "staged commit in index undone in workdir": {
                initial: `
q=B:Cz-1;Bmaster=z|x=S:C2-1 s=Sq:1;I s=Sq:z,x=Sq:1;Bmaster=2;Os H=1`,
                doAll: false,
                message: "message",
                expected: `
x=E:Cx-2 x=Sq:1;Bmaster=x;I s=~,x=~`,
            },
            "staged change in submodule, mentioned": {
                initial: "a=S|x=U:Os I u=v",
                doAll: false,
                message: null,
                subMessages: {
                    s: "this message",
                },
                expected: "x=E:Os Cthis message#s-1 u=v!H=s",
            },
            "staged change in submodule with commit override": {
                initial: "a=S|x=U:Os I u=v",
                doAll: false,
                message: "message",
                subMessages: {
                    s: "this message",
                },
                expected:
                    "x=U:Cx-2 s=Sa:s;Os Cthis message#s-1 u=v!H=s;Bmaster=x",
            },
            "new commit in a submodule": {
                initial: "a=S|x=U:Ca-1;Bx=a;I s=Sa:a;Ba=a",
                message: "message",
                expected: "x=E:Cx-2 s=Sa:a;Bmaster=x;I s=~",
                doAll: false,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const manipulator = makeCommitter(c.doAll,
                                                  c.message,
                                                  c.subMessages);
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               c.expected,
                                                               manipulator,
                                                               c.fails);
            }));
        });
    });

    it("getCommitMetaData", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        const sig = NodeGit.Signature.now("me", "me@me");
        const id = yield repo.createCommitOnHead([], sig, sig, "the mess");
        const commit = yield repo.getCommit(id);
        const meta = Commit.getCommitMetaData(commit);
        assert.equal(meta.signature.name(), "me");
        assert.equal(meta.signature.email(), "me@me");
        assert.equal(meta.message, "the mess");
    }));

    describe("getSubmoduleAmendStatus", function () {
        // Will always use subrepo 's' in repo 'x'
        const cases = {
            "unchanged": {
                input: "a=B|x=U:C3-2;Bmaster=3",
                expected: {
                    status: new Submodule({
                        commit: new Submodule.Commit("1", "a"),
                        index: new Submodule.Index("1", "a", RELATION.SAME),
                    }),
                },
            },
            "re-removed": {
                input: "a=B|x=U:I s",
                expected: {},
            },
            "added in index": {
                input: "a=B|x=S:I s=Sa:1",
                expected: {
                    status: new Submodule({
                        commit: null,
                        index: new Submodule.Index("1", "a", null),
                    }),
                },
            },
            "added in commit": {
                input: "a=B|x=U",
                expected: {
                    status: new Submodule({
                        commit: null,
                        index: new Submodule.Index("1", "a", null),
                    }),
                },
            },
            "removed in index": {
                input: "a=B|x=U:C3-2;Bmaster=3;I s",
                expected: {
                    status: new Submodule({
                        commit: new Submodule.Commit("1", "a"),
                        index: null,
                    }),
                },
            },
            "new commit in index": {
                input: "a=B:Ca-1;Ba=a|x=U:C3-2;Bmaster=3;I s=Sa:a",
                expected: {
                    status: new Submodule({
                        commit: new Submodule.Commit("1", "a"),
                        index: new Submodule.Index("a", "a", RELATION.UNKNOWN),
                    }),
                },
            },
            "new commit in index open": {
                input: "a=B:Ca-1;Ba=a|x=U:C3-2;Bmaster=3;I s=Sa:a;Os",
                expected: {
                    status: new Submodule({
                        commit: new Submodule.Commit("1", "a"),
                        index: new Submodule.Index("a", "a", RELATION.AHEAD),
                        workdir: new Submodule.Workdir(new RepoStatus({
                            headCommit: "a",
                        }), RELATION.SAME),
                    }),
                },
            },
            "new commit in workdir": {
                input: "a=B:Ca-1;Ba=a|x=U:C3-2;Bmaster=3;Os H=a",
                expected: {
                    status: new Submodule({
                        commit: new Submodule.Commit("1", "a"),
                        index: new Submodule.Index("a", "a", RELATION.AHEAD),
                        workdir: new Submodule.Workdir(new RepoStatus({
                            headCommit: "a",
                        }), RELATION.SAME),
                    }),
                },
            },
            "simple amend": {
                input: "a=B:Chi#a-1;Ba=a|x=U:C3-2 s=Sa:a;Bmaster=3;Os",
                expected: {
                    status: new Submodule({
                        commit: new Submodule.Commit("1", "a"),
                        index: new Submodule.Index("1", "a", RELATION.SAME),
                        workdir: new Submodule.Workdir(new RepoStatus({
                            headCommit: "1",
                            staged: {
                                a: FILESTATUS.ADDED,
                            },
                        }), RELATION.SAME),
                    }),
                    oldMessage: "hi",
                },
            },
            "amend and unstaged": {
                input: `
a=B:Chi#a-1;Ba=a|x=U:C3-2 s=Sa:a;Bmaster=3;Os W README.md=888`,
                expected: {
                    status: new Submodule({
                        commit: new Submodule.Commit("1", "a"),
                        index: new Submodule.Index("1", "a", RELATION.SAME),
                        workdir: new Submodule.Workdir(new RepoStatus({
                            headCommit: "1",
                            staged: {
                                a: FILESTATUS.ADDED,
                            },
                            workdir: {
                                "README.md": FILESTATUS.MODIFIED,
                            },
                        }), RELATION.SAME),
                    }),
                    oldMessage: "hi",
                },
            },
            "amend and unstaged -- all": {
                input: `
a=B:Chi#a-1;Ba=a|x=U:C3-2 s=Sa:a;Bmaster=3;Os W README.md=888`,
                all: true,
                expected: {
                    status: new Submodule({
                        commit: new Submodule.Commit("1", "a"),
                        index: new Submodule.Index("1", "a", RELATION.SAME),
                        workdir: new Submodule.Workdir(new RepoStatus({
                            headCommit: "1",
                            staged: {
                                a: FILESTATUS.ADDED,
                                "README.md": FILESTATUS.MODIFIED,
                            },
                        }), RELATION.SAME),
                    }),
                    oldMessage: "hi",
                },
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written =
                               yield RepoASTTestUtil.createMultiRepos(c.input);
                const repos = written.repos;
                const repo = repos.x;
                const all = c.all || false;
                const allStatus = yield StatusUtil.getRepoStatus(repo);
                const status = allStatus.submodules.s;
                const head = yield repo.getHeadCommit();
                const parent = yield GitUtil.getParentCommit(repo, head);
                let oldSubs = {};
                if (null !== parent) {
                    oldSubs =
                      yield SubmoduleUtil.getSubmodulesForCommit(repo, parent);
                }
                const old = oldSubs.s || null;
                const getRepo = co.wrap(function *() {
                    return yield SubmoduleUtil.getRepo(repo, "s");
                });
                const result = yield Commit.getSubmoduleAmendStatus(status,
                                                                    old,
                                                                    getRepo,
                                                                    all);
                const expectedOld = c.expected.oldMessage || null;
                if (expectedOld === null) {
                    assert.isNull(result.oldCommit);
                }
                else {
                    assert.isNotNull(result.oldCommit);
                    assert.equal(result.oldCommit.message, expectedOld);
                }
                const expectedStatus = c.expected.status || null;
                if (null !== expectedStatus) {
                    assert.instanceOf(result.status, RepoStatus.Submodule);
                    const mapped = StatusUtil.remapSubmodule(result.status,
                                                             written.commitMap,
                                                             written.urlMap);
                    assert.deepEqual(mapped, expectedStatus);
                }
                else {
                    assert.isNull(result.status);
                }
            }));
        });
    });

    describe("getAmendStatus", function () {
        const cases = {
            "trivial": {
                state: "x=S",
                expected: {
                    status: new RepoStatus({
                        currentBranchName: "master",
                        headCommit: "1",
                    }),
                },
            },
            "include meta": {
                state: "x=S:C2-1;Bmaster=2;I a=b;W README.md=888",
                includeMeta: true,
                expected: {
                    status: new RepoStatus({
                        currentBranchName: "master",
                        headCommit: "2",
                        staged: {
                            a: FILESTATUS.ADDED,
                            "2": FILESTATUS.ADDED,
                        },
                        workdir: {
                            "README.md": FILESTATUS.MODIFIED,
                        },
                    }),
                },
            },
            "include meta, all": {
                state: "x=S:C2-1;Bmaster=2;I a=b;W README.md=888",
                includeMeta: true,
                all: true,
                expected: {
                    status: new RepoStatus({
                        currentBranchName: "master",
                        headCommit: "2",
                        staged: {
                            a: FILESTATUS.ADDED,
                            "2": FILESTATUS.ADDED,
                            "README.md": FILESTATUS.MODIFIED,
                        },
                    }),
                },
            },
            "sub, no amend": {
                state: "a=B|x=U:C3-2;Bmaster=3",
                expected: {
                    status: new RepoStatus({
                        currentBranchName: "master",
                        headCommit: "3",
                        submodules: {
                            s: new Submodule({
                                commit: new Submodule.Commit("1", "a"),
                                index: new Submodule.Index("1", "a", SAME),
                            }),
                        },
                    }),
                },
            },
            "sub, no amend, but changes": {
                state: "a=B|x=U:C3-2;Bmaster=3;Os I a=b!W README.md=4",
                expected: {
                    status: new RepoStatus({
                        currentBranchName: "master",
                        headCommit: "3",
                        submodules: {
                            s: new Submodule({
                                commit: new Submodule.Commit("1", "a"),
                                index: new Submodule.Index("1", "a", SAME),
                                workdir: new Submodule.Workdir(new RepoStatus({
                                    headCommit: "1",
                                    staged: {
                                        a: FILESTATUS.ADDED,
                                    },
                                    workdir: {
                                        "README.md": FILESTATUS.MODIFIED,
                                    },
                                }), SAME),
                            }),
                        },
                    }),
                },
            },
            "sub, no amend, but changes and all": {
                state: "a=B|x=U:C3-2;Bmaster=3;Os I a=b!W README.md=4",
                all: true,
                expected: {
                    status: new RepoStatus({
                        currentBranchName: "master",
                        headCommit: "3",
                        submodules: {
                            s: new Submodule({
                                commit: new Submodule.Commit("1", "a"),
                                index: new Submodule.Index("1", "a", SAME),
                                workdir: new Submodule.Workdir(new RepoStatus({
                                    headCommit: "1",
                                    staged: {
                                        a: FILESTATUS.ADDED,
                                        "README.md": FILESTATUS.MODIFIED,
                                    },
                                }), SAME),
                            }),
                        },
                    }),
                },
            },
            "reverted submodule": {
                state: "a=B|x=U:I s",
                expected: {
                    status: new RepoStatus({
                        currentBranchName: "master",
                        headCommit: "2",
                    }),
                },
            },
            "submodule to amend, but closed": {
                state: "a=B:Chi#a-1;Ba=a|x=U:C3-2 s=Sa:a;Bmaster=3",
                expected: {
                    status: new RepoStatus({
                        currentBranchName: "master",
                        headCommit: "3",
                        submodules: {
                            s: new Submodule({
                                commit: new Submodule.Commit("1", "a"),
                                index: new Submodule.Index("1", "a", SAME),
                                workdir: new Submodule.Workdir(new RepoStatus({
                                    headCommit: "1",
                                    staged: {
                                        a: FILESTATUS.ADDED,
                                    },
                                }), SAME),
                            }),
                        },
                    }),
                    toAmend: {
                        s: "hi",
                    },
                },
            },
            "submodule to amend": {
                state: "a=B:Chi#a-1;Ba=a|x=U:C3-2 s=Sa:a;Bmaster=3;Os",
                expected: {
                    status: new RepoStatus({
                        currentBranchName: "master",
                        headCommit: "3",
                        submodules: {
                            s: new Submodule({
                                commit: new Submodule.Commit("1", "a"),
                                index: new Submodule.Index("1", "a", SAME),
                                workdir: new Submodule.Workdir(new RepoStatus({
                                    headCommit: "1",
                                    staged: {
                                        a: FILESTATUS.ADDED,
                                    },
                                }), SAME),
                            }),
                        },
                    }),
                    toAmend: {
                        s: "hi",
                    },
                },
            },
            "submodule to amend without all": {
                state: "a=B:Chi#a-1;Ba=a|x=U:C3-2 s=Sa:a;Bmaster=3;Os W a=b",
                expected: {
                    status: new RepoStatus({
                        currentBranchName: "master",
                        headCommit: "3",
                        submodules: {
                            s: new Submodule({
                                commit: new Submodule.Commit("1", "a"),
                                index: new Submodule.Index("1", "a", SAME),
                                workdir: new Submodule.Workdir(new RepoStatus({
                                    headCommit: "1",
                                    staged: {
                                        a: FILESTATUS.ADDED,
                                    },
                                    workdir: {
                                        a: FILESTATUS.MODIFIED,
                                    },
                                }), SAME),
                            }),
                        },
                    }),
                    toAmend: {
                        s: "hi",
                    },
                },
            },
            "submodule to amend with all": {
                state: "a=B:Chi#a-1;Ba=a|x=U:C3-2 s=Sa:a;Bmaster=3;Os W a=b",
                all: true,
                expected: {
                    status: new RepoStatus({
                        currentBranchName: "master",
                        headCommit: "3",
                        submodules: {
                            s: new Submodule({
                                commit: new Submodule.Commit("1", "a"),
                                index: new Submodule.Index("1", "a", SAME),
                                workdir: new Submodule.Workdir(new RepoStatus({
                                    headCommit: "1",
                                    staged: {
                                        a: FILESTATUS.ADDED,
                                    },
                                }), SAME),
                            }),
                        },
                    }),
                    toAmend: {
                        s: "hi",
                    },
                },
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written =
                               yield RepoASTTestUtil.createMultiRepos(c.state);
                const repos = written.repos;
                const repo = repos.x;
                let cwd = c.cwd;
                if (undefined !== cwd) {
                    cwd = path.join(repo.workdir(), cwd);
                }
                const result = yield Commit.getAmendStatus(repo, {
                    all: c.all,
                    cwd: cwd,
                    includeMeta: c.includeMeta,
                });
                const mapped = StatusUtil.remapRepoStatus(result.status,
                                                          written.commitMap,
                                                          written.urlMap);
                assert.deepEqual(mapped, c.expected.status);
                let toAmend = {};
                for (let name in result.subsToAmend) {
                    toAmend[name] = result.subsToAmend[name].message;
                }
                const expectedToAmend = c.expected.toAmend || {};
                assert.deepEqual(toAmend, expectedToAmend);
            }));
        });
    });

    describe("amendRepo", function () {
        const cases = {
            "trivial": {
                input: "x=S",
                message: "foo",
                expected: `
x=N:Cfoo#x README.md=hello world;*=master;Bmaster=x`,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const amend = co.wrap(function *(repos) {
                    const repo = repos.x;
                    const newSha = yield Commit.amendRepo(repo, c.message);
                    const commitMap = {};
                    commitMap[newSha] = "x";
                    return { commitMap: commitMap };
                });
                yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                               c.expected,
                                                               amend,
                                                               c.fails);
            }));
        });
    });

    describe("amendMetaRepo", function () {
        // Most of the logic surrounding committing is handled in previously
        // tested codepaths.  We need to verify that it's all tied together
        // properly, that submodules are properly staged, and that when there
        // is no difference between the current state and the base commit, we
        // strip the last commit.

        // We'll use the repo `x` and name created commits as `am` for the
        // meta-repo and `a<sub name>` for commits in submodules.

        const cases = {
            "trivial": {
                input: "x=N:Cm#1;H=1",
                expected: "x=N:Cam 1=1;H=am",
            },
            "meta change": {
                input: "x=S:C2-1;Bmaster=2;I README.md=3",
                expected: "x=S:Cam-1 README.md=3,2=2;Bmaster=am",
            },
            "meta staged": {
                input: "x=S:C2-1;Bmaster=2;W README.md=3",
                expected: "x=S:Cam-1 README.md=3,2=2;Bmaster=am",
                all: true,
            },
            "repo with new sha in index": {
                input: "a=B:Ca-1;Bmaster=a|x=U:C3-2;I s=Sa:a;Bmaster=3",
                expected: "x=U:Cam-2 3=3,s=Sa:a;Bmaster=am",
            },
            "repo with new head in workdir": {
                input: "a=B:Ca-1;Bmaster=a|x=U:C3-2;Bmaster=3;Os H=a",
                expected: "x=U:Cam-2 3=3,s=Sa:a;Bmaster=am;Os",
            },
            "repo with staged workdir changes": {
                input: "a=B|x=U:C3-2;Bmaster=3;Os I x=x",
                expected: `x=U:Cam-2 3=3,s=Sa:as;Bmaster=am;Os Cas-1 x=x!H=as`,
            },
            "repo with unstaged workdir changes": {
                input: "a=B|x=U:C3-2;Bmaster=3;Os W README.md=3",
                expected: `
x=U:Cam-2 3=3,s=Sa:as;Bmaster=am;Os Cas-1 README.md=3!H=as`,
                all: true,
            },
            "repo with staged and unstaged workdir changes": {
                input: "a=B|x=U:C3-2;Bmaster=3;Os I a=b!W README.md=3",
                expected: `
x=U:Cam-2 3=3,s=Sa:as;Bmaster=am;Os Cas-1 a=b,README.md=3!H=as`,
                all: true,
            },
            "amended subrepo": {
                input: "a=B:Ca-1;Bx=a|x=U:C3-2 s=Sa:a;Bmaster=3;Os",
                message: "hi",
                expected: `
x=U:Chi#am-2 s=Sa:as;Bmaster=am;Os Chi#as-1 a=a!H=as`,
            },
            "amended subrepo with index change": {
                input: "a=B:Ca-1;Bx=a|x=U:C3-2 s=Sa:a;Bmaster=3;Os I q=4",
                message: "hi",
                expected: `
x=U:Chi#am-2 s=Sa:as;Bmaster=am;Os Chi#as-1 a=a,q=4!H=as`,
            },
            "amended subrepo with unstaged change": {
                input: `
a=B:Ca-1;Bx=a|x=U:C3-2 s=Sa:a;Bmaster=3;Os W README.md=2`,
                message: "hi",
                expected: `
x=U:Chi#am-2 s=Sa:as;Bmaster=am;Os Chi#as-1 a=a!H=as!W README.md=2`,
            },
            "amended subrepo with change to stage": {
                input: `
a=B:Ca-1;Bx=a|x=U:C3-2 s=Sa:a;Bmaster=3;Os W README.md=2`,
                message: "hi",
                expected: `
x=U:Chi#am-2 s=Sa:as;Bmaster=am;Os Chi#as-1 a=a,README.md=2!H=as`,
                all: true,
            },
            "strip submodule commit": {
                input: `
a=B:Ca-1;Bmaster=a|x=U:C3-2 s=Sa:a,3=3;Os I a;Bmaster=3`,
                message: "foo",
                expected: `x=U:Cfoo#am-2 3=3;Bmaster=am;Os`,
            },
            "strip submodule commit, leave untracked": {
                input: `
a=B:Ca-1;Bmaster=a|x=U:C3-2 s=Sa:a,3=3;Os I a!W x=y;Bmaster=3`,
                message: "foo",
                expected: `x=U:Cfoo#am-2 3=3;Bmaster=am;Os W x=y`,
            },
            "strip submodule commit, leave modified": {
                input: `
a=B:Ca-1;Bmaster=a|x=U:C3-2 s=Sa:a,3=3;Os I a!W README.md=2;Bmaster=3`,
                message: "foo",
                expected: `x=U:Cfoo#am-2 3=3;Bmaster=am;Os W README.md=2`,
            },
            "strip submodule commit unchange from index": {
                input: `
a=B:Ca-1;Cb-a a=9;Bmaster=b|x=U:C3-2 s=Sa:b,3=3;Os I a=a;Bmaster=3`,
                message: "foo",
                expected: `x=U:Cfoo#am-2 3=3,s=Sa:a;Bmaster=am;Os`
            },
            "not strip submodule commit unchange from workdir": {
                input: `
a=B:Ca-1;Cb-a a=9;Bmaster=b|x=U:C3-2 s=Sa:b,3=3;Os W a=a;Bmaster=3`,
                message: "foo",
                expected: `
x=U:Cfoo#am-2 3=3,s=Sa:as;Bmaster=am;Os Cfoo#as-a a=9!W a=a`
            },
            "strip submodule commit unchange from workdir, when all": {
                input: `
a=B:Ca-1;Cb-a a=9;Bmaster=b|x=U:C3-2 s=Sa:b,3=3;Os W a=a;Bmaster=3`,
                message: "foo",
                expected: `x=U:Cfoo#am-2 3=3,s=Sa:a;Bmaster=am;Os`,
                all: true,
            },
            "skipped meta repo": {
                input: "a=B:Ca-1;Bx=a|x=U:C3-2 s=Sa:a;Bmaster=3;Os",
                message: null,
                subMessages: {
                    s: "hi",
                },
                expected: `x=E:Os Chi#as-1 a=a!H=as`,
            },
            "skipped non-amend": {
                input: "a=B|x=U:C3-2;Bmaster=3;I q=r;Os I y=z;B3=3",
                subMessages: {},
                expected: "x=E:Cam-2 3=3,q=r;I q=~;Bmaster=am",
            },
            "non-amend with own message": {
                input: "a=B|x=U:C3-2;Bmaster=3;Os I y=z;B3=3",
                subMessages: {
                    s: "hola",
                },
                expected: `
x=E:Cam-2 3=3,s=Sa:as;Bmaster=am;Os Chola#as-1 y=z!H=as`,
            },
            "amended subrepo skipped with subMessage": {
                input: `
a=B:Ca-1;Bx=a|x=U:C3-2 s=Sa:a;Bmaster=3;Os;I foo=moo`,
                subMessages: {},
                message: "hi",
                expected: `
x=U:Chi#am-2 foo=moo,s=Sa:a;Bmaster=am;Os`,
            },
            "amended subrepo skipped with own message": {
                input: `
a=B:Ca-1;Bx=a|x=U:C3-2 s=Sa:a;Bmaster=3;Os;I foo=moo`,
                subMessages: {
                    s: "meh",
                },
                message: "hi",
                expected: `
x=U:Chi#am-2 foo=moo,s=Sa:as;Bmaster=am;Os Cmeh#as-1 a=a!H=as`,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const amender = co.wrap(function *(repos) {
                    const repo = repos.x;
                    const all = c.all || false;
                    const amend = yield Commit.getAmendStatus(repo, {
                        showMetaChanges: true,
                        all: all,
                        includeMeta: true,
                    });
                    const subsToAmend = Object.keys(amend.subsToAmend);
                    const subMessages = c.subMessages || null;
                    let message = "message";
                    if (undefined !== c.message) {
                        message = c.message;
                    }
                    const result = yield Commit.amendMetaRepo(repo,
                                                              amend.status,
                                                              subsToAmend,
                                                              all,
                                                              message,
                                                              subMessages);
                    const commitMap = {};
                    commitMap[result.meta] = "am";
                    Object.keys(result.subs).forEach(subName => {
                        commitMap[result.subs[subName]] = "a" + subName;
                    });
                    return { commitMap: commitMap, };
                });
                yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                               c.expected,
                                                               amender,
                                                               c.fails);
            }));
        });
    });
    describe("formatAmendSignature", function () {
        const sig = NodeGit.Signature.create("me", "me@me", 3, -60);
        const sigYouName = NodeGit.Signature.create("youName", "me@me", 4, 60);
        const sigYouEmail = NodeGit.Signature.create("me", "u@u", 5, 60);
        const cases = {
            "same": {
                current: sig,
                last: sig,
                expected: "Date:      12/31/1969, 23:00:03 -100\n\n",
            },
            "different": {
                current: sig,
                last: sigYouName,
                expected: `\
Author:    youName <me@me>
Date:      1/1/1970, 01:00:04 100

`,
            },
            "different email": {
                current: sig,
                last: sigYouEmail,
                expected: `\
Author:    me <u@u>
Date:      1/1/1970, 01:00:05 100

`,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = Commit.formatAmendSignature(c.current, c.last);
                const resultLines = result.split("\n");
                const expectedLines = c.expected.split("\n");
                assert.deepEqual(resultLines, expectedLines);
            });
        });
    });

    describe("formatAmendEditorPrompt", function () {
        // Mostly, this method chains some other methods together.  We just
        // need to do a couple of tests to validate that things are hooked up,
        // and that it omits the author when it's unchanged between the current
        // and previous signatures.

        const sig = NodeGit.Signature.create("me", "me@me", 3, -60);
        const last = new Commit.CommitMetaData(sig, "my message");
        const cases = {
            "change to meta": {
                status: new RepoStatus({
                    currentBranchName: "a-branch",
                    staged: {
                        "bam/baz": FILESTATUS.ADDED,
                    },
                }),
                currentSig: sig,
                lastCommitData: last,
                expected: `\
my message
# Please enter the commit message for your changes. Lines starting
# with '#' will be ignored, and an empty message aborts the commit.
#
# Date:      12/31/1969, 23:00:03 -100
#
# On branch a-branch.
# Changes to be committed:
# \tnew file:     bam/baz
#
`,
            },
            "different cwd": {
                status: new RepoStatus({
                    currentBranchName: "a-branch",
                    staged: {
                        "bam/baz": FILESTATUS.ADDED,
                    },
                }),
                currentSig: sig,
                lastCommitData: last,
                cwd: "bam",
                expected: `\
my message
# Please enter the commit message for your changes. Lines starting
# with '#' will be ignored, and an empty message aborts the commit.
#
# Date:      12/31/1969, 23:00:03 -100
#
# On branch a-branch.
# Changes to be committed:
# \tnew file:     baz
#
`,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const cwd = c.cwd || "";
                const result = Commit.formatAmendEditorPrompt(c.currentSig,
                                                              c.lastCommitData,
                                                              c.status,
                                                              cwd);

                const resultLines = result.split("\n");
                const expectedLines = c.expected.split("\n");
                assert.deepEqual(resultLines, expectedLines);
            });
        });
    });

    describe("calculatePathCommitStatus", function () {
        const cases = {
            "trivial": {
                cur: new RepoStatus(),
                req: new RepoStatus(),
                exp: new RepoStatus(),
            },
            "no cur": {
                cur: new RepoStatus(),
                req: new RepoStatus({
                    staged: { foo: FILESTATUS.ADDED },
                }),
                exp: new RepoStatus({
                    staged: { foo: FILESTATUS.ADDED },
                }),
            },
            "no cur, from workdir": {
                cur: new RepoStatus(),
                req: new RepoStatus({
                    workdir: { foo: FILESTATUS.MODIFIED },
                }),
                exp: new RepoStatus({
                    staged: { foo: FILESTATUS.MODIFIED },
                }),
            },
            "no cur, ignore added": {
                cur: new RepoStatus(),
                req: new RepoStatus({
                    workdir: { foo: FILESTATUS.ADDED },
                }),
                exp: new RepoStatus(),
            },
            "no requested": {
                cur: new RepoStatus({
                    staged: { foo: FILESTATUS.MODIFIED },
                }),
                req: new RepoStatus(),
                exp: new RepoStatus({
                    workdir: { foo: FILESTATUS.MODIFIED },
                }),
            },
            "requested overrides": {
                cur:  new RepoStatus({
                    staged: {
                        foo: FILESTATUS.MODIFIED,
                        ugh: FILESTATUS.ADDED,
                    },
                    workdir: {
                        bar: FILESTATUS.MODIFIED,
                        baz: FILESTATUS.REMOVED,
                    },
                }),
                req: new RepoStatus({
                    staged: { foo: FILESTATUS.ADDED },
                    workdir: { bar: FILESTATUS.MODIFIED },
                }),
                exp: new RepoStatus({
                    staged: {
                        foo: FILESTATUS.ADDED,
                        bar: FILESTATUS.MODIFIED,
                    },
                    workdir: {
                        ugh: FILESTATUS.ADDED,
                        baz: FILESTATUS.REMOVED,
                    },
                }),
            },
            "in a sub, no cur": {
                cur: new RepoStatus({
                    submodules: {
                        s: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(new RepoStatus({
                                headCommit: "1",
                            }), RELATION.SAME),
                        }),
                    },
                }),
                req: new RepoStatus({
                    submodules: {
                        s: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(new RepoStatus({
                                headCommit: "1",
                                staged: { foo: FILESTATUS.ADDED },
                            }), RELATION.SAME),
                        }),
                    },
                }),
                exp: new RepoStatus({
                    submodules: {
                        s: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(new RepoStatus({
                                headCommit: "1",
                                staged: { foo: FILESTATUS.ADDED },
                            }), RELATION.SAME),
                        }),
                    },
                }),
            },
            "unrequested sub": {
                cur: new RepoStatus({
                    submodules: {
                        xxx: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(new RepoStatus({
                                headCommit: "1",
                                staged: {
                                    xxx: FILESTATUS.MODIFIED,
                                },
                            }), RELATION.SAME),
                        }),
                    },
                }),
                req: new RepoStatus(),
                exp: new RepoStatus({
                    submodules: {
                        xxx: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(new RepoStatus({
                                headCommit: "1",
                                workdir: {
                                    xxx: FILESTATUS.MODIFIED,
                                },
                            }), RELATION.SAME),
                        }),
                    },
                }),
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = Commit.calculatePathCommitStatus(c.cur, c.req);
                assert.deepEqual(result, c.exp);
            });
        });
    });

    describe("writeRepoPaths", function () {

        // Will apply commit to repo `x` and name the created commit `x`.
        const cases = {
            "simple staged change": {
                state: "x=S:I README.md=haha",
                fileChanges: {
                    "README.md": FILESTATUS.MODIFIED,
                },
                expected: "x=S:Cx-1 README.md=haha;Bmaster=x",
            },
            "simple workdir change": {
                state: "x=S:W README.md=haha",
                fileChanges: { "README.md": FILESTATUS.MODIFIED, },
                expected: "x=S:Cx-1 README.md=haha;Bmaster=x",
            },
            "simple change with message": {
                state: "x=S:I README.md=haha",
                fileChanges: { "README.md": FILESTATUS.MODIFIED, },
                expected: "x=S:Chello world#x-1 README.md=haha;Bmaster=x",
                message: "hello world",
            },
            "added file": {
                state: "x=S:W q=3",
                fileChanges: { "q": FILESTATUS.ADDED },
                expected: "x=S:Cx-1 q=3;Bmaster=x",
            },
            "added two files, but mentioned only one": {
                state: "x=S:W q=3,r=4",
                fileChanges: { "q": FILESTATUS.ADDED },
                expected: "x=S:Cx-1 q=3;W r=4;Bmaster=x",
            },
            "staged a change and didn't mention it": {
                state: "x=S:W q=3;I r=4",
                fileChanges: { "q": FILESTATUS.ADDED },
                expected: "x=S:Cx-1 q=3;I r=4;Bmaster=x",
            },
            "staged a change and did mention it": {
                state: "x=S:W q=3;I r=4",
                fileChanges: {
                    "q": FILESTATUS.ADDED,
                    "r": FILESTATUS.ADDED,
                },
                expected: "x=S:Cx-1 q=3,r=4;Bmaster=x",
            },
            "deep path": {
                state: "x=S:W a/b/c=2",
                fileChanges: {
                    "a/b/c": FILESTATUS.ADDED,
                },
                expected: "x=S:Cx-1 a/b/c=2;Bmaster=x",
            },
            "submodule": {
                state: "a=B:Ca-1;Bm=a|x=U:I s=Sa:a",
                subChanges: ["s"],
                expected: "x=E:Cx-2 s=Sa:a;Bmaster=x;I s=~",
            },
            "submodule in workdir": {
                state: "a=B:Ca-1;Bm=a|x=U:Os H=a",
                subChanges: ["s"],
                expected: "x=E:Cx-2 s=Sa:a;Bmaster=x",
            },
            "ignored a sub": {
                state: "a=B:Ca-1;Bm=a|x=U:Os H=a;W foo=bar",
                fileChanges: {
                    "foo": FILESTATUS.ADDED,
                },
                subChanges: [],
                expected: "x=E:Cx-2 foo=bar;Bmaster=x;W foo=~",
            },
            "deep sub": {
                state: `
a=B:Ca-1;Bm=a|
x=S:C2-1 q/r/s=Sa:1;Bmaster=2;Oq/r/s H=a`,
                subChanges: ["q/r/s"],
                expected: "x=E:Cx-2 q/r/s=Sa:a;Bmaster=x",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            const writer = co.wrap(function *(repos) {
                const repo = repos.x;
                let status = yield StatusUtil.getRepoStatus(repo);
                const message = c.message || "message";
                const subChanges = c.subChanges || [];
                const subs = {};
                const submodules = status.submodules;
                subChanges.forEach(subName => {
                    subs[subName] = submodules[subName];
                });
                status = status.copy({
                    staged: c.fileChanges || {},
                    submodules: subs,
                });
                const result = yield Commit.writeRepoPaths(repo,
                                                           status,
                                                           message);
                const commitMap = {};
                commitMap[result] = "x";
                return { commitMap: commitMap, };

            });
            it(caseName, co.wrap(function *() {
                yield RepoASTTestUtil.testMultiRepoManipulator(c.state,
                                                               c.expected,
                                                               writer,
                                                               c.fails);
            }));
        });
    });

    describe("commitPaths", function () {
        // Most of the logic here is delegated to the previously tested method
        // 'writeRepo'.

        const cases = {
            "one file": {
                state: "x=S:C2-1 x=y;W x=q;Bmaster=2",
                paths: ["x"],
                expected: "x=E:Cx-2 x=q;W x=~;Bmaster=x",
            },
            "skip a file": {
                state: "x=S:C2-1 x=y;I a=b;W x=q;Bmaster=2",
                paths: ["x"],
                expected: "x=E:Cx-2 x=q;W x=~;Bmaster=x",
            },
            "files in a tree": {
                state: "x=S:I x/y=2,x/z=3,y/r=4",
                paths: ["x"],
                expected: "x=E:Cx-1 x/y=2,x/z=3;I x/y=~,x/z=~;Bmaster=x"
            },
            "files in a submodule": {
                state: "a=B:Ca-1;Bm=a|x=U:Os I q=r",
                paths: ["s"],
                expected: "x=E:Cx-2 s=Sa:s;Os Cs-1 q=r!H=s;Bmaster=x",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const committer = co.wrap(function *(repos) {
                    const repo = repos.x;
                    const status = yield Commit.getCommitStatus(
                                                              repo,
                                                              repo.workdir(), {
                        showMetaChanges: true,
                        paths: c.paths,
                    });
                    const message = c.message || "message";
                    const result = yield Commit.commitPaths(repo,
                                                            status,
                                                            message);
                    const commitMap = {};
                    commitMap[result.metaCommit] = "x";
                    Object.keys(result.submoduleCommits).forEach(name => {
                        const sha = result.submoduleCommits[name];
                        commitMap[sha] = name;
                    });
                    return { commitMap: commitMap };
                });
                yield RepoASTTestUtil.testMultiRepoManipulator(c.state,
                                                               c.expected,
                                                               committer,
                                                               c.fails);
            }));
        });
    });

    describe("areSubmodulesIncompatibleWithPathCommits", function () {
        const cases = {
            "trivial": {
                input: new RepoStatus(),
                expected: false,
            },
            "good submodule": {
                input: new RepoStatus({
                    submodules: {
                        x: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                        }),
                    },
                }),
                expected: false,
            },
            "new sub": {
                input: new RepoStatus({
                    submodules: {
                        x: new Submodule({
                            index: new Submodule.Index(null, "/a", null),
                        }),
                    },
                }),
                expected: true,
            },
            "removed sub": {
                input: new RepoStatus({
                    submodules: {
                        x: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                        }),
                    },
                }),
                expected: true,
            },
            "new URL": {
                input: new RepoStatus({
                    submodules: {
                        x: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/b",
                                                       RELATION.SAME),
                        }),
                    },
                }),
                expected: true,
            },
            "new index commit": {
                input: new RepoStatus({
                    submodules: {
                        x: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("2",
                                                       "/a",
                                                       RELATION.AHEAD),
                            workdir: new Submodule.Workdir(new RepoStatus({
                                headCommit: "2",
                                staged: {
                                    q: FILESTATUS.ADDED,
                                },
                            }), RELATION.SAME)
                        }),
                    },
                }),
                expected: true,
            },
            "new index commit, workdir change": {
                input: new RepoStatus({
                    submodules: {
                        x: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("2",
                                                       "/a",
                                                       RELATION.AHEAD),
                            workdir: new Submodule.Workdir(new RepoStatus({
                                headCommit: "2",
                                workdir: {
                                    q: FILESTATUS.MODIFIED,
                                },
                            }), RELATION.SAME)
                        }),
                    },
                }),
                expected: false,
            },
            "new workdir commit": {
                input: new RepoStatus({
                    submodules: {
                        x: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(new RepoStatus({
                                headCommit: "2",
                                staged: {
                                    q: FILESTATUS.ADDED,
                                },
                            }), RELATION.AHEAD),
                        }),
                    },
                }),
                expected: true,
            },
            "bad and good submodule": {
                input: new RepoStatus({
                    submodules: {
                        x: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                        }),
                        y: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/b",
                                                       RELATION.SAME),
                        }),
                    },
                }),
                expected: true,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result =
                      Commit.areSubmodulesIncompatibleWithPathCommits(c.input);
                assert.equal(result, c.expected);
            });
        });
    });

    describe("calculateAllStatus", function () {
        const cases = {
            "trivial": {
                staged: {},
                workdir: {},
                expected: {
                    staged: {},
                    workdir: {},
                },
            },
            "ignore normal staged": {
                staged: { foo: FILESTATUS.ADDED, },
                workdir: {},
                expected: {
                    staged: {},
                    workdir: {},
                },
            },
            "ignore normal workdir": {
                staged: { foo: FILESTATUS.ADDED, },
                workdir: {},
                expected: {
                    staged: {},
                    workdir: {},
                },
            },
            "copy workdir mod": {
                staged: {},
                workdir: {
                    foo: FILESTATUS.MODIFIED,
                },
                expected: {
                    staged: {
                        foo: FILESTATUS.MODIFIED,
                    },
                    workdir: {},
                },
            },
            "added and staged": {
                staged: {
                    bar: FILESTATUS.ADDED,
                },
                workdir: {
                    bar: FILESTATUS.ADDED,
                },
                expected: {
                    staged: {
                        bar: FILESTATUS.ADDED,
                    },
                    workdir: {},
                },
            },
            "added but not staged": {
                staged: {},
                workdir: {
                    foo: FILESTATUS.ADDED,
                },
                expected: {
                    staged: {},
                    workdir: {
                        foo: FILESTATUS.ADDED,
                    },
                },
            },
        };
        Object.keys(cases).forEach(caseName => {
            it(caseName, function () {
                const c = cases[caseName];
                const result = Commit.calculateAllStatus(c.staged, c.workdir);
                assert.deepEqual(result, c.expected);
            });
        });
    });

    describe("calculateAllRepoStatus", function () {
        // We don't need to test the logic already tested in
        // `calculateAllStatus` here, just that we call it correctly and
        // properly assemble the sub-parts, e.g., the submodules.

        const cases = {
            "trivial": {
                normal: new RepoStatus(),
                toWorkdir: new RepoStatus(),
                expected: new RepoStatus(),
            },
            "read correctly from staged": {
                normal: new RepoStatus({
                    staged: { foo: FILESTATUS.ADDED, },
                }),
                toWorkdir: new RepoStatus(),
                expected: new RepoStatus(),
            },
            "read correctly from workdir": {
                normal: new RepoStatus(),
                toWorkdir: new RepoStatus({
                    workdir: {
                        foo: FILESTATUS.MODIFIED,
                    },
                }),
                expected: new RepoStatus({
                    staged: {
                        foo: FILESTATUS.MODIFIED,
                    },
                }),
            },

            // We don't need to retest the logic exhaustively with submodules,
            // just that closed submodules are handled and that the basic logic
            // is correctly applied to open submodules.

            "with a submodule": {
                normal: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                        }),
                    },
                }),
                toWorkdir: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                        }),
                    },
                }),
                expected: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                        }),
                    },
                }),
            },
            "with a submodule with untracked changes": {
                normal: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(
                                new RepoStatus({
                                    headCommit: "1",
                                }),
                                RELATION.SAME
                            ),
                        }),
                    },
                }),
                toWorkdir: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(
                                new RepoStatus({
                                    headCommit: "1",
                                    workdir: {
                                        foo: FILESTATUS.ADDED,
                                    },
                                }),
                                RELATION.SAME
                            ),
                        }),
                    },
                }),
                expected: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(
                                new RepoStatus({
                                    headCommit: "1",
                                    workdir: {
                                        foo: FILESTATUS.ADDED,
                                    },
                                }),
                                RELATION.SAME
                            ),
                        }),
                    },
                }),
            },
            "with a submodule with changes to stage": {
                normal: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(
                                new RepoStatus({
                                    headCommit: "1",
                                }),
                                RELATION.SAME
                            ),
                        }),
                    },
                }),
                toWorkdir: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(
                                new RepoStatus({
                                    headCommit: "1",
                                    workdir: {
                                        foo: FILESTATUS.MODIFIED,
                                    },
                                }),
                                RELATION.SAME
                            ),
                        }),
                    },
                }),
                expected: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(
                                new RepoStatus({
                                    headCommit: "1",
                                    staged: {
                                        foo: FILESTATUS.MODIFIED,
                                    },
                                }),
                                RELATION.SAME
                            ),
                        }),
                    },
                }),
            },
        };
        Object.keys(cases).forEach(caseName => {
            it(caseName, function () {
                const c = cases[caseName];
                const result = Commit.calculateAllRepoStatus(c.normal,
                                                             c.toWorkdir);
                assert.deepEqual(result, c.expected);
            });
        });
    });

    describe("removeSubmoduleChanges", function () {
        const cases = {
            "trivial": {
                input: new RepoStatus(),
                expected: new RepoStatus(),
            },
            "some data in base": {
                input: new RepoStatus({
                    headCommit: "1",
                    currentBranchName: "foo",
                }),
                expected: new RepoStatus({
                    headCommit: "1",
                    currentBranchName: "foo",
                }),
            },
            "closed sub": {
                input: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                        }),
                    },
                }),
                expected: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                        }),
                    },
                }),
            },
            "open and unchanged": {
                input: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(
                                new RepoStatus({
                                    headCommit: "1",
                                }),
                                RELATION.SAME
                            ),
                        }),
                    },
                }),
                expected: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(
                                new RepoStatus({
                                    headCommit: "1",
                                }),
                                RELATION.SAME
                            ),
                        }),
                    },
                }),
            },
            "open and changed": {
                input: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(
                                new RepoStatus({
                                    headCommit: "1",
                                    staged: { foo: FILESTATUS.ADDED },
                                    workdir: { bar: FILESTATUS.MODIFIED },
                                }),
                                RELATION.SAME
                            ),
                        }),
                    },
                }),
                expected: new RepoStatus({
                    submodules: {
                        foo: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(
                                new RepoStatus({
                                    headCommit: "1",
                                }),
                                RELATION.SAME
                            ),
                        }),
                    },
                }),
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = Commit.removeSubmoduleChanges(c.input);
                assert.deepEqual(result, c.expected);
            });
        });
    });

    describe("formatSplitCommitEditorPrompt", function () {
        // Here, we don't need to test the details of formatting that are
        // tested elsewhere, just that we pull it all together, including,
        // especially

        const sig = NodeGit.Signature.create("me", "me@me", 3, -60);

        const cases = {
            // This case couldn't actually be used to generate a commit, but it
            // is the simplest case.

            "just on a branch": {
                input: new RepoStatus({
                    currentBranchName: "master",
                }),
                expected: `\

# <*> enter meta-repo message above this line; delete to commit only submodules
# On branch master.
#
# Please enter the commit message(s) for your changes.  The message for a
# repo will be composed of all lines not beginning with '#' that come before
# its tag, but after any other tag (or the beginning of the file).  Tags are
# lines beginning with '# <sub-repo-name>', or '# <*>' for the meta-repo.
# If the tag for a repo is removed, no commit will be generated for that repo.
# If you do not provide a commit message for a sub-repo, the commit
# message for the meta-repo will be used.
`,
            },
            "with commit meta data": {
                input: new RepoStatus({
                    currentBranchName: "master",
                }),
                metaCommitData: new Commit.CommitMetaData(sig, "hiya"),
                expected: `\
hiya
# <*> enter meta-repo message above this line; delete to commit only submodules
# Date:      12/31/1969, 23:00:03 -100
#
# On branch master.
#
# Please enter the commit message(s) for your changes.  The message for a
# repo will be composed of all lines not beginning with '#' that come before
# its tag, but after any other tag (or the beginning of the file).  Tags are
# lines beginning with '# <sub-repo-name>', or '# <*>' for the meta-repo.
# If the tag for a repo is removed, no commit will be generated for that repo.
# If you do not provide a commit message for a sub-repo, the commit
# message for the meta-repo will be used.
`,
            },
            "changes to the meta": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    staged: {
                        baz: FILESTATUS.ADDED,
                    },
                }),
                expected: `\

# <*> enter meta-repo message above this line; delete to commit only submodules
# On branch foo.
# Changes to be committed:
# \tnew file:     baz
#
# Please enter the commit message(s) for your changes.  The message for a
# repo will be composed of all lines not beginning with '#' that come before
# its tag, but after any other tag (or the beginning of the file).  Tags are
# lines beginning with '# <sub-repo-name>', or '# <*>' for the meta-repo.
# If the tag for a repo is removed, no commit will be generated for that repo.
# If you do not provide a commit message for a sub-repo, the commit
# message for the meta-repo will be used.
`,
            },
            "sub-repo with staged change": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    submodules: {
                        bar: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("2",
                                                       "/a",
                                                       RELATION.AHEAD),
                        }),
                    },
                }),
                expected: `\

# <*> enter meta-repo message above this line; delete to commit only submodules
# On branch foo.
# Changes to be committed:
# \tmodified:     bar (submodule, new commits)
#
# Please enter the commit message(s) for your changes.  The message for a
# repo will be composed of all lines not beginning with '#' that come before
# its tag, but after any other tag (or the beginning of the file).  Tags are
# lines beginning with '# <sub-repo-name>', or '# <*>' for the meta-repo.
# If the tag for a repo is removed, no commit will be generated for that repo.
# If you do not provide a commit message for a sub-repo, the commit
# message for the meta-repo will be used.
`,
            },
            "sub-repo with just unstaged changes": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    submodules: {
                        bar: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(
                                new RepoStatus({
                                    headCommit: "1",
                                    workdir: {
                                        foo: FILESTATUS.MODIFIED,
                                    },
                                }),
                                RELATION.SAME
                            ),
                        }),
                    },
                }),
                expected: `\

# <*> enter meta-repo message above this line; delete to commit only submodules
# On branch foo.
#
# Please enter the commit message(s) for your changes.  The message for a
# repo will be composed of all lines not beginning with '#' that come before
# its tag, but after any other tag (or the beginning of the file).  Tags are
# lines beginning with '# <sub-repo-name>', or '# <*>' for the meta-repo.
# If the tag for a repo is removed, no commit will be generated for that repo.
# If you do not provide a commit message for a sub-repo, the commit
# message for the meta-repo will be used.
`,
            },
            "sub-repo with staged changes": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    submodules: {
                        bar: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(
                                new RepoStatus({
                                    headCommit: "1",
                                    staged: {
                                        foo: FILESTATUS.MODIFIED,
                                    },
                                }),
                                RELATION.SAME
                            ),
                        }),
                    },
                }),
                expected: `\

# <*> enter meta-repo message above this line; delete to commit only submodules
# On branch foo.
# -----------------------------------------------------------------------------

# <bar> enter message for 'bar' above this line; delete this line to skip \
committing 'bar'
# Changes to be committed:
# \tmodified:     foo
#
# Please enter the commit message(s) for your changes.  The message for a
# repo will be composed of all lines not beginning with '#' that come before
# its tag, but after any other tag (or the beginning of the file).  Tags are
# lines beginning with '# <sub-repo-name>', or '# <*>' for the meta-repo.
# If the tag for a repo is removed, no commit will be generated for that repo.
# If you do not provide a commit message for a sub-repo, the commit
# message for the meta-repo will be used.
`,
            },
            "sub-repo with staged changes and meta data": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    submodules: {
                        bar: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(
                                new RepoStatus({
                                    headCommit: "1",
                                    staged: {
                                        foo: FILESTATUS.MODIFIED,
                                    },
                                }),
                                RELATION.SAME
                            ),
                        }),
                    },
                }),
                subCommitData: {
                    bar: new Commit.CommitMetaData(sig, "yoyoyo"),
                },
                expected: `\

# <*> enter meta-repo message above this line; delete to commit only submodules
# On branch foo.
# -----------------------------------------------------------------------------
yoyoyo
# <bar> enter message for 'bar' above this line; delete this line to skip \
committing 'bar'
# If this sub-repo is skipped, it will not be amended and the original commit
# will be used.
# Date:      12/31/1969, 23:00:03 -100
#
# Changes to be committed:
# \tmodified:     foo
#
# Please enter the commit message(s) for your changes.  The message for a
# repo will be composed of all lines not beginning with '#' that come before
# its tag, but after any other tag (or the beginning of the file).  Tags are
# lines beginning with '# <sub-repo-name>', or '# <*>' for the meta-repo.
# If the tag for a repo is removed, no commit will be generated for that repo.
# If you do not provide a commit message for a sub-repo, the commit
# message for the meta-repo will be used.
`,
            },
            "sub-repo with staged changes and meta data, dupe meta message": {
                input: new RepoStatus({
                    currentBranchName: "foo",
                    submodules: {
                        bar: new Submodule({
                            commit: new Submodule.Commit("1", "/a"),
                            index: new Submodule.Index("1",
                                                       "/a",
                                                       RELATION.SAME),
                            workdir: new Submodule.Workdir(
                                new RepoStatus({
                                    headCommit: "1",
                                    staged: {
                                        foo: FILESTATUS.MODIFIED,
                                    },
                                }),
                                RELATION.SAME
                            ),
                        }),
                    },
                }),
                metaCommitData: new Commit.CommitMetaData(sig, "yoyoyo"),
                subCommitData: {
                    bar: new Commit.CommitMetaData(sig, "yoyoyo"),
                },
                expected: `\
yoyoyo
# <*> enter meta-repo message above this line; delete to commit only submodules
# Date:      12/31/1969, 23:00:03 -100
#
# On branch foo.
# -----------------------------------------------------------------------------

# <bar> enter message for 'bar' above this line; delete this line to skip \
committing 'bar'
# If this sub-repo is skipped, it will not be amended and the original commit
# will be used.
# Date:      12/31/1969, 23:00:03 -100
#
# Changes to be committed:
# \tmodified:     foo
#
# Please enter the commit message(s) for your changes.  The message for a
# repo will be composed of all lines not beginning with '#' that come before
# its tag, but after any other tag (or the beginning of the file).  Tags are
# lines beginning with '# <sub-repo-name>', or '# <*>' for the meta-repo.
# If the tag for a repo is removed, no commit will be generated for that repo.
# If you do not provide a commit message for a sub-repo, the commit
# message for the meta-repo will be used.
`,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const currentSig = c.currentSignature || sig;
                const metaCommitData = c.metaCommitData || null;
                const subCommitData = c.subCommitData || {};
                const result = Commit.formatSplitCommitEditorPrompt(
                                                                c.input,
                                                                currentSig,
                                                                metaCommitData,
                                                                subCommitData);
                const resultLines = result.split("\n");
                const expectedLines = c.expected.split("\n");
                assert.deepEqual(resultLines, expectedLines);
            });
        });
    });

    describe("parseSplitCommitMessages", function () {
        const cases = {
            "trivial": {
                input: "",
                expected: {
                    metaMessage: null,
                    subMessages: {},
                },
            },
            "some meta": {
                input: `\
# just thinking
This is my commit.

and a little more.
# but not this

# or this
# <*>
`,
                expected: {
                    metaMessage: `\
This is my commit.

and a little more.
`,
                    subMessages: {},
                },
            },
            "tag with trail": {
                input: `\
my message
# <*> trailing stuff
`,
                expected: {
                    metaMessage: `my message\n`,
                    subMessages: {},
                },
            },
            "just a sub": {
                input: `\


hello sub
# <my-sub>
`,
                expected: {
                    metaMessage: null,
                    subMessages: {
                        "my-sub": `\
hello sub
`,
                    },
                },
            },
            "double sub": {
                input: `\
# <sub>
# <sub>
`,
                fails: true,
            },
            "sub, no meta": {
                input: "# <sub>\n",
                expected: {
                    metaMessage: null,
                    subMessages: {},
                },
            },
            "inherited sub message": {
                input: `\
meta message
# <*>
# <a-sub>
`,
                expected: {
                    metaMessage: "meta message\n",
                    subMessages: {
                        "a-sub": "meta message\n",
                    },
                },
            },
            "mixed": {
                input: `\
# intro
my meta message
# <*>

my a message
# <a>

# hmm
# <b>

this is for c
# <c>

and for d
# <d>
`,
                expected: {
                    metaMessage: "my meta message\n",
                    subMessages: {
                        a: "my a message\n",
                        b: "my meta message\n",
                        c: "this is for c\n",
                        d: "and for d\n",
                    },
                },
            },
            "empty meta": {
                input: "# <*> meta meta\n",
                fails: true,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                let result;
                try {
                    result = Commit.parseSplitCommitMessages(c.input);
                }
                catch (e) {
                    if (c.fails && (e instanceof UserError)) {
                        return;                                       // RETURN
                    }
                    throw e;
                }
                assert(!c.fails, "should fail");
                assert.deepEqual(result, c.expected);
            });
        });
    });
    describe("doCommitCommand", function () {
        // We don't need to retest core functionality, but we do need to ensure
        // that all flags are passed through and/or handled appropriately.

        const cases = {
            "nothing to commit": {
                initial: "x=S",
            },
            "no meta, no commit": {
                initial: "x=S:I a=b",
                meta: false,
            },
            "meta commit": {
                initial: "x=S:I a=b",
                message: "foo",
                expected: "x=S:Cfoo#x-1 a=b;Bmaster=x",
            },
            "meta commit, with editor": {
                initial: "x=S:I a=b",
                editor: () => Promise.resolve("haha"),
                expected: "x=S:Chaha\n#x-1 a=b;Bmaster=x",
            },
            "no all": {
                initial: "x=S:W README.md=2",
            },
            "all": {
                initial: "x=S:W README.md=2",
                all: true,
                message: "foo",
                expected: "x=S:Cfoo#x-1 README.md=2;Bmaster=x",
            },
            "paths, cwd": {
                initial: "x=S:I a/b=b,b=d",
                message: "foo",
                paths: ["b"],
                cwd: "a",
                expected: "x=S:Cfoo#x-1 a/b=b;I b=d;Bmaster=x",
            },
            "uncommitable": {
                initial: "a=B|x=S:I a=Sa:;Oa",
                message: "foo",
                fails: true,
            },
            "not path-compatible": {
                initial: "x=S:I s=S.:1,a=b",
                message: "foo",
                paths: ["a"],
                fails: true,
            },
            "interactive": {
                initial: "a=B|x=U:Os I a=b",
                interactive: true,
                editor: () => Promise.resolve(`\
foo
# <*>
bar
# <s>
`),
                expected: `
x=U:Cfoo\n#x-2 s=Sa:s;Os Cbar\n#s-1 a=b!H=s;Bmaster=x`,
            },
            "interactive, no commit": {
                initial: "a=B|x=U:Os I a=b",
                interactive: true,
                editor: () => Promise.resolve(""),
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            const doCommit = co.wrap(function *(repos) {
                const repo = repos.x;
                let cwd = "";
                if (undefined !== c.cwd) {
                    cwd = path.join(repo.workdir(), c.cwd);
                }
                else {
                    cwd = repo.workdir();
                }
                const editor = c.editor || (() => {
                    assert(false, "no editor");
                });
                const meta = undefined === c.meta ? true : false;
                const result = yield Commit.doCommitCommand(
                                                        repo,
                                                        cwd,
                                                        c.message || null,
                                                        meta,
                                                        c.all || false,
                                                        c.paths || [],
                                                        c.interactive || false,
                                                        editor);
                if (undefined !== result) {
                    return {
                        commitMap: mapCommitResult(result),
                    };
                }
            });
            it(caseName, co.wrap(function *() {
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               c.expected,
                                                               doCommit,
                                                               c.fails);
            }));
        });
    });
});
