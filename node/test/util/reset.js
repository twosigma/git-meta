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
const fs      = require("fs-promise");
const NodeGit = require("nodegit");
const path    = require("path");

const Reset               = require("../../lib/util/reset");
const RepoASTTestUtil     = require("../../lib/util/repo_ast_test_util");
const SparseCheckoutUtil  = require("../../lib/util/sparse_checkout_util");
const SubmoduleChange     = require("../../lib/util/submodule_change");
const SubmoduleConfigUtil = require("../../lib/util/submodule_config_util");
const SubmoduleUtil       = require("../../lib/util/submodule_util");

describe("reset", function () {
    describe("resetMetaRepo", function () {
        const cases = {
            "noop": {
                input: "x=S",
                to: "1",
            },
            "another": {
                input: "x=S:C2-1;Bfoo=2",
                to: "2",
                expected: "x=E:I 2=2;W 2",
            },
            "a sub": {
                input: "a=B:Ca-1;Ba=a|x=U:C3 s=Sa:a;Bfoo=3",
                to: "3",
                expected: "x=E:I s=Sa:a,README.md;W README.md=hello world",
            },
            "a new sub": {
                input: "a=B|x=S:C2-1 s=Sa:1;Bfoo=2",
                to: "2",
                expected: "x=E:I s=Sa:1",
            },
            "removed a sub": {
                input: "a=B|x=U:C3-2 s;Bfoo=3",
                to: "3",
                expected: "x=E:I s",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            const updateHead = co.wrap(function *(repos, maps) {
                const repo = repos.x;
                const rev = maps.reverseCommitMap;
                const index = yield repo.index();
                const commit = yield repo.getCommit(rev[c.to]);
                const head = yield repo.getHeadCommit();
                const headTree = yield head.getTree();
                const commitTree = yield commit.getTree();
                const diff = yield NodeGit.Diff.treeToTree(repo,
                                                           headTree,
                                                           commitTree,
                                                           null);
                const changes =
                   yield SubmoduleUtil.getSubmoduleChangesFromDiff(diff, true);

                yield Reset.resetMetaRepo(repo, index, commit, changes);
                yield index.write();
                const fromWorkdir =
                      yield SubmoduleConfigUtil.getSubmodulesFromWorkdir(repo);
                const fromIndex =
                 yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, index);
                assert.deepEqual(fromIndex, fromWorkdir);
            });
            it(caseName, co.wrap(function *() {
                yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                               c.expected,
                                                               updateHead);

            }));
        });
        it("does a mixed and non-mixed reset", co.wrap(function *() {
            const input = "a=B|x=S:C2-1 s=Sa:1;Bmaster=2";
            const maps = yield RepoASTTestUtil.createMultiRepos(input);
            const repo = maps.repos.x;
            const index = yield repo.index();

            let fromWorkdir =
                yield SubmoduleConfigUtil.getSubmodulesFromWorkdir(repo);
            assert.equal(1, Object.keys(fromWorkdir).length);
            let fromIndex =
                yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, index);
            assert.equal(1, Object.keys(fromIndex).length);

            const rev = maps.reverseCommitMap;
            const commit = yield repo.getCommit(rev["1"]);
            const head = yield repo.getHeadCommit();
            const headTree = yield head.getTree();
            const commitTree = yield commit.getTree();
            const diff = yield NodeGit.Diff.treeToTree(repo,
                                                       headTree,
                                                       commitTree,
                                                       null);
            const changes =
                  yield SubmoduleUtil.getSubmoduleChangesFromDiff(diff, true);

            yield Reset.resetMetaRepo(repo, index, commit, changes, true);

            fromWorkdir =
                yield SubmoduleConfigUtil.getSubmodulesFromWorkdir(repo);
            assert.equal(1, Object.keys(fromWorkdir).length);
            fromIndex =
                yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, index);
            assert.equal(0, Object.keys(fromIndex).length);

            yield Reset.resetMetaRepo(repo, index, commit, changes, false);

            fromWorkdir =
                yield SubmoduleConfigUtil.getSubmodulesFromWorkdir(repo);
            assert.equal(0, Object.keys(fromWorkdir).length);
            fromIndex =
                yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, index);
            assert.equal(0, Object.keys(fromIndex).length);

        }));
        it("submodule directory is cleaned up", co.wrap(function *() {
            const written = yield RepoASTTestUtil.createRepo(
                                                            "U:C3-2 s;Bfoo=3");
            const repo = written.repo;
            const rev = written.oldCommitMap;
            const index = yield repo.index();
            const commit = yield repo.getCommit(rev["3"]);
            const changes = {
                s: new SubmoduleChange(rev["1"], null, null),
            };
            yield Reset.resetMetaRepo(repo, index, commit, changes);
            let exists = true;
            try {
                yield fs.stat(path.join(repo.workdir(), "s"));
            } catch (e) {
                exists = false;
            }
            assert.equal(false, exists);
        }));
        it("no directory creatd in sparse mode", co.wrap(function *() {
            const written = yield RepoASTTestUtil.createRepo(
                                                      "S:C2-1 s=S/a:1;Bfoo=2");
            const repo = written.repo;
            yield SparseCheckoutUtil.setSparseMode(repo);
            const rev = written.oldCommitMap;
            const index = yield repo.index();
            const commit = yield repo.getCommit(rev["2"]);
            const changes = {
                s: new SubmoduleChange(null, rev["1"], null),
            };
            yield Reset.resetMetaRepo(repo, index, commit, changes);
            let exists = true;
            try {
                yield fs.stat(path.join(repo.workdir(), "s"));
            } catch (e) {
                exists = false;
            }
            assert.equal(false, exists);
        }));
   });
    describe("reset", function () {

        // We are deferring the actual reset logic to NodeGit, so we are not
        // testing the reset logic itself.  What we need to validate is that we
        // invoke `NodeGit.Reset` properly, and that we propagate the call to
        // submodules.

        const TYPE = Reset.TYPE;
        const cases = {
            "trivial soft": {
                initial: "x=S",
                to: "1",
                type: TYPE.SOFT,
            },
            "trivial mixed": {
                initial: "x=S",
                to: "1",
                type: TYPE.MIXED,
            },
            "trivial hard": {
                initial: "x=S",
                to: "1",
                type: TYPE.HARD,
            },
            "hard with commit in sub": {
                initial: "a=B:Ca-1;Ba=a|x=U:Os H=a",
                expected: "x=U:Os",
                to: "2",
                type: TYPE.HARD,
            },
            "unchanged sub-repo not open": {
                initial: "a=B|x=U:C4-2 t=Sa:1;Bfoo=4",
                to: "4",
                type: TYPE.HARD,
                expected: "x=E:Bmaster=4"
            },
            "hard changed sub-repo not open": {
                initial: "a=B:Ca-1 y=x;Bfoo=a|x=U:C4-2 s=Sa:a;Bfoo=4",
                to: "4",
                type: TYPE.HARD,
                expected: "x=E:Bmaster=4"
            },
            "changed sub-repo open": {
                initial: "a=B:Ca-1 y=x;Bfoo=a|x=U:C4-2 s=Sa:a;Bfoo=4;Os",
                to: "4",
                type: TYPE.HARD,
                expected: "x=E:Bmaster=4;Os"
            },
            "changed sub-repo open, with local changes": {
                initial: "a=B:Ca-1 y=x;Bfoo=a|x=U:C4-2 s=Sa:a;Bfoo=4;Os W y=q",
                to: "4",
                type: TYPE.HARD,
                expected: "x=E:Bmaster=4;Os"
            },
            "multiple changed sub-repos open": {
                initial: `
a=B:Ca-1 y=x;Bfoo=a|x=U:C3-2 t=Sa:1;C4-3 s=Sa:a,t=Sa:a;Bfoo=4;Bmaster=3;Os;Ot`,
                to: "4",
                type: TYPE.HARD,
                expected: "x=E:Bmaster=4;Os;Ot"
            },
            "soft in sub": {
                initial: "a=B:Ca-1;Bmaster=a|x=U:C3-2 s=Sa:a;Bmaster=3;Bf=3",
                to: "2",
                type: TYPE.SOFT,
                expected: "x=E:Os H=1!I a=a;Bmaster=2",
            },
            "soft in sub, already open": {
                initial: `
a=B:Ca-1;Bmaster=a|x=U:C3-2 s=Sa:a;Bmaster=3;Bf=3;Os`,
                to: "2",
                type: TYPE.SOFT,
                expected: "x=E:Os H=1!I a=a;Bmaster=2",
            },
            "merge should do as HARD but not refuse": {
                initial: `a=B|x=U:Os W README.md=888`,
                to: "1",
                type: TYPE.MERGE,
                expected: "x=S",
            },
            "soft, submodule with changes should not refuse": {
                initial: `a=B|x=U:Os W README.md=888;Bfoo=2`,
                to: "1",
                expected: "x=E:Bmaster=1;I s=Sa:1",
                type: TYPE.SOFT,
            },
            "submodule with unchanged head but changes": {
                initial: "a=B|x=U:Os W README.md=888",
                to: "2",
                type: TYPE.HARD,
                expected: "x=E:Os",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const resetter = co.wrap(function *(repos, maps) {
                    const commitId = maps.reverseCommitMap[c.to];
                    const repo = repos.x;
                    const commit = yield repo.getCommit(commitId);
                    yield Reset.reset(repo, commit, c.type);
                });
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               c.expected,
                                                               resetter,
                                                               c.fails);
            }));
        });
    });
    describe("resetPaths", function () {
        const cases = {
            "nothing to do": {
                initial: "x=S",
                commit: "1",
                paths: [],
            },
            "direct, but nothing": {
                initial: "x=S",
                commit: "1",
                paths: [ "README.md" ],
            },
            "reset from another commit": {
                initial: "x=S:C2-1 README.md=8;Bfoo=2;I README.md=3",
                commit: "2",
                paths: [ "README.md" ],
                fails: true,
            },
            "in submodule": {
                initial: "a=B|x=U:Os I README.md=88",
                commit: "2",
                paths: [ "s" ],
                expected: "x=E:Os W README.md=88",
            },
            "in submodule, relative": {
                initial: "a=B|x=U:Os I README.md=88",
                commit: "2",
                paths: [ "README.md" ],
                cwd: "s",
                expected: "x=E:Os W README.md=88",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const resetter = co.wrap(function *(repos, maps) {
                    const commitId = maps.reverseCommitMap[c.commit];
                    const repo = repos.x;
                    const commit = yield repo.getCommit(commitId);
                    let cwd = repo.workdir();
                    if (undefined !== c.cwd) {
                        cwd = path.join(cwd, c.cwd);
                    }
                    yield Reset.resetPaths(repo, cwd, commit, c.paths);
                });
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               c.expected,
                                                               resetter,
                                                               c.fails);
           }));
        });
    });
});
