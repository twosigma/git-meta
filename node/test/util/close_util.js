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

const co   = require("co");
const path = require("path");

const CloseUtil       = require("../../lib/util/close_util");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");

describe("close_util", function () {
    describe("close", function () {
        // Don't need to test that deinitialization works, that's tested in
        // submodule_config_util; just need to see that we handle paths and
        // dirty submodule situations.

        const cases = {
            "trivial": {
                state: "x=S",
                paths: [],
                fails: false,
            },
            "simple works": {
                state: "a=B|x=U:Os",
                paths: ["s"],
                expected: "a=B|x=U",
            },
            "with path and closed sub": {
                state: "a=B|x=U",
                paths: ["."],
            },
            "simple with resolved paths": {
                state: "a=B|x=U:Os",
                paths: ["s"],
                expected: "a=B|x=U",
            },
            "simple with cwd miss": {
                state: "a=B|x=S:C2-1 s/t=Sa:1,u/t=3;Os/t;Bmaster=2",
                cwd: "u",
                paths: ["t"]
            },
            "simple with cwd hit": {
                state: "a=B|x=S:C2-1 s/t=Sa:1,u/t=3;Os/t;Bmaster=2",
                cwd: "s",
                paths: ["t"],
                expected: "x=S:C2-1 s/t=Sa:1,u/t=3;Bmaster=2",
            },
            "multiple": {
                state: "a=B|x=S:C2-1 s=Sa:1,t=Sa:1;Bmaster=2;Os;Ot",
                paths: ["s","t"],
                expected: "x=S:C2-1 s=Sa:1,t=Sa:1;Bmaster=2",
            },
            // This tests something only triggered by a race condition, so
            // it might be hard to trigger a failure
            "multiple, in a subdir": {
                state: `a=B|x=S:C2-1 a/b/c/d/e/s1=Sa:1,
a/b/c/d/e/s2=Sa:1,
a/b/c/d/e/s3=Sa:1,
a/b/c/d/e/s4=Sa:1;
Bmaster=2;
Oa/b/c/d/e/s1;
Oa/b/c/d/e/s2;
Oa/b/c/d/e/s3;
Oa/b/c/d/e/s4`,
                paths: ["a"],
                expected: `x=S:C2-1 a/b/c/d/e/s1=Sa:1,
a/b/c/d/e/s2=Sa:1,
a/b/c/d/e/s3=Sa:1,
a/b/c/d/e/s4=Sa:1;Bmaster=2`,
            },
            "dirty fail staged": {
                state: "a=B|x=U:Os I a=b",
                paths: ["s"],
                fails: true,
            },
            "dirty fail untracked": {
                state: "a=B|x=U:Os W a=b",
                paths: ["s"],
                fails: true,
            },
            "dirty forced": {
                state: "a=B|x=U:Os I a=b",
                paths: ["s"],
                expected: "a=B|x=U",
                force: true,
            },
            "dirty and clean": {
                state: "a=B|x=S:C2-1 s=Sa:1,t=Sa:1;Bmaster=2;Os I a=b;Ot",
                paths: ["s","t"],
                expected: "x=S:C2-1 s=Sa:1,t=Sa:1;Bmaster=2;Os I a=b",
                fails: true,
            },
            "a/b doesn't close a": {
                state: "a=B|x=U:Os",
                paths: ["s/t"],
                expected: "a=B|x=U:Os",
            },
        };
        Object.keys(cases).forEach(caseName => {
            for (const sparse of [true, false]) {
                const c = cases[caseName];
                const closer = co.wrap(function *(repos) {
                    const x = repos.x;
                    let cwd = x.workdir();
                    if (undefined !== c.cwd) {
                        cwd = path.join(cwd, c.cwd);
                    }
                    yield CloseUtil.close(x, cwd, c.paths, c.force || false);
                });
                it(caseName + (sparse ? " sparse" : ""), co.wrap(function *() {
                    let state = c.state;
                    let expected = c.expected;
                    if (sparse) {
                        state = state.replace("x=S", "x=%S");
                        if (expected !== undefined) {
                            expected = expected.replace("x=S", "x=%S");
                        }
                    }
                    yield RepoASTTestUtil.testMultiRepoManipulator(state,
                                                                   expected,
                                                                   closer,
                                                                   c.fails);

                }));
            }
        });
    });
});
