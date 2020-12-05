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
const rimraf  = require("rimraf");

const ForcePushSpec       = require("../../lib/util/force_push_spec");
const GitUtil             = require("../../lib/util/git_util");
const Push                = require("../../lib/util/push");
const RepoAST             = require("../../lib/util/repo_ast");
const RepoASTUtil         = require("../../lib/util/repo_ast_util");
const RepoASTTestUtil     = require("../../lib/util/repo_ast_test_util");
const SubmoduleUtil       = require("../../lib/util/submodule_util");
const SubmoduleConfigUtil = require("../../lib/util/submodule_config_util");

/**
 * Return a map from name to RepoAST that is the same as the one in the
 * specified `expected`, but having transformed the name of each reference from
 * the form of `ref/commit/<logical commit id>` to
 * `ref/commit/<physical commit id>`, where <logical commit id> is the id of
 * the commit the ref points to.  The specified `mapping` argument contains a
 * `reverseCommitMap` object that maps from logical to physical commit id.
 *
 * @param {Object} expected
 * @param {Object} mapping (as in RepoASTTestUtil)
 * @return  {Object}
 */
function refMapper(expected, mapping) {
    const syntheticMetaRefRE = /(commits\/)(.*)/;
    const reverseCommitMap = mapping.reverseCommitMap;

    function mapASTRefs(ast) {
        let newRefs = {};
        const oldRefs = ast.refs;
        Object.keys(oldRefs).forEach(ref => {
            const logicalId = oldRefs[ref];
            const physicalId = reverseCommitMap[logicalId];
            const newRefName = ref.replace(syntheticMetaRefRE,
                                           `$1${physicalId}`);
            newRefs[newRefName] = logicalId;
        });
        return newRefs;
    }

    let result = {};
    Object.keys(expected).forEach(key => {
        const ast = expected[key];
        const newRefs = mapASTRefs(ast);
        const newSubs = refMapper(ast.openSubmodules, mapping);
        result[key] = ast.copy({
            openSubmodules: newSubs,
            refs: newRefs,
        });
    });
    return result;
}

describe("refMapper", function () {
    // Test the `refMapper` function used in this test driver.

    const Commit    = RepoAST.Commit;
    const Submodule = RepoAST.Submodule;
    const cases = {
        "trivial": {
            input: {
            },
            expected: {
            },
        },
        "simple": {
            input: {
                x: new RepoAST(),
            },
            expected: {
                x: new RepoAST(),
            },
        },
        "no transform": {
            input: {
                x: new RepoAST({
                    commits: { "1": new Commit() },
                    refs: {
                        "foo/bar": "1",
                    },
                }),
            },
            expected: {
                x: new RepoAST({
                    commits: { "1": new Commit() },
                    refs: {
                        "foo/bar": "1",
                    },
                }),
            },
        },
        "transform": {
            input: {
                x: new RepoAST({
                    commits: { "1": new Commit() },
                    refs: {
                        "commits/1": "1",
                    },
                }),
            },
            expected: {
                x: new RepoAST({
                    commits: { "1": new Commit() },
                    refs: {
                        "commits/ffff": "1",
                    },
                }),
            },
            reverseCommitMap: {
                "1": "ffff",
            },
        },
        "transform in sub": {
            input: {
                x: new RepoAST({
                    commits: { "2": new Commit() },
                    head: "2",
                    index: {
                        q: new Submodule("a","a"),
                    },
                    openSubmodules: {
                        q: new RepoAST({
                            commits: { "1": new Commit() },
                            refs: {
                                "commits/1": "1",
                            },
                        })
                    },
                }),
            },
            expected: {
                x: new RepoAST({
                    commits: { "2": new Commit() },
                    head: "2",
                    index: {
                        q: new Submodule("a","a"),
                    },
                    openSubmodules: {
                        q: new RepoAST({
                            commits: { "1": new Commit() },
                            refs: {
                                "commits/ffff": "1",
                            },
                        })
                    },
                }),
            },
            reverseCommitMap: {
                "1": "ffff",
            },
        },
    };

    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, () => {
            const result = refMapper(c.input, {
                reverseCommitMap: c.reverseCommitMap || {},
            });
            RepoASTUtil.assertEqualRepoMaps(result, c.expected);
        });
    });
});

