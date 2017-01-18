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
const co     = require("co");

const Commit          = require("../../lib/util/commit");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");
const RepoStatus      = require("../../lib/util/repo_status");
const Status          = require("../../lib/util/status");


// We'll always commit the repo named 'x'.  If a new commit is created ni the
// meta-repo, it will be named 'x'.  New commits created in sub-repos will be
// identified as their submodule name.

const committer = co.wrap(function *(doAll, message, repos) {
    const x = repos.x;
    const status = yield Status.getRepoStatus(x);
    const result = yield Commit.commit(x, doAll, status, message);
    if (null === result) {
        return undefined;                                             // RETURN
    }
    let commitMap = {};
    commitMap[result.metaCommit] = "x";
    Object.keys(result.submoduleCommits).forEach(subName => {
        const newCommit = result.submoduleCommits[subName];
        commitMap[newCommit] = subName;
    });
    return {
        commitMap: commitMap,
    };
});

describe("Commit", function () {
    const FILESTATUS = RepoStatus.FILESTATUS;
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

# Please enter the commit message for your changes. Lines starting
# with '#' will be ignored, and an empty message aborts the commit.
# On branch master.
# Changes to be committed:
# \tnew file:     foo
#
# Changes not staged for commit:
# \tmodified:     bar
#
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

# Please enter the commit message for your changes. Lines starting
# with '#' will be ignored, and an empty message aborts the commit.
# On branch master.
# Changes to be committed:
# \tnew file:     foo
#
# Untracked files:
# \tbar
#
`,
            },
            "workdir rollup": {
                status: new RepoStatus({
                    currentBranchName: "master",
                    workdir: {
                        "bar": FILESTATUS.MODIFIED,
                    },
                }),
                all: true,
                expected: `\

# Please enter the commit message for your changes. Lines starting
# with '#' will be ignored, and an empty message aborts the commit.
# On branch master.
# Changes to be committed:
# \tmodified:     bar
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

    describe("commit", function () {
        function makeCommitter(doAll, message) {
            return function (repos, maps) {
                return committer(doAll, message, repos, maps);
            };
        }
        const cases = {
            "simple nothing": {
                initial: "x=S",
                doAll: false,
                message: "",
                expected: {},
            },
            "nothing with all": {
                initial: "x=S",
                doAll: true,
                message: "",
                expected: {},
            },
            "staged addition": {
                initial: "x=S:I a=b",
                doAll: true,
                message: "hello",
                expected: "x=S:Chello#x-1 a=b;Bmaster=x",
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
            "unstaged addition": {
                initial: "x=S:W a=b",
                message: "foo",
                doAll: false,
                expected: {},
            },
            "unstaged addition, auto-stage": {
                initial: "x=S:W a=b",
                message: "foo",
                doAll: true,
                expected: {},
            },
            "unstaged deletion": {
                initial: "x=S:W README.md",
                message: "foo",
                doAll: false,
                expected: {},
            },
            "unstaged deletion, auto-stage": {
                initial: "x=S:W README.md",
                message: "message",
                doAll: true,
                expected: "x=S:Cx-1 README.md;Bmaster=x",
            },
            "unstaged modification": {
                initial: "x=S:W README.md=foo",
                message: "foo",
                doAll: false,
                expected: {},
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
            "wd change in submodule": {
                initial: "a=S|x=U:Os W README.md=bar",
                message: "foo",
                doAll: false,
                expected: {},
            },
            "wd change in submodule -- auto-stage": {
                initial: "a=S|x=U:Os W README.md=bar",
                message: "message",
                doAll: true,
                expected: `
x=U:Cx-2 s=Sa:s;Os Cs-1 README.md=bar!H=s;Bmaster=x`,
            },
            "wd addition in submodule -- auto-stage": {
                initial: "a=S|x=U:Os W foo=baz",
                message: "foo",
                doAll: true,
                expected: {},
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const manipulator = makeCommitter(c.doAll, c.message);
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               c.expected,
                                                               manipulator,
                                                               c.fails);
            }));
        });
    });
});
