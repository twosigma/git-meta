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
const fs      = require("fs-promise");
const co      = require("co");
const NodeGit = require("nodegit");

const ReadRepoASTUtil     = require("../../lib/util/read_repo_ast_util");
const RepoAST             = require("../../lib/util/repo_ast");
const RepoASTUtil         = require("../../lib/util/repo_ast_util");
const RepoASTTestUtil     = require("../../lib/util/repo_ast_test_util");
const ShorthandParserUtil = require("../../lib/util/shorthand_parser_util");
const TestUtil            = require("../../lib/util/test_util");
const UserError           = require("../../lib/util/user_error");
const WriteRepoASTUtil    = require("../../lib/util/write_repo_ast_util");

const S = ShorthandParserUtil.RepoType.S;

const noOp = co.wrap(function *() {
    yield (Promise.resolve(2));  // silence warnings
});

const committer = co.wrap(function *(repo) {
    const newCommit = yield TestUtil.generateCommit(repo);
    let result = {};
    result[newCommit.id().tostrS()] = "2";
    return result;
});

const makeRepo = co.wrap(function *() {
    const path = yield TestUtil.makeTempDir();
    const written = yield WriteRepoASTUtil.writeRAST(S, path);
    return {
        commitMap: written.commitMap,
        urlMap:  { a: path },
    };
});

function fail() {
    return Promise.reject(new UserError("I failed."));
}

function failWithWrongError() {
    return Promise.reject("I failed.");
}

const makeClone = co.wrap(function *(repos, maps) {
    assert.isObject(maps);
    assert.isObject(maps.commitMap);
    assert.isObject(maps.urlMap);
    const a = repos.a;
    const bPath = yield TestUtil.makeTempDir();
    const aPath = yield fs.realpath(a.workdir());

    // Test framework expects a trailing '/' to support relative paths.

    const b = yield NodeGit.Clone.clone(aPath, bPath);
    const head = yield b.getHeadCommit();
    yield b.createBranch("foo", head.id(), 1);
    yield b.checkoutBranch("foo");
    const commit = yield TestUtil.generateCommit(b);
    yield b.checkoutBranch("master");
    let returnCommitMap = {};
    returnCommitMap[commit.id().tostrS()] = "2";
    return {
        commitMap: returnCommitMap,
        urlMap: { b: bPath },
    };
});

