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

const ConflictUtil        = require("../../lib/util/conflict_util");
const GitUtil             = require("../../lib/util/git_util");
const Rebase              = require("../../lib/util/rebase");
const RepoAST             = require("../../lib/util/repo_ast");
const ReadRepoASTUtil     = require("../../lib/util/read_repo_ast_util");
const RepoASTUtil         = require("../../lib/util/repo_ast_util");
const SequencerState      = require("../../lib/util/sequencer_state");
const SequencerStateUtil  = require("../../lib/util/sequencer_state_util");
const SparseCheckoutUtil  = require("../../lib/util/sparse_checkout_util");
const SubmoduleConfigUtil = require("../../lib/util/submodule_config_util");
const TestUtil            = require("../../lib/util/test_util");

const CommitAndRef = SequencerState.CommitAndRef;
const File = RepoAST.File;

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
        changes: { "README.md": new File("", false)},
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
        changes: { "README.md": new File("", false)},
        message: "first commit",
    });
    commits[secondCommit] = new Commit({
        parents: [firstCommit],
        changes: {
            "README.md": new File("bleh", false),
            "foobar": new File("meh", false),
        },
        message: "message\n",
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
        changes: { "README.md": new File("", false)},
        message: "first commit",
    });
    commits[secondCommit] = new Commit({
        changes: { "README.md": new File("bleh", false) },
        parents: [firstCommit],
        message: "message\n",
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
            changes: { "README.md": new File("", false)},
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
            changes: { "README.md": new File("", false)},
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
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        commits[secondSha] = new Commit({
            parents: [firstSha],
            changes: { "foo/bar": new File("meh", false) },
            message: "message\n",
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
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        commits[delSha] = new Commit({
            parents: [headSha],
            changes: { "README.md": null },
            message: "message\n",
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
            changes: { "README.md": new File("", false)},
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
            changes: { "README.md": new File("", false)},
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
            changes: { "README.md": new File("", false)},
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
        const sig = yield r.defaultSignature();
        const builder = yield NodeGit.Treebuilder.create(r, null);
        const treeObj = yield builder.write();
        const tree = yield r.getTree(treeObj.tostrS());
        const commitId = yield NodeGit.Commit.create(r,
                                                     0,
                                                     sig,
                                                     sig,
                                                     0,
                                                     "message\n",
                                                     tree,
                                                     0,
                                                     []);
        yield NodeGit.Reference.create(r, "refs/ref", commitId, 0, "x");
        const ast = yield ReadRepoASTUtil.readRAST(r);
        const commits = {};
        const sha = commitId.tostrS();
        commits[sha] = new RepoAST.Commit({
            message: "message\n",
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
            changes: { "README.md": new File("", false)},
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

    it("remote with path in tracking branch", co.wrap(function *() {
        const base = yield TestUtil.createSimpleRepository();
        const headId = (yield base.getHeadCommit()).id();
        yield base.createBranch("foo/bar", headId, 1);
        const clonePath = yield TestUtil.makeTempDir();
        const clone = yield NodeGit.Clone.clone(base.workdir(), clonePath);
        const master = yield clone.getBranch("refs/heads/master");
        yield NodeGit.Branch.setUpstream(master, "origin/foo/bar");
        const ast = yield ReadRepoASTUtil.readRAST(clone);
        const commit = headId.tostrS();
        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        const workdir = base.workdir();
        const expected = new RepoAST({
            commits: commits,
            remotes: {
                origin: new RepoAST.Remote(workdir, {
                    branches: {
                        master: commit,
                        "foo/bar": commit,
                    }
                }),
            },
            branches: {
                master: new RepoAST.Branch(commit, "origin/foo/bar"),
            },
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
            changes: { "README.md": new File("", false)},
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
        yield SubmoduleConfigUtil.deinit(repo, ["x/y"]);
        let commits = {};
        commits[headCommit.id().tostrS()] = new Commit({
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        commits[commit.id().tostrS()] = new Commit({
            parents: [headCommit.id().tostrS()],
            changes: {
                "x/y": new RepoAST.Submodule(baseSubPath,
                                             subHead.id().tostrS()),
            },
            message: "message\n",
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
        yield SubmoduleConfigUtil.deinit(repo, ["x/y"]);
        let commits = {};
        commits[headCommit.id().tostrS()] = new Commit({
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        commits[commit.id().tostrS()] = new Commit({
            parents: [headCommit.id().tostrS()],
            changes: {
                "x/y": new RepoAST.Submodule(baseSubPath,
                                             subHead.id().tostrS()),
            },
            message: "message\n",
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
        yield SubmoduleConfigUtil.deinit(repo, ["x/y"]);

        let commits = {};
        commits[headCommit.id().tostrS()] = new Commit({
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        commits[commit.id().tostrS()] = new Commit({
            parents: [headCommit.id().tostrS()],
            changes: {
                "x/y": new RepoAST.Submodule(baseSubPath,
                                             subHead.id().tostrS()),
            },
            message: "message\n",
        });
        commits[lastCommit.id().tostrS()] = new Commit({
            parents: [commit.id().tostrS()],
            changes: {
                "x/y": new RepoAST.Submodule(
                                            baseSubPath,
                                            anotherSubCommit.id().tostrS())
            },
            message: "message\n",
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
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { "master": new RepoAST.Branch(commit, null), },
            head: commit,
            currentBranchName: "master",
            index: { "README.md": new File("foo", false) },
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
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { "master": new RepoAST.Branch(commit, null), },
            head: commit,
            currentBranchName: "master",
            index: { "foo": new File("foo", false), },
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
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { "master": new RepoAST.Branch(commit, null), },
            head: commit,
            currentBranchName: "master",
            index: { "foo": new File("foo", false), },
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
            changes: { "README.md": new File("", false)},
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
        yield SubmoduleConfigUtil.deinit(repo, ["x/y"]);

        let commits = {};
        commits[headCommit.id().tostrS()] = new Commit({
            changes: { "README.md": new File("", false)},
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
        yield SubmoduleConfigUtil.deinit(repo, ["x/y"]);

        let commits = {};
        commits[headCommit.id().tostrS()] = new Commit({
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        commits[commit.id().tostrS()] = new Commit({
            parents: [headCommit.id().tostrS()],
            changes: {
                "x/y": new RepoAST.Submodule(baseSubPath,
                                             subHead.id().tostrS()),
            },
            message: "message\n",
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
            changes: { "README.md": new File("", false)},
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
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: {
                master: new RepoAST.Branch(headCommit.id().tostrS(), null),
            },
            currentBranchName: "master",
            head: headCommit.id().tostrS(),
            workdir: { foo: new File("x", false),  },
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
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: {
                master: new RepoAST.Branch(headCommit.id().tostrS(), null),
            },
            currentBranchName: "master",
            head: headCommit.id().tostrS(),
            workdir: { "README.md": new File("x", false) },
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
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: {
                master: new RepoAST.Branch(headCommit.id().tostrS(), null),
            },
            currentBranchName: "master",
            head: headCommit.id().tostrS(),
            index: { "README.md": new File("x", false), },
            workdir: { "README.md": new File("xy", false), },
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
        const sig = yield repo.defaultSignature();
        yield repo.createBranch("b", firstCommit, 0);
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
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        commits[bSha] = new Commit({
            parents: [firstSha],
            changes: { foo: new File("foo", false) },
            message: "message\n",
        });
        commits[cSha] = new Commit({
            parents: [firstSha],
            changes: { bar: new File("bar", false) },
            message: "message\n",
        });
        commits[mergeSha] = new Commit({
            parents: [cSha, bSha],
            changes: { foo: new File("foo", false) },
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
        const sig = yield repo.defaultSignature();

        // Create the base repo for the submodule and add a couple of
        // commits.

        const base = yield TestUtil.createSimpleRepository();
        const basePath = base.workdir();
        const baseMaster = yield base.getHeadCommit();
        const baseMasterSha = baseMaster.id().tostrS();
        yield base.createBranch("foo", baseMaster, 0);
        yield base.checkoutBranch("foo");
        yield fs.writeFile(path.join(basePath, "foo"), "foo");
        const fooCommit = yield TestUtil.makeCommit(base, ["foo"]);
        const fooSha = fooCommit.id().tostrS();
        yield base.createBranch("bar", baseMaster, 0);
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

        yield repo.createBranch("wham", subCommit, 0);
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
                                                 "message\n",
                                                 id,
                                                 [ masterCommit, whamCommit ]);
        const mergeSha = mergeCommit.tostrS();
        const Commit = RepoAST.Commit;
        const Submodule = RepoAST.Submodule;

        const subCommits = {};
        subCommits[baseMasterSha] = new Commit({
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        subCommits[fooSha] = new Commit({
            parents: [baseMasterSha],
            changes: { foo: new File("foo", false), },
            message: "message\n",
        });
        subCommits[barSha] = new Commit({
            parents: [baseMasterSha],
            changes: { bar: new File("bar", false) },
            message: "message\n",
        });

        const commits = {};
        commits[firstSha] = new Commit({
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        commits[subSha] = new Commit({
            parents: [firstSha],
            changes: { "s": new Submodule(basePath, baseMasterSha), },
            message: "message\n",
        });
        commits[whamSha] = new Commit({
            parents: [subSha],
            changes: { "s": new Submodule(basePath, barSha) },
            message: "message\n",
        });
        commits[masterSha] = new Commit({
            parents: [subSha],
            changes: { "s": new Submodule(basePath, fooSha) },
            message: "message\n",
        });
        commits[mergeSha] = new Commit({
            parents: [masterSha, whamSha],
            changes: { "s": new Submodule(basePath, barSha) },
            message: "message\n",
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
        const sig = yield repo.defaultSignature();

        // Create the base repo for the submodule and add a couple of
        // commits.

        const base = yield TestUtil.createSimpleRepository();
        const basePath = base.workdir();
        const baseMaster = yield base.getHeadCommit();
        const baseMasterSha = baseMaster.id().tostrS();
        yield base.createBranch("foo", baseMaster, 0);
        yield base.checkoutBranch("foo");
        yield fs.writeFile(path.join(basePath, "foo"), "foo");
        const fooCommit = yield TestUtil.makeCommit(base, ["foo"]);
        const fooSha = fooCommit.id().tostrS();
        yield base.createBranch("bar", baseMaster, 0);
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

        yield repo.createBranch("wham", subCommit, 0);
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
                                                 "message\n",
                                                 id,
                                                 [ masterCommit, whamCommit ]);
        const mergeSha = mergeCommit.tostrS();
        const Commit = RepoAST.Commit;
        const Submodule = RepoAST.Submodule;

        const subCommits = {};
        subCommits[baseMasterSha] = new Commit({
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        subCommits[fooSha] = new Commit({
            parents: [baseMasterSha],
            changes: { foo: new File("foo", false) },
            message: "message\n",
        });
        subCommits[barSha] = new Commit({
            parents: [baseMasterSha],
            changes: { bar: new File("bar", false) },
            message: "message\n",
        });

        const commits = {};
        commits[firstSha] = new Commit({
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        commits[subSha] = new Commit({
            parents: [firstSha],
            changes: { "s": new Submodule(basePath, baseMasterSha), },
            message: "message\n",
        });
        commits[whamSha] = new Commit({
            parents: [subSha],
            changes: { "s": new Submodule(basePath, barSha) },
            message: "message\n",
        });
        commits[masterSha] = new Commit({
            parents: [subSha],
            changes: { "s": new Submodule(basePath, fooSha) },
            message: "message\n",
        });
        commits[mergeSha] = new Commit({
            parents: [masterSha, whamSha],
            changes: {},
            message: "message\n",
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

        const sig = yield r.defaultSignature();

        yield NodeGit.Note.create(r, "refs/notes/test",
                                  sig, sig, headId, "note", 0);
        const ast = yield ReadRepoASTUtil.readRAST(r);
        const commit = headId.tostrS();
        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": new File("", false)},
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

        const ast = yield ReadRepoASTUtil.readRAST(r);
        const rebase = ast.rebase;
        assert.equal(rebase.originalHead, thirdCommit.id().tostrS());
        assert.equal(rebase.onto, secondCommit.id().tostrS());
    }));

    it("sequencer", co.wrap(function *() {
        // Start out with a base repo having two branches, "master", and "foo",
        // foo having one commit on top of master.

        const start = yield repoWithCommit();
        const r = start.repo;

        // Switch to master

        yield r.checkoutBranch("master");

        const head = yield r.getHeadCommit();
        const sha = head.id().tostrS();

        const sequencer = new SequencerState({
            type: SequencerState.TYPE.REBASE,
            originalHead: new CommitAndRef(sha, "foo"),
            target: new CommitAndRef(sha, "bar"),
            currentCommit: 0,
            commits: [sha],
        });

        const original = yield ReadRepoASTUtil.readRAST(r);
        const expected = original.copy({
            sequencerState: sequencer,
        });

        yield SequencerStateUtil.writeSequencerState(r.path(), sequencer);

        const actual = yield ReadRepoASTUtil.readRAST(r);

        RepoASTUtil.assertEqualASTs(actual, expected);
    }));

    it("sequencer - unreachable", co.wrap(function *() {
        const r = yield TestUtil.createSimpleRepository();
        r.detachHead();
        const second = yield TestUtil.generateCommit(r);
        const third = yield TestUtil.generateCommit(r);
        const fourth = yield TestUtil.generateCommit(r);

        // Then begin a cherry-pick.

        const sequencer = new SequencerState({
            type: SequencerState.TYPE.REBASE,
            originalHead: new CommitAndRef(second.id().tostrS(), "foo"),
            target: new CommitAndRef(third.id().tostrS(), "bar"),
            currentCommit: 0,
            commits: [fourth.id().tostrS()],
        });

        yield SequencerStateUtil.writeSequencerState(r.path(), sequencer);

        // Remove the branches, making the commits reachable only from the
        // rebase.

        const ast = yield ReadRepoASTUtil.readRAST(r);
        const actualSequencer = ast.sequencerState;
        assert.deepEqual(actualSequencer, sequencer);
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
        yield SubmoduleConfigUtil.deinit(repo, ["a"]);

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
            message: "message\n",
        });
        commits[finalSha] = new RepoAST.Commit({
            parents: [nextSha],
            changes: {
                a: new RepoAST.Submodule(thirdUrl, anotherHeadSha),
            },
            message: "message\n",
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
                                                       null,
                                                       false);

        const ast = yield ReadRepoASTUtil.readRAST(r);
        const headId = yield r.getHeadCommit();
        const commit = headId.id().tostrS();
        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": new File("", false)},
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
                                                         null,
                                                         false);
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
                "README.md": new File("data", false),
            },
            message: "message\n",
        });
        const ast = yield ReadRepoASTUtil.readRAST(r);
        const headId = yield r.getHeadCommit();
        const commit = headId.id().tostrS();
        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": new File("", false)},
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
                                 yield repo.defaultSignature(),
                                 "stash",
                                 NodeGit.Stash.FLAGS.INCLUDE_UNTRACKED);
        yield ReadRepoASTUtil.readRAST(repo);
    }));
    describe("conflicts", function () {
        const FILEMODE = NodeGit.TreeEntry.FILEMODE;
        const ConflictEntry = ConflictUtil.ConflictEntry;
        it("three versions", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const makeEntry = co.wrap(function *(data) {
                const id = yield GitUtil.hashObject(repo, data);
                return new ConflictEntry(FILEMODE.BLOB, id.tostrS());
            });
            const ancestor = yield makeEntry("xxx");
            const our = yield makeEntry("yyy");
            const their = yield makeEntry("zzz");
            const index = yield repo.index();
            const filename = "README.md";
            const conflict = new ConflictUtil.Conflict(ancestor, our, their);
            yield ConflictUtil.addConflict(index, filename, conflict);
            yield index.write();
            yield fs.writeFile(path.join(repo.workdir(), filename),
                               "conflicted");
            const result = yield ReadRepoASTUtil.readRAST(repo);
            const simple = yield astFromSimpleRepo(repo);
            const expected = simple.copy({
                index: {
                    "README.md": new RepoAST.Conflict(new File("xxx", false),
                                                      new File("yyy", false),
                                                      new File("zzz", false)),
                },
                workdir: {
                    "README.md": new File("conflicted", false),
                },
            });
            RepoASTUtil.assertEqualASTs(result, expected);
        }));
        it("with a deletion", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const makeEntry = co.wrap(function *(data) {
                const id = yield GitUtil.hashObject(repo, data);
                return new ConflictEntry(FILEMODE.BLOB, id.tostrS());
            });
            const ancestor = yield makeEntry("xxx");
            const their = yield makeEntry("zzz");
            const conflict = new ConflictUtil.Conflict(ancestor, null, their);
            const index = yield repo.index();
            const filename = "README.md";
            yield ConflictUtil.addConflict(index, filename, conflict);
            yield index.write();
            yield fs.writeFile(path.join(repo.workdir(), filename),
                               "conflicted");
            const result = yield ReadRepoASTUtil.readRAST(repo);
            const simple = yield astFromSimpleRepo(repo);
            const expected = simple.copy({
                index: {
                    "README.md": new RepoAST.Conflict(new File("xxx", false),
                                                      null,
                                                      new File("zzz", false)),
                },
                workdir: {
                    "README.md": new File("conflicted", false),
                },
            });
            RepoASTUtil.assertEqualASTs(result, expected);
        }));
        it("with submodule", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const head = yield repo.getHeadCommit();
            const sha = head.id().tostrS();
            const entry = new ConflictEntry(FILEMODE.COMMIT, sha);
            const index = yield repo.index();
            const conflict = new ConflictUtil.Conflict(null, entry, null);
            yield ConflictUtil.addConflict(index, "s", conflict);
            yield index.write();
            const result = yield ReadRepoASTUtil.readRAST(repo);
            const simple = yield astFromSimpleRepo(repo);
            const expected = simple.copy({
                index: {
                    "s": new RepoAST.Conflict(null,
                                              new RepoAST.Submodule("", sha),
                                              null),
                },
            });
            RepoASTUtil.assertEqualASTs(result, expected);
        }));
        it("with submodule and open", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const head = yield repo.getHeadCommit();
            const sha = head.id().tostrS();
            const baseSub = yield TestUtil.createSimpleRepository();
            const subHead = yield baseSub.getHeadCommit();
            const baseHead = yield baseSub.getHeadCommit();
            const baseSha = baseHead.id().tostrS();
            const subAST = yield astFromSimpleRepo(baseSub);
            yield addSubmodule(repo, baseSub.workdir(), "foo", baseSha);
            const commit = yield TestUtil.makeCommit(repo,
                                                     ["foo", ".gitmodules"]);

            const entry = new ConflictEntry(FILEMODE.COMMIT, sha);
            const index = yield repo.index();
            const conflict = new ConflictUtil.Conflict(null, entry, null);
            yield ConflictUtil.addConflict(index, "foo", conflict);
            yield index.write();
            let commits = {};
            commits[sha] = new Commit({
                changes: { "README.md": new File("", false)},
                message: "first commit",
            });
            commits[commit.id().tostrS()] = new Commit({
                parents: [sha],
                changes: {
                    "foo": new RepoAST.Submodule(baseSub.workdir(),
                                                 subHead.id().tostrS()),
                },
                message: "message\n",
            });
            const expected = new RepoAST({
                commits: commits,
                branches: {
                    master: new RepoAST.Branch(commit.id().tostrS(), null),
                },
                currentBranchName: "master",
                head: commit.id().tostrS(),
                index: {
                    "foo": new RepoAST.Conflict(null,
                                                new RepoAST.Submodule("", sha),
                                                null),
                },
                openSubmodules: {
                    "foo": subAST.copy({
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
            const actual = yield ReadRepoASTUtil.readRAST(repo);
            RepoASTUtil.assertEqualASTs(actual, expected);
        }));
    });
    it("sparse", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        yield SparseCheckoutUtil.setSparseMode(repo);
        const result = yield ReadRepoASTUtil.readRAST(repo);
        assert.equal(result.sparse, true);
    }));
    it("sparse ignores worktree", co.wrap(function *() {
        // Unfortunately, NodeGit will view files missing from the worktree as
        // modifications.  We need to verify that we deal with that.

        const repo = yield TestUtil.createSimpleRepository();
        yield SparseCheckoutUtil.setSparseMode(repo);
        yield fs.unlink(path.join(repo.workdir(), "README.md"));
        const result = yield ReadRepoASTUtil.readRAST(repo);
        assert.equal(result.sparse, true);
        assert.deepEqual(result.workdir, {});
    }));
    it("workdir exec bit change", co.wrap(function *() {
        const r = yield TestUtil.createSimpleRepository();

        // Make readme executable
        yield fs.chmod(path.join(r.workdir(), "README.md"), "755");

        const ast = yield ReadRepoASTUtil.readRAST(r);
        const headId = yield r.getHeadCommit();
        const commit = headId.id().tostrS();
        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });

        const expected = new RepoAST({
            commits: commits,
            branches: { "master": new RepoAST.Branch(commit, null), },
            head: commit,
            currentBranchName: "master",
            workdir: {
                "README.md": new File("", true),
            },
        });
        RepoASTUtil.assertEqualASTs(ast, expected);
    }));
    it("new, executable file", co.wrap(function *() {
        const r = yield TestUtil.createSimpleRepository();

        // Make readme executable
        const filePath = path.join(r.workdir(), "foo");
        yield fs.writeFile(filePath, "meh");
        yield fs.chmod(filePath, "755");

        const ast = yield ReadRepoASTUtil.readRAST(r);
        const headId = yield r.getHeadCommit();
        const commit = headId.id().tostrS();
        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });

        const expected = new RepoAST({
            commits: commits,
            branches: { "master": new RepoAST.Branch(commit, null), },
            head: commit,
            currentBranchName: "master",
            workdir: {
                foo: new File("meh", true),
            },
        });
        RepoASTUtil.assertEqualASTs(ast, expected);
    }));
    it("executable change in index", co.wrap(function *() {
        const r = yield TestUtil.createSimpleRepository();

        // Make readme executable and stage it
        yield fs.chmod(path.join(r.workdir(), "README.md"), "755");
        const index = yield r.index();
        yield index.addByPath("README.md");

        const ast = yield ReadRepoASTUtil.readRAST(r);
        const headId = yield r.getHeadCommit();
        const commit = headId.id().tostrS();
        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });

        const expected = new RepoAST({
            commits: commits,
            branches: { "master": new RepoAST.Branch(commit, null), },
            head: commit,
            currentBranchName: "master",
            index: {
                "README.md": new File("", true),
            },
        });
        RepoASTUtil.assertEqualASTs(ast, expected);
    }));
    it("new, executable file in index", co.wrap(function *() {
        const r = yield TestUtil.createSimpleRepository();

        // Make readme executable
        const filePath = path.join(r.workdir(), "foo");
        yield fs.writeFile(filePath, "meh");
        yield fs.chmod(filePath, "755");
        const index = yield r.index();
        yield index.addByPath("foo");

        const ast = yield ReadRepoASTUtil.readRAST(r);
        const headId = yield r.getHeadCommit();
        const commit = headId.id().tostrS();
        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });

        const expected = new RepoAST({
            commits: commits,
            branches: { "master": new RepoAST.Branch(commit, null), },
            head: commit,
            currentBranchName: "master",
            index: {
                foo: new File("meh", true),
            },
        });
        RepoASTUtil.assertEqualASTs(ast, expected);
    }));
    it("executable change in commit", co.wrap(function *() {
        const r = yield TestUtil.createSimpleRepository();

        const headId = yield r.getHeadCommit();
        const commit = headId.id().tostrS();

        // Make readme executable and stage it
        yield fs.chmod(path.join(r.workdir(), "README.md"), "755");
        const index = yield r.index();
        yield index.addByPath("README.md");
        const execCommit = yield TestUtil.makeCommit(r, ["README.md"]);
        const execSha = execCommit.id().tostrS();

        const ast = yield ReadRepoASTUtil.readRAST(r);

        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        commits[execSha] = new Commit({
            changes: {
                "README.md": new File("", true),
            },
            parents: [commit],
            message: "message\n",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { "master": new RepoAST.Branch(execSha, null), },
            head: execSha,
            currentBranchName: "master",
        });
        RepoASTUtil.assertEqualASTs(ast, expected);
    }));
    it("executable new file in commit", co.wrap(function *() {
        const r = yield TestUtil.createSimpleRepository();

        const headId = yield r.getHeadCommit();
        const commit = headId.id().tostrS();

        // Make readme executable and stage it
        const filePath = path.join(r.workdir(), "foo");
        yield fs.writeFile(filePath, "meh");
        yield fs.chmod(filePath, "755");
        const index = yield r.index();
        yield index.addByPath("foo");
        const execCommit = yield TestUtil.makeCommit(r, ["foo"]);
        const execSha = execCommit.id().tostrS();

        const ast = yield ReadRepoASTUtil.readRAST(r);

        let commits = {};
        commits[commit] = new Commit({
            changes: { "README.md": new File("", false)},
            message: "first commit",
        });
        commits[execSha] = new Commit({
            changes: {
                "foo": new File("meh", true),
            },
            parents: [commit],
            message: "message\n",
        });
        const expected = new RepoAST({
            commits: commits,
            branches: { "master": new RepoAST.Branch(execSha, null), },
            head: execSha,
            currentBranchName: "master",
        });
        RepoASTUtil.assertEqualASTs(ast, expected);
    }));
});