describe("getPushMap", function () {
    const cases = {
        "empty, by sha" : {
            initial: "x=S:C2-1;Bmaster=2",
            source: "2",
            expectedPushMap: {}
        },
        "simple" : {
            initial: `sub=S:C8-1;Bmaster=8|x=S:C2-1 d=Ssub:8;Bmaster=2;Od`,
            source: "2",
            expectedPushMap: {
                d : "8"
            },
        },
        "another sub in parent commit" : {
            initial: `sub1=S:C8-1;Bmaster=8|
                      sub2=S:C7-1;Bmaster=7|
                      x=S:C2-1 d1=Ssub1:8;C3-2 d2=Ssub2:7;Bmaster=3;Od1;Od2`,
            source: "3",
            expectedPushMap: {
                d1 : "8",
                d2 : "7"
            },
        },
        "another sub in parent commit, but origin already has it" : {
            initial: `sub1=S:C8-1;Bmaster=8|
                      sub2=S:C7-1;Bmaster=7|
                      x=S:C2-1 d1=Ssub1:8;C3-2 d2=Ssub2:7;Bmaster=3;
                      Rorigin=foo target=2;
                      Od1;Od2`,
            source: "3",
            expectedPushMap: {
                d2 : "7",
            },
        },
        "origin has a child but we didn't fetch it, so we don't know that" : {
            initial: `sub=S:C7-1;C8-7;Bmaster=8|
                      x=S:C2-1 d=Ssub:8;C3-1 d=Ssub:7;Bmaster=3;
                      Rorigin=foo target=2;
                      Od`,
            source: "3",
            expectedPushMap: {
                d : "7",
            },
        },
        "origin has different commit, but we didn't change anything": {
            initial: `
a=B:B3=3;C3-2 s=Sa:z;Cz-1;Bz=z|b=B|
x=S:B3=3;C2-1 s=Sa:1;Rorigin=a master=3;Rtarget=b;Bmaster=2 origin/master;Os`,
            source: "refs/heads/master",
            expectedPushMap: {},
        },
        "origin is equal" : {
            initial: `sub=S:C7-1;Bmaster=7|
                      x=S:C2-1 d=Ssub:7;Bmaster=2;
                      Rorigin=foo target=2;
                      Od`,
            extraFetch: {
                "d" : {
                    sub: "sub",
                    commits: ["7"],
                },
            },
            source: "2",
            expectedPushMap: {},
        },
    };

    const testGetPushMap = function(source, expectedPushMap, extraFetch) {
        return co.wrap(function *(repos, commitMap) {
            const repo = repos.x;
            let sha;
            if (parseInt(source) > 0) {
                sha = commitMap.reverseCommitMap[source];
            } else {
                sha = (yield repo.getReference(source)).target();
            }

            const commit = yield repo.getCommit(sha);

            // Do any necessary extra fetches in submodules
            for (const sub of Object.keys(extraFetch)) {
                const extra = extraFetch[sub];
                const subRepo = yield SubmoduleUtil.getBareRepo(repo, sub);
                for (const toFetch of extra.commits) {
                    const mappedCommit = commitMap.reverseCommitMap[toFetch];
                    yield GitUtil.fetchSha(subRepo,
                                           commitMap.reverseUrlMap[extra.sub],
                                           mappedCommit);
                    }
            }

            // We want to test two modes: one with submodules open,
            // and another with them closed. We need them to be initially
            // open, because this will populate .git/modules, but
            // we also want to test with them closed to ensure
            // that we can handle that case.
            for (const closeSubs of [false, true]) {
                if (closeSubs) {
                    const subs = yield SubmoduleUtil.listOpenSubmodules(repo);
                    yield SubmoduleConfigUtil.deinit(repo, subs);
                }

                const pushMap = yield Push.getPushMap(repo, source, commit);
                const mappedPushMap = {};
                for (const sub of Object.keys(pushMap)) {
                    mappedPushMap[sub] = commitMap.commitMap[pushMap[sub]];
                }
                assert.deepEqual(expectedPushMap, mappedPushMap);
            }
        });
    };

    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const parts = c.initial.split(";");
            const expectedParts = parts.filter(
                part => !part.trim().startsWith("O"));
            const expected = expectedParts.join(";");
            const manipulator = testGetPushMap(c.source,
                                               c.expectedPushMap,
                                               c.extraFetch || {});
            yield RepoASTTestUtil.testMultiRepoManipulator(
                c.initial,
                expected,
                manipulator,
                false,
                {includeRefsCommits : true});
        }));
    });

    it("handles a case with no tracking branches", co.wrap(function*() {
        // We can't use the usual multi-repo test for this because it
        // gets confused about which commits should exist in which
        // submodules.  Instead, we create a meta commit in one repo
        // then do a fetch into a fresh repo (which has ever opened
        // the repo in question but which doesn't have the
        // newly-fetched commit).

        const them = "sub=S:C8-1;Bmaster=8|x=S:C2-1 d=Ssub:8;Bmaster=2";
        const us = "sub=S:C7-1;Bmaster=7|x=S:C3-1 d=Ssub:7;Bmaster=3;Od";

        const theirWritten = yield RepoASTTestUtil.createMultiRepos(them);
        const theirRepo = theirWritten.repos.x;
        const theirCommitMap = theirWritten.reverseCommitMap;

        const ourWritten = yield RepoASTTestUtil.createMultiRepos(us);

        const ourRepo = ourWritten.repos.x;
        const config = yield ourRepo.config();
        yield config.setString("remote.upstream.url", theirRepo.path());
        yield GitUtil.fetch(ourRepo, "upstream");

        const sha = theirCommitMap["2"];
        const commit = yield ourRepo.getCommit(sha);
        const pushMap = yield Push.getPushMap(ourRepo, "2", commit);
        assert.deepEqual({}, pushMap);
    }));

    it("local clone is missing directory", co.wrap(function*() {
        const them = "sub=S:C8-1;Bmaster=8|x=S:C2-1 d=Ssub:8;Bmaster=2";
        const our = "sub=S:C7-1;Bmaster=7|x=S:C3-1 d=Ssub:7;Bmaster=3;Od";

        const theirWritten = yield RepoASTTestUtil.createMultiRepos(them);
        const theirRepo = theirWritten.repos.x;

        const ourWritten = yield RepoASTTestUtil.createMultiRepos(our);
        const ourRepo = ourWritten.repos.x;
        const ourCommitMap = ourWritten.reverseCommitMap;

        const config = yield ourRepo.config();
        yield config.setString("remote.upstream.url", theirRepo.path());

        const sha = ourCommitMap["3"];
        const commit = yield ourRepo.getCommit(sha);
        const pushMap = yield Push.getPushMap(ourRepo, "2", commit);
        assert.deepEqual({"d": ourCommitMap["7"]}, pushMap);

        // "Delete" the codebase, but remain absorbed.
        yield (new Promise(callback => {
            return rimraf(ourWritten.repos.x.workdir() + "d", {},
                callback);
        }));
        const pushMapDel = yield Push.getPushMap(ourRepo, "2", commit);
        assert.deepEqual({"d": ourCommitMap["7"]}, pushMapDel);

        // Remove the absorbed codebase.
        yield (new Promise(callback => {
            return rimraf(ourWritten.repos.x.path() + "modules/d", {},
                callback);
        }));
        const pushMapRm = yield Push.getPushMap(ourRepo, "2", commit);
        assert.deepEqual({}, pushMapRm);
    }));
});

