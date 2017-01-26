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

const assert  = require("chai").assert;
const co      = require("co");

const LogUtil             = require("../../lib/util/log_util");
const RepoASTTestUtil     = require("../../lib/util/repo_ast_test_util");
const SubmoduleFetcher    = require("../../lib/util/submodule_fetcher");
const SubmoduleUtil       = require("../../lib/util/submodule_util");
const UserError           = require("../../lib/util/user_error");

describe("log_util", function () {
    describe("findMetaCommit", function () {
        // We will always search from the HEAD of the meta and the submodule
        // named 's', using meta repo named 'x'.

        const cases = {
            "found": {
                state: "a=B|x=U:Os",
                expected: "2",
            },
            "missing": {
                state: "a=B|x=U:Os C5-1!H=5",
                expected: null,
            },
            "not on head of meta": {
                state: "a=B|x=U:C3-2;H=3;Os",
                expected: "2",
            },
            "descendant of commit being searched for": {
                state: `
a=B:C6-1;Bmaster=6|
x=S:C2-1 s=Sa:6;H=2;Os H=1`,
                expected: "2",
            },
            "from merge commit": {
                state: `
a=B|
x=S:C2-1;C3-1 s=Sa:1;C4-2,3 s=Sa:1;H=4;Os`,
                expected: "3",
            },
            "merge first (see that we do BFS)": {
                state: `
a=B:Cx;Bx=x|
x=S:Ca-1 s=Sa:1;Cb-a;C3-1 foo=3,s=Sa:1;C4-b,3;H=4;Os`,
                expected: "3",
            },
            "move past when deleted": {
                state: `
a=B|
x=S:C2-1 s=Sa:1;C3-2 s;C4-3 s=Sa:x;H=4;Os Cx!Bmaster=x!H=1`,
                expected: "2",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written =
                               yield RepoASTTestUtil.createMultiRepos(c.state);
                const metaRepo = written.repos.x;
                const subRepo = yield SubmoduleUtil.getRepo(metaRepo, "s");
                const metaHead = yield metaRepo.getHeadCommit();
                const subHead = yield subRepo.getHeadCommit();
                const fetcher = new SubmoduleFetcher(metaRepo, metaHead);
                let result;
                try {
                    result = yield LogUtil.findMetaCommit(metaRepo,
                                                          metaHead,
                                                          subHead,
                                                          "s",
                                                          subRepo,
                                                          fetcher);
                }
                catch (e) {
                    if (!c.fails) {
                        throw e;
                    }
                    assert.instanceOf(e, UserError);
                    return;
                }
                assert(!c.fails);
                const expected = c.expected;
                if (null === expected) {
                    assert.isNull(result);
                }
                else {
                    assert.isNotNull(result);
                    const mapped = written.commitMap[result];
                    assert.equal(mapped, expected);
                }
            }));
        });

    });

});
