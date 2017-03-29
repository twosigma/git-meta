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

const co     = require("co");

const Pull            = require("../../lib/util/pull");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");

describe("pull", function () {
    // Most of the logic for 'pull' is done in terms of fetch and rebase.  We
    // need to ensure that those operatios are invoked correctly, but not that
    // fetch and rebase are correct themselves, and also validate failure
    // conditions.

    const cases = {
        "trivial, no change": {
            initial: "a=B|x=Ca",
            remote: "origin",
            source: "master",
        },
        "bad remote": {
            initial: "x=S",
            remote: "origin",
            source: "master",
            fails: true,
        },
        "bad branch": {
            initial: "a=B|x=Ca",
            remote: "origin",
            source: "foo",
            fails: true,
        },
        "changes": {
            initial: "a=B:C2-1;Bfoo=2|x=Ca",
            remote: "origin",
            source: "foo",
            expected: "x=E:Bmaster=2",
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        const pull = co.wrap(function *(repos) {
            const repo = repos.x;
            yield Pull.pull(repo, c.remote, c.source);
        });
        it(caseName, co.wrap(function *() {
            yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                           c.expected,
                                                           pull,
                                                           c.fails);
        }));
    });
});
