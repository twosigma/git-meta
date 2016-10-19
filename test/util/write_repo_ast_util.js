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
const co      = require("co");
const NodeGit = require("nodegit");

const ReadRepoASTUtil     = require("../../lib/util/read_repo_ast_util");
const RepoAST             = require("../../lib/util/repo_ast");
const RepoASTUtil         = require("../../lib/util/repo_ast_util");
const ShorthandParserUtil = require("../../lib/util/shorthand_parser_util");
const TestUtil            = require("../../lib/util/test_util");
const WriteRepoASTUtil    = require("../../lib/util/write_repo_ast_util");

describe("WriteRepoASTUtil", function () {

    describe("buildDirectoryTree", function () {
        const cases = {
            "trivial": { input: {}, expected: {}, },
            "simple": {
                input: { a: "b" },
                expected: { a: "b" },
            },
            "deep": {
                input: { "a/b": "c" },
                expected: {
                    a: { b: "c" },
                },
            },
            "overlap": {
                input: { "a/b": "1", "a/d": "2" },
                expected: {
                    a: {
                        b: "1",
                        d: "2",
                    },
                },
            },
            "deep overlap": {
                input: { "a/b": "1", "a/c/d": "2" },
                expected: {
                    a: {
                        b: "1",
                        c: { d: "2", }
                    },
                },
            },
            "deep overlap reversed": {
                input: { "a/c/d": "2", "a/b": "1" },
                expected: {
                    a: {
                        c: { d: "2", },
                        b: "1",
                    },
                },
            },
        };
        Object.keys(cases).forEach((caseName) => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = WriteRepoASTUtil.buildDirectoryTree(c.input);
                assert.deepEqual(result, c.expected);
            });
        });
    });

    describe("writeRAST", function () {
        // We will "cheat" and utilize the already-tested `readRAST` to test
        // this one.

        const testCase = co.wrap(function *(shorthand, testName) {
            let ast = shorthand;
            if (!(ast instanceof RepoAST)) {
                ast = ShorthandParserUtil.parseRepoShorthand(shorthand);
            }
            const path = yield TestUtil.makeTempDir();
            const result = yield WriteRepoASTUtil.writeRAST(ast, path);
            const repoPath = result.repo.isBare() ?
                             result.repo.path() :
                             result.repo.workdir();
            const samePath = yield TestUtil.isSameRealPath(path, repoPath);
            assert(samePath, `${path} === ${repoPath}`);
            assert.instanceOf(result.repo, NodeGit.Repository);
            assert.isObject(result.commitMap);
            const newAst = yield ReadRepoASTUtil.readRAST(result.repo);

            // Same as `ast` but with commit ids remapped to new ids.

            const mappedNewAst =
               RepoASTUtil.mapCommitsAndUrls(newAst, result.commitMap, {});

            RepoASTUtil.assertEqualASTs(mappedNewAst, ast, testName);
        });

        const cases = {
            "simple": "S",
            "new head": "S:C2-1;H=2",
            "simple with branch": "S:Bfoo=1",
            "with another commit": "S:C2-1;Bmaster=2",
            "with commit chain": "S:C3-2;C2-1;Bmaster=3",
            "bare": "B",
            "bare with commits": "B:C2-1;Bmaster=2",
            "remote": "S:Rfoo=bar master=1",
            "bare with commit": "B:C2-1;Bmaster=2",
            "switch current": "S:Bfoo=1;*=foo",
            "delete branch": "S:Bfoo=1;Bmaster=;*=foo",
            "add submodule": "S:C2-1 foo=S/a:1;Bmaster=2",
            "update submodule": "S:C2-1 foo=S/x:1;C3-2 foo=S/x:2;Bmaster=3",
            "update submodule twice":
                    "S:C2-1 foo=S/y:1;C3-2 foo=S/y:2;C4-3 foo=S/y:3;Bmaster=4",
            "index add": "S:I foo=bar",
            "index change": "S:I README.md=bar",
            "index rm": "S:I README.md",
            "workdir add file": "S:W foo=bar",
            "workdir change file": "S:W foo=bar,README.md=meh",
            "workdir rm file": "S:W README.md",
            "added in index, removed in wd": "S:I foo=bar;W foo",
            "nested path": "S:C2-1 x/y/z=meh;Bmaster=2",
            "multiple nested path": "S:C2-1 x/y/z=meh;I x/y/q=S/a:2;Bmaster=2",
            "rm nesed": "S:C2-1 x/y/z=meh;I x/y/z;Bmaster=2",
            "nested in workdir": "S:W x/y/z=foo",
            "two nested in workdir": "S:W x/y/z=foo,x/y/k=bar",
            "merge": "S:C2-1;C3-1;C4-2,3 3=3;Bmaster=4",
            "merge with deletion":
                "S:C2-1;C3-1 README.md;C4-2,3 README.md;Bmaster=4",
            "notes": "S:C2-1;Bmaster=2;N refs/notes/morx 1=one",
            "multiple notes": "S:C2-1;Bmaster=2;" +
                "N refs/notes/morx 1=one;" +
                "N refs/notes/morx 2=two;" +
                "N refs/notes/fleem 1=fone;" +
                "N refs/notes/fleem 2=ftwo",
        };

        Object.keys(cases).forEach(caseName => {
            const shorthand = cases[caseName];
            it(caseName, co.wrap(function *() {
                yield testCase(shorthand);
            }));
        });
    });

    describe("writeMultiRAST", function () {
        const cases = {
            "simple": "a=S",
            "bare": "a=B",
            "multiple": "a=B|b=Ca:C2-1;Bmaster=2",
            "external commit": "a=S:Bfoo=2|b=S:C2-1;Bmaster=2",
            "external commit from descendant":
                "a=S:C3-2;C2-1;Bbar=3|b=S:Bbaz=3",
            "external ref'd from head": "a=S:H=2|b=S:C2-1;Bmaster=2",
            "external ref'd from remote": "a=S:Ra=b m=2|b=S:C2-1;Bmaster=2",
            "submod": "a=S|b=S:C2-1 foo=Sa:1;Bmaster=2",
            "an index change": "a=S:I max=maz|b=S:C2-1 foo=Sa:1;Bmaster=2",
            "submodule in index": "a=S|b=S:I foo=Sa:1",
            "basic open submodule": "a=S|b=S:I foo=Sa:1;Ofoo",
            "open submodule with index and workdir changes":
                "a=S|b=S:I foo=Sa:1;Ofoo I x=y!W q=r",
            "open submodule checked out to master":
                "a=S|b=S:I foo=Sa:1;Ofoo Bmaster=1!*=master",
            "open submodule with deep path":
                  "a=S|b=S:I x/y/z=Sa:1;Ox/y/z",
            "two open submodules with deep paths":
                  "a=S|b=S:I x/y/z=Sa:1,x/y/q=Sa:1;Ox/y/z;Ox/y/q",
            "two open submodules with deep paths and changes in one":
                  "a=S|b=S:I x/y/z=Sa:1,x/y/q=Sa:1;Ox/y/z;Ox/y/q W x=hello",
            "open sub with new commit":
                "a=S|x=S:C2-1 s=Sa:1;Bmaster=2;Os Bmaster=2!*=master",
        };
        Object.keys(cases).forEach(caseName => {
            const input = cases[caseName];
            it(caseName, co.wrap(function *() {
                const inASTs =
                            ShorthandParserUtil.parseMultiRepoShorthand(input);
                const root = yield TestUtil.makeTempDir();
                const result = yield WriteRepoASTUtil.writeMultiRAST(inASTs,
                                                                     root);
                assert.isObject(result);
                assert.isObject(result.repos);
                assert.isObject(result.commitMap);
                assert.isObject(result.urlMap);
                let resultASTs = {};
                for (let repoName in result.repos) {
                    const repo = result.repos[repoName];
                    const resultAST = yield ReadRepoASTUtil.readRAST(repo);
                    const mapped = RepoASTUtil.mapCommitsAndUrls(
                                                              resultAST,
                                                              result.commitMap,
                                                              result.urlMap);
                    resultASTs[repoName] = mapped;
                }
                RepoASTUtil.assertEqualRepoMaps(resultASTs, inASTs);
            }));
        });

        it("no unreferenced commits", co.wrap(function *() {
            const ast = ShorthandParserUtil.parseMultiRepoShorthand(
                "a=Aa|b=Ab");
            const root = yield TestUtil.makeTempDir();
            const written = yield WriteRepoASTUtil.writeMultiRAST(ast, root);
            let aSha;
            Object.keys(written.commitMap).forEach(commit => {
                const original = written.commitMap[commit];
                if ("a" === original) {
                    aSha = commit;
                }
            });

            const b = written.repos.b;
            try {
                yield b.getCommit(aSha);
            }
            catch (e) {
                return;                                               // RETURN
            }
            assert(false, "commit still exists");
        }));
    });
});
