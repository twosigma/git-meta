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

const assert = require("chai").assert;
const co     = require("co");

const RepoASTTestUtil  = require("../../lib/util/repo_ast_test_util");
const SubmoduleFetcher = require("../../lib/util/submodule_fetcher");
const SubmoduleUtil    = require("../../lib/util/submodule_util");
const UserError        = require("../../lib/util/user_error");

describe("SubmoduleFetcher", function () {

    describe("getMetaOriginUrl", function () {
        // Always use repo 'x'.

        const cases = {
            "no origin": {
                initial: "a=B:C4-1;Bfoo=4|b=B|x=U:Os Rorigin=c",
                metaSha: "2",
                expected: null,
            },
            "null commit": {
                initial: "a=B:C4-1;Bfoo=4|b=B|x=U:Os Rorigin=c",
                metaSha: null,
                expected: null,
            },
            "pulled from origin": {
                initial: "a=B:C4-1;Bfoo=4|b=B|x=Ca",
                metaSha: "1",
                metaOriginUrl: null,
                expected: "a",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written =
                             yield RepoASTTestUtil.createMultiRepos(c.initial);
                const repo = written.repos.x;
                let commit = null;
                if (null !== c.metaSha) {
                    const newSha = written.reverseCommitMap[c.metaSha];
                    commit = yield repo.getCommit(newSha);
                }
                let metaUrl = c.metaOriginUrl;
                if (null !== metaUrl) {
                    metaUrl = written.reverseUrlMap[metaUrl];
                }
                const fetcher = new SubmoduleFetcher(repo, commit);
                let resultUrl = yield fetcher.getMetaOriginUrl();
                if (null !== resultUrl) {
                    resultUrl = written.urlMap[resultUrl];
                }
                assert.equal(resultUrl, c.expected);
            }));
        });
    });

    describe("simple accessors", function () {
        it("repo", co.wrap(function *() {
            const written = yield RepoASTTestUtil.createMultiRepos("x=S");
            const x = written.repos.x;
            const commit = yield x.getCommit(written.reverseCommitMap["1"]);
            const fetcher = new SubmoduleFetcher(x, commit);
            assert.equal(x, fetcher.repo);
        }));
        it("commit", co.wrap(function *() {
            const written = yield RepoASTTestUtil.createMultiRepos("x=S");
            const x = written.repos.x;
            const commit = yield x.getCommit(written.reverseCommitMap["1"]);
            const fetcher = new SubmoduleFetcher(x, commit);
            assert.equal(commit, fetcher.commit);
        }));
    });

    describe("getSubmoduleUrl", function () {
        it("breathing", co.wrap(function *() {
            const written = yield RepoASTTestUtil.createMultiRepos(
                                                        "a=B:C4-1;Bfoo=4|x=U");
            const x = written.repos.x;
            const commit = yield x.getCommit(written.reverseCommitMap["2"]);
            const fetcher = new SubmoduleFetcher(x, commit);
            const newUrl = yield fetcher.getSubmoduleUrl("s");
            const resultUrl = written.urlMap[newUrl];
            assert.equal(resultUrl, "a");
        }));
        it("bad on commit", co.wrap(function *() {
            const written = yield RepoASTTestUtil.createMultiRepos(
                                                        "a=B:C4-1;Bfoo=4|x=U");
            const x = written.repos.x;
            const commit = yield x.getCommit(written.reverseCommitMap["1"]);
            const fetcher = new SubmoduleFetcher(x, commit);
            try {
                yield fetcher.getSubmoduleUrl("s");
            }
            catch (e) {
                assert.instanceOf(e, UserError);
                return;                                               // RETURN
            }
            assert(false, "should have failed");
        }));
    });

    describe("fetchSha", function () {
        // Will always fetch from repo 'x'.

        const cases = {
            "simple": {
                initial: "a=B:C4-1;Bfoo=4|x=U:Os",
                metaSha: "2",
                fetches: [
                    {
                        sub: "s",
                        sha: "4",
                    },
                ],
            },
            "with ignored remote": {
                initial: "a=B:C4-1;Bfoo=4|b=B|x=U:Os Rorigin=c",
                metaSha: "2",
                fetches: [
                    {
                        sub: "s",
                        sha: "4",
                    },
                ],
            },
            "with relative url": {
                initial:
                    "a=B:C4-1;Bfoo=4|b=B|x=Cb:C2-1 s=S../a:1;Os;Bmaster=2",
                metaSha: "2",
                fetches: [
                    {
                        sub: "s",
                        sha: "4",
                    },
                ],
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const fetcher = co.wrap(function *(repos, maps) {
                    const x = repos.x;
                    const revMap = maps.reverseCommitMap;
                    const newShaw = revMap[c.metaSha];
                    const commit = yield x.getCommit(newShaw);
                    const subFetcher = new SubmoduleFetcher(x, commit);
                    yield c.fetches.map(co.wrap(function *(fetch) {
                        const repo = yield SubmoduleUtil.getRepo(x, fetch.sub);
                        const newFetchSha = revMap[fetch.sha];
                        yield subFetcher.fetchSha(repo,
                                                  fetch.sub,
                                                  newFetchSha);

                        // Try to get the commit to verify it was retrieved.

                        yield repo.getCommit(newFetchSha);
                    }));
                });
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               c.expected,
                                                               fetcher,
                                                               c.fails);
            }));
        });
    });
});
