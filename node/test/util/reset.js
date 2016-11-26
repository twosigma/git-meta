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

const co = require("co");

const Reset           = require("../../lib/util/reset");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");

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
        "meta soft": {
            initial: "x=S:C2-1 README.md=aaa;Bfoo=2",
            to: "2",
            type: TYPE.SOFT,
            expected: "x=E:Bmaster=2;I README.md=hello world",
        },
        "meta mixed": {
            initial: "x=S:C2-1 README.md=aaa;Bfoo=2",
            to: "2",
            type: TYPE.MIXED,
            expected: "x=E:Bmaster=2;W README.md=hello world",
        },
        "meta hard": {
            initial: "x=S:C2-1 README.md=aaa;Bfoo=2",
            to: "2",
            type: TYPE.HARD,
            expected: "x=E:Bmaster=2",
        },
        "unchanged sub-repo not open": {
            initial: "a=B|x=U:C4-2 x=y;Bfoo=4",
            to: "4",
            type: TYPE.HARD,
            expected: "x=E:Bmaster=4"
        },
        "changed sub-repo not open": {
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
            initial: "\
a=B:Ca-1 y=x;Bfoo=a|x=U:C3-2 t=Sa:1;C4-3 s=Sa:a,t=Sa:a;Bfoo=4;Bmaster=3;Os;Ot",
            to: "4",
            type: TYPE.HARD,
            expected: "x=E:Bmaster=4;Os;Ot"
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const resetter = co.wrap(function *(repos, maps) {
                const commitId = maps.reverseMap[c.to];
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
