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
const mkdirp  = require("mkdirp");
const NodeGit = require("nodegit");
const path    = require("path");

const ForcePushSpec       = require("../../lib/util/force_push_spec");
const GitUtil             = require("../../lib/util/git_util");
const RepoAST             = require("../../lib/util/repo_ast");
const RepoASTTestUtil     = require("../../lib/util/repo_ast_test_util");
const ShorthandParserUtil = require("../../lib/util/shorthand_parser_util");
const TestUtil            = require("../../lib/util/test_util");
const UserError           = require("../../lib/util/user_error");
const WriteRepoASTUtil    = require("../../lib/util/write_repo_ast_util");

describe("GitUtil", function () {
    describe("getTrackingInfo", function () {
        const cases = {
            "no tracking": {
                state: "S",
                branch: "master",
                expected: null,
            },
            "local tracking": {
                state: "S:Bfoo=1 master",
                branch: "foo",
                expected: {
                    remoteName: null,
                    branchName: "master",
                    pushRemoteName: null,
                },
            },
            "with remote": {
                state: "S:Rhoo=/a gob=1;Bbar=1 hoo/gob",
                branch: "bar",
                expected: {
                    remoteName: "hoo",
                    pushRemoteName: "hoo",
                    branchName: "gob",
                },
            },
            "with slashes in branch name": {
                state: "S:Rhoo=/a foo/bar=1;Bbar=1 hoo/foo/bar",
                branch: "bar",
                expected: {
                    remoteName: "hoo",
                    pushRemoteName: "hoo",
                    branchName: "foo/bar",
                },
            },
            "with pushRemote": {
                state: "S:Rhoo=/a gob=1;Bbar=1 hoo/gob",
                branch: "bar",
                pushRemote: "bah",
                expected: {
                    remoteName: "hoo",
                    pushRemoteName: "bah",
                    branchName: "gob",
                },
            },
            "with pushDefault": {
                state: "S:Rhoo=/a gob=1;Bbar=1 hoo/gob",
                branch: "bar",
                pushDefault: "bah",
                expected: {
                    remoteName: "hoo",
                    pushRemoteName: "bah",
                    branchName: "gob",
                },
            },
            "with pushRemote and pushDefault": {
                state: "S:Rhoo=/a gob=1;Bbar=1 hoo/gob",
                branch: "bar",
                pushRemote: "hehe",
                pushDefault: "bah",
                expected: {
                    remoteName: "hoo",
                    pushRemoteName: "hehe",
                    branchName: "gob",
                },
            }
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written = yield RepoASTTestUtil.createRepo(c.state);
                const repo = written.repo;
                if (undefined !== c.pushRemote) {
                    const configPath = path.join(repo.path(), "config");
                    yield fs.appendFile(configPath, `\
[branch "${c.branch}"]
        pushRemote = ${c.pushRemote}
`);
                }
                if (undefined !== c.pushDefault) {
                    const configPath = path.join(repo.path(), "config");
                    yield fs.appendFile(configPath, `\
[remote]
        pushDefault = ${c.pushDefault}
`);
                }
                const branch = yield repo.getBranch(c.branch);
                const result = yield GitUtil.getTrackingInfo(repo, branch);
                assert.deepEqual(result, c.expected);
            }));
        });
    });
    describe("getCurrentTrackingBranchName", function () {
        const cases = {
            "no tracking": {
                state: "S",
                expected: null,
            },
            "local tracking": {
                state: "S:Bfoo=1;Bblah=1 foo;*=blah",
                expected: "foo",
            },
            "no branch": {
                state: "S:H=1",
                expected: null,
            },
            "with remote": {
                state: "S:Rhoo=/a gob=1;Bmaster=1 hoo/gob",
                expected: "hoo/gob",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written = yield RepoASTTestUtil.createRepo(c.state);
                const repo = written.repo;
                const result =
                              yield GitUtil.getCurrentTrackingBranchName(repo);
                assert.equal(result, c.expected);
            }));
        });
    });
    describe("getRemoteForBranch", function () {
        it("no upstream", co.wrap(function *() {
            const written = yield RepoASTTestUtil.createRepo("S");
            const repo = written.repo;
            const branch = yield repo.getCurrentBranch();
            const result = yield GitUtil.getRemoteForBranch(repo, branch);
            assert.isNull(result);
        }));
        it("has upstream", co.wrap(function *() {
            const clonePath = yield TestUtil.makeTempDir();
            const baseRepo = yield TestUtil.createSimpleRepository();
            const repo = yield NodeGit.Clone.clone(baseRepo.workdir(),
                                                   clonePath);
            const branch = yield repo.getCurrentBranch();
            const result = yield GitUtil.getRemoteForBranch(repo, branch);
            assert.instanceOf(result, NodeGit.Remote);
            assert.equal(result.name(), "origin");
        }));
    });

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

    describe("getRemoteUrl", function () {
        const cases = {
            "simple": {
                i: "a=B|x=Ca",
                name: "origin",
                expected: "a",
            },
            "relative": {
                i: "a=B|x=S:Rups=../a",
                name: "ups",
                expected: "a",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written = yield RepoASTTestUtil.createMultiRepos(c.i);
                const x = written.repos.x;
                const remote = yield x.getRemote(c.name);
                const result = yield GitUtil.getRemoteUrl(x, remote);
                const expectedRepo = written.repos[c.expected];
                const expected = yield fs.realpath(expectedRepo.path());
                assert.equal(result, expected);
            }));
        });
    });

    describe("getUrlFromRemoteName", function () {
        it("works", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const func = GitUtil.getUrlFromRemoteName;
            yield NodeGit.Remote.create(repo, "upstream",
                                        "https://example.com");
            assert.equal("https://example.com", yield func(repo, "upstream"));
            assert.equal("https://example.org",
                         yield func(repo, "https://example.org"));
        }));
    });

    describe("getOriginUrl", function () {
        it("url from branch remote", co.wrap(function *() {
            // TODO: don't have it in my shorthand to associate a branch with
            // an upstream yet so we have to do this test manually.

            const clonePath = yield TestUtil.makeTempDir();
            const baseRepo = yield TestUtil.createSimpleRepository();
            const upstream = yield TestUtil.createSimpleRepository();
            const repo = yield NodeGit.Clone.clone(baseRepo.workdir(),
                                                   clonePath);
            yield NodeGit.Remote.create(repo, "upstream", upstream.workdir());
            yield GitUtil.fetch(repo, "upstream");
            const branch = yield repo.getCurrentBranch();
            yield NodeGit.Branch.setUpstream(branch, "upstream/master");
            const result = yield GitUtil.getOriginUrl(repo);
            assert.equal(result, upstream.workdir());
        }));
        const cases = {
            "good": { i: "a=B|x=Ca", e: "a" },
            "good, but no branch": {
                i: "a=B|x=Ca:H=1",
                e: "a"
            },
            "bad": { i: "x=S", e: null},
            "no head and empty": { i: "x=N", e: null },
            "relative origin": {
                i: "a=B|x=S:Rorigin=../a/",
                e: "a",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written = yield RepoASTTestUtil.createMultiRepos(c.i);
                const x = written.repos.x;
                const result = yield GitUtil.getOriginUrl(x);

                // If we are expecting a URL, `expected` will not be null.  In
                // that case, we need map the physical value written to disk
                // for that logical URL, and check that physical value against
                // what was returned by `getOriginUrl`.

                let expected = c.e;
                if (null !== expected) {
                    for (let key in written.urlMap) {
                        if (expected === written.urlMap[key]) {
                            expected = key;
                        }
                    }
                }

                assert.equal(result, expected);
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
            }
            catch (e) {
                assert.instanceOf(e, UserError);
                return;
            }
            assert(false, "didn't throw error");
        }));
    });

    describe("push", function () {

        // We know that we're not actually implementing push ourselves; it's
        // done in terms of `git push`, though eventually it will be through
        // NodeGit.

        function pusher(repoName, origin, local, remote, force, quiet) {
            return co.wrap(function *(repos) {
                force = force || ForcePushSpec.NoForce;
                const result =
                    yield GitUtil.push(repos[repoName],
                                       origin,
                                       local,
                                       remote,
                                       force,
                                       quiet);
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
            "no-ffwd failure": {
                input: "a=B:C2-1;Bmaster=2|b=Ca:C3-1;Bmaster=3",
                manipulator: pusher("b", "origin", "master", "master"),
                fail: true,
            },
            "force success": {
                input: "a=B:C2-1;Bmaster=2|b=Ca:C3-1;Bmaster=3",
                manipulator: pusher(
                    "b", "origin", "master", "master", ForcePushSpec.Force),
                expected: "a=B:C3-1;Bmaster=3|b=Ca:Bmaster=3",
            },
            "force with lease success": {
                input: "a=B:C2-1;Bmaster=2|b=Ca:C3-1;Bmaster=3",
                manipulator: pusher(
                    "b",
                    "origin",
                    "master",
                    "master",
                    ForcePushSpec.ForceWithLease),
                expected: "a=B:C3-1;Bmaster=3|b=Ca:Bmaster=3",
            },
            "force with lease failure": {
                input: `
                    a=B:C2-1;Bmaster=2|
                    b=Ca:Rorigin=a master=1;C3-1;
                    Bmaster=3 origin/master;Bold=2`,
                manipulator: pusher(
                    "b", "origin", "master", "master", ForcePushSpec.Force),
                fail: true,
            },
            "push new branch": {
                input: "a=S|b=Ca:Bfoo=1",
                expected: "a=S:Bfoo=1|b=Ca:Bfoo=1",
                manipulator: pusher("b", "origin", "foo", "foo"),
            },
            "quiet push new branch": {
                input: "a=S|b=Ca:Bfoo=1",
                expected: "a=S:Bfoo=1|b=Ca:Bfoo=1",
                manipulator: pusher(
                    "b", "origin", "foo", "foo", ForcePushSpec.Force),
            },
            "update a branch": {
                input: "a=B|b=Ca:C2-1;Bmaster=2 origin/master",
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
                }
                catch (e) {
                    assert(c.fail, e.stack);
                    return;
                }
                assert(!c.fail);
            }));
        });
    });

    describe("getCurrentBranchName", function () {
        const cases = {
            "simple": { input: "S", expected: "master" },
            "no branch": { input: "S:Bmaster=;*=", expected: null },
            "detached head": { input: "S:*=", expected: null },
            "not master": { input: "S:Bmaster=;Bfoo=1;*=foo", expected: "foo"},
            "empty": { input: new RepoAST(), expected: null },
            "no current branch but not empty": {
                input: "N:C2;Rtrunk=/a foo=2",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                let ast = c.input;
                if ("string" === typeof c.input) {
                    ast = ShorthandParserUtil.parseRepoShorthand(c.input);
                }
                const path = yield TestUtil.makeTempDir();
                const repo =
                            (yield WriteRepoASTUtil.writeRAST(ast, path)).repo;
                const result = yield GitUtil.getCurrentBranchName(repo);
                assert.equal(result, c.expected);
            }));
        });
    });

    describe("readNote", function () {
        it("simple test", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const headCommit = yield repo.getHeadCommit();

            yield NodeGit.Note.create(repo, "refs/notes/foo",
                                      headCommit.committer(),
                                      headCommit.committer(), headCommit.id(),
                                      "note", 1);

            const readNote = yield GitUtil.readNote(repo, "refs/notes/foo",
                                                   headCommit.id());
            assert.equal(readNote.message(), "note");

            const missingRef = yield GitUtil.readNote(repo,
                                                      "refs/notes/missing",
                                                      headCommit.id());
            assert.isNull(missingRef);

            const badSha = "0123456789012345678901234567890123456789";
            const missingCommit = yield GitUtil.readNote(repo,
                                                         "refs/notes/foo",
                                                         badSha);
            assert.isNull(missingCommit);

        }));
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
                }
                catch (e) {
                    assert(c.fail, e.stack);
                    return;
                }
                assert(!c.fail);
            }));
        });
    });

    describe("fetchBranch", function () {

        function fetcher(repoName, remoteName, branch) {
            return function (repos) {
                return GitUtil.fetchBranch(repos[repoName],
                                           remoteName,
                                           branch);
            };
        }

        const cases = {
            "noop": {
                input: "a=B|b=Ca",
                expected: {},
                manipulator: fetcher("b", "origin", "master"),
            },
            "fail": {
                input: "a=B|b=Ca",
                expected: {},
                manipulator: fetcher("b", "baz", "zap"),
                fail: true,
            },
            "pull just one": {
                input: "a=B:C2-1;Bbaz=2|b=B|c=S:Rorigin=c;Rx=a",
                expected: "c=S:Rorigin=c;Rx=a master=1",
                manipulator: fetcher("c", "x", "master"),
            },
            "pull other remote": {
                input: "a=B:C2-1;Bbaz=2|b=B|c=S:Rorigin=c;Rx=a",
                expected: "c=S:Rorigin=c master=1;Rx=a",
                manipulator: fetcher("c", "origin", "master"),
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
                }
                catch (e) {
                    assert(c.fail, e.stack);
                    return;
                }
                assert(!c.fail);
            }));
        });
    });

    describe("fetchSha", function () {
        it("already have it, would fail otherwise", co.wrap(function *() {
            const ast = ShorthandParserUtil.parseRepoShorthand("S");
            const path = yield TestUtil.makeTempDir();
            const written = yield WriteRepoASTUtil.writeRAST(ast, path);
            const commit = written.oldCommitMap["1"];
            const repo = written.repo;
            const result = yield GitUtil.fetchSha(repo, "not a url", commit);
            assert.equal(result, false);
        }));

        it("fetch one", co.wrap(function *() {
            const xPath= yield TestUtil.makeTempDir();
            const yPath= yield TestUtil.makeTempDir();
            const astX =
                ShorthandParserUtil.parseRepoShorthand("S:C2-1;Bmaster=2");
            const astY = ShorthandParserUtil.parseRepoShorthand("S");
            const writtenX = yield WriteRepoASTUtil.writeRAST(astX, xPath);
            const writtenY = yield WriteRepoASTUtil.writeRAST(astY, yPath);
            const commit = writtenX.oldCommitMap["2"];
            const repo = writtenY.repo;
            const result = yield GitUtil.fetchSha(repo, xPath, commit);
            assert.equal(result, true);
            yield repo.getCommit(commit);
        }));

        it("bad sha", co.wrap(function *() {
            const xPath= yield TestUtil.makeTempDir();
            const yPath= yield TestUtil.makeTempDir();
            const astX =
                ShorthandParserUtil.parseRepoShorthand("S:C2-1;Bmaster=2");
            const astY = ShorthandParserUtil.parseRepoShorthand("S");
            yield WriteRepoASTUtil.writeRAST(astX, xPath);
            const writtenY = yield WriteRepoASTUtil.writeRAST(astY, yPath);
            const repo = writtenY.repo;
            const bad = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            try {
                yield GitUtil.fetchSha(repo, xPath, bad);
            }
            catch (e) {
                assert.instanceOf(e, UserError);
                assert.equal(e.code, UserError.CODES.FETCH_ERROR);
                return;
            }
            assert(false, "Bad sha, should have failed");
        }));
    });

    describe("isUpToDate", function () {
        const cases = {
            "trivial": {
                initial: "S",
                from: "1",
                to: "1",
                expected: true,
            },
            "is in history": {
                initial: "S:C2-1;Bmaster=2",
                from: "2",
                to: "1",
                expected: true,
            },
            "behind": {
                initial: "S:C2-1;Bmaster=2",
                from: "1",
                to: "2",
                expected: false,
            },
            "divergent": {
                initial: "S:C2-1;C3-1;Bmaster=2;Bfoo=3",
                from: "2",
                to: "3",
                expected: false,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const ast = ShorthandParserUtil.parseRepoShorthand(c.initial);
                const path = yield TestUtil.makeTempDir();
                const written = yield WriteRepoASTUtil.writeRAST(ast, path);
                const repo = written.repo;
                const oldMap = written.oldCommitMap;
                assert.property(oldMap, c.from);
                assert.property(oldMap, c.to);
                const from = oldMap[c.from];
                const to = oldMap[c.to];
                const result = yield GitUtil.isUpToDate(repo, from, to);
                assert.equal(result, c.expected);
            }));
        });
    });

    describe("setHeadHard", function () {
        function makeSetter(commitId) {
            return co.wrap(function *(repo, commitMap, oldMap) {
                const realId = oldMap[commitId];
                const commit = yield repo.getCommit(realId);
                yield GitUtil.setHeadHard(repo, commit);
            });
        }
        const cases = {
            "same commit": { i: "S", c: "1", e: "S:H=1" },
            "old commit": {
                i: "S:C2-1;Bmaster=2",
                c: "1",
                e: "S:C2-1;H=1;Bmaster=2"
            },
        };
        Object.keys(cases).forEach(caseName => {
            it(caseName, co.wrap(function *() {
                const c = cases[caseName];
                yield RepoASTTestUtil.testRepoManipulator(c.i,
                                                          c.e,
                                                          makeSetter(c.c));
            }));
        });
    });

    describe("parseRefspec", function () {
        const cases = {
            null: { fail: true },
            "a": { d_force: false, d_src: "a", d_dst: "a" },
            ":": { fail: true },
            "a:": { fail: true },
            ":b": { d_force: false, d_src: "", d_dst: "b" },
            "a:b": { d_force: false, d_src: "a", d_dst: "b" },
            "+a": { d_force: true, d_src: "a", d_dst: "a" },
            "+:": { fail: true },
            "+a:": { fail: true },
            "+:b": { d_force: true, d_src: "", d_dst: "b"},
            "+a:b": { d_force: true, d_src: "a", d_dst: "b" },
        };
        Object.keys(cases).forEach(str => {
            it(str, function() {
                try {
                    const actual = GitUtil.parseRefspec(str);
                    assert.deepEqual(cases[str], actual);
                } catch (e) {
                    assert(true === cases[str].fail);
                }
            });
        });
    });

    describe("resolveRelativePath", function () {
        // We don't need to test this exhaustively -- the hard work is done by
        // `fs` and `path` -- just that we're calling the APIs correctly and
        // throwing the right errors.

        const cases = {
            trivial: {
                paths: ["a"],
                workdir: "a",
                cwd: "a",
                filename: ".",
                expected: "",
            },
            "outside": {
                paths: ["a"],
                workdir: "a",
                cwd: "a",
                filename: "/",
                fails: true,
            },
            "not there": {
                paths: ["a"],
                workdir: "a",
                cwd: "a",
                filename: "b",
                expected: "b",
            },
            "not there, relative": {
                paths: ["a/c"],
                workdir: "a",
                cwd: "a/c",
                filename: "../b",
                expected: "b",
            },
            "inside": {
                paths: ["a/b/c"],
                workdir: "a",
                cwd: "a",
                filename: "b",
                expected: "b",
            },
            "inside with trail": {
                paths: ["a/b/c"],
                workdir: "a",
                cwd: "a",
                filename: "b/",
                expected: "b",
            },
            "inside and up": {
                paths: ["a/b/c", "a/b/d"],
                workdir: "a",
                cwd: "a/b/c",
                filename: "../d",
                expected: "b/d",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const tempDir = yield TestUtil.makeTempDir();
                c.paths.map(filename => {
                    const dir = path.join(tempDir, filename);
                    mkdirp.sync(dir);
                });
                const workdir = path.join(tempDir, c.workdir);
                const cwd = path.join(tempDir, c.cwd);
                let result;
                try {
                    result = GitUtil.resolveRelativePath(workdir,
                                                         cwd,
                                                         c.filename);
                }
                catch (e) {
                    if (!c.fails) {
                        throw e;
                    }
                    assert.instanceOf(e, UserError);
                    return;
                }
                assert(!c.fails, "should fail");
                assert.equal(result, c.expected);
            }));
        });
    });

    describe("getEditorCommand", function () {
        // This command is implemented in terms of `git var`, so we just need
        // to see that it returns a correct result; we're not going to test
        // `git var`.

        it("breathing", co.wrap(function *() {
            const editor = "my-crazy-editor";
            process.env.GIT_EDITOR = editor;
            const repo = yield TestUtil.createSimpleRepository();
            const result = yield GitUtil.getEditorCommand(repo);
            assert.equal(result, editor);
        }));
    });

    describe("editMessage", function () {
        it("breathing", co.wrap(function *() {
            const cmd = "echo bar >> ";
            process.env.GIT_EDITOR = cmd;
            const repo = yield TestUtil.createSimpleRepository();
            const result = yield GitUtil.editMessage(repo, "foo\n", true,
                                                     true);
            assert.equal(result, "foo\nbar\n");
        }));
    });

    describe("isComment", function () {
        const cases = {
            "trivial": {
                input: "",
                expected: false,
            },
            "no comment": {
                input: "c",
                expected: false,
            },
            "no comment after space": {
                input: " c",
                expected: false,
            },
            "comment": {
                input: "#",
                expected: true,
            },
            "comment not first": {
                input: " #",
                expected: true,
            },
            "comment with more": {
                input: " #c",
                expected: true,
            },
            "comment with tab": {
                input: "\t#",
                expected: true,
            },
            "comment with multi space": {
                input: " \t# asdf",
                expected: true,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = GitUtil.isComment(c.input);
                assert.equal(result, c.expected);
            });
        });
    });

    describe("isBlank", function () {
        const cases = {
            "trivial": {
                input: "",
                expected: true,
            },
            "non": {
                input: "b",
                expected: false,
            },
            "blank before": {
                input: " b",
                expected: false,
            },
            "blank after": {
                input: "b ",
                expected: false,
            },
            "blank": {
                input: " ",
                expected: true,
            },
            "more blank": {
                input: " \t",
                expected: true,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = GitUtil.isBlank(c.input);
                assert.equal(result, c.expected);
            });
        });
    });

    describe("stripMessageLines", function () {
        const cases = {
            "trivial": {
                input: [],
                expected: "",
            },
            "almost trivial": {
                input: [""],
                expected: "",
            },
            "simple": {
                input: ["a"],
                expected: "a\n",
            },
            "all blank": {
                input: ["", "", ""],
                expected: "",
            },
            "all comments": {
                input: ["#", " ", "#"],
                expected: "",
            },
            "lines before": {
                input: ["", "", "", "a"],
                expected: "a\n",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = GitUtil.stripMessageLines(c.input);
                assert.equal(result, c.expected);
            });
        });
    });


    describe("stripMessage", function () {
        const cases = {
            "trivial": {
                input: "",
                expected: "",
            },
            "simple": {
                input: "a",
                expected: "a\n",
            },
            "simple, nl": {
                input: "a\n",
                expected: "a\n",
            },
            "all blank": {
                input: "\n\n\n",
                expected: "",
            },
            "all comments": {
                input: "#\n \n#\n",
                expected: "",
            },
            "lines before": {
                input: "\n\n\na\n",
                expected: "a\n",
            },
            "lines before no nl": {
                input: "\n\n\na",
                expected: "a\n",
            }
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = GitUtil.stripMessage(c.input);
                assert.equal(result, c.expected);
            });
        });
    });

    describe("getParentCommit", function () {
        it("no parent", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const head = yield repo.getHeadCommit();
            const result = yield GitUtil.getParentCommit(repo, head);
            assert.isNull(result);
        }));

        it("a parent", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const head = yield repo.getHeadCommit();
            yield fs.appendFile(path.join(repo.workdir(), "README.md"), "foo");
            const sig = yield repo.defaultSignature();
            const newCommitId = yield repo.createCommitOnHead(["README.md"],
                                                              sig,
                                                              sig,
                                                              "hello");
            const newCommit = yield repo.getCommit(newCommitId);
            const result = yield GitUtil.getParentCommit(repo, newCommit);
            assert.equal(result.id().tostrS(), head.id().tostrS());
        }));
    });
    describe("getMergeBase", function () {
        const cases = {
            "base": {
                input: "S:Cx-1;Cy-1;Bfoo=x;Bmaster=y",
                expected: "1",
            },
            "no base": {
                input: "S:Cx-1;Cy;Bfoo=x;Bmaster=y",
                expected: null,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written = yield RepoASTTestUtil.createRepo(c.input);
                const repo = written.repo;
                const oldMap = written.oldCommitMap;
                const x = yield repo.getCommit(oldMap.x);
                const y = yield repo.getCommit(oldMap.y);
                const result = yield GitUtil.getMergeBase(repo, x, y);
                if (null === c.expected) {
                    assert.isNull(result);
                } else {
                    assert.isNotNull(result);
                    const sha = written.commitMap[result.id().tostrS()];
                    assert.equal(c.expected, sha);
                }
            }));
        });
    });
    describe("updateHead", function () {
        const cases = {
            "noop": {
                input: "x=S",
                to: "1",
            },
            "another": {
                input: "x=S:C2-1;Bfoo=2",
                to: "2",
                expected: "x=E:Bmaster=2;I 2",
            },
            "from detached": {
                input: "x=S:H=1;C2-1;Bmaster=2",
                to: "2",
                expected: "x=E:H=2;I 2",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            const updateHead = co.wrap(function *(repos, maps) {
                const repo = repos.x;
                const rev = maps.reverseCommitMap;
                const commit = yield repo.getCommit(rev[c.to]);

                // TODO: test reason propagation to reflog; we don't have good
                // support for this in the test facility though, and it's
                // pretty hard to mess up.

                yield GitUtil.updateHead(repo, commit, "a reason");
            });
            it(caseName, co.wrap(function *() {
                yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                               c.expected,
                                                               updateHead);
            }));
        });
    });
    describe("getReference", function () {
        it("good", co.wrap(function *() {
            const written = yield RepoASTTestUtil.createRepo("S");
            const repo = written.repo;
            const result = yield GitUtil.getReference(repo,
                                                      "refs/heads/master");
            assert.instanceOf(result, NodeGit.Reference);
            assert.equal(result.name(), "refs/heads/master");
        }));
        it("bad", co.wrap(function *() {
            const written = yield RepoASTTestUtil.createRepo("S");
            const repo = written.repo;
            const result = yield GitUtil.getReference(repo, "refs/foo");
            assert.isNull(result);
        }));
    });
});
