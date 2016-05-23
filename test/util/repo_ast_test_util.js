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

const RepoASTIOUtil       = require("../../lib/util/repo_ast_io_util");
const RepoASTTestUtil     = require("../../lib/util/repo_ast_test_util");
const ShorthandParserUtil = require("../../lib/util/shorthand_parser_util");
const TestUtil            = require("../../lib/util/test_util");

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
    const written = yield RepoASTIOUtil.writeRAST(S, path);
    return {
        commitMap: written.commitMap,
        urlMap:  { a: path },
    };
});

const makeClone = co.wrap(function *(repos) {
    const a = repos.a;
    const bPath = yield TestUtil.makeTempDir();
    const aPath = yield fs.realpath(a.workdir());
    const b = yield NodeGit.Clone.clone(aPath, bPath);
    const sig = b.defaultSignature();
    const head = yield b.getHeadCommit();
    yield b.createBranch("foo", head.id(), 1, sig, "branch commit");
    yield b.checkoutBranch("foo");
    const commit = yield TestUtil.generateCommit(b);
    yield b.checkoutBranch("master");
    let commitMap = {};
    commitMap[commit.id().tostrS()] = "2";
    return {
        commitMap: commitMap,
        urlMap: { b: bPath },
    };
});

describe("RepoASTTestUtil", function () {
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
                e: { b:
                   "S:Rorigin=a master=1;C2-1 README.md=hello worlddata;Bfoo=2"
                },
                m: makeClone,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                try {
                    yield RepoASTTestUtil.testMultiRepoManipulator(c.i,
                                                                   c.e,
                                                                   c.m);
                    assert(!c.fails);
                }
                catch (e) {
                    assert(c.fails, e.stack);
                }
            }));
        });
    });
});
