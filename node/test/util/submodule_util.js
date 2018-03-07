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

const RepoASTTestUtil     = require("../../lib/util/repo_ast_test_util");
const TestUtil            = require("../../lib/util/test_util");
const SubmoduleChange     = require("../../lib/util/submodule_change");
const Submodule           = require("../../lib/util/submodule");
const SubmoduleUtil       = require("../../lib/util/submodule_util");
const SubmoduleConfigUtil = require("../../lib/util/submodule_config_util");
const UserError           = require("../../lib/util/user_error");

describe("SubmoduleUtil", function () {
    describe("getSubmoduleNames", function () {
        const cases = {
            "none": {
                state: "S",
                expected: [],
            },
            "one": {
                state: "S:C2-1 foo=S/a:1;H=2",
                expected: ["foo"],
            },
            "two": {
                state: "S:C2-1 foo=S/a:1;C3-2 bar=S/b:2;H=3",
                expected: ["foo", "bar"],
            },
            "one in index": {
                state: "S:I foo=S/a:1",
                expected: ["foo"],
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const repo = (yield RepoASTTestUtil.createRepo(c.state)).repo;
                const names = yield SubmoduleUtil.getSubmoduleNames(repo);
                assert.deepEqual(names.sort(), c.expected.sort());
            }));
        });
    });

    describe("getSubmoduleNamesForCommit", function () {
        // This method is implemented entirely in terms of
        // `getConfiguredSubmodulesForCommit`, so we'll just throw a couple of
        // cases at it to see that 

        const cases = {
            "none": {
                state: "S",
                commit: "1",
                expected: [],
            },
            "one": {
                state: "S:C2-1 foo=S/a:1;H=2",
                commit: "2",
                expected: ["foo"],
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const result = yield RepoASTTestUtil.createRepo(c.state);
                const repo = result.repo;
                const mappedCommitSha = result.oldCommitMap[c.commit];
                const commit = yield repo.getCommit(mappedCommitSha);
                const names = yield SubmoduleUtil.getSubmoduleNamesForCommit(
                                                                       repo,
                                                                       commit);
                assert.deepEqual(names.sort(), c.expected.sort());
            }));
        });
    });

    describe("getSubmoduleNamesForCommittish", function () {
        // This method is implemented in terms of `getSubmoduleNamesForCommit`;
        // we just need to do basic verification.

        const cases = {
            "none": { state: "S", branch: "master", expected: [], },
            "from master": {
                state: "S:C2-1 foo=S/a:1;Bmaster=2",
                branch: "master",
                expected: ["foo"],
            },
            "from another": {
                state: "S:C2-1 foo=S/a:1;Bbar=2",
                branch: "bar",
                expected: ["foo"],
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const repo = (yield RepoASTTestUtil.createRepo(c.state)).repo;
                const names = yield SubmoduleUtil.getSubmoduleNamesForBranch(
                                                                     repo,
                                                                     c.branch);
                assert.deepEqual(names.sort(), c.expected.sort());
            }));
        });
    });

    describe("getSubmoduleShasForCommit", function () {
         const cases = {
            "one": {
                state: "S:C2-1 foo=S/a:1;H=2",
                names: ["foo"],
                commit: "2",
                expected: { foo: "1" },
            },
            "missing": {
                state: "S",
                names: ["foo"],
                commit: "1",
                expected: {},
            },
            "from later commit": {
                state: "S:C2-1 x=S/a:1;C3-2 x=S/a:2;H=3",
                names: ["x"],
                commit: "3",
                expected: { x: "2" },
            },
            "from earlier commit": {
                state: "S:C2-1 x=S/a:1;C3-2 x=S/a:2;H=3",
                names: ["x"],
                commit: "2",
                expected: { x: "1" },
            },
            "one from two": {
                state: "S:C2-1 x=Sa:1,y=Sa:1;H=2",
                names: ["y"],
                commit: "2",
                expected: { y: "1" },
            },
            "two from two": {
                state: "S:C2-1 x=Sa:1,y=Sa:1;H=2",
                names: ["x", "y"],
                commit: "2",
                expected: { x: "1", y: "1" },
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written = yield RepoASTTestUtil.createRepo(c.state);
                const repo = written.repo;
                const mappedCommitSha = written.oldCommitMap[c.commit];
                const commit = yield repo.getCommit(mappedCommitSha);
                const result = yield SubmoduleUtil.getSubmoduleShasForCommit(
                                                                       repo,
                                                                       c.names,
                                                                       commit);
                let mappedResult = {};
                Object.keys(result).forEach((name) => {
                    mappedResult[name] = written.commitMap[result[name]];
                });
                assert.deepEqual(mappedResult, c.expected);
            }));
        });
    });

    describe("getSubmoduleShasForCommitish", function () {
        // The implementation of this method is delegated to
        // `getSubmoduleShasForCommit`; just exercise basic functionality.

        it("breathing", co.wrap(function *() {
            const written =
                        yield RepoASTTestUtil.createRepo("S:C2-1 x=Sa:1;Bm=2");
            const repo = written.repo;
            const result =
                  yield SubmoduleUtil.getSubmoduleShasForCommitish(repo, "m");
            assert.equal(written.commitMap[result.x], "1");
        }));
    });

    describe("getCurrentSubmoduleShas", function () {
         const cases = {
            "none": {
                state: "S",
                names: [],
                expected: [],
            },
            "one in commit": {
                state: "S:C2-1 x=Sa:1;H=2",
                names: ["x"],
                expected: ["1"],
            },
            "two in commit, one asked": {
                state: "S:C2-1 x=Sa:1;C3-2 y=Sa:2;H=3",
                names: ["x"],
                expected: ["1"],
            },
            "two in commit, two asked": {
                state: "S:C2-1 x=Sa:1;C3-2 y=Sa:2;H=3",
                names: ["x", "y"],
                expected: ["1", "2"],
            },
            "two in commit, second asked": {
                state: "S:C2-1 x=Sa:1;C3-2 y=Sa:2;H=3",
                names: ["y"],
                expected: ["2"],
            },
            "one overriden in index": {
                state: "S:C3-2;C2-1 x=Sa:1;H=3;I x=Sa:2",
                names: ["x"],
                expected: ["2"],
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written = yield RepoASTTestUtil.createRepo(c.state);
                const repo = written.repo;
                const index = yield repo.index();
                const result = yield SubmoduleUtil.getCurrentSubmoduleShas(
                                                                      index,
                                                                      c.names);
                const mappedResult = result.map(id => written.commitMap[id]);
                assert.deepEqual(mappedResult, c.expected);
            }));
        });
    });

    describe("isVisible", function () {
        // Will have to set up multiple repos this time because we cannot make
        // an open repo in the single repo world.  In each case, we will
        // operate on the repo named "x".

        const cases = {
            "simple not": {
                state: "a=S|x=S:C2-1 a=Sa:1;H=2",
                name: "a",
                expected: false,
            },
            "simple open": {
                state: "a=S|x=S:C2-1 a=Sa:1;Oa;H=2",
                name: "a",
                expected: true,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const w = yield RepoASTTestUtil.createMultiRepos(c.state);
                const x = w.repos.x;
                const result = yield SubmoduleUtil.isVisible(x, c.name);
                assert.equal(result, c.expected);
            }));
        });
    });

    describe("getRepo", function () {
        // This method is pretty simple; we'll validate that a repo was
        // returned with the expected path of the submodule.

        it("breathing", co.wrap(function *() {
            const shorthand = "a=S|b=S:I x=Sa:1;Ox";
            const written = yield RepoASTTestUtil.createMultiRepos(shorthand);
            const bRepo = written.repos.b;
            const xRepo = yield SubmoduleUtil.getRepo(bRepo, "x");
            assert(TestUtil.isSameRealPath(xRepo.workdir(),
                                           path.join(bRepo.workdir(), "x")));
        }));
    });

    describe("listOpenSubmodules", function () {
        // We will always inspect the repo `x`.

        const cases = {
            "simple": {
                input: "x=S",
                expected: [],
            },
            "one open": {
                input: "a=S|x=S:I q=Sa:1;Oq",
                expected: ["q"],
            },
            "two open": {
                input: "a=S|x=S:I q=Sa:1,s/x=Sa:1;Oq;Os/x",
                expected: ["q", "s/x"],
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written =
                               yield RepoASTTestUtil.createMultiRepos(c.input);
                const x = written.repos.x;
                const result = yield SubmoduleUtil.listOpenSubmodules(x);
                assert.deepEqual(result.sort(), c.expected.sort());
            }));
        });

        it("listOpenSubmodules-missing", co.wrap(function *() {
            // Verify that a module is not listed as open when it has an entry
            // in `.git/config` but is missing the `.git` link in its
            // directory.

            const repo = yield TestUtil.createSimpleRepository();
            const url =
                      "/Users/peabody/repos/git-meta-demo/scripts/demo/z-bare";
            SubmoduleConfigUtil.initSubmodule(repo.workdir(), "z", url);
            const openSubs = yield SubmoduleUtil.listOpenSubmodules(repo);
            assert.deepEqual(openSubs, []);
        }));

        it("missing from .gitmodules", co.wrap(function *() {
            const input = "a=B|x=U:Os";
            const written = yield RepoASTTestUtil.createMultiRepos(input);
            const x = written.repos.x;
            const modulesPath = path.join(x.workdir(),
                                          SubmoduleConfigUtil.modulesFileName);
            yield fs.unlink(modulesPath);
            const result = yield SubmoduleUtil.listOpenSubmodules(x);
            assert.deepEqual(result, []);
        }));
    });

    describe("getSubmoduleRepos", function () {
        // The functionality of this method is delegated to
        // `getSubmoduleNames`, `listOpenSubmodules`, and `getRepo`.  We just
        // need to test basic funtionality:
        // - it screens hidden submodules
        // - it returns visible submods and name map is good
        // - hidden ones are screened

        it("breathing", co.wrap(function *() {
            const shorthand = "a=S|b=S:I x=Sa:1,y=Sa:1;Ox";
            const written = yield RepoASTTestUtil.createMultiRepos(shorthand);
            const bRepo = written.repos.b;
            const result = yield SubmoduleUtil.getSubmoduleRepos(bRepo);
            assert.equal(result.length, 1);
            const x = result[0];
            assert.equal(x.name, "x");
            assert.instanceOf(x.repo, NodeGit.Repository);
        }));
    });

    describe("getSubmoduleChangesFromDiff", function () {
        const cases = {
            "trivial": {
                state: "S",
                from: "1",
                result: {},
                allowMetaChanges: true,
            },
            "trivial, no meta": {
                state: "S",
                from: "1",
                result: {},
                allowMetaChanges: false,
                fails: true,
            },
            "changed something else": {
                state: "S:C2-1 README.md=foo;H=2",
                from: "2",
                result: {},
                allowMetaChanges: true,
            },
            "changed something in meta, not allowed": {
                state: "S:C2-1 README.md=foo;H=2",
                from: "2",
                result: {},
                allowMetaChanges: false,
                fails: true,
            },
            "removed something else": {
                state: "S:C2-1 README.md;H=2",
                from: "2",
                result: {},
                allowMetaChanges: true,
            },
            "removed in meta, not allowed": {
                state: "S:C2-1 README.md;H=2",
                from: "2",
                result: {},
                allowMetaChanges: false,
                fails: true,
            },
            "not on current commit": {
                state: "S:C2-1 x=Sa:1;H=2",
                from: "1",
                result: {},
                allowMetaChanges: true,
            },
            "added one": {
                state: "S:C2-1 x=Sa:1;H=2",
                from: "2",
                result: {
                    "x": new SubmoduleChange(null, "1"),
                },
                allowMetaChanges: false,
            },
            "added two": {
                state: "S:C2-1 a=Sa:1,x=Sa:1;H=2",
                from: "2",
                result: {
                    a: new SubmoduleChange(null, "1"),
                    x: new SubmoduleChange(null, "1"),
                },
                allowMetaChanges: true,
            },
            "changed one": {
                state: "S:C3-2 a=Sa:2;C2-1 a=Sa:1,x=Sa:1;H=3",
                from: "3",
                result: {
                    a: new SubmoduleChange("1", "2"),
                },
                allowMetaChanges: true,
            },
            "changed url": {
                state: "S:C3-2 a=Sb:1;C2-1 a=Sa:1,x=Sa:1;H=3",
                from: "3",
                result: {},
                allowMetaChanges: true,
            },
            "changed and added": {
                state: "S:C3-2 a=Sa:2,c=Sa:2;C2-1 a=Sa:1,x=Sa:1;H=3",
                from: "3",
                result: {
                    a: new SubmoduleChange("1", "2"),
                    c: new SubmoduleChange(null, "2"),
                },
                allowMetaChanges: true,
            },
            "removed one": {
                state: "S:C3-2 a;C2-1 a=Sa:1,x=Sa:1;H=3",
                from: "3",
                result: {
                    a: new SubmoduleChange("1", null),
                },
                allowMetaChanges: false,
            },
            "added and removed": {
                state: "S:C3-2 a,c=Sa:2;C2-1 a=Sa:1,x=Sa:1;H=3",
                from: "3",
                result: {
                    c: new SubmoduleChange(null, "2"),
                    a: new SubmoduleChange("1", null),
                },
                allowMetaChanges: true,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written = yield RepoASTTestUtil.createRepo(c.state);
                const repo = written.repo;
                const fromSha = written.oldCommitMap[c.from];
                const fromId = NodeGit.Oid.fromString(fromSha);
                const commit = yield repo.getCommit(fromId);
                let parentTree = null;
                const parents = yield commit.getParents();
                if (0 !== parents.length) {
                    parentTree = yield parents[0].getTree();
                }
                const tree = yield commit.getTree();
                const diff = yield NodeGit.Diff.treeToTree(repo,
                                                           parentTree,
                                                           tree,
                                                           null);
                let changes;
                let exception;
                try {
                    changes = yield SubmoduleUtil.getSubmoduleChangesFromDiff(
                                                           diff,
                                                           c.allowMetaChanges);
                }
                catch (e) {
                    exception = e;
                }
                const shouldFail = c.fails || false;
                if (undefined === exception) {
                    assert.equal(false, shouldFail);
                }
                else {
                    if (!(exception instanceof UserError)) {
                        throw exception;
                    }
                    assert.equal(true, shouldFail);
                    return;                                           // RETURN
                }

                const commitMap = written.commitMap;

                // map the logical commits in the expected results to the
                // actual commit ids

                Object.keys(changes).forEach(name => {
                    const change = changes[name];
                    assert.instanceOf(change, SubmoduleChange);
                    const oldSha = change.oldSha && commitMap[change.oldSha];
                    const newSha = change.newSha && commitMap[change.newSha];
                    changes[name] = new SubmoduleChange(oldSha, newSha);
                });
                assert.deepEqual(changes, c.result);
            }));
        });
    });

    describe("getSubmoduleChanges", function () {
        // We know this is implemented in terms of
        // `getSubmoduleChangesFromDiff`, so we just need to verify that it's
        // hooked up correctly.

        const cases = {
            "trivial": {
                state: "S",
                from: "1",
                fails: true,
                allowMetaChanges: false,
            },
            "added one": {
                state: "S:C2-1 x=Sa:1;H=2",
                from: "2",
                result: {
                    "x": new SubmoduleChange(null, "1"),
                },
                allowMetaChanges: false,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written = yield RepoASTTestUtil.createRepo(c.state);
                const repo = written.repo;
                const fromSha = written.oldCommitMap[c.from];
                const fromId = NodeGit.Oid.fromString(fromSha);
                const commit = yield repo.getCommit(fromId);
                let changes;
                let exception;
                try {
                    changes = yield SubmoduleUtil.getSubmoduleChanges(
                                                           repo,
                                                           commit,
                                                           c.allowMetaChanges);
                }
                catch (e) {
                    exception = e;
                }
                const shouldFail = c.fails || false;
                if (undefined === exception) {
                    assert.equal(false, shouldFail);
                }
                else {
                    if (!(exception instanceof UserError)) {
                        throw exception;
                    }
                    assert.equal(true, shouldFail);
                    return;                                           // RETURN
                }

                const commitMap = written.commitMap;

                // map the logical commits in the expected results to the
                // actual commit ids

                Object.keys(changes).forEach(name => {
                    const change = changes[name];
                    assert.instanceOf(change, SubmoduleChange);
                    const oldSha = change.oldSha && commitMap[change.oldSha];
                    const newSha = change.newSha && commitMap[change.newSha];
                    changes[name] = new SubmoduleChange(oldSha, newSha);
                });
                assert.deepEqual(changes, c.result);
            }));
        });
    });
    describe("getSubmodulesForCommit", function () {
         const cases = {
            "one": {
                state: "S:C2-1 foo=Sa:1;H=2",
                commit: "2",
                expected: { foo: new Submodule("a", "1") },
                names: null,
            },
            "two": {
                state: "S:C2-1 foo=Sa:1,bar=Sa:1;H=2",
                commit: "2",
                expected: {
                    foo: new Submodule("a", "1"),
                    bar: new Submodule("a", "1"),
                },
                names: null,
            },
            "no names": {
                state: "S:C2-1 foo=Sa:1,bar=Sa:1;H=2",
                commit: "2",
                expected: {},
                names: [],
            },
            "bad name": {
                state: "S:C2-1 foo=Sa:1,bar=Sa:1;H=2",
                commit: "2",
                expected: {},
                names: ["whoo"],
            },
            "good name": {
                state: "S:C2-1 foo=Sa:1,bar=Sa:1;H=2",
                commit: "2",
                expected: {
                    bar: new Submodule("a", "1"),
                },
                names: ["bar"],
            },
            "from later commit": {
                state: "S:C2-1 x=S/a:1;C3-2 x=S/a:2;H=3",
                commit: "3",
                expected: { x: new Submodule("/a", "2") },
                names: null,
            },
             "none": {
                 state: "S:Cu 1=1;Bu=u",
                 commit: "u",
                 expected: {},
                 names: null,
             },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written = yield RepoASTTestUtil.createRepo(c.state);
                const repo = written.repo;
                const mappedCommitSha = written.oldCommitMap[c.commit];
                const commit = yield repo.getCommit(mappedCommitSha);
                const result = yield SubmoduleUtil.getSubmodulesForCommit(
                                                                      repo,
                                                                      commit,
                                                                      c.names);
                let mappedResult = {};
                Object.keys(result).forEach((name) => {
                    const resultSub = result[name];
                    const commit = written.commitMap[resultSub.sha];
                    mappedResult[name] = new Submodule(resultSub.url, commit);
                });
                assert.deepEqual(mappedResult, c.expected);
            }));
        });
    });
    describe("getSubmodulesInPath", function () {
        const cases = {
            "trivial": {
                state: "x=S",
                dir: "",
                indexSubNames: [],
                expected: [],
            },
            "got a sub": {
                state: "a=B|x=S:C2-1 q/r=Sa:1;Bmaster=2",
                dir: "",
                indexSubNames: ["q/r"],
                expected: ["q/r"],
            },
            "got a sub, by path": {
                state: "a=B|x=S:C2-1 q/r=Sa:1;Bmaster=2",
                dir: "q",
                indexSubNames: ["q/r"],
                expected: ["q/r"],
            },
            "got a sub, by exact path": {
                state: "a=B|x=S:C2-1 q/r=Sa:1;Bmaster=2",
                dir: "q/r",
                indexSubNames: ["q/r"],
                expected: ["q/r"],
            },
            "missed": {
                state: "a=B|x=S:C2-1 q/r=Sa:1;Bmaster=2",
                dir: "README.md",
                indexSubNames: ["q/r"],
                expected: [],
            },
            "missed, with a dot": {
                state: "a=B|x=S:C2-1 q/r=Sa:1;Bmaster=2;W .foo=bar",
                dir: ".foo",
                indexSubNames: ["q/r"],
                expected: [],
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written =
                               yield RepoASTTestUtil.createMultiRepos(c.state);
                const x = written.repos.x;
                const result = yield SubmoduleUtil.getSubmodulesInPath(
                                                              x.workdir(),
                                                              c.dir,
                                                              c.indexSubNames);
                assert.deepEqual(result.sort(), c.expected.sort());
            }));
        });
    });
    describe("resolveSubmoduleNames", function () {
        // We'll run this with 
        const cases = {
            "trivial": {
                state: "x=S",
                expected: [],
            },
            "bad path": {
                state: "x=S",
                paths: ["a-bad-path"],
                expected: [],
                fails: true,
            },
            "no subs in path": {
                state: "x=S:C2-1 foo/bar=baz;Bmaster=2",
                paths: ["foo"],
                expected: [],
            },
            "found a sub": {
                state: "a=B|x=U",
                paths: ["."],
                expected: ["s"],
            },
            "sub from relative": {
                state: "a=B|x=S:C2-1 s/t=Sa:1,t/u=Sa:1;Bmaster=2",
                paths: ["s"],
                expected: ["s/t"],
            },
            "multiple subs": {
                state: "a=B|x=S:C2-1 s/t=Sa:1,t/u=Sa:1;Bmaster=2",
                paths: ["s", "t"],
                expected: ["s/t", "t/u"],
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written =
                               yield RepoASTTestUtil.createMultiRepos(c.state);
                const x = written.repos.x;
                const subs = yield SubmoduleUtil.getSubmoduleNames(x);
                let cwd = x.workdir();
                if (c.cwd) {
                    cwd = path.join(c.workdir(), cwd);
                }
                const paths = c.paths || [];
                let result;
                try {
                    result = yield SubmoduleUtil.resolveSubmoduleNames(
                                                                   x.workdir(),
                                                                   cwd,
                                                                   subs,
                                                                   paths);
                }
                catch (e) {
                    if (!(e instanceof UserError)) {
                        throw e;
                    }
                    assert(c.fails);
                    return;
                }
                assert(!c.fails);
                assert.deepEqual(result.sort(), c.expected.sort());
            }));
        });
    });

    describe("resolvePaths", function () {
        // Work off of 'x'.

        const cases = {
            "trivial": {
                state: "x=S",
                paths: [],
                open: [],
                expected: {},
            },
            "got by path": {
                state: "a=B|x=U",
                paths: ["s"],
                open: [],
                expected: { "s": [] },
            },
            "inside path": {
                state: "a=B|x=U:Os",
                paths: ["s/README.md"],
                open: ["s"],
                expected: { "s": ["README.md"]},
            },
            "inside but not listed": {
                state: "a=B|x=U:Os",
                paths: ["s/README.md"],
                open: [],
                expected: {},
            },
            "two inside": {
                state: "a=B|x=U:Os I x/y=a,a/b=b",
                paths: ["s/x", "s/a"],
                open: ["s"],
                expected: { s: ["x","a"]},
            },
            "inside path, trumped by full path": {
                state: "a=B|x=U:Os",
                paths: ["s/README.md", "s"],
                open: ["s"],
                expected: { "s": []},
            },
            "two contained": {
                state: "a=B|x=S:I a/b=Sa:1,a/c=Sa:1",
                paths: ["a"],
                open: [],
                expected: {
                    "a/b": [],
                    "a/c": [],
                },
            },
            "two specified": {
                state: "a=B|x=S:I a/b=Sa:1,a/c=Sa:1",
                paths: ["a/b", "a/c"],
                open: [],
                expected: {
                    "a/b": [],
                    "a/c": [],
                },
            },
            "path not in sub": {
                state: "a=B|x=U:Os",
                paths: ["README.md"],
                open: ["s"],
                expected: {},
            },
            "filename starts with subname but not in it": {
                state: "a=B|x=U:I sam=3;Os",
                paths: ["sam"],
                open: ["s"],
                expected: {},
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const w = yield RepoASTTestUtil.createMultiRepos(c.state);
                const repo = w.repos.x;
                const workdir = repo.workdir();
                const subs = yield SubmoduleUtil.getSubmoduleNames(repo);
                const result = yield SubmoduleUtil.resolvePaths(workdir,
                                                                c.paths,
                                                                subs,
                                                                c.open);
                assert.deepEqual(result, c.expected);
            }));
        });
    });
    describe("addRefs", function () {
        const cases = {
            "trivial": {
                input: "x=S",
                refs: [],
                subs: [],
            },
            "copy one": {
                input: "a=B|x=U:Os",
                refs: ["refs/heads/master"],
                subs: ["s"],
                expected: "x=E:Os Bmaster=1",
            },
            "overwrite ref": {
                input: "a=B|x=U:Os C6-1!Bmaster=6",
                refs: ["refs/heads/master"],
                subs: ["s"],
                expected: "x=E:Os Bmaster=1",
            },
            "don't overwrite ref if current": {
                input: "a=B|x=U:Os C6-1!Bmaster=6!*=master",
                refs: ["refs/heads/master"],
                subs: ["s"],
            },
            "for ref w/o sub": {
                input: "a=B|x=U:Os;Bfoo=1",
                refs: ["refs/heads/foo"],
                subs: ["s"],
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const addRefs = co.wrap(function *(repos) {
                    const repo = repos.x;
                    yield SubmoduleUtil.addRefs(repo, c.refs, c.subs);
                });
                yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                               c.expected,
                                                               addRefs,
                                                               c.fails);
            }));
        });
    });
    describe("cacheSubmodules", function () {
        it("breathing", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            function op(r) {
                assert.equal(repo, r);
                return Promise.resolve(3);
            }
            const result = yield SubmoduleUtil.cacheSubmodules(repo, op);
            assert.equal(result, 3);
        }));
        it("exception", co.wrap(function *() {
            class MyException {}
            function op() {
                throw new MyException();
            }
            const repo = yield TestUtil.createSimpleRepository();
            try {
                yield SubmoduleUtil.cacheSubmodules(repo, op);
            }
            catch (e) {
                assert.instanceOf(e, MyException);
                return;
            }
            assert(false, "should have thrown");
        }));
    });
    describe("mergeModulesFile", function () {
        // This is largely tested in
        // `SubmoduleConfigUtil.mergeSubmoduleConfigs`.
        const cases = {
            "trivial": {
                input: "S:Cx-1;Bx=x;Cy-1;By=y",
                expected: {},
                result: true,
            },
            "one left": {
                input: "S:Cx-1 s=Sa:1;Bx=x;Cy-1;By=y",
                expected: {
                    s: "a",
                },
                result: true,
            },
            "one right": {
                input: "S:Cx-1;Bx=x;Cy-1 s=Sa:1;By=y",
                expected: {
                    s: "a",
                },
                result: true,
            },
            "one each": {
                input: "S:Cx-1 s=Sa:1;Cy-1 t=Sa:1;By=y;Bx=x",
                expected: {
                    s: "a",
                    t: "a",
                },
                result: true,
            },
            "conflict": {
                input: `
S:Cx-1 s=Sa:1;Cy-1 s=Sb:1;By=y;Bx=x;Cz-1 z=Sq:1;Bmaster=z`,
                expected: {
                    z: "q",
                },
                result: false,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written = yield RepoASTTestUtil.createRepo(c.input);
                const repo = written.repo;
                const fromSha = written.oldCommitMap.x;
                const ontoSha = written.oldCommitMap.y;
                const from = yield repo.getCommit(fromSha);
                const onto = yield repo.getCommit(ontoSha);
                const result = yield SubmoduleUtil.mergeModulesFile(repo,
                                                                    from,
                                                                    onto);
                assert.equal(result, c.result);
                const configPath = path.join(
                                          repo.workdir(),
                                          SubmoduleConfigUtil.modulesFileName);
                const data = yield fs.readFile(configPath, "utf8");
                const onDisk = SubmoduleConfigUtil.parseSubmoduleConfig(data);
                assert.deepEqual(c.expected, onDisk);
            }));
        });
    });
});
