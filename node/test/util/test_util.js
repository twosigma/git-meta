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

const TestUtil = require("../../lib/util/test_util");

describe("TestUtil", function () {
    describe("makeTempDir", function () {

        // I don't know if we can verify that the returned directories are
        // "temporary", but we can verify that they subsequent calls return
        // different paths that are directories.

        it("breathing test", co.wrap(function *() {
            const first = yield TestUtil.makeTempDir();
            const stat = yield fs.stat(first);
            assert(stat.isDirectory());
            const second = yield TestUtil.makeTempDir();
            assert.notEqual(first, second);
        }));
    });


    describe("isSameRealPath", function () {

        // We're going to make some symlinks in a temp directory and check
        // them, and also check for proper failure.

        it("breathing test", co.wrap(function *() {
            const dir = yield TestUtil.makeTempDir();
            const subdirPath = path.join(dir, "sub");
            yield fs.mkdir(subdirPath);

            assert(yield TestUtil.isSameRealPath(dir, dir), "trivial");
            assert(!(yield TestUtil.isSameRealPath(dir, subdirPath)),
                   "not same");

            const sublinkPath = path.join(dir, "sublink");
            yield fs.symlink(subdirPath, sublinkPath);

            assert(yield TestUtil.isSameRealPath(subdirPath, sublinkPath),
                   "links same");
        }));
    });

    describe("createSimpleRepository", function () {

        it("with default", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();

            assert.instanceOf(repo, NodeGit.Repository);

            // Check repo is not in merging, rebase, etc. state

            assert(repo.isDefaultState());

            // Check that the index has an entry in it for "README.md"

            const index = yield repo.index();
            assert.equal(1, index.entryCount());
            const entry = index.getByPath("README.md");
            assert(entry);

            // Check that the repo has clean index and workdir

            const status = yield repo.getStatus();
            assert(0 === status.length);
        }));

        it("with path", co.wrap(function *() {
            const tempDir = yield TestUtil.makeTempDir();
            const repoPath = path.join(tempDir, "foo");
            const repo = yield TestUtil.createSimpleRepository(repoPath);
            assert.instanceOf(repo, NodeGit.Repository);
            assert(yield TestUtil.isSameRealPath(repo.workdir(), repoPath));
        }));
    });

    describe("createSimpleRepositoryOnBranch", function () {

        it("createSimpleRepositoryOnBranch", co.wrap(function *() {
            const branchName = "public";
            const repo = 
                yield TestUtil.createSimpleRepositoryOnBranch(branchName);
            const repoBranch = yield repo.getCurrentBranch();

            assert.instanceOf(repo, NodeGit.Repository);

            // Check repo is not in merging, rebase, etc. state

            assert(repo.isDefaultState());

            // Check that the repo in the "public" branch

            assert.equal(repoBranch.shorthand(), branchName);
        }));
    });

    describe("pathExists", function () {

        it("pathExists", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const repoDir = repo.workdir();
            const repoPathExists = yield TestUtil.pathExists(repoDir);
            assert(repoPathExists);
            const fakePath = path.join(repoDir, "not-a-path-in-the-repo");
            const fakeExists = yield TestUtil.pathExists(fakePath);
            assert.isFalse(fakeExists);
        }));
    });

    describe("createRepoAndRemote", function () {

        it("createRepoAndRemote", co.wrap(function *() {
            const rr = yield TestUtil.createRepoAndRemote();
            const bare = rr.bare;
            const clone = rr.clone;

            // Through white box testing, we know that this method is
            // implemented in terms of the already tested
            // 'createSimpleRepository'; we need to

            // verify that:
            //   - the clone is a non-bare repo
            //   - check to see that the expected 'README.md' file is in it
            //   - verify that the bare repo is bare
            //   - and that it is actually the remote of the clone

            assert(!clone.isBare(), "clone is not bare");
            const readmePath = path.join(clone.workdir(), "README.md");
            assert(yield TestUtil.pathExists(readmePath), "clone has readme");
            assert(bare.isBare(), "bare repo is bare");
            const remote = yield clone.getRemote("origin");

            // Interestingly, the 'path' returned by 'NodeGit.Repository' -- at
            // least on my mac -- is different from what it was created with;
            // it is the "real" path, e.g.: "/private/var/..." instead of
            // "/var/...".

            assert(TestUtil.isSameRealPath(remote.url(), bare.path()),
                   "remote is right url");
        }));
    });

    describe("makeCommit", function () {
        // This method passes through to 'repo.createCommitOnHead'; we'll do a
        // simple breathing test to verify that things are passed through
        // correctly.

        it("breathing test", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const currentHead = yield repo.getHeadCommit();

            const fileName = "my-file.txt";
            const filePath = path.join(repo.workdir(), fileName);
            yield fs.appendFile(filePath, "text");
            const commit  = yield TestUtil.makeCommit(repo, [fileName]);

            // Check that the commit has the expected change.

            const diffs = yield commit.getDiff();
            assert.equal(1, diffs.length);
            const diff = diffs[0];
            assert.equal(1, diff.numDeltas());
            assert.equal(fileName, diff.getDelta(0).newFile().path());

            // See that it's a new commit.

            assert(!currentHead.id().equal(commit.id()));

            // See that it's head.

            const newHead = yield repo.getHeadCommit();
            assert(newHead.id().equal(commit.id()));
        }));
    });

    describe("generateCommit", function () {

        it("breathing test", co.wrap(function *() {
            // Check that it makes a new commit that is:
            //   - the new head
            //   - different from the last head

            const repo = yield TestUtil.createSimpleRepository();
            const currentHead = yield repo.getHeadCommit();
            const newCommitId = (yield TestUtil.generateCommit(repo)).id();
            const newHead     = yield repo.getHeadCommit();

            assert(!currentHead.id().equal(newCommitId));
            assert(newHead.id().equal(newCommitId));
        }));
    });

    describe("makeBareCopy", function () {
        it("breathing test", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepositoryOnBranch("foo");
            const barePath = yield TestUtil.makeTempDir();
            const bare = yield TestUtil.makeBareCopy(repo, barePath);
            const samePath = yield TestUtil.isSameRealPath(barePath,
                                                           bare.path());
            assert(samePath);
            assert.instanceOf(bare, NodeGit.Repository);
            assert(bare.isBare());
            const master = yield bare.getBranch("master");
            assert.equal(master.shorthand(), "master");
            const foo = yield bare.getBranch("foo");
            assert.equal(foo.shorthand(), "foo");
            const remotes = yield NodeGit.Remote.list(bare);
            assert.equal(remotes.length, 0);
        }));
    });
});
