/*
 * Copyright (c) 2017, Two Sigma Open Source
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

const DiffUtil        = require("../../lib/util/diff_util");
const GitUtil         = require("../../lib/util/git_util");
const RepoStatus      = require("../../lib/util/repo_status");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");

describe("DiffUtil", function () {
    describe("convertDeltaFlags", function () {
        const DELTA = NodeGit.Diff.DELTA;
        const FILESTATUS = RepoStatus.FILESTATUS;
        const cases = {
            "modified": {
                input: DELTA.MODIFIED,
                expected: FILESTATUS.MODIFIED,
            },
            "added": {
                input: DELTA.ADDED,
                expected: FILESTATUS.ADDED,
            },
            "deleted": {
                input: DELTA.DELETED,
                expected: FILESTATUS.REMOVED,
            },
            "renamed": {
                input: DELTA.RENAMED,
                expected: FILESTATUS.RENAMED,
            },
            "typechange": {
                input: DELTA.TYPECHANGE,
                expected: FILESTATUS.TYPECHANGED,
            },
            "untracked": {
                input: DELTA.UNTRACKED,
                expected: FILESTATUS.ADDED,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = DiffUtil.convertDeltaFlag(c.input);
                assert.equal(result, c.expected);
            });
        });
    });

    describe("getRepoStatus", function () {
        const FILESTATUS = RepoStatus.FILESTATUS;
        const cases = {
            "trivial": {
                input: "x=S",
            },
            "conflict ignored": {
                input: "x=S:I *READMEmd=a*b*c",
            },
            "index - modified": {
                input: "x=S:I README.md=hhh",
                staged: { "README.md": FILESTATUS.MODIFIED },
            },
            "index - modified deep": {
                input: "x=S:C2 x/y/z=a;I x/y/z=b;H=2",
                staged: { "x/y/z": FILESTATUS.MODIFIED },
            },
            "index - added": {
                input: "x=S:I x=y",
                staged: { x: FILESTATUS.ADDED },
            },
            "index - added deep": {
                input: "x=S:I x/y=y",
                staged: { "x/y": FILESTATUS.ADDED },
            },
            "index - removed": {
                input: "x=S:I README.md",
                staged: { "README.md": FILESTATUS.REMOVED},
            },
            "index - removed deep": {
                input: "x=S:C2 x/y/z=a;I x/y/z;H=2",
                staged: { "x/y/z": FILESTATUS.REMOVED},
            },
            "workdir - modified": {
                input: "x=S:W README.md=hhh",
                workdir: { "README.md": FILESTATUS.MODIFIED },
            },
            "workdir - modified deep": {
                input: "x=S:C2 x/y/z=a;W x/y/z=b;H=2",
                workdir: { "x/y/z": FILESTATUS.MODIFIED },
            },
            "workdir - added": {
                input: "x=S:W x=y",
                workdir: { x: FILESTATUS.ADDED },
            },
            "workdir - added deep": {
                input: "x=S:W x/y=y",
                workdir: { "x/": FILESTATUS.ADDED },
            },
            "workdir - added deep all untracked": {
                input: "x=S:W x/y=y",
                untrackedFilesOption: DiffUtil.UNTRACKED_FILES_OPTIONS.ALL,
                workdir: { "x/y": FILESTATUS.ADDED },
            },
            "workdir - removed": {
                input: "x=S:W README.md",
                workdir: { "README.md": FILESTATUS.REMOVED},
            },
            "workdir - removed deep": {
                input: "x=S:C2 x/y/z=a;W x/y/z;H=2",
                workdir: { "x/y/z": FILESTATUS.REMOVED},
            },
            "modified workdir and index": {
                input: "x=S:I README.md=aaa;W README.md=bbb",
                staged: { "README.md": FILESTATUS.MODIFIED },
                workdir: { "README.md": FILESTATUS.MODIFIED },
            },
            "modified workdir and index -a": {
                input: "x=S:I README.md=aaa;W README.md=bbb",
                workdir: { "README.md": FILESTATUS.MODIFIED },
                workdirToTree: true,
            },
            "added index, rm workdir": {
                input: "x=S:I x=y;W x",
                staged: { x: FILESTATUS.ADDED, },
                workdir: { x: FILESTATUS.REMOVED },
            },
            "added index, rm workdir -a": {
                input: "x=S:I x=y;W x",
                workdirToTree: true,
            },
            "modified index, rm workdir": {
                input: "x=S:I README.md=3;W README.md",
                staged: { "README.md": FILESTATUS.MODIFIED },
                workdir: { "README.md": FILESTATUS.REMOVED },
            },
            "modified index, rm workdir, -a": {
                input: "x=S:I README.md=3;W README.md",
                workdir: { "README.md": FILESTATUS.REMOVED },
                workdirToTree: true,
            },
            "index path restriction": {
                input: "x=S:I README.md=aaa,foo=a",
                paths: [ "foo" ],
                staged: { foo: FILESTATUS.ADDED },
            },
            "index dir path": {
                input: "x=S:I x/y/z=foo,x/r/z=bar,README.md",
                paths: [ "x" ],
                staged: {
                    "x/y/z": FILESTATUS.ADDED,
                    "x/r/z": FILESTATUS.ADDED
                },
            },
            "index dir paths": {
                input: "x=S:I x/y/z=foo,x/r/z=bar,README.md",
                paths: [ "x/y", "x/r" ],
                staged: {
                    "x/y/z": FILESTATUS.ADDED,
                    "x/r/z": FILESTATUS.ADDED
                },
            },
            "index all paths": {
                input: "x=S:I x/y/z=foo,x/r/z=bar,README.md",
                paths: [ "x/y/z", "x/r/z", "README.md" ],
                staged: {
                    "x/y/z": FILESTATUS.ADDED,
                    "x/r/z": FILESTATUS.ADDED,
                    "README.md": FILESTATUS.REMOVED,
                },
            },
            "workdir path restriction": {
                input: "x=S:W README.md=aaa,foo=a",
                paths: [ "foo" ],
                workdir: { foo: FILESTATUS.ADDED },
            },
            "workdir dir path": {
                input: "x=S:W x/y/z=foo,x/r/z=bar,README.md",
                paths: [ "x" ],
                untrackedFilesOption: DiffUtil.UNTRACKED_FILES_OPTIONS.ALL,
                workdir: {
                    "x/y/z": FILESTATUS.ADDED,
                    "x/r/z": FILESTATUS.ADDED
                },
            },
            "workdir dir paths": {
                input: "x=S:W x/y/z=foo,x/r/z=bar,README.md",
                paths: [ "x/y", "x/r" ],
                untrackedFilesOption: DiffUtil.UNTRACKED_FILES_OPTIONS.ALL,
                workdir: {
                    "x/y/z": FILESTATUS.ADDED,
                    "x/r/z": FILESTATUS.ADDED
                },
            },
            "workdir all paths": {
                input: "x=S:W x/y/z=foo,x/r/z=bar,README.md",
                paths: [ "x/y/z", "x/r/z", "README.md" ],
                untrackedFilesOption: DiffUtil.UNTRACKED_FILES_OPTIONS.ALL,
                workdir: {
                    "x/y/z": FILESTATUS.ADDED,
                    "x/r/z": FILESTATUS.ADDED,
                    "README.md": FILESTATUS.REMOVED,
                },
            },
            "many changes": {
                input: `
x=S:C2 a/b=c,a/c=d,t=u;H=2;I a/b,a/q=r,f=x;W a/b=q,a/c=f,a/y=g,f`,
                untrackedFilesOption: DiffUtil.UNTRACKED_FILES_OPTIONS.ALL,
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
                input: `
x=S:C2 a/b=c,a/c=d,t=u;H=2;I a/b,a/q=r,f=x;W a/b=q,a/c=f,a/y=g,f`,
                untrackedFilesOption: DiffUtil.UNTRACKED_FILES_OPTIONS.ALL,
                paths: ["f"],
                workdir: {
                    "f": FILESTATUS.REMOVED,
                },
                staged: {
                    "f": FILESTATUS.ADDED,
                },
            },
            "from null tree": {
                input: "x=S",
                staged: { "README.md": FILESTATUS.ADDED},
                from: null,
            },
            "from null added": {
                input: "x=S:W foo=bar",
                staged: { "README.md": FILESTATUS.ADDED},
                workdir: { foo: FILESTATUS.ADDED },
                from: null,
            },
            "HEAD^ modified, not all": {
                input: "x=S:C2-1;W README.md=3;Bmaster=2",
                staged: { "2": FILESTATUS.ADDED },
                workdir: { "README.md": FILESTATUS.MODIFIED },
                from: "HEAD^",
            },
            "HEAD^ staged modified": {
                input: "x=S:C2-1;W README.md=3;Bmaster=2",
                staged: { "2": FILESTATUS.ADDED },
                workdir: { "README.md": FILESTATUS.MODIFIED },
                untrackedFilesOption: DiffUtil.UNTRACKED_FILES_OPTIONS.ALL,
                from: "HEAD^",
            },
            "HEAD^ changed in index": {
                input: "x=S:C2-1;I README.md=3;Bmaster=2",
                staged: {
                    "2": FILESTATUS.ADDED,
                    "README.md": FILESTATUS.MODIFIED,
                },
                from: "HEAD^",
            },
            "HEAD^ changed in index and workdir": {
                input: "x=S:C2-1;I README.md=3;W README.md=45;Bmaster=2",
                staged: {
                    "2": FILESTATUS.ADDED,
                    "README.md": FILESTATUS.MODIFIED,
                },
                workdir: {
                    "README.md": FILESTATUS.MODIFIED,
                },
                from: "HEAD^",
            },
            "HEAD^ added in index": {
                input: "x=S:C2-1;I foo=3;Bmaster=2",
                staged: {
                    "2": FILESTATUS.ADDED,
                    "foo": FILESTATUS.ADDED,
                },
                from: "HEAD^",
            },
            "HEAD^ removed in index": {
                input: "x=S:C2-1;I README.md;Bmaster=2",
                staged: {
                    "2": FILESTATUS.ADDED,
                    "README.md": FILESTATUS.REMOVED,
                },
                from: "HEAD^",
            },
            "HEAD^ removed in index with all": {
                input: "x=S:C2-1;I README.md;Bmaster=2",
                staged: {
                    "2": FILESTATUS.ADDED,
                    "README.md": FILESTATUS.REMOVED,
                },
                untrackedFilesOption: DiffUtil.UNTRACKED_FILES_OPTIONS.ALL,
                from: "HEAD^",
            },
            "HEAD^ removed in workdir": {
                input: "x=S:C2-1;W README.md;Bmaster=2",
                staged: {
                    "2": FILESTATUS.ADDED,
                },
                workdir: {
                    "README.md": FILESTATUS.REMOVED,
                },
                from: "HEAD^",
            },
            "HEAD^ removed in workdir with all": {
                input: "x=S:C2-1;W README.md;Bmaster=2",
                staged: {
                    "2": FILESTATUS.ADDED,
                },
                workdir: {
                    "README.md": FILESTATUS.REMOVED,
                },
                untrackedFilesOption: DiffUtil.UNTRACKED_FILES_OPTIONS.ALL,
                from: "HEAD^",
            },
            "HEAD^ ignore submodule add": {
                input: `
a=B:Ca-1;Bmaster=a|
x=S:C2-1 s=Sa:1;Bmaster=2`,
                staged: {
                    ".gitmodules": FILESTATUS.ADDED,
                },
                from: "HEAD^",
            },
            "HEAD^ ignore submodule change": {
                input: `
a=B:Ca-1;Bmaster=a|
x=S:C2-1 s=Sa:1;C3-2 s=Sa:a;Bmaster=3`,
                from: "HEAD^",
            },
            "HEAD^ ignore submodule deletion": {
                input: `
a=B:Ca-1;Bmaster=a|
x=S:C2-1 s=Sa:1;C3-2 s;Bmaster=3`,
                staged: {
                    ".gitmodules": FILESTATUS.REMOVED,
                },
                from: "HEAD^",
            },
            "HEAD^ unmodified": {
                input: `
x=S:C2-1 README.md=3;I README.md=hello world;W README.md=hello world;
Bmaster=2`,
                workdirToTree: true,
                from: "HEAD^",
            },
            "HEAD^ changed in index, rm'd in workdir": {
                input: "x=S:C2-1;I README.md=3;W README.md;Bmaster=2",
                staged: {
                    "2": FILESTATUS.ADDED,
                    "README.md": FILESTATUS.MODIFIED
                },
                workdir: {
                    "README.md": FILESTATUS.REMOVED,
                },
                from: "HEAD^",
            },
            "HEAD^ changed in index, rm'd in workdir, all": {
                input: "x=S:C2-1;I README.md=3;W README.md;Bmaster=2",
                workdir: {
                    "2": FILESTATUS.ADDED,
                    "README.md": FILESTATUS.REMOVED,
                },
                workdirToTree: true,
                from: "HEAD^",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written =
                               yield RepoASTTestUtil.createMultiRepos(c.input);
                const repos = written.repos;
                const repo = repos.x;
                let tree = null;
                let fromCommit = null;
                if (undefined === c.from) {
                    fromCommit = "HEAD";
                }
                else {
                    fromCommit = c.from;
                }
                if (null !== fromCommit) {
                    const annotated =
                              yield GitUtil.resolveCommitish(repo, fromCommit);
                    assert.isNotNull(annotated, `bad commit ${fromCommit}`);
                    const commit = yield repo.getCommit(annotated.id());
                    const treeId = commit.treeId();
                    tree = yield NodeGit.Tree.lookup(repo, treeId);
                }
                const result = yield DiffUtil.getRepoStatus(
                    repo,
                    tree,
                    c.paths || [],
                    c.workdirToTree || false,
                    c.untrackedFilesOption ||
                        DiffUtil.UNTRACKED_FILES_OPTIONS.NORMAL);
                const expected = {
                    staged: c.staged || {},
                    workdir: c.workdir || {},
                };
                assert.deepEqual(result.staged, expected.staged, "staged");
                assert.deepEqual(result.workdir, expected.workdir, "workdir");
            }));
        });
    });

});
