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
const fs     = require("fs-promise");
const NodeGit   = require("nodegit");
const os     = require("os");
const path   = require("path");

const GitUtil             = require("../../lib/util/git_util");
const RepoASTTestUtil     = require("../../lib/util/repo_ast_test_util");
const ShorthandParserUtil = require("../../lib/util/shorthand_parser_util");
const TestUtil            = require("../../lib/util/test_util");
const UserError           = require("../../lib/util/user_error");
const WriteRepoASTUtil    = require("../../lib/util/write_repo_ast_util");

describe("GitUtil", function () {
    after(TestUtil.cleanup);

    describe("createBranchFromHead", function () {
        const brancher = co.wrap(function *(repo) {
            const newBranch = yield GitUtil.createBranchFromHead(repo, "foo");
            assert.equal("foo", newBranch.shorthand());
        });
        const cases = {
            "from master": { i: "S", e: "S:Bfoo=1"},
            "detached": { i: "S:*=", e: "S:*=;Bfoo=1"},
        };
        Object.keys(cases).forEach(caseName => {
            it(caseName, co.wrap(function *() {
                const c = cases[caseName];
                yield RepoASTTestUtil.testRepoManipulator(c.i, c.e, brancher);
            }));
        });
    });

    describe("findBranch", function () {
        const cases = {
            trivial: { i: "S", b: "master", f: true, },
            missed : { i: "S", b: "foo", f: false, },
            different: { i: "S:Bfoo=1", b: "foo", f: true },
            differentMiss: { i: "S:Bfoo=1", b: "baz", f: false },
        };
        Object.keys(cases).forEach(caseName => {
            it(caseName, co.wrap(function *() {
                const c = cases[caseName];
                const path = yield TestUtil.makeTempDir();
                const ast = ShorthandParserUtil.parseRepoShorthand(c.i);
                const repo =
                            (yield WriteRepoASTUtil.writeRAST(ast, path)).repo;
                const branch = yield GitUtil.findBranch(repo, c.b);
                if (!c.f) {
                    assert.isNull(branch);
                }
                else {
                    assert.instanceOf(branch, NodeGit.Reference);
                    assert.equal(branch.shorthand(), c.b);
                }
            }));
        });
    });

    describe("isValidRemoteName", function () {
        const cases = {
            "trivial": { i: "S", r: "foo", e: false },
            "good": { i: "S:Ra=b", r: "a", e: true },
            "bad": { i: "S:Rc=d", r: "origin", e: false},
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const path = yield TestUtil.makeTempDir();
                const ast = ShorthandParserUtil.parseRepoShorthand(c.i);
                const repo =
                            (yield WriteRepoASTUtil.writeRAST(ast, path)).repo;
                const result = yield GitUtil.isValidRemoteName(repo, c.r);
                assert.equal(result, c.e);
            }));
        });
    });

    describe("findRemoteBranch", function () {
        const cases = {
            "simple fail": {
                input: "S:Ra=b",
                origin: "a",
                branch: "master",
                expected: null,
            },
            "simple success": {
                input: "S:Ra=b o=1",
                origin: "a",
                branch: "o",
                expected: true,
            },
            "another failure": {
                input: "S:Ra=b o=1",
                origin: "a",
                branch: "n",
                expected: null,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const path = yield TestUtil.makeTempDir();
                const ast = ShorthandParserUtil.parseRepoShorthand(c.input);
                const repo =
                            (yield WriteRepoASTUtil.writeRAST(ast, path)).repo;
                const result = yield GitUtil.findRemoteBranch(repo,
                                                              c.origin,
                                                              c.branch);
                if (null === c.expected) {
                    assert.isNull(result);
                }
                else {
                    assert.instanceOf(result, NodeGit.Reference);
                    assert.equal(result.shorthand(),
                                 c.origin + "/" + c.branch);
                }
            }));
        });
    });

    describe("getRootGitDirectory", function () {
        let cwd;
        before(function () {
            cwd = process.cwd();
        });
        after(function () {
            process.chdir(cwd);
        });

        // This method is recursive, so we will check just three cases:
        // - failure case
        // - simple case
        // - one deep

        it("failure", function () {
            const tempdir = os.tmpdir();
            process.chdir(tempdir);
            const result = GitUtil.getRootGitDirectory();
            assert.isNull(result);
        });

        it("successes", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const workdir = repo.workdir();
            process.chdir(workdir);
            const repoRoot = GitUtil.getRootGitDirectory(workdir);
            assert(yield TestUtil.isSameRealPath(workdir, repoRoot),
                   "trivial");
            const subdir = path.join(workdir, "sub");
            yield fs.mkdir(subdir);
            process.chdir(subdir);
            const subRoot = GitUtil.getRootGitDirectory(workdir);
            assert(yield TestUtil.isSameRealPath(workdir, subRoot), "trivial");
        }));
    });

    describe("getCurrentRepo", function () {

        let cwd;
        before(function () {
            cwd = process.cwd();
        });
        after(function () {
            process.chdir(cwd);
        });

        it("breathing test", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            process.chdir(repo.workdir());
            const current = yield GitUtil.getCurrentRepo();
            assert.instanceOf(current, NodeGit.Repository);
            assert(TestUtil.isSameRealPath(repo.workdir(), current.workdir()));
        }));

        it("failure", co.wrap(function *() {
            // Making an assumption here that the temp dir is not in a git
            // repo; otherwise, not sure how I could test this.

            const emptyDir = yield TestUtil.makeTempDir();
            process.chdir(emptyDir);

            try {
                yield GitUtil.getCurrentRepo();
                assert(false, "didn't throw error");
            }
            catch (e) {
                assert.instanceOf(e, UserError);
            }
        }));
    });

    describe("push", function () {

        // We know that we're not actually implementing push ourselves; it's
        // done in terms of `git push`, though eventually it will be through
        // NodeGit.

        function pusher(repoName, origin, local, remote) {
            return co.wrap(function *(repos) {
                const result =
                    yield GitUtil.push(repos[repoName], origin, local, remote);
                if (null !== result) {
                    throw new Error(result);
                }
            });
        }

        const cases = {
            "failure": {
                input: "a=S",
                expected: {},
                manipulator: pusher("a", "foo", "bar", "bar"),
                fail: true
            },
            "push new branch": {
                input: "a=S|b=Ca:Bfoo=1",
                expected: "a=S:Bfoo=1|b=Ca:Bfoo=1",
                manipulator: pusher("b", "origin", "foo", "foo"),
            },
            "update a branch": {
                input: "a=B|b=Ca:C2-1;Bmaster=2",
                expected: "a=B:C2-1;Bmaster=2|b=Ca",
                manipulator: pusher("b", "origin", "master", "master"),
            },
            "update to a different branch": {
                input: "a=B|b=Ca:C2-1;Bmaster=2",
                expected: "a=B:C2-1;Bfoo=2|b=Ca:Bmaster=2",
                manipulator: pusher("b", "origin", "master", "foo"),
            },
        };

        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                try {
                    yield RepoASTTestUtil.testMultiRepoManipulator(
                                                                c.input,
                                                                c.expected,
                                                                c.manipulator);
                    assert(!c.fail);
                }
                catch (e) {
                    assert(c.fail, e.stack);
                }
            }));
        });
    });

    describe("getCurrentBranchName", function () {
        const cases = {
            "simple": { input: "S", expected: "master" },
            "no branch": { input: "S:Bmaster=;*=", expected: null },
            "detached head": { input: "S:*=", expected: null },
            "not master": { input: "S:Bmaster=;Bfoo=1;*=foo", expected: "foo"},
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const ast = ShorthandParserUtil.parseRepoShorthand(c.input);
                const path = yield TestUtil.makeTempDir();
                const repo =
                            (yield WriteRepoASTUtil.writeRAST(ast, path)).repo;
                const result = yield GitUtil.getCurrentBranchName(repo);
                assert.equal(result, c.expected);
            }));
        });
    });

    describe("resolveCommitish", function () {

        // We know the actual resolution is handled by 'NodeGit', so just do
        // some simple tests to prove to ourselves that we are forwarding the
        // arguments correctly; no need for a table as there are no
        // corner-cases or logic in our code.  The main reason we wrote this
        // function is to deal with the fact that there's no way to detect a
        // bad commitish without using try/catch.

        it("breathing test", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();

            const headCommit = yield repo.getHeadCommit();
            const headCommitId = headCommit.id();

            const masterResolve =
                                yield GitUtil.resolveCommitish(repo, "master");

            assert(headCommitId.equal(masterResolve.id()));

            const partialSha = headCommitId.tostrS();
            const shaResolve =
                              yield GitUtil.resolveCommitish(repo, partialSha);

            assert(headCommitId.equal(shaResolve.id()));

            assert.isNull(yield GitUtil.resolveCommitish(repo, "foo"));
        }));
    });

    describe("shortSha", function () {
        it("breahingTest", function () {
            const input = "e76a1dda3a42ba1f20b6f35297ee5eda6f9cc017";
            assert.equal("e76a1d", GitUtil.shortSha(input));
        });
    });

    describe("fetch", function () {

        function fetcher(repoName, remoteName) {
            return function (repos) {
                return GitUtil.fetch(repos[repoName], remoteName);
            };
        }

        const cases = {
            "noop": {
                input: "a=B|b=Ca",
                expected: {},
                manipulator: fetcher("b", "origin"),
            },
            "fail": {
                input: "a=B|b=Ca",
                expected: {},
                manipulator: fetcher("b", "baz"),
                fail: true,
            },
            "pull one": {
                input: "a=B:C2-1;Bbaz=2|b=B|c=S:Rorigin=c;Rx=a",
                expected: "c=S:C2-1;Rorigin=c;Rx=a master=1,baz=2",
                manipulator: fetcher("c", "x"),
            },
            "pull other one": {
                input: "a=B:C2-1;Bbaz=2|b=B|c=S:Rorigin=c;Rx=a",
                expected: "c=S:Rorigin=c master=1;Rx=a",
                manipulator: fetcher("c", "origin"),
            },
        };

        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                try {
                    yield RepoASTTestUtil.testMultiRepoManipulator(
                                                                c.input,
                                                                c.expected,
                                                                c.manipulator);
                    assert(!c.fail);
                }
                catch (e) {
                    assert(c.fail, e.stack);
                }
            }));
        });
    });

    describe("listUnpushedCommits", function () {
        const cases = {
            "no branches": {
                input: "S:Rorigin=foo",
                from: "1",
                remote: "origin",
                expected: ["1"],
            },
            "up to date": {
                input: "S:Rorigin=foo moo=1",
                from: "1",
                remote: "origin",
                expected: [],
            },
            "one not pushed": {
                input: "S:C2-1;Bmaster=2;Rorigin=foo moo=1",
                from: "2",
                remote: "origin",
                expected: ["2"],
            },
            "two not pushed": {
                input: "S:C3-2;C2-1;Bmaster=3;Rorigin=foo moo=1",
                from: "3",
                remote: "origin",
                expected: ["2","3"],
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const ast = ShorthandParserUtil.parseRepoShorthand(c.input);
                const path = yield TestUtil.makeTempDir();
                const written = yield WriteRepoASTUtil.writeRAST(ast, path);
                const fromSha = written.oldCommitMap[c.from];
                const unpushed = yield GitUtil.listUnpushedCommits(
                                                                  written.repo,
                                                                  c.remote,
                                                                  fromSha);
                const unpushedShas = unpushed.map(id => {
                    assert.instanceOf(id, NodeGit.Oid);
                    return written.commitMap[id.tostrS()];
                });
                assert.sameMembers(unpushedShas, c.expected);
            }));
        });
    });
});
