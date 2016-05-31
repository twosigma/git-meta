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

const RepoAST             = require("../../lib/util/repo_ast");
const RepoASTIOUtil       = require("../../lib/util/repo_ast_io_util");
const RepoASTUtil         = require("../../lib/util/repo_ast_util");
const ShorthandParserUtil = require("../../lib/util/shorthand_parser_util");
const TestUtil            = require("../../lib/util/test_util");

                               // Test utilities

/**
 * Add a submodule to the specified `repo` that has the specified `url`
 * as the base repository for the submodule at the specified `path`.  Set the
 * sha for the submodule to the specified `sha`.
 *
 * @async
 * @private
 * @param {NodeGit.Repository} repo
 * @param {String}             url
 * @param {String}             path
 * @param {String}             sha
 */
const addSubmodule = co.wrap(function *(repo, url, path, sha) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(url);
    assert.isString(path);
    assert.isString(sha);
    const submodule = yield NodeGit.Submodule.addSetup(repo, url, path, 1);
    const subRepo = yield submodule.open();
    const origin = yield subRepo.getRemote("origin");
    yield origin.connect(NodeGit.Enums.DIRECTION.FETCH,
                         new NodeGit.RemoteCallbacks(),
                         function () {});
    yield subRepo.fetch("origin", {});
    subRepo.setHeadDetached(sha);
    yield submodule.addFinalize();
    return submodule;
});

/**
 * Create a repository with a branch and two commits and a `RepoAST` object
 * representing its expected state.
 *
 * @private
 * @async
 * @return {Object}
 * @return {NodeGit.Repository} return.repo
 * @return {RepoAST}            return.expected
 */
const repoWithCommit = co.wrap(function *() {
    const Commit = RepoAST.Commit;
    const r = yield TestUtil.createSimpleRepositoryOnBranch("foo");
    const headId = yield r.getHeadCommit();
    const firstCommit = headId.id().tostrS();
    const repoPath = r.workdir();
    const readmePath = path.join(repoPath, "README.md");
    const foobarPath = path.join(repoPath, "foobar");
    yield fs.appendFile(readmePath, "bleh");
    yield fs.appendFile(foobarPath, "meh");
    const anotherCommit =
                 yield TestUtil.makeCommit(r, ["README.md", "foobar"]);
    const secondCommit = anotherCommit.id().tostrS();
    let commits = {};
    commits[firstCommit] = new Commit({
        changes: { "README.md": ""}
    });
    commits[secondCommit] = new Commit({
        parents: [firstCommit],
        changes: {
            "README.md": "bleh",
            "foobar": "meh",
        }
    });
    const expected = new RepoAST({
        commits: commits,
        branches: {
            "master": firstCommit,
            "foo": secondCommit,
        },
        head: secondCommit,
        currentBranchName: "foo",
    });
    return {
        repo: r,
        expected: expected,
    };
});

/**
 * Create a repository with a chain of commits; return that repository and the
 * AST it is expected to have.
 *
 * @private
 * @async
 * @return {Object}
 * @return {NodeGit.Repository} return.repo
 * @return {RepoAST}            return.expected
 */
const repoWithDeeperCommits = co.wrap(function *() {
    const Commit = RepoAST.Commit;
    const r = yield TestUtil.createSimpleRepository();
    const headCommit = yield r.getHeadCommit();
    const firstCommit = headCommit.id().tostrS();
    const repoPath = r.workdir();
    const readmePath = path.join(repoPath, "README.md");
    yield fs.appendFile(readmePath, "bleh");
    const anotherCommit = yield TestUtil.makeCommit(r, ["README.md"]);
    const secondCommit = anotherCommit.id().tostrS();

    let commits = {};
    commits[firstCommit] = new Commit({
        changes: { "README.md": ""}
    });
    commits[secondCommit] = new Commit({
        changes: { "README.md": "bleh" },
        parents: [firstCommit],
    });
    const expected = new RepoAST({
        commits: commits,
        branches: { "master": secondCommit},
        head: secondCommit,
        currentBranchName: "master",
    });
    return {
        repo: r,
        expected: expected,
    };
});

