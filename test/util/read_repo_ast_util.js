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

const Close               = require("../../lib/util/close");
const RepoAST             = require("../../lib/util/repo_ast");
const ReadRepoASTUtil     = require("../../lib/util/read_repo_ast_util");
const RepoASTUtil         = require("../../lib/util/repo_ast_util");
const TestUtil            = require("../../lib/util/test_util");

                               // Test utilities

/**
 * Return the AST representing the state of the specified `repo` created by
 * `TestUtil.createSimpleRepository`.
 *
 * @async
 * @private
 * @param {NodeGit.Repository} repo
 * @return {RepoAST}
 */
const astFromSimpleRepo = co.wrap(function *(repo) {
    const headId = yield repo.getHeadCommit();
    const commit = headId.id().tostrS();
    let commits = {};
    commits[commit] = new RepoAST.Commit({
        changes: { "README.md": ""},
        message: "first commit",
    });
    return new RepoAST({
        commits: commits,
        branches: { "master": commit },
        head: commit,
        currentBranchName: "master",
    });
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
        changes: { "README.md": ""},
        message: "first commit",
    });
    commits[secondCommit] = new Commit({
        parents: [firstCommit],
        changes: {
            "README.md": "bleh",
            "foobar": "meh",
        },
        message: "message",
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
        changes: { "README.md": ""},
        message: "first commit",
    });
    commits[secondCommit] = new Commit({
        changes: { "README.md": "bleh" },
        parents: [firstCommit],
        message: "message",
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
    const commit = yield subRepo.getCommit(sha);
    yield NodeGit.Reset.reset(subRepo, commit, NodeGit.Reset.TYPE.HARD);
    yield submodule.addFinalize();
    return submodule;
});