describe("push", function () {

    function pusher(repoName, remoteName, source, target, force) {
        return co.wrap(function *(repos) {
            force = force || ForcePushSpec.NoForce;
            const x = repos[repoName];
            yield Push.push(x, remoteName, source, target, force);
        });
    }

    const cases = {
        "simple failure": {
            initial: "a=S",
            manipulator: pusher("a", "origin", "master", "master"),
            fails: true,
        },
        "no-ffwd failure": {
            initial: "a=B:C2-1;Bmaster=2|b=Ca:C3-1;Bmaster=3",
            manipulator: pusher("b", "origin", "master", "master"),
            fails: true,
        },
        "no-ffwd success": {
            initial: "a=B:C2-1;Bmaster=2|b=Ca:C3-1;Bmaster=3 origin/master",
            manipulator: pusher(
                "b", "origin", "master", "master", ForcePushSpec.Force),
            expected: "a=B:C3-1;Bmaster=3|b=Ca",
        },
        "no-ffwd success with lease": {
            initial: "a=B:C2-1;Bmaster=2|b=Ca:C3-1;Bmaster=3 origin/master",
            manipulator: pusher(
                "b",
                "origin",
                "master",
                "master",
                ForcePushSpec.ForceWithLease),
            expected: "a=B:C3-1;Bmaster=3|b=Ca",
        },
        "no-ffwd old remote failure": {
            initial: `
                a=B:C2-1;Bmaster=2|
                b=Ca:Rorigin=a master=1;C3-1;Bmaster=3 origin/master;Bold=2`,
            manipulator: pusher(
                "b",
                "origin",
                "master",
                "master",
                ForcePushSpec.NoForce),
            fails: true,
        },
        "no-ffwd old remote success": {
            initial: `
                a=B:C2-1;Bmaster=2|
                b=Ca:Rorigin=a master=1;C3-1;Bmaster=3 origin/master;Bold=2`,
            manipulator: pusher(
                "b",
                "origin",
                "master",
                "master",
                ForcePushSpec.Force),
            expected: "a=B:C3-1;Bmaster=3|b=Ca:Bold=2",
        },
        "no-ffwd old remote failure with lease": {
            initial: `
                a=B:C2-1;Bmaster=2|
                b=Ca:Rorigin=a master=1;C3-1;Bmaster=3 origin/master;Bold=2`,
            manipulator: pusher(
                "b",
                "origin",
                "master",
                "master",
                ForcePushSpec.ForceWithLease),
            fails: true,
        },
        "simple (noop) success": {
            initial: "a=S|b=Ca",
            manipulator: pusher("b", "origin", "master", "master"),
        },
        "simple new branch success": {
            initial: "a=S|b=Ca",
            manipulator: pusher("b", "origin", "master", "foo"),
            expected: "a=E:Bfoo=1|b=E:Rorigin=a foo=1,master=1",
        },
        "simple success": {
            initial: "a=B|b=Ca:C2-1;Bmaster=2",
            manipulator: pusher("b", "origin", "master", "master"),
            expected: "a=E:C2-1;Bmaster=2|b=E:Rorigin=a master=2",
        },
        "closed submodule no change": {
            initial: "a=B|b=B|x=Ca:I b=Sb:1",
            manipulator: pusher("x", "origin", "master", "master"),
        },
        "open submodule no change": {
            initial: "a=B|b=B|x=Ca:I b=Sb:1;Ob Bmaster=1",
            manipulator: pusher("x", "origin", "master", "master"),
        },
        "open submodule make an unneeded ref": {
            initial: "a=B|b=B|x=Ca:C2-1 b=Sb:1;Bmaster=2;Ob",
            manipulator: pusher("x", "origin", "master", "foo"),
            expected: "\
a=E:Bfoo=2|\
b=E:Fcommits/1=1|\
x=E:Rorigin=a master=1,foo=2;Ob",
        },
        "open submodule push new ref": {
            initial: "a=B|b=B|x=Ca:C2-1 b=Sb:3;Bmaster=2;Ob C3-1",
            manipulator: pusher("x", "origin", "master", "foo"),
            expected: "\
a=E:Bfoo=2|\
b=E:Fcommits/3=3|\
x=E:Rorigin=a master=1,foo=2;Ob",
        },
        "open submodule derive URL from meta-repo, not local remote": {
            initial: "\
a=B|\
b=B|\
c=B|\
x=Ca:C2-1 b=Sb:3;Bmaster=2;Ob C3-1!Rorigin=c",
            manipulator: pusher("x", "origin", "master", "foo"),
            expected: "\
a=E:Bfoo=2|\
b=E:Fcommits/3=3|\
x=E:Rorigin=a master=1,foo=2;Ob Rorigin=c",
        },
        "open submodule meta remote is sub remote": {
            initial: `
a=B|
x=S:Rorigin=a;C2-1 b=S.:x;Bmaster=2;Ob Cx-1!H=x!Rorigin=a`,
            manipulator: pusher("x", "origin", "master", "foo"),
            expected: `
a=E:Bfoo=2;Fcommits/x=x|
x=E:Rorigin=a foo=2`,
        },
        "open submodule meta remote is sub remote, ignore origin": {
            initial: `
a=B|
b=B|
x=S:Rorigin=a;C2-1 b=S.:x;Bmaster=2;Ob Cx-1!H=x!Rorigin=b`,
            manipulator: pusher("x", "origin", "master", "foo"),
            expected: `
a=E:Bfoo=2;Fcommits/x=x|
x=E:Rorigin=a foo=2`,
        },
    };

    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                           c.expected,
                                                           c.manipulator,
                                                           c.fails, {
                includeRefsCommits : true,
                expectedTransformer: refMapper,
            });
        }));
    });
});

