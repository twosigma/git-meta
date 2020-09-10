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

const ConfigUtil       = require("../../lib/util/config_util");
const Open             = require("../../lib/util/open");
const RepoASTTestUtil  = require("../../lib/util/repo_ast_test_util");
const SubmoduleFetcher = require("../../lib/util/submodule_fetcher");
const SubmoduleUtil    = require("../../lib/util/submodule_util");

const FORCE_OPEN = Open.SUB_OPEN_OPTION.FORCE_OPEN;
describe("openOnCommit", function () {
    // Assumption is that 'x' is the target repo.
    // TODO: test for template path usage.  We're just passing it through but
    // should verify that.

    const cases = {
        "simple": {
            initial: "a=B|x=U",
            subName: "s",
            commitSha: "1",
            expected: "x=E:Os",
        },
        "sparse": {
            initial: "a=B|x=%U",
            subName: "s",
            commitSha: "1",
            expected: "x=E:Os",
        },
        "not head": {
            initial: "a=B:C3-1;Bmaster=3|x=U",
            subName: "s",
            commitSha: "3",
            expected: "x=E:Os H=3",
        },
        "revert on bad fetch": {
            initial: "a=B|b=B|x=Ca:C3-1;C2-1 s=Sb:3;Bmaster=2;Bfoo=3",
            subName: "s",
            commitSha: "2",
            fails: true,
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const manipulator = co.wrap(function *(repos, maps) {
                assert.property(maps.reverseCommitMap, c.commitSha);
                const commit = maps.reverseCommitMap[c.commitSha];
                const x = repos.x;
                const head = yield x.getHeadCommit();
                const fetcher = new SubmoduleFetcher(x, head);
                const result = yield Open.openOnCommit(fetcher,
                                                       c.subName,
                                                       commit,
                                                       null,
                                                       false);
                assert.instanceOf(result, NodeGit.Repository);
            });
            yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                           c.expected,
                                                           manipulator,
                                                           c.fails);
        }));
    });
    describe("Opener", function () {
        it("repo", co.wrap(function *() {
            const w = yield RepoASTTestUtil.createMultiRepos("a=B|x=U:Os");
            const repo = w.repos.x;
            const opener = new Open.Opener(repo, null);
            assert.equal(opener.repo, repo);
        }));
        it("already open", co.wrap(function *() {
            const w = yield RepoASTTestUtil.createMultiRepos("a=B|x=U:Os");
            const repo = w.repos.x;
            const opener = new Open.Opener(repo, null);
            const s1 = yield opener.getSubrepo("s", FORCE_OPEN);
            const s2 = yield opener.getSubrepo("s", FORCE_OPEN);
            const base = yield SubmoduleUtil.getRepo(repo, "s");
            assert.equal(s1, s2, "not re-opened");
            assert.equal(s1.workdir(), base.workdir(), "right path");
        }));
        it("not open", co.wrap(function *() {
            const w = yield RepoASTTestUtil.createMultiRepos("a=B|x=U");
            const repo = w.repos.x;
            const opener = new Open.Opener(repo, null);
            const s1 = yield opener.getSubrepo("s", FORCE_OPEN);
            const s2 = yield opener.getSubrepo("s", FORCE_OPEN);
            const base = yield SubmoduleUtil.getRepo(repo, "s");
            assert.equal(s1, s2, "not re-opened");
            assert.equal(s1.workdir(), base.workdir(), "right path");
            const config = yield s1.config();
            const gcConfig = yield ConfigUtil.getConfigString(config,
                                                            "gc.auto");
            assert.equal("0", gcConfig);
        }));
        it("different commit", co.wrap(function *() {
            const state = "a=B:Ca-1;Ba=a|x=U:C3-2 s=Sa:a;Bfoo=3";
            const w = yield RepoASTTestUtil.createMultiRepos(state);
            const commitMap = w.reverseCommitMap;
            const baseSha = commitMap["3"];
            const subSha = commitMap.a;
            const repo = w.repos.x;
            const commit = yield repo.getCommit(baseSha);
            const opener = new Open.Opener(repo, commit);
            const s = yield opener.getSubrepo("s", FORCE_OPEN);
            const head = yield s.getHeadCommit();
            assert.equal(head.id().tostrS(), subSha);
        }));
        it("fetcher", co.wrap(function *() {
            const state = "x=S";
            const w = yield RepoASTTestUtil.createMultiRepos(state);
            const repo = w.repos.x;
            const opener = new Open.Opener(repo, null);
            const fetcher = yield opener.fetcher();
            assert.instanceOf(fetcher, SubmoduleFetcher);
        }));
        it("getOpenSubs, empty", co.wrap(function *() {
            const state = "a=B|x=U";
            const w = yield RepoASTTestUtil.createMultiRepos(state);
            const repo = w.repos.x;
            const opener = new Open.Opener(repo, null);
            const open = yield opener.getOpenSubs();
            assert.deepEqual(Array.from(open), []);
        }));
        it("getOpenSubs, empty after open", co.wrap(function *() {
            const state = "a=B|x=U";
            const w = yield RepoASTTestUtil.createMultiRepos(state);
            const repo = w.repos.x;
            const opener = new Open.Opener(repo, null);
            yield opener.getSubrepo("s", FORCE_OPEN);
            const open = yield opener.getOpenSubs();
            assert.deepEqual(Array.from(open), []);
        }));
        it("getOpenSubs, non-empty", co.wrap(function *() {
            const state = "a=B|x=U:Os";
            const w = yield RepoASTTestUtil.createMultiRepos(state);
            const repo = w.repos.x;
            const opener = new Open.Opener(repo, null);
            const open = yield opener.getOpenSubs();
            assert.deepEqual(Array.from(open), ["s"]);
        }));
        it("getOpenedSubs, empty", co.wrap(function *() {
            const state = "a=B|x=U";
            const w = yield RepoASTTestUtil.createMultiRepos(state);
            const repo = w.repos.x;
            const opener = new Open.Opener(repo, null);
            const opened = yield opener.getOpenedSubs();
            assert.deepEqual(opened, []);
        }));
        it("getOpenedSubs, empty after getting opened", co.wrap(function *() {
            const state = "a=B|x=U:Os";
            const w = yield RepoASTTestUtil.createMultiRepos(state);
            const repo = w.repos.x;
            const opener = new Open.Opener(repo, null);
            yield opener.getSubrepo("s", FORCE_OPEN);
            const opened = yield opener.getOpenedSubs();
            assert.deepEqual(opened, []);
        }));
        it("getOpenedSubs, non-empty", co.wrap(function *() {
            const state = "a=B|x=U";
            const w = yield RepoASTTestUtil.createMultiRepos(state);
            const repo = w.repos.x;
            const opener = new Open.Opener(repo, null);
            yield opener.getSubrepo("s", FORCE_OPEN);
            const opened = yield opener.getOpenedSubs();
            assert.deepEqual(opened, ["s"]);
        }));
        it("isOpen, not", co.wrap(function *() {
            const state = "a=B|x=U";
            const w = yield RepoASTTestUtil.createMultiRepos(state);
            const repo = w.repos.x;
            const opener = new Open.Opener(repo, null);
            const result = opener.isOpen("s");
            assert.equal(false, result);
        }));
        it("isOpen, true after open", co.wrap(function *() {
            const state = "a=B|x=U";
            const w = yield RepoASTTestUtil.createMultiRepos(state);
            const repo = w.repos.x;
            const opener = new Open.Opener(repo, null);
            const s = yield opener.getSubrepo("s", FORCE_OPEN);
            const result = opener.isOpen("s");
            assert.equal(true, result);
            const config = yield s.config();
            const gcConfig = yield ConfigUtil.getConfigString(config,
                                                            "gc.auto");
            assert.equal("0", gcConfig);
        }));
        it("getOpenSubs, true immediately", co.wrap(function *() {
            const state = "a=B|x=U:Os";
            const w = yield RepoASTTestUtil.createMultiRepos(state);
            const repo = w.repos.x;
            const opener = new Open.Opener(repo, null);
            const result = opener.isOpen("s");
            assert.equal(true, result);
        }));
    });
});