describe("readRAST", function () {
    const Commit = RepoAST.Commit;

    // We're going to test just those things we expect to support.

    it("simple", co.wrap(function *() {
        const r = yield TestUtil.createSimpleRepository();
        const ast = yield ReadRepoASTUtil.readRAST(r);
        const headId = yield r.getHeadCommit();
        const commit = headId.id().tostrS();
        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": ""},
            message: "first commit",
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
            changes: { "README.md": ""},
            message: "first commit",
        });
        commits[secondSha] = new Commit({
            parents: [firstSha],
            changes: { "foo/bar": "meh" },
            message: "message",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { "master": secondSha },
            head: secondSha,
            currentBranchName: "master",
        });
        const ast = yield ReadRepoASTUtil.readRAST(r);
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
        const delCommit = yield TestUtil.makeCommit(r, []);
        const delSha = delCommit.id().tostrS();
        commits[headSha] = new Commit({
            changes: { "README.md": ""},
            message: "first commit",
        });
        commits[delSha] = new Commit({
            parents: [headSha],
            changes: { "README.md": null },
            message: "message",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { "master": delSha },
            head: delSha,
            currentBranchName: "master",
        });
        const ast = yield ReadRepoASTUtil.readRAST(r);
        RepoASTUtil.assertEqualASTs(ast, expected);
    }));

    it("simple detached", co.wrap(function *() {
        const r = yield TestUtil.createSimpleRepository();
        r.detachHead();
        const branch = yield r.getBranch("master");
        NodeGit.Branch.delete(branch);
        const ast = yield ReadRepoASTUtil.readRAST(r);
        const headId = yield r.getHeadCommit();
        const commit = headId.id().tostrS();
        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": ""},
            message: "first commit",
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
        const ast = yield ReadRepoASTUtil.readRAST(r);
        const headId = yield r.getHeadCommit();
        const commit = headId.id().tostrS();
        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": ""},
            message: "first commit",
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
        const ast = yield ReadRepoASTUtil.readRAST(r);
        RepoASTUtil.assertEqualASTs(ast, expected);
    }));

    it("deep commits", co.wrap(function *() {
        const deeper = yield repoWithDeeperCommits();
        const ast = yield ReadRepoASTUtil.readRAST(deeper.repo);
        RepoASTUtil.assertEqualASTs(ast, deeper.expected);
    }));

    it("bare", co.wrap(function *() {
        const r = yield TestUtil.createSimpleRepository();
        const path = yield TestUtil.makeTempDir();
        const bare = yield TestUtil.makeBareCopy(r, path);
        const ast = yield ReadRepoASTUtil.readRAST(bare);
        const headId = yield r.getHeadCommit();
        const commit = headId.id().tostrS();
        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": ""},
            message: "first commit",
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
        const ast = yield ReadRepoASTUtil.readRAST(repos.clone);
        const headId = yield repos.clone.getHeadCommit();
        const commit = headId.id().tostrS();
        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": ""},
            message: "first commit",
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
        const ast = yield ReadRepoASTUtil.readRAST(repo);
        const headId = yield repo.getHeadCommit();
        const commit = headId.id().tostrS();
        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": ""},
            message: "first commit",
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

        yield Close.close(repo, "x/y");
        const commit = yield TestUtil.makeCommit(repo,
                                                 ["x/y", ".gitmodules"]);
        let commits = {};
        commits[headCommit.id().tostrS()] = new Commit({
            changes: {"README.md":""},
            message: "first commit",
        });
        commits[commit.id().tostrS()] = new Commit({
            parents: [headCommit.id().tostrS()],
            changes: {
                "x/y": new RepoAST.Submodule(baseSubPath,
                                             subHead.id().tostrS()),
            },
            message: "message",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { master: commit.id().tostrS() },
            currentBranchName: "master",
            head: commit.id().tostrS(),
        });
        const actual = yield ReadRepoASTUtil.readRAST(repo);
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
        yield Close.close(repo, "x/y");

        let commits = {};
        commits[headCommit.id().tostrS()] = new Commit({
            changes: {"README.md":""},
            message: "first commit",
        });
        commits[commit.id().tostrS()] = new Commit({
            parents: [headCommit.id().tostrS()],
            changes: {
                "x/y": new RepoAST.Submodule(baseSubPath,
                                             subHead.id().tostrS()),
            },
            message: "message",
        });
        commits[lastCommit.id().tostrS()] = new Commit({
            parents: [commit.id().tostrS()],
            changes: {
                "x/y": new RepoAST.Submodule(
                                            baseSubPath,
                                            anotherSubCommit.id().tostrS())
            },
            message: "message",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { master: lastCommit.id().tostrS() },
            currentBranchName: "master",
            head: lastCommit.id().tostrS(),
        });
        const actual = yield ReadRepoASTUtil.readRAST(repo);
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
            changes: { "README.md": ""},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { "master": commit },
            head: commit,
            currentBranchName: "master",
            index: { "README.md": "foo" },
        });
        const ast = yield ReadRepoASTUtil.readRAST(r);
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
            changes: { "README.md": ""},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { "master": commit },
            head: commit,
            currentBranchName: "master",
            index: { "foo": "foo" },
        });
        const ast = yield ReadRepoASTUtil.readRAST(r);
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
            changes: { "README.md": ""},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { "master": commit },
            head: commit,
            currentBranchName: "master",
            index: { "foo": "foo" },
            workdir: { "foo": null },
        });
        const ast = yield ReadRepoASTUtil.readRAST(r);
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
            changes: { "README.md": ""},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { "master": commit },
            head: commit,
            currentBranchName: "master",
            index: { "README.md": null },
        });
        const ast = yield ReadRepoASTUtil.readRAST(r);
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
        yield Close.close(repo, "x/y");

        let commits = {};
        commits[headCommit.id().tostrS()] = new Commit({
            changes: {"README.md":""},
            message: "first commit",
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
        const actual = yield ReadRepoASTUtil.readRAST(repo);
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
        yield Close.close(repo, "x/y");

        let commits = {};
        commits[headCommit.id().tostrS()] = new Commit({
            changes: {"README.md":""},
            message: "first commit",
        });
        commits[commit.id().tostrS()] = new Commit({
            parents: [headCommit.id().tostrS()],
            changes: {
                "x/y": new RepoAST.Submodule(baseSubPath,
                                             subHead.id().tostrS()),
            },
            message: "message",
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
        const actual = yield ReadRepoASTUtil.readRAST(repo);
        RepoASTUtil.assertEqualASTs(actual, expected);
    }));

    it("workdir deletion", co.wrap(function *() {
        const r = yield TestUtil.createSimpleRepository();
        const headCommit = yield r.getHeadCommit();
        yield fs.unlink(path.join(r.workdir(), "README.md"));
        let commits = {};
        commits[headCommit.id().tostrS()] = new Commit({
            changes: {"README.md":""},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { master: headCommit.id().tostrS() },
            currentBranchName: "master",
            head: headCommit.id().tostrS(),
            workdir: { "README.md": null },
        });
        const actual = yield ReadRepoASTUtil.readRAST(r);
        RepoASTUtil.assertEqualASTs(actual, expected);
    }));

    it("workdir addition", co.wrap(function *() {
        const r = yield TestUtil.createSimpleRepository();
        const headCommit = yield r.getHeadCommit();
        yield fs.appendFile(path.join(r.workdir(), "foo"), "x");
        let commits = {};
        commits[headCommit.id().tostrS()] = new Commit({
            changes: {"README.md":""},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { master: headCommit.id().tostrS() },
            currentBranchName: "master",
            head: headCommit.id().tostrS(),
            workdir: { foo: "x" },
        });
        const actual = yield ReadRepoASTUtil.readRAST(r);
        RepoASTUtil.assertEqualASTs(actual, expected);
    }));

    it("workdir change", co.wrap(function *() {
        const r = yield TestUtil.createSimpleRepository();
        const headCommit = yield r.getHeadCommit();
        yield fs.appendFile(path.join(r.workdir(), "README.md"), "x");
        let commits = {};
        commits[headCommit.id().tostrS()] = new Commit({
            changes: {"README.md":""},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { master: headCommit.id().tostrS() },
            currentBranchName: "master",
            head: headCommit.id().tostrS(),
            workdir: { "README.md": "x" },
        });
        const actual = yield ReadRepoASTUtil.readRAST(r);
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
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { master: headCommit.id().tostrS() },
            currentBranchName: "master",
            head: headCommit.id().tostrS(),
            index: { "README.md": "x" },
            workdir: { "README.md": "xy" },
        });
        const actual = yield ReadRepoASTUtil.readRAST(r);
        RepoASTUtil.assertEqualASTs(actual, expected);
    }));

    it("open submodule", co.wrap(function *() {
        const r = yield TestUtil.createSimpleRepository();
        const baseSub = yield TestUtil.createSimpleRepository();
        const baseHead = yield baseSub.getHeadCommit();
        const baseSha = baseHead.id().tostrS();

        const subAST = yield astFromSimpleRepo(baseSub);

        yield addSubmodule(r, baseSub.workdir(), "foo", baseSha);

        const baseExpected = yield astFromSimpleRepo(r);
        const expected = baseExpected.copy({
            index: {
                foo: new RepoAST.Submodule(baseSub.workdir(), baseSha),
            },
            openSubmodules: {
                foo: subAST.copy({
                    branches: {},
                    currentBranchName: null,
                    remotes: {
                        origin: new RepoAST.Remote(baseSub.workdir(), {
                            branches: {
                                master: baseSha,
                            }
                        }),
                    },
                }),
            },
        });
        const ast = yield ReadRepoASTUtil.readRAST(r);
        RepoASTUtil.assertEqualASTs(ast, expected);
    }));

    it("merge commit", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        const workdir = repo.workdir();
        const firstCommit = yield repo.getHeadCommit();
        const firstSha = firstCommit.id().tostrS();
        const sig = repo.defaultSignature();
        yield repo.createBranch("b", firstCommit, 0, sig);
        yield repo.checkoutBranch("b");
        yield fs.writeFile(path.join(workdir, "foo"), "foo");
        const commitB = yield TestUtil.makeCommit(repo, ["foo"]);
        const bSha = commitB.id().tostrS();
        yield repo.checkoutBranch("master");
        yield fs.writeFile(path.join(workdir, "bar"), "bar");
        const commitC = yield TestUtil.makeCommit(repo, ["bar"]);
        const cSha = commitC.id().tostrS();
        const mergeId = yield repo.mergeBranches(
                                                 "refs/heads/master",
                                                 "refs/heads/b",
                                                 sig,
                                                 NodeGit.Merge.PREFERENCE.NONE,
                                                 {});
        const mergeSha = mergeId.tostrS();
        const commits = {};
        const Commit = RepoAST.Commit;
        commits[firstSha] = new Commit({
            changes: { "README.md": "", },
            message: "first commit",
        });
        commits[bSha] = new Commit({
            parents: [firstSha],
            changes: { foo: "foo" },
            message: "message",
        });
        commits[cSha] = new Commit({
            parents: [firstSha],
            changes: { bar: "bar" },
            message: "message",
        });
        commits[mergeSha] = new Commit({
            parents: [cSha, bSha],
            changes: { foo: "foo" },
            message: "Merged b into master",
        });
        const expected = new RepoAST({
            head: mergeSha,
            currentBranchName: "master",
            branches: {
                master: mergeSha,
                b: bSha,
            },
            commits: commits,
        });
        const actual = yield ReadRepoASTUtil.readRAST(repo);
        RepoASTUtil.assertEqualASTs(actual, expected);
    }));

    it("merge commit with submodule change", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        const sig = repo.defaultSignature();

        // Create the base repo for the submodule and add a couple of
        // commits.

        const base = yield TestUtil.createSimpleRepository();
        const basePath = base.workdir();
        const baseMaster = yield base.getHeadCommit();
        const baseMasterSha = baseMaster.id().tostrS();
        yield base.createBranch("foo", baseMaster, 0, sig);
        yield base.checkoutBranch("foo");
        yield fs.writeFile(path.join(basePath, "foo"), "foo");
        const fooCommit = yield TestUtil.makeCommit(base, ["foo"]);
        const fooSha = fooCommit.id().tostrS();
        yield base.createBranch("bar", baseMaster, 0, sig);
        yield base.checkoutBranch("bar");
        yield fs.writeFile(path.join(basePath, "bar"), "bar");
        const barCommit = yield TestUtil.makeCommit(base, ["bar"]);
        const barSha = barCommit.id().tostrS();
        yield base.checkoutBranch("master");

        const firstCommit = yield repo.getHeadCommit();
        const firstSha = firstCommit.id().tostrS();
        // Add the submodule and commit
        const submodule =
                        yield addSubmodule(repo, basePath, "s", baseMasterSha);
        const subCommit = yield TestUtil.makeCommit(repo,
                                                    [".gitmodules", "s"]);
        const subSha = subCommit.id().tostrS();

        // Make the `wham` branch and put a change to the submodule on it.

        yield repo.createBranch("wham", subCommit, 0, sig);
        yield repo.checkoutBranch("wham");
        const subRepo = yield submodule.open();
        const localBar = yield subRepo.getCommit(barSha);
        yield NodeGit.Reset.reset(subRepo,
                                  localBar,
                                  NodeGit.Reset.TYPE.HARD);
        const whamCommit = yield TestUtil.makeCommit(repo, ["s"]);
        const whamSha = whamCommit.id().tostrS();

        // Go back to master and put a different submodule change on it.

        yield repo.checkoutBranch("master");
        const localFoo = yield subRepo.getCommit(fooSha);
        yield NodeGit.Reset.reset(subRepo,
                                  localFoo,
                                  NodeGit.Reset.TYPE.HARD);
        const masterCommit = yield TestUtil.makeCommit(repo, ["s"]);
        const masterSha = masterCommit.id().tostrS();

        // Now make the merge commit.

        let index = yield NodeGit.Merge.commits(repo,
                                                masterCommit,
                                                whamCommit,
                                                null);

        // Have to force set the submodule to the 'bar' commit.

        NodeGit.Reset.reset(subRepo,
                            localBar,
                            NodeGit.Reset.TYPE.HARD);

        // And deal with the index.
        index.addByPath("s");
        index.conflictCleanup();
        index.write();
        yield index.writeTreeTo(repo);
        yield NodeGit.Checkout.index(repo, index, {
            checkoutStrategy: NodeGit.Checkout.STRATEGY.FORCE,
        });
        index = yield repo.openIndex();
        index.addByPath("s");
        index.write();
        const id = yield index.writeTreeTo(repo);
        const mergeCommit = yield repo.createCommit(
                                                 "HEAD",
                                                 sig,
                                                 sig,
                                                 "message",
                                                 id,
                                                 [ masterCommit, whamCommit ]);
        const mergeSha = mergeCommit.tostrS();
        const Commit = RepoAST.Commit;
        const Submodule = RepoAST.Submodule;

        const subCommits = {};
        subCommits[baseMasterSha] = new Commit({
            changes: { "README.md": "", },
            message: "first commit",
        });
        subCommits[fooSha] = new Commit({
            parents: [baseMasterSha],
            changes: { foo: "foo" },
            message: "message",
        });
        subCommits[barSha] = new Commit({
            parents: [baseMasterSha],
            changes: { bar: "bar" },
            message: "message",
        });

        const commits = {};
        commits[firstSha] = new Commit({
            changes: { "README.md": "", },
            message: "first commit",
        });
        commits[subSha] = new Commit({
            parents: [firstSha],
            changes: { "s": new Submodule(basePath, baseMasterSha), },
            message: "message",
        });
        commits[whamSha] = new Commit({
            parents: [subSha],
            changes: { "s": new Submodule(basePath, barSha) },
            message: "message",
        });
        commits[masterSha] = new Commit({
            parents: [subSha],
            changes: { "s": new Submodule(basePath, fooSha) },
            message: "message",
        });
        commits[mergeSha] = new Commit({
            parents: [masterSha, whamSha],
            changes: { "s": new Submodule(basePath, barSha) },
            message: "message",
        });

        const expected = new RepoAST({
            head: mergeSha,
            currentBranchName: "master",
            branches: {
                master: mergeSha,
                wham: whamSha,
            },
            commits: commits,
            openSubmodules: {
                s: new RepoAST({
                    head: barSha,
                    commits: subCommits,
                    remotes: {
                        origin: new RepoAST.Remote(basePath, {
                            branches: {
                                foo: fooSha,
                                bar: barSha,
                                master: baseMasterSha,
                            },
                        }),
                    },
                }),
            },
        });
        const actual = yield ReadRepoASTUtil.readRAST(repo);
        RepoASTUtil.assertEqualASTs(actual, expected);
    }));

});