describe("RepoASTTestUtil", function () {
    describe("createRepo", function () {
        // This method is pretty simple; we'll make sure it works with both
        // shorthand and ASTs.

        const S = ShorthandParserUtil.RepoType.S;
        it("with shorthand", co.wrap(function *() {
            const result = yield RepoASTTestUtil.createRepo("S");
            const repo = result.repo;
            const ast = yield ReadRepoASTUtil.readRAST(repo);
            const mappedAST = RepoASTUtil.mapCommitsAndUrls(ast,
                                                            result.commitMap,
                                                            {});
            RepoASTUtil.assertEqualASTs(mappedAST,
                                        ShorthandParserUtil.RepoType.S);
        }));

        it("with AST", co.wrap(function *() {
            const result = yield RepoASTTestUtil.createRepo(S);
            const repo = result.repo;
            const ast = yield ReadRepoASTUtil.readRAST(repo);
            const mappedAST = RepoASTUtil.mapCommitsAndUrls(ast,
                                                            result.commitMap,
                                                            {});
            RepoASTUtil.assertEqualASTs(mappedAST,
                                        ShorthandParserUtil.RepoType.S);
        }));
    });

    describe("createMultiRepos", function () {
        // This method delegates to `createMultiRepoASTMap`; here we'll just
        // exercise its basic functionality.

        const S = ShorthandParserUtil.RepoType.S;

        const cases = {
            "both from shorthand": "a=S|b=S",
            "one from each": { a: S, b: "S" },
            "both ASTs": { a: S, b: S },
        };

        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const result = yield RepoASTTestUtil.createMultiRepos(c);
                const readRepo = co.wrap(function *(repo) {
                    const ast = yield ReadRepoASTUtil.readRAST(repo);
                    return RepoASTUtil.mapCommitsAndUrls(ast,
                                                         result.commitMap,
                                                         result.urlMap);
                });
                const aAST = yield readRepo(result.repos.a);
                RepoASTUtil.assertEqualASTs(aAST, S);
                const bAST = yield readRepo(result.repos.b);
                RepoASTUtil.assertEqualASTs(bAST, S);
            }));
        });
    });

    describe("testRepoManipulator", function () {
        // Most of the functionality of this method is deferred.  Check basic
        // usage and commit mapping.

        const cases = {
            trivial: { i: "S", e: "S", m: noOp },
            badTrivial: { i: "S", e: "S:Bfoo=1", m: noOp, fails: true },
            trivialWithAST: { i: S, e: S, m: noOp },
            committer: {
                i: "S",
                e: "S:C2-1 README.md=hello worlddata;Bmaster=2",
                m: committer,
            },
        };
        Object.keys(cases).forEach(caseName => {
            it(caseName, co.wrap(function *() {
                const c = cases[caseName];
                try {
                    yield RepoASTTestUtil.testRepoManipulator(c.i, c.e, c.m);
                    assert(!c.fails);
                }
                catch(e) {
                    assert(c.fails, e.stack);
                }
            }));
        });
    });

    describe("testMultiRepoManipulator", function () {
        const cases = {
            trivial: { i: {}, e: {}, m: noOp },
            simple: { i: "a=S", e: "a=S", m: noOp },
            "with input map to string": {
                i: { a: "S" },
                e: "a=S",
                m: noOp,
            },
            "with input map to AST": {
                i: { a: S },
                e: "a=S",
                m: noOp,
            },
            "with output map to string": {
                i: "a=S",
                e: { a: "S" },
                m: noOp,
            },
            "with output map to AST": {
                i: "a=S",
                e: { a: S },
                m: noOp,
            },
            "implied output": { i: "a=S", e: {}, m: noOp },
            "simple failure": {
                i: "a=S",
                e: "a=S:Bfoo=1",
                m: noOp,
                fails: true
            },
            "new repo": {
                i: {},
                e: "a=S",
                m: makeRepo,
            },
            "missed new repo": {
                i: {},
                e: "a=S",
                m: noOp,
                fails: true,
            },
            "new repos with clone": {
                i: "a=S",
                e: { b: `
S:Rorigin=a master=1;C2-1 README.md=hello worlddata;Bfoo=2;
Bmaster=1 origin/master`,
                },
                m: makeClone,
            },
            "failure": {
                i: "a=S",
                m: fail,
                userError: true,
            },
            "wrong failure": {
                i: "a=S",
                m: failWithWrongError,
                userError: true,
                fails: true,
            },
            "uses original": {
                i: "a=S:C2-1;Bmaster=2",
                m: co.wrap(function *(repos) {
                    const repo = repos.a;
                    const newCommit = yield TestUtil.generateCommit(repo);
                    let result = {};
                    result[newCommit.id().tostrS()] = "3";
                    return {
                        commitMap: result
                    };
                }),
                e: "a=E:C3-2 README.md=hello worlddata;Bmaster=3",
            },
            "fails and makes state change": {
                i: "x=S",
                m: co.wrap(function *(repos) {
                    const x = repos.x;
                    const head = yield x.getHeadCommit();
                    yield repos.x.createBranch("foo", head, 0);
                    throw new UserError("bad bad");
                }),
                e: "x=E:Bfoo=1",
                userError: true,
            },
            "simple expected transform": {
                i: "x=S:Bfoo=1",
                m: noOp,
                e: "x=S",
                options: {
                    expectedTransformer: (expected) => {
                        const x = expected.x;
                        let branches = x.branches;
                        branches.foo = new RepoAST.Branch("1", null);
                        return {
                            x: x.copy({ branches: branches}),
                        };
                    },
                },
            },
            "commit id in branch, transformed by expected transformer": {
                i: "x=S",
                m: co.wrap(function *(repos) {
                    const x = repos.x;
                    const head = yield x.getHeadCommit();
                    const headStr = head.id().tostrS();
                    yield repos.x.createBranch(`foo-${headStr}`, head, 0);
                }),
                e: "x=S",
                options: {
                    expectedTransformer: (expected, mappings) => {
                        const x = expected.x;
                        let branches = x.branches;
                        const commitId = mappings.reverseCommitMap["1"];
                        branches[`foo-${commitId}`] =
                                                 new RepoAST.Branch("1", null);
                        return {
                            x: x.copy({ branches: branches}),
                        };
                    },
                },
            },
            "commit id in branch, transformed by actual transformer": {
                i: "x=S",
                m: co.wrap(function *(repos) {
                    const x = repos.x;
                    const head = yield x.getHeadCommit();
                    const headStr = head.id().tostrS();
                    yield repos.x.createBranch(`foo-${headStr}`, head, 0);
                }),
                e: "x=E:Bfoo-1=1",
                options: {
                    actualTransformer: (expected, mappings) => {
                        const x = expected.x;
                        let branches = x.branches;
                        const commitId = mappings.reverseCommitMap["1"];
                        delete branches[`foo-${commitId}`];
                        branches["foo-1"] = new RepoAST.Branch("1", null);
                        return {
                            x: x.copy({ branches: branches}),
                        };
                    },
                },
            },
            "bad remap": {
                i: {},
                e: {},
                m: function () {
                    return Promise.resolve({
                        commitMap: { "foo": "bar"},
                    });
                },
                fails: true,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                try {
                    yield RepoASTTestUtil.testMultiRepoManipulator(
                                                                  c.i,
                                                                  c.e,
                                                                  c.m,
                                                                  c.userError,
                                                                  c.options);
                }
                catch (e) {
                    assert(c.fails, e.stack);
                    return;
                }
                assert(!c.fails);
            }));
        });
    });
    describe("mapCommits", function () {
        const cases = {
            "nothing to do": {
                commits: {},
                commitMap: {},
                suffix: "foo",
                expected: {},
            },
            "map one": {
                commits: { "2": "1" },
                commitMap: { "1": "foo" },
                suffix: "bar",
                expected: { "2": "foobar" },
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = {};
                RepoASTTestUtil.mapCommits(result,
                                           c.commits,
                                           c.commitMap,
                                           c.suffix);
                assert.deepEqual(result, c.expected);
            });
        });
    });
    describe("mapSubCommits", function () {
        const cases = {
            "nothing to do": {
                subCommits: {},
                commitMap: {},
                expected: {},
            },
            "map one": {
                subCommits: { "x": { "2": "1" } },
                commitMap: { "1": "fo" },
                expected: { "2": "fox" },
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = {};
                RepoASTTestUtil.mapSubCommits(result,
                                              c.subCommits,
                                              c.commitMap);
                assert.deepEqual(result, c.expected);
            });
        });
    });
});
