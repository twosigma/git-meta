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

const co     = require("co");

const Push            = require("../../lib/util/push");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");

describe("push", function () {

    function pusher(repoName, remoteName, source, target) {
        return co.wrap(function *(repos) {
            const x = repos[repoName];
            yield Push.push(x, remoteName, source, target);
        });
    }

    const cases = {
        "simple failure": {
            initial: "a=S",
            manipulator: pusher("a", "origin", "master", "master"),
            fails: true,
        },
        "simple (noop) success": {
            initial: "a=S|b=Ca",
            manipulator: pusher("b", "origin", "master", "master"),
        },
        "simple new branch success": {
            initial: "a=S|b=Ca",
            manipulator: pusher("b", "origin", "master", "foo"),
            expected: "a=E:Bfoo=1|b=E:Rorigin=a foo=1,master=1",
        },
        "simple success": {
            initial: "a=B|b=Ca:C2-1;Bmaster=2",
            manipulator: pusher("b", "origin", "master", "master"),
            expected: "a=E:C2-1;Bmaster=2|b=E:Rorigin=a master=2",
        },
        "closed submodule no change": {
            initial: "a=B|b=B|x=Ca:I b=Sb:1",
            manipulator: pusher("x", "origin", "master", "master"),
        },
        "open submodule no change": {
            initial: "a=B|b=B|x=Ca:I b=Sb:1;Ob Bmaster=1",
            manipulator: pusher("x", "origin", "master", "master"),
        },
        "open submodule make a branch": {
            initial: "a=B|b=B|x=Ca:I b=Sb:1;Ob Bmaster=1",
            manipulator: pusher("x", "origin", "master", "foo"),
            expected: "\
a=E:Bfoo=1|\
b=E:Bfoo=1|\
x=E:Rorigin=a master=1,foo=1;Ob Bmaster=1!Rorigin=b master=1,foo=1",
        },
        "open submodule fails, no meta update": {
            initial: "a=B|b=B|x=Ca:I b=Sb:1;Ob",
            manipulator: pusher("x", "origin", "master", "foo"),
            fails: true,
        }
    };

    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                           c.expected,
                                                           c.manipulator,
                                                           c.fails);
        }));
    });
});
