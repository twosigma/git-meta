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

const RepoAST             = require("../../lib/util/repoast");
const RepoASTIOUtil       = require("../../lib/util/repoastioutil");
const RepoASTUtil         = require("../../lib/util/repoastutil");
const ShorthandParserUtil = require("../../lib/util/shorthandparserutil");
const TestUtil            = require("../../lib/util/testutil");

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

describe("repoastioutil", function () {
    after(TestUtil.cleanup);

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
    });

    describe("writeRAST", function () {
        // We will "cheat" and utilize the already-tested `readRAST` to test
        // this one.

        const cases = {
            "simple": "S",
            "simple with branch": "S:Bfoo=1",
            "with another commit": "S:C2-1;Bmaster=2",
            "with commit chain": "S:C3-2;C2-1;Bmaster=3",
            "bare": "B",
            "bare with commits": "B:C2-1;Bmaster=2",
            "remote": "S:Rfoo=bar master=1",
            "bare with commit": "B:C2-1;Bmaster=2",
            "switch current": "S:Bfoo=1;*=foo",
            "delete branch": "S:Bfoo=1;Bmaster=;*=foo",
        };

        Object.keys(cases).forEach(caseName => {
            const shorthand = cases[caseName];
            it(caseName, co.wrap(function *() {
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

                RepoASTUtil.assertEqualASTs(mappedNewAst, ast);
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
