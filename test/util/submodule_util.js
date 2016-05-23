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

const RepoASTIOUtil       = require("../../lib/util/repo_ast_io_util");
const ShorthandParserUtil = require("../../lib/util/shorthand_parser_util");
const TestUtil            = require("../../lib/util/test_util");
const SubmoduleUtil       = require("../../lib/util/submodule_util");

describe("SubmoduleUtil", function () {
    after(TestUtil.cleanup);

    describe("getSubmoduleNames", function () {
        const cases = {
            "none": {
                state: "S",
                expected: [],
            },
            "one": {
                state: "S:C2-1 foo=S/a:1;H=2",
                expected: ["foo"],
            },
            "two": {
                state: "S:C2-1 foo=S/a:1;C3-2 bar=S/b:2;H=3",
                expected: ["foo", "bar"],
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const ast = ShorthandParserUtil.parseRepoShorthand(c.state);
                const path = yield TestUtil.makeTempDir();
                const repo = (yield RepoASTIOUtil.writeRAST(ast, path)).repo;
                const names = yield SubmoduleUtil.getSubmoduleNames(repo);
                assert.deepEqual(names.sort(), c.expected.sort());
            }));
        });
    });

    describe("getSubmoduleNamesForCommit", function () {
        const cases = {
            "none": {
                state: "S",
                commit: "1",
                expected: [],
            },
            "one": {
                state: "S:C2-1 foo=S/a:1;H=2",
                commit: "2",
                expected: ["foo"],
            },
            "two": {
                state: "S:C2-1 foo=S/a:1;C3-2 bar=S/b:2;H=3",
                commit: "3",
                expected: ["foo", "bar"],
            },
            "none from earlier commit": {
                state: "S:C2-1 foo=S/a:1;C3-2 bar=S/b:2;H=3",
                commit: "1",
                expected: [],
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const ast = ShorthandParserUtil.parseRepoShorthand(c.state);
                const path = yield TestUtil.makeTempDir();
                const result = yield RepoASTIOUtil.writeRAST(ast, path);
                const repo = result.repo;
                const mappedCommitSha = result.oldCommitMap[c.commit];
                const commit = yield repo.getCommit(mappedCommitSha);
                const names = yield SubmoduleUtil.getSubmoduleNamesForCommit(
                                                                       repo,
                                                                       commit);
                assert.deepEqual(names.sort(), c.expected.sort());
            }));
        });
    });
});

