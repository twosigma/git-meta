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
const fs      = require("fs-promise");
const NodeGit = require("nodegit");
const path    = require("path");

const ReadRepoASTUtil     = require("../../lib/util/read_repo_ast_util");
const RepoAST             = require("../../lib/util/repo_ast");
const RepoASTUtil         = require("../../lib/util/repo_ast_util");
const ShorthandParserUtil = require("../../lib/util/shorthand_parser_util");
const TestUtil            = require("../../lib/util/test_util");
const WriteRepoASTUtil    = require("../../lib/util/write_repo_ast_util");

describe("WriteRepoASTUtil", function () {

    describe("levelizeCommitTrees", function () {
        // We are going to cheat here and use `ShorthandParserUtil` to make it
        // easy to describe commits, though we'll not use any other part of the
        // ASTs.  If input is a string, we parse it; otherwise, we consider it
        // to be a commit map.  We will sort the result vectors returned by
        // `levelizeCommitTrees`.

        const cases = {
            "trivial": {
                input: {},
                shas: [],
                expected: []
            },
            "simple": {
                input: "B",
                shas: ["1"],
                expected: [["1"]],
            },
            "simple -- omitted": {
                input: "B",
                shas: [],
                expected: [],
            },
            "multiple": {
                input: "B:C2-1;Bx=2",
                shas: ["1", "2"],
                expected: [["1"], ["2"]],
            },
            "one from parent, one from sub": {
                input: "B:C2-1;C3-1 x=Sa:2;Bx=2;By=3",
                shas: ["1", "2", "3"],
                expected: [["1"], ["2"], ["3"]],
            },
            "two deep": {
                input: "B:C3-1;C4-1 x=Sa:1;C2-4 y=Sq:4;Bx=3;By=4;Bz=2",
                shas: ["1", "3", "4", "2"],
                expected: [["1"],["3","4"],["2"]],
            },
            "skipped sub": {
                input: "B:C3-1;C4-1 x=Sa:1;C2-4 y=Sq:4;Bx=3;By=4;Bz=2",
                shas: ["3", "4", "2"],
                expected: [["3", "4"],["2"]],
            },
        };
        Object.keys(cases).forEach(caseName => {
            it(caseName, function () {
                const c = cases[caseName];
                let input = c.input;
                if ("string" === typeof input) {
                    input =
                         ShorthandParserUtil.parseRepoShorthand(input).commits;
                }
                let result = WriteRepoASTUtil.levelizeCommitTrees(input,
                                                                  c.shas);
                result = result.map(array => array.sort());
                assert.deepEqual(result, c.expected);
            });
        });
    });

    describe("writeCommits", function () {
        // TODO: Move unit tests relating to commits from `writeRAST` into this
        // unit as `writeRAST` is implemented in terms of `writeCommits`.

        const cases = {
            "trivial": {
                input: new RepoAST(),
                shas: [[]],
            },
            "don't write any": {
                input: "B",
                shas: [[]],
            },
            "write one": {
                input: "B",
                shas: [["1"]],
            },
            "write two": {
                input: "B:C2-1;Bmaster=2",
                shas: [["2", "1"]],
            },
            "write two in waves": {
                input: "B:C2;Bmaster=2;Bf=1",
                shas: [["2"], ["1"]],
            },
            "write two connected in waves": {
                input: "B:C2-1;Bmaster=2;Bf=1",
                shas: [["1"], ["2"]],
            },
            "deleted sub": {
                input: "B:C2-1 s=Sa:1;C3-2 s;Bmaster=3",
                shas: [["1", "2", "3"]],
            },
            "deep files": {
                input: "B:C2-1 x/y/z=2,a/b/c=2,a/b/d=1;Bmaster=2",
                shas: [["1", "2"]],
            },
            "deep file with child": {
                input: "B:C2-1 x/y/z=2;C3-2 x/y/r=3;Bm=3",
                shas: [["1", "2"], ["3"]],
            },
            "deep file with child middle change": {
                input: "B:C2-1 x/y/z=2;C3-2 x/r/r=3;Bm=3",
                shas: [["1", "2"], ["3"]],
            },
            "deep file with missing change": {
                input: "B:C2-1 x/y/z=2;C3-2 a=b;C4-3 x/r/r=3;Bm=4",
                shas: [["1", "2"], ["3"], ["4"]],
            },
            "deep sub": {
                input: "B:C2-1 x/y/qq=Sa:1,aa/bb/cc=Sb:1;Bmaster=2",
                shas: [["1", "2"]],
            },
            "deep sub middle change": {
                input: "B:C2-1 x/y/qq=Sa:1,x/y/cc=Sb:1;Bmaster=2",
                shas: [["1", "2"]],
            },
            "deep sub with child": {
                input: `
B:C2-1 x/y/qq=Sa:1,aa/bb/cc=Sb:1;C3-2 x/y/zz=Sq:1,aa/bb/dd=Sy:1;
  C4-3 a/b/c=Sq:1,x/y/zy=Si:1;Bm=4`,
                shas: [["1", "2"], ["3"], ["4"]],
            },
            "deep sub with child middle change": {
                input: `
B:C2-1 x/y/qq=Sa:1,aa/bb/cc=Sb:1;C3-2 x/y/zz=Sq:1,aa/bb/dd=Sy:1;
  C4-3 aa/b/c=Sq:1,x/y/zy=Si:1;Bm=4`,
                shas: [["1", "2"], ["3"], ["4"]],
            },
            "deep sub with child missing middle change": {
                input: `
B:C2-1 x/y/qq=Sa:1,aa/bb/cc=Sb:1;C3-2 x/y/zz=Sq:1,aa/bb/dd=Sy:1;
  C4-3 aa/b/c=Sq:1;C5-4 x/r/q=Si:1;C6-5;
  C7-6 aa/n/q=Spp:1,x/n/q=Sqq:1;Bm=7`,
                shas: [["1", "2"], ["3"], ["4"], ["5"], ["6"], ["7"]],
            },
            "file with exec bit": {
                input: "N:C1 s=+2;Bmaster=1",
                shas: [["1"]],
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                let ast = c.input;
                if (!(ast instanceof RepoAST)) {
                    ast = ShorthandParserUtil.parseRepoShorthand(ast);
                }
                const path = yield TestUtil.makeTempDir();
                const repo = yield NodeGit.Repository.init(path, 1);
                const oldCommitMap = {};
                const treeCache = {};
                const inputCommits = ast.commits;
                const written = new Set();
                const newCommitMap = {};
                for (let i = 0; i < c.shas.length; ++i) {
                    const shas = c.shas[i];
                    const newToOld = yield WriteRepoASTUtil.writeCommits(
                                                                  oldCommitMap,
                                                                  treeCache,
                                                                  repo,
                                                                  inputCommits,
                                                                  shas);
                    Object.assign(newCommitMap, newToOld);

                    // We have to write a reference for each commit to make
                    // sure it will be read; `readRAST` loads only reachable
                    // commits.

                    for (let sha in newToOld) {
                        const id = NodeGit.Oid.fromString(sha);
                        yield NodeGit.Reference.create(repo,
                                                       `refs/reach/${sha}`,
                                                       id,
                                                       0,
                                                       "makde a ref");
                    }

                    const shasCheck = new Set(shas);
                    const newAst = yield ReadRepoASTUtil.readRAST(repo);

                    // Same as `ast` but with commit ids remapped to new ids.

                    const mappedNewAst =
                       RepoASTUtil.mapCommitsAndUrls(newAst, newCommitMap, {});

                    const newCommits = mappedNewAst.commits;
                    for (let sha in newCommits) {
                        if (shasCheck.delete(sha)) {
                            RepoASTUtil.assertEqualCommits(newCommits[sha],
                                                           inputCommits[sha]);
                        }
                        else {
                            assert(written.has(sha), `\
${sha} not in written list ${JSON.stringify(written)}`);
                        }
                        written.add(sha);
                    }
                    assert.equal(shasCheck.size, 0, "all commits written");
                }
            }));
        });
    });

    describe("writeRAST", function () {
        // We will "cheat" and utilize the already-tested `readRAST` to test
        // this one.

        const testCase = co.wrap(function *(testName,
                                            shorthand,
                                            expectedShorthand) {
            let ast = shorthand;
            if (!(ast instanceof RepoAST)) {
                ast = ShorthandParserUtil.parseRepoShorthand(shorthand);
            }
            let expectedAst = expectedShorthand;
            if (!(expectedAst instanceof RepoAST)) {
                expectedAst =
                           ShorthandParserUtil.parseRepoShorthand(expectedAst);
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

            RepoASTUtil.assertEqualASTs(mappedNewAst, expectedAst, testName);
        });

        // The general format for a case in this test driver is to specify a
        // string that is both the input and the expected value of the
        // repository after the repository is rendered.
        //
        // Certain types of strings may not be reflexive.  For example, when a
        // shorthand string denotes a rebase, that rebase is applied to the
        // repository after it has been written, and will change its state.
        // For these types of test cases, the case is given as an object
        // containing an `input` and `expected` string.

        const cases = {
            "simple": "S",
            "sparse": "%S:H=1",
            "new head": "S:C2-1;H=2",
            "simple with branch": "S:Bfoo=1",
            "simple with ref": "S:Bfoo=1;Fa/b=1",
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
            "with rebase": {
                input: "S:C2-1;C3-1;Bfoo=3;Bmaster=2;Efoo,2,3",
                expected: "S:C2-1;C3-1;Bfoo=3;Bmaster=2;Efoo,2,3;H=3",
            },
            "with rebase and workdir changes": {
                input: "\
S:C2-1 x=y;C3-1 x=z;Bmaster=2;Bfoo=3;Erefs/heads/master,2,3;W x=q",
                expected: "\
S:C2-1 x=y;C3-1 x=z;Bmaster=2;Bfoo=3;Erefs/heads/master,2,3;W x=q;H=3",
            },
            "with rebase and index changes": {
                input: "\
S:C2-1 x=y;C3-1 x=z;Bmaster=2;Bfoo=3;Erefs/heads/master,2,3;I x=q",
                expected: "\
S:C2-1 x=y;C3-1 x=z;Bmaster=2;Bfoo=3;Erefs/heads/master,2,3;I x=q;H=3",
            },
            "with in-progress sequencer": "S:QR 1:foo 1:bar 0 1",
            "sequencer with message": "S:Qfoo#R 1:foo 1:bar 0 1",
            "headless": {
                input: new RepoAST(),
                expected: new RepoAST(),
            },
            "conflict": "S:I *README.md=aa*bb*cc;W README.md=yyy",
            "conflict with exec": "S:I *README.md=aa*+bb*cc;W README.md=yyy",
            "submodule conflict": "S:I *README.md=aa*S:1*cc;W README.md=yyy",
            "index exec change": "S:I README.md=+hello world",
            "workdir exec change": "S:W README.md=+hello world",
            "workdir new exec file": "S:W foo=+hello world",
        };

        Object.keys(cases).forEach(caseName => {
            let input = cases[caseName];
            let expected = input;

            if ("string" !== typeof input) {
                expected = input.expected;
                input = input.input;
            }
            it(caseName, co.wrap(function *() {
                yield testCase(caseName, input, expected);
            }));
        });
    });

    describe("writeMultiRAST", function () {
        const cases = {
            "simple": "a=S",
            "simple sparse": "a=%S",
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
            "headless": {
                a: new RepoAST(),
            },
            "new sub open w/o SHA": "a=B|x=S:I s=Sa:;Os",
            "cloned": "a=B|x=Ca",
            "pathed tracking branch":
                "a=B:Bfoo/bar=1|x=Ca:Bfoo/bar=1 origin/foo/bar",
            "open submodule conflict":
                "a=B|x=U:I *README.md=aa*S:1*cc;W README.md=yyy;Os",
            "open sub with commit new to sub": "a=B|x=U:Os Cfoo-1!H=foo",
        };
        Object.keys(cases).forEach(caseName => {
            const input = cases[caseName];
            it(caseName, co.wrap(function *() {
                let inASTs = input;
                if ("string" === typeof input) {
                    inASTs =
                            ShorthandParserUtil.parseMultiRepoShorthand(input);
                }
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
        it("sparse subdir rm'd", co.wrap(function *() {
            const root = yield TestUtil.makeTempDir();
            const input = "a=B|x=%U";
            const asts = ShorthandParserUtil.parseMultiRepoShorthand(input);
            yield WriteRepoASTUtil.writeMultiRAST(asts, root);
            let exists = true;
            try {
                yield fs.stat(path.join(root, "x", "s"));
            } catch (e) {
                exists = false;
            }
            assert.equal(exists, false);
        }));
        it("sparse subdir rm'd, detached head", co.wrap(function *() {
            const root = yield TestUtil.makeTempDir();
            const input = "a=B|x=%U:H=2";
            const asts = ShorthandParserUtil.parseMultiRepoShorthand(input);
            yield WriteRepoASTUtil.writeMultiRAST(asts, root);
            let exists = true;
            try {
                yield fs.stat(path.join(root, "x", "s"));
            } catch (e) {
                exists = false;
            }
            assert.equal(exists, false);
        }));
    });
});
