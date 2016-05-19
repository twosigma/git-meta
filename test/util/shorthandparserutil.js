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

const RepoAST             = require("../../lib/util/repoast");
const RepoASTUtil         = require("../../lib/util/repoastutil");
const ShorthandParserUtil = require("../../lib/util/shorthandparserutil");

describe("shorthandparserutil", function () {
    describe("parseRepoShorthandRaw", function () {
        const Commit = RepoAST.Commit;
        function m(args) {
            let result = {
                type: args.type || "S",
                commits: {},
                branches: {},
                remotes: {},
            };
            return Object.assign(result, args);
        }
        const cases = {
            "just type": { i: "S", e: m({ type: "S"})},
            "just another type": { i: "B", e: m({ type: "B"})},
            "branch": { i: "S:Bm=2", e: m({ branches: { m: "2"}})},
            "null branch": { i: "S:Bm=", e: m({ branches: { m: null}})},
            "commit": { i: "S:C1-2", e: m({
                commits: {
                    "1": new Commit({
                        parents: ["2"],
                        changes: { "1": "1"},
                    }),
                }
            })},
            "commit with change": { i: "S:C1-2 foo=bar", e: m({
                commits: {
                    "1": new Commit({
                        parents: ["2"],
                        changes: { "foo": "bar"},
                    }),
                }
            })},
            "commit with empty change": { i: "S:C1-2 foo=", e: m({
                commits: {
                    "1": new Commit({
                        parents: ["2"],
                        changes: { "foo": ""},
                    }),
                }
            })},
            "commit with changes": { i: "S:C1-2 foo=bar,b=z", e: m({
                commits: {
                    "1": new Commit({
                        parents: ["2"],
                        changes: { "foo": "bar", "b": "z"},
                    }),
                }
            })},
            "head": { i: "S:H=2", e: m({ head: "2"})},
            "no head": { i: "S:H=", e: m({ head: null })},
            "current branch": { i: "S:*=1", e: m({currentBranchName: "1"})},
            "no current branch": { i: "S:*=", e: m({currentBranchName: null})},
            "multiple overrides": {
                i: "S:Bm=;C1-2;*=1",
                e: m({
                    currentBranchName: "1",
                    commits: {
                        "1": new Commit({
                            parents: ["2"],
                            changes: { "1": "1"},
                    })},
                    branches: { m: null },
                }),
            },
            "multiple branches": {
                i: "S:Bm=1;By=2;Bz=",
                e: m({
                    branches: {
                        m: "1",
                        y: "2",
                        z: null,
                    },
                }),
            },
            "multiple commits": {
                i: "S:C1-2;C3-4",
                e: m({
                    commits: {
                        "1": new Commit({
                            parents: ["2"],
                            changes: { "1": "1"},
                        }),
                        "3": new Commit({
                            parents: ["4"],
                            changes: { "3": "3"},
                        }),
                    },
                }),
            },
            "remote": {
                i: "S:Rfoo=bar",
                e: m({
                    remotes: { foo: { url: "bar", branches: {}} },
                }),
            },
            "remote with a branch": {
                i: "S:Rfoo=bar origin=1",
                e: m({
                    remotes: {
                        foo: { url: "bar", branches: { origin: "1" }},
                    },
                }),
            },
            "remote with branches": {
                i: "S:Rfoo=bar origin=1,lame=2",
                e: m({
                    remotes: {
                        foo: {
                            url: "bar",
                            branches: { origin: "1", lame: "2", },
                        },
                    },
                }),
            },
            "updated remote": {
                i: "S:Rfoo= origin=1,lame=2",
                e: m({
                    remotes: {
                        foo: {
                            url: null,
                            branches: { origin: "1", lame: "2", },
                        },
                    },
                }),
            },
            "type with data": {
                i: "Cfoo",
                e: m({
                    type: "C",
                    typeData: "foo",
                }),
            },
            "type with data and overrides": {
                i: "Cx x x:Bbaz=1",
                e: m({
                    type: "C",
                    typeData: "x x x",
                    branches: { baz: "1" },
                }),
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const r = ShorthandParserUtil.parseRepoShorthandRaw(c.i);
                const e = c.e;
                assert.equal(r.type, e.type);
                assert.equal(r.typeData, e.typeData);
                assert.deepEqual(r.commits, e.commits);
                assert.deepEqual(r.branches, e.branches);
                assert.deepEqual(r.remotes, e.remotes);
                assert.equal(r.head, e.head);
                assert.equal(r.currentBranchName, e.currentBranchName);
            });
        });
    });

    describe("parseRepoShorthand", function () {
        // Parsing is handled (and tested) by `parseRepoShorthandRaw`.  Here we
        // just need to test that subsequent assembly is correct.

        const Commit = RepoAST.Commit;
        const Remote = RepoAST.Remote;
        const B = ShorthandParserUtil.RepoType.B;
        const S = ShorthandParserUtil.RepoType.S;

        const cases = {
            "simple": {
                i: "S",
                e: S
            },
            "bare": {
                i: "B",
                e: B,
            },
            "noHead": {
                i: "S:H=",
                e: S.copy({ head: null, currentBranchName: null }),
            },
            "killMaster": {
                i: "S:Bmaster=;*=",
                e: S.copy({ branches: {}, currentBranchName: null }),
            },
            "newMaster": {
                i: "S:C2-1;Bmaster=2",
                e: S.copy({
                    head: "2",
                    branches: { master: "2"},
                    commits: (() => {
                        let commits = S.commits;
                        commits[2] = new Commit({
                            parents: ["1"],
                            changes: { "2": "2"},
                        });
                        return commits;
                    })(),
                }),
            },
            "switchCurrent": {
                i: "S:C2-1;Bfoo=2;*=foo",
                e: S.copy({
                    head: "2",
                    currentBranchName: "foo",
                    branches: { master: "1", foo: "2"},
                    commits: (() => {
                        let commits = S.commits;
                        commits[2] = new Commit({
                            parents: ["1"],
                            changes: { "2": "2"},
                        });
                        return commits;
                    })(),
                }),
            },
            "remote": {
                i: "S:Ra=b",
                e: S.copy({
                    remotes: {
                        a: new Remote("b"),
                    }
                }),
            },
            "remote and branch": {
                i: "S:Ra=b q=1",
                e: S.copy({
                    remotes: {
                        a: new Remote("b", {
                            branches: { q: "1" },
                        }),
                    }
                }),
            },
        };
        Object.keys(cases).forEach(caseName => {
            it(caseName, function () {
                const c = cases[caseName];
                const result = ShorthandParserUtil.parseRepoShorthand(c.i);
                RepoASTUtil.assertEqualASTs(result, c.e);
            });
        });
    });

    describe("parseMultiRepoShorthand", function () {
        const cases = {
            "simple": { i: "a=S", e: { a: "S"} },
            "multiple": {
                i: "a=S|b=S:Bfoo=1",
                e: { a: "S", b: "S:Bfoo=1" }
            },
            "external commit": {
                i: "a=S:Bfoo=2|b=S:C2-1;Bmaster=2",
                e: {
                    a: "S:C2-1;Bfoo=2",
                    b: "S:C2-1;Bmaster=2",
                },
            },
            "external commit from descendant": {
                i: "a=S:C3-2;C2-1;Bbar=3|b=S:Bbaz=3",
                e: {
                    a: "S:C3-2;C2-1;Bbar=3",
                    b: "S:C3-2;C2-1;Bbaz=3",
                }
            },
            "external ref'd from head": {
                i: "a=S:H=2|b=S:C2-1;Bmaster=2",
                e: {
                    a: "S:C2-1;H=2",
                    b: "S:C2-1;Bmaster=2",
                },
            },
            "external ref'd from remote": {
                i: "a=S:Ra=b m=2|b=S:C2-1;Bmaster=2",
                e: {
                    a: "S:C2-1;Ra=b m=2",
                    b: "S:C2-1;Bmaster=2",
                },
            },
            "simple clone": {
                i: "a=S|b=Ca",
                e: {
                    a: "S",
                    b: "S:Rorigin=a master=1",
                },
            },
            "clone with overrides": {
                i: "a=S:C2-1;Bfoo=2;*=foo|b=Ca:Bg=1",
                e: {
                    a: "S:C2-1;Bfoo=2;*=foo",
                    b:
                  "S:C2-1;Rorigin=a master=1,foo=2;*=foo;Bg=1;Bfoo=2;Bmaster=",
                },
            },
            "clone with remote update": {
                i: "a=S|b=Ca:Rorigin= baz=1",
                e: {
                    a: "S",
                    b: "S:Rorigin=a master=1,baz=1",
                },
            },
            "clone with remote update deleting branch": {
                i: "a=S|b=Ca:Rorigin= master=",
                e: {
                    a: "S",
                    b: "S:Rorigin=a",
                },
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = 
                              ShorthandParserUtil.parseMultiRepoShorthand(c.i);
                let expected = {};
                for (let name in c.e) {
                    expected[name] =
                             ShorthandParserUtil.parseRepoShorthand(c.e[name]);
                }
                RepoASTUtil.assertEqualRepoMaps(result, expected);
            });
        });
    });
});
