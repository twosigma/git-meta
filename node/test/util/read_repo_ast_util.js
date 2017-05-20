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

const DeinitUtil          = require("../../lib/util/deinit_util");
const Rebase              = require("../../lib/util/rebase");
const RepoAST             = require("../../lib/util/repo_ast");
const ReadRepoASTUtil     = require("../../lib/util/read_repo_ast_util");
const RepoASTUtil         = require("../../lib/util/repo_ast_util");
const SubmoduleConfigUtil = require("../../lib/util/submodule_config_util");
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
        branches: { "master": new RepoAST.Branch(commit, null) },
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
            "master": new RepoAST.Branch(firstCommit, null),
            "foo": new RepoAST.Branch(secondCommit, null),
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
        branches: { "master": new RepoAST.Branch(secondCommit, null) },
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
            branches: { "master": new RepoAST.Branch(commit, null), },
            head: commit,
            currentBranchName: "master",
        });
        RepoASTUtil.assertEqualASTs(ast, expected);
    }));

    it("with a ref", co.wrap(function *() {
        const r = yield TestUtil.createSimpleRepository();
        const headId = yield r.getHeadCommit();

        yield NodeGit.Reference.create(r, "refs/foo/bar", headId.id(), 0, "");

        const ast = yield ReadRepoASTUtil.readRAST(r);
        const commit = headId.id().tostrS();

        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": ""},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { "master": new RepoAST.Branch(commit, null), },
            refs: { "foo/bar": commit },
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
            branches: { "master": new RepoAST.Branch(secondSha, null), },
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
        yield index.write();
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
            branches: { "master": new RepoAST.Branch(delSha, null), },
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
                "master": new RepoAST.Branch(commit, null),
                "foo": new RepoAST.Branch(commit, null),
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
            branches: { "master": new RepoAST.Branch(commit, null), },
            head: commit,
            currentBranchName: "master",
            bare: true,
        });
        RepoASTUtil.assertEqualASTs(ast, expected);
    }));

    it("headless", co.wrap(function *() {
        const path = yield TestUtil.makeTempDir();
        const r = yield NodeGit.Repository.init(path, 0);
        const ast = yield ReadRepoASTUtil.readRAST(r);
        const expected = new RepoAST();
        RepoASTUtil.assertEqualASTs(ast, expected);
    }));

    it("headless with a commit", co.wrap(function *() {
        const path = yield TestUtil.makeTempDir();
        const r = yield NodeGit.Repository.init(path, 1);
        const sig = r.defaultSignature();
        const builder = yield NodeGit.Treebuilder.create(r, null);
        const treeObj = builder.write();
        const tree = yield r.getTree(treeObj.tostrS());
        const commitId = yield NodeGit.Commit.create(r,
                                                     0,
                                                     sig,
                                                     sig,
                                                     0,
                                                     "message",
                                                     tree,
                                                     0,
                                                     []);
        yield NodeGit.Reference.create(r, "refs/ref", commitId, 0, "x");
        const ast = yield ReadRepoASTUtil.readRAST(r);
        const commits = {};
        const sha = commitId.tostrS();
        commits[sha] = new RepoAST.Commit({
            message: "message",
        });
        const expected = new RepoAST({
            commits: commits,
            refs: { "ref": sha, },
            bare: true,
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
            branches: { master: new RepoAST.Branch(commit, "origin/master"), },
            currentBranchName: "master",
            head: commit,
        });
        RepoASTUtil.assertEqualASTs(ast, expected);
    }));

    it("missing remote", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        const tempDir = yield TestUtil.makeTempDir();
        const url = path.join(tempDir, "no-path");
        yield NodeGit.Remote.create(repo, "badremote", url);
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
            branches: { master: new RepoAST.Branch(commit, null), },
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
        yield DeinitUtil.deinit(repo, "x/y");
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
            branches: {
                master: new RepoAST.Branch(commit.id().tostrS(), null),
            },
            currentBranchName: "master",
            head: commit.id().tostrS(),
        });
        const actual = yield ReadRepoASTUtil.readRAST(repo);
        RepoASTUtil.assertEqualASTs(actual, expected);
    }));

    it("submodule URL change on index", co.wrap(function *() {

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
        yield fs.writeFile(path.join(repo.workdir(), ".gitmodules"), `\
[submodule "x/y"]
\tpath = x/y
\turl = /foo
`);
        const index = yield repo.index();
        yield index.addByPath(".gitmodules");
        yield index.write();
        yield DeinitUtil.deinit(repo, "x/y");
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
            branches: {
                master: new RepoAST.Branch(commit.id().tostrS(), null),
            },
            currentBranchName: "master",
            head: commit.id().tostrS(),
            index: {
                "x/y": new RepoAST.Submodule("/foo",
                                             subHead.id().tostrS()),
            },
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
        yield DeinitUtil.deinit(repo, "x/y");

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
            branches: {
                master: new RepoAST.Branch(lastCommit.id().tostrS(), null),
            },
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
        yield index.addByPath("README.md");
        yield index.write();

        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": ""},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { "master": new RepoAST.Branch(commit, null), },
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
        yield index.addByPath("foo");
        yield index.write();

        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": ""},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { "master": new RepoAST.Branch(commit, null), },
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
        yield index.addByPath("foo");
        yield index.write();

        fs.unlink(fooPath);

        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": ""},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { "master": new RepoAST.Branch(commit, null), },
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
        yield index.write();

        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": ""},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { "master": new RepoAST.Branch(commit, null), },
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
        yield DeinitUtil.deinit(repo, "x/y");

        let commits = {};
        commits[headCommit.id().tostrS()] = new Commit({
            changes: {"README.md":""},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: {
                master: new RepoAST.Branch(headCommit.id().tostrS(), null),
            },
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
        yield DeinitUtil.deinit(repo, "x/y");

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
            branches: {
                master: new RepoAST.Branch(commit.id().tostrS(), null),
            },
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
            branches: {
                master: new RepoAST.Branch(headCommit.id().tostrS(), null),
            },
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
            branches: {
                master: new RepoAST.Branch(headCommit.id().tostrS(), null),
            },
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
            branches: {
                master: new RepoAST.Branch(headCommit.id().tostrS(), null),
            },
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
        yield index.addByPath("README.md");
        yield index.write();
        yield fs.appendFile(path.join(r.workdir(), "README.md"), "y");
        let commits = {};
        commits[headCommit.id().tostrS()] = new Commit({
            changes: {"README.md":""},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: {
                master: new RepoAST.Branch(headCommit.id().tostrS(), null),
            },
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
            message: "Merge branch 'b'",
        });
        const expected = new RepoAST({
            head: mergeSha,
            currentBranchName: "master",
            branches: {
                master: new RepoAST.Branch(mergeSha, null),
                b: new RepoAST.Branch(bSha, null),
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

        yield NodeGit.Reset.reset(subRepo,
                                  localBar,
                                  NodeGit.Reset.TYPE.HARD);

        yield index.conflictCleanup();
        yield index.writeTreeTo(repo);
        yield NodeGit.Checkout.index(repo, index, {
            checkoutStrategy: NodeGit.Checkout.STRATEGY.FORCE,
        });
        index = yield repo.index();
        yield index.addByPath("s");
        yield index.write();
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
                master: new RepoAST.Branch(mergeSha, null),
                wham: new RepoAST.Branch(whamSha, null),
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

    it("merge commit with ignored submodule change", co.wrap(function *() {
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

        // We're going to ignore the 'bar' commit.

        yield index.conflictCleanup();
        yield index.writeTreeTo(repo);
        yield NodeGit.Checkout.index(repo, index, {
            checkoutStrategy: NodeGit.Checkout.STRATEGY.FORCE,
        });
        index = yield repo.index();
        yield index.write();
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
            changes: {},
            message: "message",
        });

        const expected = new RepoAST({
            head: mergeSha,
            currentBranchName: "master",
            branches: {
                master: new RepoAST.Branch(mergeSha, null),
                wham: new RepoAST.Branch(whamSha, null),
            },
            commits: commits,
            openSubmodules: {
                s: new RepoAST({
                    head: fooSha,
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

    it("notes", co.wrap(function *() {
        const r = yield TestUtil.createSimpleRepository();
        const head = yield r.getHeadCommit();
        const headId = head.id();

        const sig = r.defaultSignature();

        yield NodeGit.Note.create(r, "refs/notes/test",
                                  sig, sig, headId, "note", 0);
        const ast = yield ReadRepoASTUtil.readRAST(r);
        const commit = headId.tostrS();
        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": ""},
            message: "first commit",
        });
        const note = {};
        note[headId] = "note";
        const expected = new RepoAST({
            notes: {
                    "refs/notes/test" : note
            },
            commits: commits,
            branches: { "master": new RepoAST.Branch(commit, null), },
            head: commit,
            currentBranchName: "master",
        });
        RepoASTUtil.assertEqualASTs(ast, expected);
    }));

    it("rebase", co.wrap(function *() {
        // Start out with a base repo having two branches, "master", and "foo",
        // foo having one commit on top of master.

        const start = yield repoWithCommit();
        const r = start.repo;

        // Switch to master

        yield r.checkoutBranch("master");

        const master = yield r.getBranch("master");
        const foo = yield r.getBranch("foo");

        const current = yield NodeGit.AnnotatedCommit.fromRef(r, master);
        const onto = yield NodeGit.AnnotatedCommit.fromRef(r, foo);

        // Then begin a rebase.

        yield NodeGit.Rebase.init(r, current, onto, null, null);

        const ast = yield ReadRepoASTUtil.readRAST(r);
        assert.deepEqual(ast.rebase,
                         new Rebase("refs/heads/master",
                                    current.id().tostrS(),
                                    onto.id().tostrS()));
    }));

    it("rebase - unreachable", co.wrap(function *() {
        const r = yield TestUtil.createSimpleRepository();
        r.detachHead();
        const secondCommit = yield TestUtil.generateCommit(r);
        const thirdCommit = yield TestUtil.generateCommit(r);
        const current = yield NodeGit.AnnotatedCommit.lookup(r,
                                                             thirdCommit.id());
        const onto = yield NodeGit.AnnotatedCommit.lookup(r,
                                                          secondCommit.id());

        // Then begin a rebase.

        yield NodeGit.Rebase.init(r, current, onto, null, null);

        // Remove the branches, making the commits reachable only from the
        // rebase.

        const ast = yield ReadRepoASTUtil.readRAST(r);
        const rebase = ast.rebase;
        assert.equal(rebase.originalHead, thirdCommit.id().tostrS());
        assert.equal(rebase.onto, secondCommit.id().tostrS());
    }));

    it("add subs again", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        let expected = yield astFromSimpleRepo(repo);
        const another = yield TestUtil.createSimpleRepository();
        const anotherUrl = another.path();
        const anotherHead = yield another.getHeadCommit();
        const anotherHeadSha = anotherHead.id().tostrS();
        const third = yield TestUtil.createSimpleRepository();
        const thirdUrl = third.path();
        const headCommit = yield repo.getHeadCommit();
        yield addSubmodule(repo,
                           anotherUrl,
                           "a",
                           anotherHeadSha);
        const modules = ".gitmodules";
        const nextCommit = yield TestUtil.makeCommit(repo, ["a", modules]);
        const nextSha = nextCommit.id().tostrS();
        yield DeinitUtil.deinit(repo, "a");

        yield fs.writeFile(path.join(repo.workdir(),
                                     modules),
                            `\
[submodule "a"]
\tpath = a
\turl = ${thirdUrl}
`
                          );
        const finalCommit = yield TestUtil.makeCommit(repo, [modules]);
        const finalSha = finalCommit.id().tostrS();

        let commits = expected.commits;
        commits[nextSha] = new RepoAST.Commit({
            parents: [headCommit.id().tostrS()],
            changes: {
                a: new RepoAST.Submodule(anotherUrl, anotherHeadSha),
            },
            message: "message",
        });
        commits[finalSha] = new RepoAST.Commit({
            parents: [nextSha],
            changes: {
                a: new RepoAST.Submodule(thirdUrl, anotherHeadSha),
            },
            message: "message",
        });
        expected = expected.copy({
            branches: {
                master: new RepoAST.Branch(finalSha, null),
            },
            head: finalSha,
            commits: commits,
        });
        const ast = yield ReadRepoASTUtil.readRAST(repo);
        assert.deepEqual(ast, expected);
    }));

    it("new sub, no sha", co.wrap(function *() {
        // Going to initialize a submodule with a URL, but not assign it a SHA.

        const r = yield TestUtil.createSimpleRepository();
        const modulesPath = path.join(r.workdir(),
                                      SubmoduleConfigUtil.modulesFileName);
        fs.appendFileSync(modulesPath, `\
[submodule "x"]
    path = x
    url = foo
`);
        const index = yield r.index();
        yield index.addByPath(SubmoduleConfigUtil.modulesFileName);
        yield index.write();
        yield SubmoduleConfigUtil.initSubmoduleAndRepo("bar",
                                                       r,
                                                       "x",
                                                       "foo",
                                                       null);

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
            branches: { "master": new RepoAST.Branch(commit, null), },
            head: commit,
            currentBranchName: "master",
            index: { x: new RepoAST.Submodule("foo", null) },
            openSubmodules: {
                x: new RepoAST({
                    remotes: {
                        origin: new RepoAST.Remote("foo"),
                    },
                }),
            },
        });
        RepoASTUtil.assertEqualASTs(ast, expected);
    }));

    it("new sub, new HEAD in WD", co.wrap(function *() {
        // Going to initialize a submodule with a URL, but not assign it a SHA.

        const r = yield TestUtil.createSimpleRepository();
        const modulesPath = path.join(r.workdir(),
                                      SubmoduleConfigUtil.modulesFileName);
        fs.appendFileSync(modulesPath, `\
[submodule "x"]
    path = x
    url = foo
`);
        const index = yield r.index();
        yield index.addByPath(SubmoduleConfigUtil.modulesFileName);
        yield index.write();
        const subRepo =
          yield SubmoduleConfigUtil.initSubmoduleAndRepo("bar",
                                                         r,
                                                         "x",
                                                         "foo",
                                                         null);
        const subCommit = yield TestUtil.generateCommit(subRepo);
        yield NodeGit.Checkout.tree(subRepo, subCommit, {
            checkoutStrategy: NodeGit.Checkout.STRATEGY.FORCE,
        });
        subRepo.setHeadDetached(subCommit);
        const branch = yield subRepo.getBranch("master");
        NodeGit.Branch.delete(branch);
        const subCommits = {
        };
        subCommits[subCommit.id().tostrS()] = new RepoAST.Commit({
            changes: {
                "README.md": "data",
            },
            message: "message",
        });
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
            branches: { "master": new RepoAST.Branch(commit, null), },
            head: commit,
            currentBranchName: "master",
            index: { x: new RepoAST.Submodule("foo", null) },
            openSubmodules: {
                x: new RepoAST({
                    commits: subCommits,
                    remotes: {
                        origin: new RepoAST.Remote("foo"),
                    },
                    head: subCommit.id().tostrS(),
                }),
            },
        });
        RepoASTUtil.assertEqualASTs(ast, expected);
    }));
    it("stash commit", co.wrap(function *() {
        // I'm not testing the accuracy of what's read here, just that we can
        // read it.  Previously, it would attempt to process the diffs for all
        // the children made for the stash commit and result in an illogical
        // change set rejected by the constructor of `RepoAST`.

        const repo = yield TestUtil.createSimpleRepository();
        const repoPath = repo.workdir();
        console.log(repoPath);
        const readmePath = path.join(repoPath, "README.md");
        const foobarPath = path.join(repoPath, "foobar");
        const bazPath    = path.join(repoPath, "baz");
        yield fs.appendFile(readmePath, "bleh");
        yield fs.writeFile(foobarPath, "meh");
        yield fs.writeFile(bazPath, "baz");
        const index = yield repo.index();
        yield index.addByPath("foobar");
        yield index.write();
        yield NodeGit.Stash.save(repo,
                                 repo.defaultSignature(),
                                 "stash",
                                 NodeGit.Stash.FLAGS.INCLUDE_UNTRACKED);
        yield ReadRepoASTUtil.readRAST(repo);
    }));
});

