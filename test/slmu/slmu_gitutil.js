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
 * * Neither the name of slim nor the names of its
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
const co     = require("co");
const fs     = require("fs-promise");
const os     = require("os");
const path   = require("path");

const GitUtil   = require("../../lib/slmu/slmu_gitutil");
const TestUtil  = require("../../lib/slmu/slmu_testutil");
const NodeGit   = require("nodegit");
const UserError = require("../../lib/slmu/slmu_usererror");

describe("slmu_gitutil", function () {
    after(TestUtil.cleanup);

    describe("createBranchFromHead", function () {

        it("from master", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const commit = yield repo.getHeadCommit();
            const newBranch = yield GitUtil.createBranchFromHead(repo, "foo");
            assert.instanceOf(newBranch, NodeGit.Reference);
            assert(newBranch.isBranch());
            assert.equal("foo", newBranch.shorthand());
            const branchCommitId = newBranch.target();
            assert(commit.id().equal(branchCommitId), "commits are equal");

            // Verify we didn't change branch.

            const current = yield repo.getCurrentBranch();
            assert.equal("master", current.shorthand());
        }));

        it("detached head", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const commit = yield repo.getHeadCommit();
            repo.detachHead();
            const newBranch = yield GitUtil.createBranchFromHead(repo, "foo");
            assert.instanceOf(newBranch, NodeGit.Reference);
            assert(newBranch.isBranch());
            assert.equal("foo", newBranch.shorthand());
            const branchCommitId = newBranch.target();
            assert(commit.id().equal(branchCommitId), "commits are equal");
        }));
    });

    describe("findBranch", function () {

        it("breathingTest", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            yield GitUtil.createBranchFromHead(repo, "foo");

            // Find the master branch.

            const master = yield GitUtil.findBranch(repo, "master");
            assert.instanceOf(master, NodeGit.Reference);
            assert.equal("master", master.shorthand());

            // Find another branch.

            const foundNew = yield GitUtil.findBranch(repo, "foo");
            assert.instanceOf(foundNew, NodeGit.Reference);
            assert.equal("foo", foundNew.shorthand());

            // Verify failure.

            const result = yield GitUtil.findBranch(repo, "bar");
            assert.isNull(result);
        }));
    });

    describe("isValidRemoteName", function () {
        after(TestUtil.cleanup);

        it("breathing test", co.wrap(function *() {
            const rr = yield TestUtil.createRepoAndRemote();
            assert(yield GitUtil.isValidRemoteName(rr.clone, "origin"),
                   "origin good");
            assert(!(yield GitUtil.isValidRemoteName(rr.clone, "foo")),
                   "foo not good");
        }));
    });

    describe("findRemoteBranch", function () {
        after(TestUtil.cleanup);

        it("breathingTest", co.wrap(function *() {
            const rr = yield TestUtil.createRepoAndRemote();
            const branch =
                  yield GitUtil.findRemoteBranch(rr.clone, "origin", "master");
            assert.isNotNull(branch);
            assert.instanceOf(branch, NodeGit.Reference);
            assert.equal("origin/master", branch.shorthand());
            assert(branch.isRemote());

            const bad =
                     yield GitUtil.findRemoteBranch(rr.clone, "origin", "foo");
            assert.isNull(bad, "bad branch name");
        }));
    });

    describe("getRootGitDirectory", function () {
        let cwd;
        before(function () {
            cwd = process.cwd();
        });
        after(co.wrap(function *() {
            process.chdir(cwd);
            yield TestUtil.cleanup();
        }));

        // This method is recursive, so we will check just three cases:
        // - failure case
        // - simple case
        // - one deep

        it("failure", function () {
            const tempdir = os.tmpdir();
            process.chdir(tempdir);
            const result = GitUtil.getRootGitDirectory();
            assert.isNull(result);
        });

        it("successes", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const workdir = repo.workdir();
            process.chdir(workdir);
            const repoRoot = GitUtil.getRootGitDirectory(workdir);
            assert(yield TestUtil.isSameRealPath(workdir, repoRoot),
                   "trivial");
            const subdir = path.join(workdir, "sub");
            yield fs.mkdir(subdir);
            process.chdir(subdir);
            const subRoot = GitUtil.getRootGitDirectory(workdir);
            assert(yield TestUtil.isSameRealPath(workdir, subRoot), "trivial");
        }));
    });

    describe("getCurrentRepo", function () {

        let cwd;
        before(function () {
            cwd = process.cwd();
        });
        after(co.wrap(function *() {
            process.chdir(cwd);
            yield TestUtil.cleanup();
        }));

        it("breathing test", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            process.chdir(repo.workdir());
            const current = yield GitUtil.getCurrentRepo();
            assert.instanceOf(current, NodeGit.Repository);
            assert(TestUtil.isSameRealPath(repo.workdir(), current.workdir()));
        }));

        it("failure", co.wrap(function *() {
            // Making an assumption here that the temp dir is not in a git
            // repo; otherwise, not sure how I could test this.

            const emptyDir = yield TestUtil.makeTempDir();
            process.chdir(emptyDir);

            try {
                yield GitUtil.getCurrentRepo();
                assert(false, "didn't throw error");
            }
            catch (e) {
                assert.instanceOf(e, UserError);
            }
        }));
    });

    describe("push", function () {
        after(TestUtil.cleanup);

        // We know that we're not actually implementing push ourselves; it's
        // done in terms of `git push`, though eventually it will be through
        // NodeGit.

        it("breathing test", co.wrap(function *() {
            const rr = yield TestUtil.createRepoAndRemote();
            const goodResult =
                       yield GitUtil.push(rr.clone, "origin", "master", "foo");
            assert.isNull(goodResult);
            const newBranch = yield GitUtil.findBranch(rr.bare, "foo");
            assert.isNotNull(newBranch);
            const masterHead = yield rr.clone.getHeadCommit();
            const fooHead    = yield rr.bare.getHeadCommit();
            assert(masterHead.id().equal(fooHead.id()));

            const badResult =
                           yield GitUtil.push(rr.clone, "xx", "master", "bar");
            assert.isString(badResult);
        }));
    });

    describe("getCurrentBranchName", function () {
        after(TestUtil.cleanup);

        it("breathing test", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();

            assert.equal("master", yield GitUtil.getCurrentBranchName(repo));

            repo.detachHead();

            assert.isNull(yield GitUtil.getCurrentBranchName(repo));
        }));
    });

    describe("resolveCommitish", function () {
        after(TestUtil.cleanup);

        // We know the actual resolution is handled by 'NodeGit', so just do
        // some simple tests to prove to ourselves that we are forwarding the
        // arguments correctly.

        it("breathing test", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();

            const headCommit = yield repo.getHeadCommit();
            const headCommitId = headCommit.id();

            const masterResolve =
                                yield GitUtil.resolveCommitish(repo, "master");

            assert(headCommitId.equal(masterResolve.id()));

            const partialSha = headCommitId.tostrS();
            const shaResolve =
                              yield GitUtil.resolveCommitish(repo, partialSha);

            assert(headCommitId.equal(shaResolve.id()));

            assert.isNull(yield GitUtil.resolveCommitish(repo, "foo"));
        }));
    });

    describe("shortSha", function () {
        it("breahingTest", function () {
            const input = "e76a1dda3a42ba1f20b6f35297ee5eda6f9cc017";
            assert.equal("e76a1d", GitUtil.shortSha(input));
        });
    });

    describe("fetch", function () {
        after(TestUtil.cleanup);

        // We aren't doing the actual work, so just test that we pass things
        // through for now.

        it("breathingTest", co.wrap(function *() {
            const rr = yield TestUtil.createRepoAndRemote();
            const repo = rr.clone;
            const newCommit = yield TestUtil.generateCommit(repo);
            const newDir = yield TestUtil.makeTempDir();
            const newRepo = yield NodeGit.Clone.clone(rr.bare.path(), newDir);

            yield GitUtil.push(repo, "origin", "master", "master");
            yield GitUtil.fetch(newRepo, "origin");

            const master =
                   yield GitUtil.findRemoteBranch(newRepo, "origin", "master");
            const masterCommit = master.target();
            assert(masterCommit.equal(newCommit));

            // Now fetch and fail.

            try {
                yield GitUtil.fetch(newRepo, "garbage");
                assert(false, "didn't fail");
            }
            catch (e) {
                assert.instanceOf(e, UserError);
            }
        }));
    });

    describe("listUnpushedCommits", function () {
        after(TestUtil.cleanup);

        // This one is a bit complicated to test, to catch all the edge cases.
        // A few things we want to check:
        // - nothing unpushed
        // - all commits unpushed
        // - simple case
        // TODO
        // - multiple remote branches to exercise the logic that chooses the
        //   best one

        it("all already pushed", co.wrap(function *() {
            const rr = yield TestUtil.createRepoAndRemote();
            const repo = rr.clone;
            const head = yield repo.getHeadCommit();
            const unpushed = yield GitUtil.listUnpushedCommits(
                                                           repo,
                                                           "origin",
                                                           head.id().tostrS());
            assert.equal(0, unpushed.length);
        }));

        it("one not pushed", co.wrap(function *() {
            const rr = yield TestUtil.createRepoAndRemote();
            const repo = rr.clone;
            const head = yield repo.getHeadCommit();
            const newCommit = yield TestUtil.generateCommit(repo);
            const fromHead = yield GitUtil.listUnpushedCommits(
                                                           repo,
                                                           "origin",
                                                           head.id().tostrS());
            assert.equal(0, fromHead.length);
            const fromNew = yield GitUtil.listUnpushedCommits(
                                                           repo,
                                                           "origin",
                                                           newCommit.tostrS());
            assert.equal(1, fromNew.length);
            assert(fromNew[0].equal(newCommit));
        }));

        it("a descendant is pushed", co.wrap(function *() {
            // Check the case where the head of a remote branch points to a
            // descendant of the commit we're checking from.

            const rr = yield TestUtil.createRepoAndRemote();
            const repo = rr.clone;
            const newCommit = yield TestUtil.generateCommit(repo);
            yield TestUtil.generateCommit(repo);
            yield GitUtil.push(rr.clone, "origin", "master", "foo");
            const result  = yield GitUtil.listUnpushedCommits(
                                                           repo,
                                                           "origin",
                                                           newCommit.tostrS());
            assert.equal(0, result.length);
        }));

        it("all unpushed", co.wrap(function *() {
            // This hits the special case where no remote branch has history in
            // common with the commit.

            const rr = yield TestUtil.createRepoAndRemote();
            const repo = rr.clone;
            const newDir = yield TestUtil.makeTempDir();
            const newRepo = yield NodeGit.Repository.init(newDir, 1);
            NodeGit.Remote.create(repo, "foo", newRepo.path());
            const head = yield repo.getHeadCommit();
            const unpushed = yield GitUtil.listUnpushedCommits(
                                                           repo,
                                                           "foo",
                                                           head.id().tostrS());
            assert.equal(1, unpushed.length);
            assert(unpushed[0].equal(head.id()));
        }));
    });
});
