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

const RepoAST             = require("../../lib/util/repo_ast");
const RepoASTUtil         = require("../../lib/util/repo_ast_util");
const ShorthandParserUtil = require("../../lib/util/shorthand_parser_util");

describe("ShorthandParserUtil", function () {
    describe("parseRepoShorthandRaw", function () {
        const Commit = RepoAST.Commit;
        const Submodule = RepoAST.Submodule;
        function m(args) {
            let result = {
                type: args.type || "S",
                commits: {},
                branches: {},
                remotes: {},
                index: {},
                workdir: {},
                openSubmodules: {},
            };
            result = Object.assign(result, args);

            // If a 'null' type was specified, remove it -- this indicates that
            // the test case wants no type, not the default.

            if (null === result.type) {
                delete result.type;
            }
            return result;
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
                        message: "message",
                    }),
                }
            })},
            "commit with message": { i: "S:Chello world#1-2", e: m({
                commits: {
                    "1": new Commit({
                        parents: ["2"],
                        changes: { "1": "1"},
                        message: "hello world",
                    }),
                }
            })},
            "commit with longer names": { i: "S:Cxxx2-yy", e: m({
                commits: {
                    "xxx2": new Commit({
                        parents: ["yy"],
                        changes: { "xxx2": "xxx2"},
                        message: "message",
                    }),
                }
            })},
            "commit with change": { i: "S:C1-2 foo=bar", e: m({
                commits: {
                    "1": new Commit({
                        parents: ["2"],
                        changes: { "foo": "bar"},
                        message: "message",
                    }),
                }
            })},
            "commit with empty change": { i: "S:C1-2 foo=", e: m({
                commits: {
                    "1": new Commit({
                        parents: ["2"],
                        changes: { "foo": ""},
                        message: "message",
                    }),
                }
            })},
            "commit with changes": { i: "S:C1-2 foo=bar,b=z", e: m({
                commits: {
                    "1": new Commit({
                        parents: ["2"],
                        changes: { "foo": "bar", "b": "z"},
                        message: "message",
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
                            message: "message",
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
                            message: "message",
                        }),
                        "3": new Commit({
                            parents: ["4"],
                            changes: { "3": "3"},
                            message: "message",
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
            "commit with submodule": {
                i: "S:C2-1 baz=S/foo.git:1",
                e: m({
                    type: "S",
                    commits: {
                        "2": new Commit({
                            parents: ["1"],
                            changes: { "baz": new Submodule("/foo.git", "1") },
                            message: "message",
                        }),
                    },
                }),
            },
            "commit with short submodule": {
                i: "S:C2-1 baz=So:1;Bmaster=2",
                e: m({
                    type: "S",
                    commits: {
                        "2": new Commit({
                            parents: ["1"],
                            changes: { "baz": new Submodule("o", "1") },
                            message: "message",
                        }),
                    },
                    branches: { master: "2"},
                }),
            },
            "index change": {
                i: "S:I x=y",
                e: m({
                    type: "S",
                    index: { x: "y" },
                }),
            },
            "index deletion and changes": {
                i: "S:I x=y,q,z=r",
                e: m({
                    type: "S",
                    index: { x: "y", q: null, z: "r" },
                }),
            },
            "index submodule change": {
                i: "S:I x=S/x:1",
                e: m({
                    type: "S",
                    index: { x: new Submodule("/x", "1") },
                }),
            },
            "workdir change": {
                i: "S:W x=y",
                e: m({
                    type: "S",
                    workdir: { x: "y" },
                }),
            },
            "workdir  deletion and changes": {
                i: "S:W x=y,q,z=r",
                e: m({
                    type: "S",
                    workdir: { x: "y", q: null, z: "r" },
                }),
            },
            "workdir submodule change": {
                i: "S:W x=S/x:1",
                e: m({
                    type: "S",
                    workdir: { x: new Submodule("/x", "1") },
                }),
                fails: true,
            },
            "open submodule": {
                i: "S:Ox",
                e: m({
                    openSubmodules: { "x": m({ type: null}) },
                })
            },
            "open submodule one override": {
                i: "S:Oy Bmaster=foo",
                e: m({
                    openSubmodules: {
                        y: m({ type: null, branches: { master: "foo" }}),
                    },
                }),
            },
            "open submodule multiple overrides": {
                i: "S:Oy Bmaster=foo!W x=z",
                e: m({
                    openSubmodules: {
                        y: m({
                            type: null,
                            branches: { master: "foo" },
                            workdir: { x: "z" },
                        }),
                    },
                }),
            },
            "remote override": {
                i: "S:Rorigin=a;H=2",
                e: m({
                    head: "2",
                    remotes: {
                        origin: {
                            url: "a",
                            branches: {},
                        },
                    },
                }),
            },
            "submodule with remote override": {
                i: "S:C2-1 a=Sa:1;Oa Rorigin=a;H=2",
                e: m({
                    commits: {
                        "2": new RepoAST.Commit({
                            parents: ["1"],
                            changes: {
                                a: new RepoAST.Submodule("a", "1"),
                            },
                            message: "message",
                        }),
                    },
                    head: "2",
                    openSubmodules: {
                        a: m({
                            type: null,
                            remotes: {
                                origin: {
                                    url: "a", 
                                    branches: {
                                    },
                                },
                            },
                        }),
                    },
                }),
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                let r;
                try {
                    r = ShorthandParserUtil.parseRepoShorthandRaw(c.i);
                }
                catch (e) {
                    assert(c.fails, e.stack);
                    return;
                }
                assert(!c.fails);
                const e = c.e;
                assert.equal(r.type, e.type);
                assert.equal(r.typeData, e.typeData);
                assert.deepEqual(r.commits, e.commits);
                assert.deepEqual(r.branches, e.branches);
                assert.deepEqual(r.remotes, e.remotes);
                assert.deepEqual(r.index, e.index);
                assert.equal(r.head, e.head);
                assert.equal(r.currentBranchName, e.currentBranchName);
                assert.deepEqual(r.openSubmodules, e.openSubmodules);
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
            "A type": {
                i: "Axyz",
                e: new RepoAST({
                    commits: {
                        xyz: new Commit({
                            changes: {
                                xyz: "xyz",
                            },
                            message: "changed xyz",
                        }),
                    },
                    branches: {
                        master: "xyz",
                    },
                    head: "xyz",
                    currentBranchName: "master",
                }),
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
                            message: "message",
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
                            message: "message",
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
            "index change": {
                i: "S:I a=b",
                e: S.copy({
                    index: {
                        a: "b",
                    }
                }),
            },
            "bad type data": {
                i: "S I max=maz",
                fails: true,
            },
            "bad: open submodule": {
                i: "S:Ox",
                fails: true,
            },
            "test U": {
                i: "S:Cadded 's'#2-1 s=Sa:1;Bmaster=2",
                e: ShorthandParserUtil.RepoType.U,
            },
        };
        Object.keys(cases).forEach(caseName => {
            it(caseName, function () {
                const c = cases[caseName];
                let result;
                try {
                    result = ShorthandParserUtil.parseRepoShorthand(c.i);
                }
                catch (e) {
                    assert(c.fails, e.stack);
                    return;
                }
                assert(!c.fails);
                RepoASTUtil.assertEqualASTs(result, c.e);
            });
        });
    });

    describe("parseMultiRepoShorthand", function () {
        const AST = RepoAST;
        const Commit = AST.Commit;
        const Submodule = AST.Submodule;
        const S = ShorthandParserUtil.RepoType.S;
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
            "bad type data": {
                i: "a=S I max=maz|b=S:C2-1 foo=Sa:1;Bmaster=2",
                fails: true,
            },
            "simple open sub": {
                i: "a=S|b=S:I foo=Sa:1;Ofoo",
                e: {
                    a: "S",
                    b: S.copy({
                        index: { foo: new Submodule("a", "1") },
                        openSubmodules: {
                            foo: RepoASTUtil.cloneRepo(S, "a").copy({
                                branches: {},
                                currentBranchName: null,
                            })
                        }
                    }),
                },
            },
            "open sub with branch": {
                i: "a=S|b=S:I foo=Sa:1;Ofoo Bm=1",
                e: {
                    a: "S",
                    b: S.copy({
                        index: { foo: new Submodule("a", "1") },
                        openSubmodules: {
                            foo: RepoASTUtil.cloneRepo(S, "a").copy({
                                branches: { m: "1" },
                                currentBranchName: null,
                            })
                        }
                    }),
                },
            },
            "open sub with branch and new commit": {
                i: "a=S|b=S:I foo=Sa:1;Ofoo Bm=1!C2-1!Baa=2",
                e: {
                    a: "S",
                    b: S.copy({
                        index: { foo: new Submodule("a", "1") },
                        openSubmodules: {
                            foo: RepoASTUtil.cloneRepo(S, "a").copy({
                                commits: {
                                    "1": new Commit({
                                        changes: {
                                            "README.md": "hello world"
                                        },
                                        message: "the first commit",
                                    }),
                                    "2": new Commit({
                                        parents: ["1"],
                                        changes: { "2": "2" },
                                        message: "message",
                                    }),
                                },
                                branches: { m: "1", aa: "2" },
                                currentBranchName: null,
                            })
                        }
                    }),
                },
            },
            "open sub with index and workdir": {
                i: "a=S|b=S:I foo=Sa:1;Ofoo I x=y!W u=2",
                e: {
                    a: "S",
                    b: S.copy({
                        index: { foo: new Submodule("a", "1") },
                        openSubmodules: {
                            foo: RepoASTUtil.cloneRepo(S, "a").copy({
                                branches: {},
                                index: { x: "y"},
                                workdir: { u: "2" },
                                currentBranchName: null,
                            })
                        }
                    }),
                },
            },
            "sub with new commit": {
                i: "a=S|b=S:C2-1 s=Sa:3;Bmaster=2",
                e: {
                    a: "S",
                    b: new RepoAST({
                        currentBranchName: "master",
                        head: "2",
                        branches: {
                            master: "2",
                        },
                        commits: {
                            "1": new Commit({
                                changes: {
                                    "README.md": "hello world",
                                },
                                message: "the first commit",
                            }),
                            "2": new Commit({
                                parents: ["1"],
                                changes: {
                                    s: new Submodule("a","3"),
                                },
                                message: "message",
                            }),
                        },
                    }),
                },
            },
            "open sub with new commit": {
                i: "a=S|b=S:C2-1 s=Sa:3;Bmaster=2;Os C3-1!H=3",
                e: {
                    a: "S",
                    b: new RepoAST({
                        currentBranchName: "master",
                        head: "2",
                        branches: {
                            master: "2",
                        },
                        commits: {
                            "1": new Commit({
                                changes: {
                                    "README.md": "hello world",
                                },
                                message: "the first commit",
                            }),
                            "2": new Commit({
                                parents: ["1"],
                                changes: {
                                    s: new Submodule("a","3"),
                                },
                                message: "message",
                            }),
                        },
                        openSubmodules: {
                            s: ShorthandParserUtil.parseRepoShorthand(
                                "S:C3-1;H=3;Bmaster=;Rorigin=a master=1"),
                        },
                    }),
                },
            },

            // crazy, but should work
            "commit defined in open sub referenced elsewhere": {
                i: "r=S:Bmax=2|a=S|b=S:I foo=Sa:1;Ofoo C2-1!Bx=2",
                e: {
                    a: "S",
                    r: "S:C2-1;Bmax=2",
                    b: S.copy({
                        index: { foo: new Submodule("a", "1") },
                        openSubmodules: {
                            foo: RepoASTUtil.cloneRepo(S, "a").copy({
                                commits: {
                                    "1": new Commit({
                                        changes: {
                                            "README.md": "hello world"
                                        },
                                        message: "the first commit",
                                    }),
                                    "2": new Commit({
                                        parents: ["1"],
                                        changes: { "2": "2" },
                                        message: "message",
                                    }),
                                },
                                branches: { x: "2" },
                                currentBranchName: null,
                            })
                        }
                    }),
                },
            },
            "keeping an existing": {
                i: "a=S:Bfoo=1",
                existing: { b: S },
                e: {
                    a: S.copy({ branches: { master: "1", foo: "1" }}),
                    b: S,
                },
            },
            "change from existing": {
                i: "a=E:*=foo",
                existing: {
                    a: ShorthandParserUtil.parseRepoShorthand("S:Bfoo=1"),
                },
                e: {
                    a: ShorthandParserUtil.parseRepoShorthand("S:Bfoo=1;*=foo")
                },
            },
            "with an A type for base of sub": {
                i: "a=Ax|b=S:C2-1 s=Sa:x;Bmaster=2",
                e: {
                    a: ShorthandParserUtil.parseRepoShorthand("Ax"),
                    b: new RepoAST({
                        commits: {
                            "1": new RepoAST.Commit({
                                changes: {
                                    "README.md": "hello world"
                                },
                                message: "the first commit",
                            }),
                            "2": new RepoAST.Commit({
                                parents: ["1"],
                                changes: {
                                    s: new RepoAST.Submodule("a","x"),
                                },
                                message: "message",
                            }),
                        },
                        branches: { master: "2" },
                        head: "2",
                        currentBranchName: "master",
                    }),
                },
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                let result;
                try {
                    result = ShorthandParserUtil.parseMultiRepoShorthand(
                                                                   c.i,
                                                                   c.existing);
                }
                catch (e) {
                    assert(c.fails, e.stack);
                    return;
                }
                assert(!c.fails);
                let expected = {};
                for (let name in c.e) {
                    let input = c.e[name];
                    if (!(input instanceof RepoAST)) {
                        input = ShorthandParserUtil.parseRepoShorthand(input);
                    }
                    expected[name] = input;
                }
                RepoASTUtil.assertEqualRepoMaps(result, expected);
            });
        });
    });
});