describe("getClosePushedCommit", function () {
    // 5 -> 4 -> 3 -> 1
    //        -> 2 ->
    const baseRepo = "x=S:C2-1;C3-1;C4-3,2;C5-4;Bmaster=5";

    const cases = {
        "no ref, no close pushed commit": {
            source: "5",
            refs: {
            },
            expectedCommit: null,
        },
        "one ref, commit is pushed": {
            source: "5",
            refs: {
                "refs/remotes/origin/1": "5",
            },
            expectedCommit: "5",
        },
        "one ref, far commit": {
            source: "5",
            refs: {
                "refs/remotes/origin/1": "1",
            },
            expectedCommit: "1",
        },
        "one ref, close commit": {
            source: "5",
            refs: {
                "refs/remotes/origin/1": "2",
            },
            expectedCommit: "1",
        },
        "lots of refs, none matching": {
            source: "5",
            remote: "origin",
            refs: {
                "refs/nonmatch/foo/1": "1",
                "refs/nonmatch/foo/2": "2",
                "refs/nonmatch/bar/3": "3",
                "refs/nonmatch/bar/4": "4",
            },
            expectedCommit: null,
        },
        "lots of refs, something matching": {
            source: "5",
            refs: {
                "refs/remotes/origin/1": "1",
                "refs/nonmatch/foo/2": "2",
                "refs/nonmatch/bar/3": "3",
                "refs/nonmatch/bar/4": "4",
            },
            expectedCommit: "1",
        },
        "lots of refs, something matching 2": {
            source: "5",
            refs: {
                "refs/nonmatch/foo/1": "1",
                "refs/nonmatch/foo/2": "2",
                "refs/nonmatch/bar/3": "3",
                "refs/remotes/origin/4": "4",
            },
            expectedCommit: "4",
        },
        "lots of refs, all matching": {
            source: "5",
            refs: {
                "refs/remotes/origin/1": "1",
                "refs/remotes/origin/2": "2",
                "refs/remotes/bar/3": "3",
                "refs/remotes/bar/4": "4",
            },
            expectedCommit: "4",
        },
        "lots of refs, commit is pushed": {
            source: "5",
            remote: "*",
            refs: {
                "refs/remotes/origin/1": "1",
                "refs/remotes/origin/2": "2",
                "refs/remotes/bar/3": "3",
                "refs/remotes/bar/4": "5",
            },
            expectedCommit: "5",
        },
    };

    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const repos = yield RepoASTTestUtil.createMultiRepos(baseRepo);
            const repo = repos.repos.x;

            for (const ref of Object.keys(c.refs)) {
                yield NodeGit.Reference.create(
                    repo, ref, repos.reverseCommitMap[c.refs[ref]], 1, "");
            }

            const commit = yield repo.getCommit(
                repos.reverseCommitMap[c.source]);
            const actualCommit = yield Push.getClosePushedCommit(
                repo, commit);
            if (null !== c.expectedCommit) {
                assert.deepEqual(repos.reverseCommitMap[c.expectedCommit], 
                                 actualCommit.id().tostrS());
            } else {
                assert.deepEqual(null, actualCommit);
            }
        }));
    });
});
