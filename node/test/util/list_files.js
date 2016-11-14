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

const ListFiles       = require("../../lib/util/list_files");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");

describe("ListFiles", function () {
    // Will always read "x".

    const cases = {
        "empty": {
            state: "x=S:I README.md",
            expected: [],
        },
        "file in meta": {
            state: "x=S",
            expected: ["README.md"],
        },
        "excluded by relative path in meta": {
            state: "x=S",
            relativePath: "foo",
            expected: [],
        },
        "added file in meta": {
            state: "x=S:I foo=bar",
            expected: ["README.md", "foo"],
        },
        "deep file in meta": {
            state: "x=S:I foo/bar/baz=bar",
            expected: ["README.md", "foo/bar/baz"],
        },
        "filtered file in meta": {
            state: "x=S:I foo/bar/baz=bar",
            relativePath: "foo",
            expected: ["bar/baz"],
        },
        "filtered deep file in meta": {
            state: "x=S:I foo/bar/baz=bar",
            relativePath: "foo/bar",
            expected: ["baz"],
        },
        "with a closed sub": {
            state: "a=S|x=U",
            expected: ["README.md"],
        },
        "open sub": {
            state: "a=S|x=U:Os",
            expected: ["README.md", "s/README.md"],
        },
        "relative to sub": {
            state: "a=S|x=U:Os",
            relativePath: "s",
            expected: ["README.md"],
        },
        "relative in sub": {
            state: "a=S|x=U:Os I blam/pow/x.txt=hi",
            relativePath: "s/blam",
            expected: ["pow/x.txt"],
        },
        "relative in sub, filters another sub": {
            state: "a=S|x=U:Os;I t=Sa:1;Ot I baz=foa,README.md",
            relativePath: "t",
            expected: ["baz"]
        },
        "all filtered": {
            state: "a=S|x=U:Os I blam/pow/x.txt=hi",
            relativePath: "s/morx",
            expected: []
        },
        "partial prefix": {
            state: "x=S",
            relativePath: "READ",
            expected: [],
        },
        "partial prefix of submodule": {
            state: "a=S|x=S:I foo=Sa:1,fo/meh=hi;Ofoo",
            relativePath: "fo",
            expected: ["meh"],
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const written = yield RepoASTTestUtil.createMultiRepos(c.state);
            const repo = written.repos.x;
            const result = yield ListFiles.listFiles(repo, c.relativePath);
            assert.deepEqual(result.sort(), c.expected.sort());
        }));
    });
});