describe("RepoAstIOUtil", function () {
    after(TestUtil.cleanup);

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
                const result = RepoASTIOUtil.buildDirectoryTree(c.input);
                assert.deepEqual(result, c.expected);
            });
        });
    });

    describe("readRAST", function () {
        const Commit = RepoAST.Commit;

        // We're going to test just those things we expect to support.

        after(TestUtil.cleanup);

        it("simple", co.wrap(function *() {
            const r = yield TestUtil.createSimpleRepository();
            const ast = yield RepoASTIOUtil.readRAST(r);
            const headId = yield r.getHeadCommit();
            const commit = headId.id().tostrS();
            let commits = {};
            commits[commit] = new Commit({
                changes: { "README.md": ""}
            });
            const expected = new RepoAST({
                commits: commits,
                branches: { "master": commit },
                head: commit,
                currentBranchName: "master",
            });
            RepoASTUtil.assertEqualASTs(ast, expected);
        }));

        it("nested path", co.wrap(function *() {
            const r = yield TestUtil.createSimpleRepository();
            const firstCommit  = yield r.getHeadCommit();
            const firstSha = firstCommit.id().tostrS();

            const repoPath = r.workdir();
            const fooPath = path.join(repoPath, "foo");
            yield fs.mkdir(fooPath);
            const barPath = path.join(fooPath, "bar");

            yield fs.writeFile(barPath, "meh");
            const secondCommit = yield TestUtil.makeCommit(r, ["foo/bar"]);
            const secondSha = secondCommit.id().tostrS();

            let commits = {};
            commits[firstSha] = new Commit({
                changes: { "README.md": ""}
            });
            commits[secondSha] = new Commit({
                parents: [firstSha],
                changes: { "foo/bar": "meh" },
            });
            const expected = new RepoAST({
                commits: commits,
                branches: { "master": secondSha },
                head: secondSha,
                currentBranchName: "master",
            });
            const ast = yield RepoASTIOUtil.readRAST(r);
            RepoASTUtil.assertEqualASTs(ast, expected);
        }));

        it("deletion", co.wrap(function *() {
            const r = yield TestUtil.createSimpleRepository();
            const headId = yield r.getHeadCommit();
            const headSha = headId.id().tostrS();
            let commits = {};
            yield fs.unlink(path.join(r.workdir(), "README.md"));
            const index = yield r.index();
            yield index.addAll("README.md", -1);
            index.write();
            const delCommit = yield TestUtil.makeCommit(r, ["README.md"]);
            const delSha = delCommit.id().tostrS();
            commits[headSha] = new Commit({
                changes: { "README.md": ""}
            });
            commits[delSha] = new Commit({
                parents: [headSha],
                changes: { "README.md": null },
            });
            const expected = new RepoAST({
                commits: commits,
                branches: { "master": delSha },
                head: delSha,
                currentBranchName: "master",
            });
            const ast = yield RepoASTIOUtil.readRAST(r);
            RepoASTUtil.assertEqualASTs(ast, expected);
        }));

        it("simple detached", co.wrap(function *() {
            const r = yield TestUtil.createSimpleRepository();
            r.detachHead();
            const branch = yield r.getBranch("master");
            NodeGit.Branch.delete(branch);
            const ast = yield RepoASTIOUtil.readRAST(r);
            const headId = yield r.getHeadCommit();
            const commit = headId.id().tostrS();
            let commits = {};
            commits[commit] = new Commit({
                changes: { "README.md": ""}
            });
            const expected = new RepoAST({
                commits: commits,
                branches: {},
                head: commit,
                currentBranchName: null,
            });
            RepoASTUtil.assertEqualASTs(ast, expected);
        }));

        it("simple on branch", co.wrap(function *() {
            const r = yield TestUtil.createSimpleRepositoryOnBranch("foo");
            const ast = yield RepoASTIOUtil.readRAST(r);
            const headId = yield r.getHeadCommit();
            const commit = headId.id().tostrS();
            let commits = {};
            commits[commit] = new Commit({
                changes: { "README.md": ""}
            });
            const expected = new RepoAST({
                commits: commits,
                branches: {
                    "master": commit,
                    "foo": commit
                },
                head: commit,
                currentBranchName: "foo",
            });
            RepoASTUtil.assertEqualASTs(ast, expected);
        }));

        it("another commit", co.wrap(function *() {

            const withAnother = yield repoWithCommit();
            const r = withAnother.repo;
            const expected = withAnother.expected;
            const ast = yield RepoASTIOUtil.readRAST(r);
            RepoASTUtil.assertEqualASTs(ast, expected);
        }));

        it("deep commits", co.wrap(function *() {
            const deeper = yield repoWithDeeperCommits();
            const ast = yield RepoASTIOUtil.readRAST(deeper.repo);
            RepoASTUtil.assertEqualASTs(ast, deeper.expected);
        }));

        it("bare", co.wrap(function *() {
            const r = yield TestUtil.createSimpleRepository();
            const path = yield TestUtil.makeTempDir();
            const bare = yield TestUtil.makeBareCopy(r, path);
            const ast = yield RepoASTIOUtil.readRAST(bare);
            const headId = yield r.getHeadCommit();
            const commit = headId.id().tostrS();
            let commits = {};
            commits[commit] = new Commit({
                changes: { "README.md": ""}
            });
            const expected = new RepoAST({
                commits: commits,
                branches: { "master": commit },
                head: null,
                currentBranchName: "master",
            });
            RepoASTUtil.assertEqualASTs(ast, expected);
        }));

        it("remote", co.wrap(function *() {
            const repos = yield TestUtil.createRepoAndRemote();
            const ast = yield RepoASTIOUtil.readRAST(repos.clone);
            const headId = yield repos.clone.getHeadCommit();
            const commit = headId.id().tostrS();
            let commits = {};
            commits[commit] = new Commit({
                changes: { "README.md": ""}
            });
            const path = repos.bare.path();
            const realPath = yield fs.realpath(path);
            const expected = new RepoAST({
                commits: commits,
                remotes: {
                    origin: new RepoAST.Remote(realPath, {
                        branches: {
                            master: commit,
                        }
                    }),
                },
                branches: { master: commit },
                currentBranchName: "master",
                head: commit,
            });
            RepoASTUtil.assertEqualASTs(ast, expected);
        }));

        it("missing remote", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const tempDir = yield TestUtil.makeTempDir();
            const url = path.join(tempDir, "no-path");
            NodeGit.Remote.create(repo, "badremote", url);
            const ast = yield RepoASTIOUtil.readRAST(repo);
            const headId = yield repo.getHeadCommit();
            const commit = headId.id().tostrS();
            let commits = {};
            commits[commit] = new Commit({
                changes: { "README.md": ""}
            });
            const expected = new RepoAST({
                commits: commits,
                remotes: { badremote: new RepoAST.Remote(url), },
                branches: { master: commit },
                currentBranchName: "master",
                head: commit,
            });
            RepoASTUtil.assertEqualASTs(ast, expected);
        }));

        it("submodule in commit", co.wrap(function *() {

            // Here going to create a commit that adds a submodule and verify
            // that we can read it back that wah.

            const repo = yield TestUtil.createSimpleRepository();
            const headCommit = yield repo.getHeadCommit();
            const baseSubRepo = yield TestUtil.createSimpleRepository();
            const baseSubPath = baseSubRepo.workdir();
            const subHead = yield baseSubRepo.getHeadCommit();
            yield addSubmodule(repo,
                               baseSubPath,
                               "x/y",
                               subHead.id().tostrS());
            const commit = yield TestUtil.makeCommit(repo,
                                                     ["x/y", ".gitmodules"]);
            let commits = {};
            commits[headCommit.id().tostrS()] = new Commit({
                changes: {"README.md":""},
            });
            commits[commit.id().tostrS()] = new Commit({
                parents: [headCommit.id().tostrS()],
                changes: {
                    "x/y": new RepoAST.Submodule(baseSubPath,
                                                 subHead.id().tostrS()),
                },
            });
            const expected = new RepoAST({
                commits: commits,
                branches: { master: commit.id().tostrS() },
                currentBranchName: "master",
                head: commit.id().tostrS(),
            });
            const actual = yield RepoASTIOUtil.readRAST(repo);
            RepoASTUtil.assertEqualASTs(actual, expected);
        }));

        it("change submodule in commit", co.wrap(function *() {

            // This is just like the previous test: we make a commit that adds
            // a submodule, but we're also going to have a subsequent commit
            // that updates that submodule to point to a different sha.

            const repo = yield TestUtil.createSimpleRepository();
            const headCommit = yield repo.getHeadCommit();
            const baseSubRepo = yield TestUtil.createSimpleRepository();
            const baseSubPath = baseSubRepo.workdir();
            const subHead = yield baseSubRepo.getHeadCommit();
            const submodule = yield addSubmodule(repo,
                                                 baseSubPath,
                                                 "x/y",
                                                 subHead.id().tostrS());
            const commit = yield TestUtil.makeCommit(repo,
                                                     ["x/y", ".gitmodules"]);

            const subRepo = yield submodule.open();
            const anotherSubCommit = yield TestUtil.generateCommit(subRepo);
            const lastCommit = yield TestUtil.makeCommit(repo, ["x/y"]);

            let commits = {};
            commits[headCommit.id().tostrS()] = new Commit({
                changes: {"README.md":""},
            });
            commits[commit.id().tostrS()] = new Commit({
                parents: [headCommit.id().tostrS()],
                changes: {
                    "x/y": new RepoAST.Submodule(baseSubPath,
                                                 subHead.id().tostrS()),
                },
            });
            commits[lastCommit.id().tostrS()] = new Commit({
                parents: [commit.id().tostrS()],
                changes: {
                    "x/y": new RepoAST.Submodule(
                                                baseSubPath,
                                                anotherSubCommit.id().tostrS())
                },
            });
            const expected = new RepoAST({
                commits: commits,
                branches: { master: lastCommit.id().tostrS() },
                currentBranchName: "master",
                head: lastCommit.id().tostrS(),
            });
            const actual = yield RepoASTIOUtil.readRAST(repo);
            RepoASTUtil.assertEqualASTs(actual, expected);
        }));

        it("index change", co.wrap(function *() {
            const r = yield TestUtil.createSimpleRepository();
            const headId = yield r.getHeadCommit();
            const commit = headId.id().tostrS();

            const readmePath = path.join(r.workdir(), "README.md");

            yield fs.appendFile(readmePath, "foo");
            const index = yield r.index();
            index.addByPath("README.md");
            index.write();

            let commits = {};
            commits[commit] = new Commit({
                changes: { "README.md": ""}
            });
            const expected = new RepoAST({
                commits: commits,
                branches: { "master": commit },
                head: commit,
                currentBranchName: "master",
                index: { "README.md": "foo" },
            });
            const ast = yield RepoASTIOUtil.readRAST(r);
            RepoASTUtil.assertEqualASTs(ast, expected);
        }));

        it("index add", co.wrap(function *() {
            const r = yield TestUtil.createSimpleRepository();
            const headId = yield r.getHeadCommit();
            const commit = headId.id().tostrS();

            const fooPath = path.join(r.workdir(), "foo");

            yield fs.appendFile(fooPath, "foo");
            const index = yield r.index();
            index.addByPath("foo");
            index.write();

            let commits = {};
            commits[commit] = new Commit({
                changes: { "README.md": ""}
            });
            const expected = new RepoAST({
                commits: commits,
                branches: { "master": commit },
                head: commit,
                currentBranchName: "master",
                index: { "foo": "foo" },
            });
            const ast = yield RepoASTIOUtil.readRAST(r);
            RepoASTUtil.assertEqualASTs(ast, expected);
        }));

        it("index add but rm from workdir", co.wrap(function *() {
            const r = yield TestUtil.createSimpleRepository();
            const headId = yield r.getHeadCommit();
            const commit = headId.id().tostrS();

            const fooPath = path.join(r.workdir(), "foo");

            yield fs.appendFile(fooPath, "foo");
            const index = yield r.index();
            index.addByPath("foo");
            index.write();

            fs.unlink(fooPath);

            let commits = {};
            commits[commit] = new Commit({
                changes: { "README.md": ""}
            });
            const expected = new RepoAST({
                commits: commits,
                branches: { "master": commit },
                head: commit,
                currentBranchName: "master",
                index: { "foo": "foo" },
                workdir: { "foo": null },
            });
            const ast = yield RepoASTIOUtil.readRAST(r);
            RepoASTUtil.assertEqualASTs(ast, expected);
        }));

        it("index deletion change", co.wrap(function *() {
            const r = yield TestUtil.createSimpleRepository();
            const headId = yield r.getHeadCommit();
            const commit = headId.id().tostrS();

            const readmePath = path.join(r.workdir(), "README.md");

            yield fs.unlink(readmePath);
            const index = yield r.index();
            yield index.addAll("README.md", -1);
            index.write();

            let commits = {};
            commits[commit] = new Commit({
                changes: { "README.md": ""}
            });
            const expected = new RepoAST({
                commits: commits,
                branches: { "master": commit },
                head: commit,
                currentBranchName: "master",
                index: { "README.md": null },
            });
            const ast = yield RepoASTIOUtil.readRAST(r);
            RepoASTUtil.assertEqualASTs(ast, expected);
        }));

        it("submodule in index", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const headCommit = yield repo.getHeadCommit();
            const baseSubRepo = yield TestUtil.createSimpleRepository();
            const baseSubPath = baseSubRepo.workdir();
            const subHead = yield baseSubRepo.getHeadCommit();
            yield addSubmodule(repo,
                               baseSubPath,
                               "x/y",
                               subHead.id().tostrS());
            let commits = {};
            commits[headCommit.id().tostrS()] = new Commit({
                changes: {"README.md":""},
            });
            const expected = new RepoAST({
                commits: commits,
                branches: { master: headCommit.id().tostrS() },
                currentBranchName: "master",
                head: headCommit.id().tostrS(),
                index: {
                    "x/y": new RepoAST.Submodule(baseSubPath,
                                                 subHead.id().tostrS()),
                },
            });
            const actual = yield RepoASTIOUtil.readRAST(repo);
            RepoASTUtil.assertEqualASTs(actual, expected);
        }));

        it("change submodule in index", co.wrap(function *() {

            // This is just like the previous test: we make a commit that adds
            // a submodule, but we're also going to have a subsequent change
            // that updates that submodule to point to a different sha.

            const repo = yield TestUtil.createSimpleRepository();
            const headCommit = yield repo.getHeadCommit();
            const baseSubRepo = yield TestUtil.createSimpleRepository();
            const baseSubPath = baseSubRepo.workdir();
            const subHead = yield baseSubRepo.getHeadCommit();
            const submodule = yield addSubmodule(repo,
                                                 baseSubPath,
                                                 "x/y",
                                                 subHead.id().tostrS());
            const commit = yield TestUtil.makeCommit(repo,
                                                     ["x/y", ".gitmodules"]);

            const subRepo = yield submodule.open();
            const nextSubCommit = yield TestUtil.generateCommit(subRepo);
            const index = yield repo.index();
            yield index.addAll("x/y", -1);
            let commits = {};
            commits[headCommit.id().tostrS()] = new Commit({
                changes: {"README.md":""},
            });
            commits[commit.id().tostrS()] = new Commit({
                parents: [headCommit.id().tostrS()],
                changes: {
                    "x/y": new RepoAST.Submodule(baseSubPath,
                                                 subHead.id().tostrS()),
                },
            });
            const expected = new RepoAST({
                commits: commits,
                branches: { master: commit.id().tostrS() },
                currentBranchName: "master",
                head: commit.id().tostrS(),
                index: {
                    "x/y": new RepoAST.Submodule(baseSubPath,
                                                 nextSubCommit.id().tostrS()),
                },
            });
            const actual = yield RepoASTIOUtil.readRAST(repo);
            RepoASTUtil.assertEqualASTs(actual, expected);
        }));

        it("workdir deletion", co.wrap(function *() {
            const r = yield TestUtil.createSimpleRepository();
            const headCommit = yield r.getHeadCommit();
            yield fs.unlink(path.join(r.workdir(), "README.md"));
            let commits = {};
            commits[headCommit.id().tostrS()] = new Commit({
                changes: {"README.md":""},
            });
            const expected = new RepoAST({
                commits: commits,
                branches: { master: headCommit.id().tostrS() },
                currentBranchName: "master",
                head: headCommit.id().tostrS(),
                workdir: { "README.md": null },
            });
            const actual = yield RepoASTIOUtil.readRAST(r);
            RepoASTUtil.assertEqualASTs(actual, expected);
        }));

        it("workdir addition", co.wrap(function *() {
            const r = yield TestUtil.createSimpleRepository();
            const headCommit = yield r.getHeadCommit();
            yield fs.appendFile(path.join(r.workdir(), "foo"), "x");
            let commits = {};
            commits[headCommit.id().tostrS()] = new Commit({
                changes: {"README.md":""},
            });
            const expected = new RepoAST({
                commits: commits,
                branches: { master: headCommit.id().tostrS() },
                currentBranchName: "master",
                head: headCommit.id().tostrS(),
                workdir: { foo: "x" },
            });
            const actual = yield RepoASTIOUtil.readRAST(r);
            RepoASTUtil.assertEqualASTs(actual, expected);
        }));

        it("workdir change", co.wrap(function *() {
            const r = yield TestUtil.createSimpleRepository();
            const headCommit = yield r.getHeadCommit();
            yield fs.appendFile(path.join(r.workdir(), "README.md"), "x");
            let commits = {};
            commits[headCommit.id().tostrS()] = new Commit({
                changes: {"README.md":""},
            });
            const expected = new RepoAST({
                commits: commits,
                branches: { master: headCommit.id().tostrS() },
                currentBranchName: "master",
                head: headCommit.id().tostrS(),
                workdir: { "README.md": "x" },
            });
            const actual = yield RepoASTIOUtil.readRAST(r);
            RepoASTUtil.assertEqualASTs(actual, expected);
        }));

        it("workdir and index change", co.wrap(function *() {
            const r = yield TestUtil.createSimpleRepository();
            const headCommit = yield r.getHeadCommit();
            yield fs.appendFile(path.join(r.workdir(), "README.md"), "x");
            const index = yield r.index();
            index.addByPath("README.md");
            index.write();
            yield fs.appendFile(path.join(r.workdir(), "README.md"), "y");
            let commits = {};
            commits[headCommit.id().tostrS()] = new Commit({
                changes: {"README.md":""},
            });
            const expected = new RepoAST({
                commits: commits,
                branches: { master: headCommit.id().tostrS() },
                currentBranchName: "master",
                head: headCommit.id().tostrS(),
                index: { "README.md": "x" },
                workdir: { "README.md": "xy" },
            });
            const actual = yield RepoASTIOUtil.readRAST(r);
            RepoASTUtil.assertEqualASTs(actual, expected);
        }));
    });

    describe("writeRAST", function () {
        // We will "cheat" and utilize the already-tested `readRAST` to test
        // this one.

        const testCase = co.wrap(function *(shorthand, testName) {
            const ast = ShorthandParserUtil.parseRepoShorthand(shorthand);
            const path = yield TestUtil.makeTempDir();
            const result = yield RepoASTIOUtil.writeRAST(ast, path);
            const repoPath = result.repo.isBare() ?
                             result.repo.path() :
                             result.repo.workdir();
            const samePath = yield TestUtil.isSameRealPath(path, repoPath);
            assert(samePath, `${path} === ${repoPath}`);
            assert.instanceOf(result.repo, NodeGit.Repository);
            assert.isObject(result.commitMap);
            const newAst = yield RepoASTIOUtil.readRAST(result.repo);

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
        };
        Object.keys(cases).forEach(caseName => {
            const input = cases[caseName];
            it(caseName, co.wrap(function *() {
                const inASTs =
                            ShorthandParserUtil.parseMultiRepoShorthand(input);
                const result = yield RepoASTIOUtil.writeMultiRAST(inASTs);
                assert.isObject(result);
                assert.isObject(result.repos);
                assert.isObject(result.commitMap);
                assert.isObject(result.urlMap);
                let resultASTs = {};
                for (let repoName in result.repos) {
                    const repo = result.repos[repoName];
                    const resultAST = yield RepoASTIOUtil.readRAST(repo);
                    const mapped = RepoASTUtil.mapCommitsAndUrls(
                                                              resultAST,
                                                              result.commitMap,
                                                              result.urlMap);
                    resultASTs[repoName] = mapped;
                }
                RepoASTUtil.assertEqualRepoMaps(resultASTs, inASTs);
            }));
        });
    });

});
