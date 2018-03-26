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
const colors  = require("colors");
const NodeGit = require("nodegit");

const RebaseUtil      = require("../../lib/util/rebase_util");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");
const StatusUtil      = require("../../lib/util/status_util");
const SubmoduleUtil   = require("../../lib/util/submodule_util");

function makeRebaser(operation) {
    return co.wrap(function *(repos, maps) {
        const result = yield operation(repos, maps);

        // Now build a map from the newly generated commits to the
        // logical names that will be used in the expected case.

        const commitMap = {};
        RepoASTTestUtil.mapCommits(commitMap,
                                   result.metaCommits,
                                   maps.commitMap,
                                   "M");
        RepoASTTestUtil.mapSubCommits(commitMap,
                                      result.submoduleCommits,
                                      maps.commitMap);
        return {
            commitMap: commitMap,
        };
    });
}

describe("rebase", function () {
    it("callNext", co.wrap(function *() {
        const init = "S:C2-1;Bmaster=2;C3-1;Bfoo=3";
        const written = yield RepoASTTestUtil.createRepo(init);
        const repo = written.repo;
        const ontoSha = written.oldCommitMap["3"];
        const fromId = NodeGit.Oid.fromString(ontoSha);
        const fromAnnotated =
                            yield NodeGit.AnnotatedCommit.lookup(repo, fromId);
        const head = yield repo.head();
        const ontoAnnotated = yield NodeGit.AnnotatedCommit.fromRef(repo,
                                                                    head);
        const rebase = yield NodeGit.Rebase.init(repo,
                                                 fromAnnotated,
                                                 ontoAnnotated,
                                                 null,
                                                 null);
        const first = yield RebaseUtil.callNext(rebase);
        assert.equal(first.id().tostrS(), ontoSha);
        const second = yield RebaseUtil.callNext(rebase);
        assert.isNull(second);
    }));

    describe("processRebase", function () {
        const cases = {
            "no conflicts": {
                initial: "x=S:C2-1;Cr-1;Bmaster=2;Br=r",
                expected: "x=E:Crr-2 r=r;H=rr",
                conflictedCommit: null,
            },
            "conflict": {
                initial: "x=S:C2-1;Cr-1 2=3;Bmaster=2;Br=r",
                expected: "x=E:I *2=~*2*3;W 2=u;H=2;Edetached HEAD,r,2",
                conflictedCommit: "r",
                expectedTransformer: function (expected, mapping) {
                    const content = `\
<<<<<<< ${mapping.reverseCommitMap["2"]}
2
=======
3
>>>>>>> message
`;
                    expected.x = expected.x.copy({
                        workdir: {
                            "2": content,
                        },
                    });
                    return expected;
                },
            },
            "fast forward": {
                initial: "x=S:C2-r;Cr-1;Bmaster=2;Br=r",
                expected: "x=E:H=2",
                conflictedCommit: null,
            },
        };
        Object.keys(cases).forEach(caseName => {
            it(caseName, co.wrap(function *() {
                const c = cases[caseName];
                const op = co.wrap(function *(repos, maps) {
                    const repo = repos.x;
                    const headCommit = yield repo.getHeadCommit();
                    const AnnotatedCommit = NodeGit.AnnotatedCommit;
                    const headAnnotated = yield AnnotatedCommit.lookup(
                                                              repo,
                                                              headCommit.id());
                    const targetCommitSha = maps.reverseCommitMap.r;
                    const targetCommit = yield repo.getCommit(targetCommitSha);
                    const targetAnnotated = yield AnnotatedCommit.lookup(
                                                            repo,
                                                            targetCommit.id());
                    const rebase = yield NodeGit.Rebase.init(repo,
                                                             targetAnnotated,
                                                             headAnnotated,
                                                             null,
                                                             null);
                    const op = yield RebaseUtil.callNext(rebase);
                    const result = yield RebaseUtil.processRebase(repo,
                                                                  rebase,
                                                                  op);
                    if (null === c.conflictedCommit) {
                        assert.isNull(result.conflictedCommit);
                    } else {
                        assert.equal(
                                    result.conflictedCommit,
                                    maps.reverseCommitMap[c.conflictedCommit]);
                    }
                    const commitMap = {};
                    Object.keys(result.commits).forEach(newSha => {
                        const oldSha = result.commits[newSha];
                        const oldLogicalCommit = maps.commitMap[oldSha];
                        commitMap[newSha] = oldLogicalCommit + "r";
                    });
                    return {
                        commitMap: commitMap,
                    };
                });
                const options = {};
                if (undefined !== c.expectedTransformer) {
                    options.expectedTransformer = c.expectedTransformer;
                }
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               c.expected,
                                                               op,
                                                               c.fails,
                                                               options);
            }));
        });
    });

    describe("rewriteCommits", function () {
        const cases = {
            "normal rebase": {
                initial: "x=S:C2-1;Cr-1;Bmaster=2;Br=r",
                expected: "x=E:Crr-2 r=r;H=rr",
                upstream: null,
                conflictedCommit: null,
            },
            "skip none": {
                initial: "x=S:C2-1;Cr-1;Bmaster=2;Br=r",
                expected: "x=E:Crr-2 r=r;H=rr",
                upstream: "1",
                conflictedCommit: null,
            },
            "conflict": {
                initial: "x=S:C2-1;Cr-1 2=3;Bmaster=2;Br=r",
                expected: `x=E:I *2=~*2*3;H=2;Edetached HEAD,r,2;W 2=\
<<<<<<< master
2
=======
3
>>>>>>> message
;
`,
                upstream: null,
                conflictedCommit: "r",
            },
            "multiple commits": {
                initial: "x=S:C2-1;C3-1;Cr-3;Bmaster=2;Br=r",
                expected: "x=E:Crr-3r r=r;C3r-2 3=3;H=rr",
                upstream: null,
                conflictedCommit: null,
            },
            "skip a commit": {
                initial: "x=S:C2-1;C3-1;Cr-3;Bmaster=2;Br=r",
                expected: "x=E:Crr-2 r=r;H=rr",
                upstream: "3",
                conflictedCommit: null,
            },
        };
        Object.keys(cases).forEach(caseName => {
            it(caseName, co.wrap(function *() {
                const c = cases[caseName];
                const op = co.wrap(function *(repos, maps) {
                    const repo = repos.x;
                    const targetSha = maps.reverseCommitMap.r;
                    const targetCommit = yield repo.getCommit(targetSha);
                    let upstreamCommit = null;
                    if (null !== c.upstream) {
                        const upstreamSha = maps.reverseCommitMap[c.upstream];
                        upstreamCommit = yield repo.getCommit(upstreamSha);
                    }
                    const result = yield RebaseUtil.rewriteCommits(
                                                               repo,
                                                               targetCommit,
                                                               upstreamCommit);
                    if (null === c.conflictedCommit) {
                        assert.isNull(result.conflictedCommit);
                    } else {
                        assert.equal(
                                    result.conflictedCommit,
                                    maps.reverseCommitMap[c.conflictedCommit]);
                    }
                    const commitMap = {};
                    Object.keys(result.commits).forEach(newSha => {
                        const oldSha = result.commits[newSha];
                        const oldLogicalCommit = maps.commitMap[oldSha];
                        commitMap[newSha] = oldLogicalCommit + "r";
                    });
                    return {
                        commitMap: commitMap,
                    };
                });
                const options = {};
                if (undefined !== c.expectedTransformer) {
                    options.expectedTransformer = c.expectedTransformer;
                }
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               c.expected,
                                                               op,
                                                               c.fails,
                                                               options);
            }));
        });
    });


    describe("rebase", function () {

        // Will append the leter 'M' to any created meta-repo commits, and the
        // submodule name to commits created in respective submodules.


        function rebaser(repoName, commit) {
            const rebaseOper = co.wrap(function *(repos, maps) {
                assert.property(repos, repoName);
                const repo = repos[repoName];
                const reverseCommitMap = maps.reverseCommitMap;
                assert.property(reverseCommitMap, commit);
                const originalActualCommit = reverseCommitMap[commit];
                const originalCommit =
                                    yield repo.getCommit(originalActualCommit);

                return yield RebaseUtil.rebase(repo, originalCommit);
            });

            return makeRebaser(rebaseOper);
        }
        const cases = {
            "trivially nothing to do": {
                initial: "x=S",
                rebaser: rebaser("x", "1"),
            },
            "nothing to do, in past": {
                initial: "x=S:C2-1;Bmaster=2",
                rebaser: rebaser("x", "1"),
            },
            "ffwd": {
                initial: "x=S:C2-1;Bfoo=2",
                rebaser: rebaser("x", "2"),
                expected: "x=E:Bmaster=2",
            },
            "simple rebase": {
                initial: "x=S:C2-1;C3-1;Bmaster=2;Bfoo=3",
                rebaser: rebaser("x", "3"),
                expected: "x=S:C2M-3 2=2;C3-1;Bmaster=2M;Bfoo=3",
            },
            "rebase two commits": {
                initial: "x=S:C2-1;C3-2;C4-1;Bmaster=3;Bfoo=4;Bx=3",
                rebaser: rebaser("x", "4"),
                expected: "x=E:C3M-2M 3=3;C2M-4 2=2;Bmaster=3M",
            },
            "rebase two commits on two": {
                initial: "x=S:C2-1;C3-2;C4-1;C5-4;Bmaster=3;Bfoo=5;Bx=3",
                rebaser: rebaser("x", "5"),
                expected: "x=E:C3M-2M 3=3;C2M-5 2=2;Bmaster=3M",
            },
            "up-to-date with sub": {
                initial: "a=Aa:Cb-a;Bfoo=b|x=U:C3-2 s=Sa:b;Bmaster=3;Bfoo=2",
                rebaser: rebaser("x", "2"),
            },
            "ffwd with sub": {
                initial: "a=Aa:Cb-a;Bfoo=b|x=U:C3-2 s=Sa:b;Bmaster=2;Bfoo=3",
                rebaser: rebaser("x", "3"),
                expected: "x=E:Bmaster=3",
            },
            "rebase change in closed sub": {
                initial: "\
a=Aa:Cb-a;Cc-a;Bmaster=b;Bfoo=c|\
x=U:C3-2 s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4;Bother=3",
                rebaser: rebaser("x", "4"),
                expected: "x=E:C3M-4 s=Sa:bs;Bmaster=3M;Os Cbs-c b=b!H=bs",
            },
            "rebase change in sub, sub already open": {
                initial: "\
a=Aa:Cb-a;Cc-a;Bmaster=b;Bfoo=c|\
x=U:C3-2 s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4;Bother=3;Os H=b",
                rebaser: rebaser("x", "4"),
                expected: "x=E:C3M-4 s=Sa:bs;Bmaster=3M;Os Cbs-c b=b!H=bs",
            },
            "rebase change in sub with two commits": {
                initial: "\
a=Aa:Cb-a;Cc-a;Bmaster=b;Bfoo=c|\
x=U:C4-2;C5-4 s=Sa:b;C3-2 s=Sa:c;Bmaster=5;Bfoo=5;Bother=3;Os H=b",
                rebaser: rebaser("x", "3"),
                expected: `
x=E:C5M-4M s=Sa:bs;C4M-3 4=4;Bmaster=5M;Os Cbs-c b=b!H=bs`,
            },
            "rebase change in sub with two intervening commits": {
                initial: `
a=Aa:Cb-a;Cc-a;Cd-c;Bmaster=b;Bfoo=d|
x=U:C4-2;C5-4 s=Sa:c;C6-5;C7-6 s=Sa:d;C3-2 s=Sa:b;Bmaster=7;Bfoo=7;Bother=3`,
                rebaser: rebaser("x", "3"),
                expected: `
x=E:C7M-6M s=Sa:ds;C6M-5M 6=6;C5M-4M s=Sa:cs;C4M-3 4=4;Bmaster=7M;
    Os Cds-cs d=d!Ccs-b c=c!H=ds`,
            },
            "rebase change in sub with two intervening commits, open": {
                initial: `
a=Aa:Cb-a;Cc-a;Cd-c;Bmaster=b;Bfoo=d|
x=U:C4-2;C5-4 s=Sa:c;C6-5;C7-6 s=Sa:d;C3-2 s=Sa:b;Bmaster=7;Bfoo=7;Bother=3;
    Os H=d`,
                rebaser: rebaser("x", "3"),
                expected: `
x=E:C7M-6M s=Sa:ds;C6M-5M 6=6;C5M-4M s=Sa:cs;C4M-3 4=4;Bmaster=7M;
    Os Cds-cs d=d!Ccs-b c=c!H=ds`,
            },
            "ffwd, but not sub (should ffwd anyway)": {
                initial: "\
a=Aa:Cb-a;Cc-a;Bmaster=b;Bfoo=c|\
x=U:C3-2 s=Sa:b;C4-3 s=Sa:c;Bmaster=3;Bfoo=4;Bother=3",
                rebaser: rebaser("x", "4"),
                expected: "x=E:Bmaster=4",
            },
            "no ffwd, but can ffwd sub": {
                initial: "\
a=Aa:Cb-a;Cc-b;Bmaster=b;Bfoo=c|\
x=U:C3-2 3=3,s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4;Bother=3;Os",
                rebaser: rebaser("x", "4"),
                expected: "x=E:C3M-4 3=3;Bmaster=3M;Os H=c",
            },
            "ffwd sub 2X": {
                initial: `
a=Aa:Cb-a;Cc-b;Bmaster=b;Bfoo=c|
x=U:Cr-2;C3-2 s=Sa:b;C4-3 s=Sa:c;Bmaster=4;Bother=r;Os;Bfoo=4`,
                rebaser: rebaser("x", "r"),
                expected: "x=E:C3M-r s=Sa:b;C4M-3M s=Sa:c;Bmaster=4M;Os H=c",
            },
            "ffwd-ed sub is closed after rebase": {
                initial: "\
a=Aa:Cb-a;Cc-b;Bmaster=b;Bfoo=c|\
x=U:C3-2 3=3,s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4;Bother=3",
                rebaser: rebaser("x", "4"),
                expected: "x=E:C3M-4 3=3;Bmaster=3M",
            },
            "rebase two changes in sub": {
                initial: "\
a=Aa:Cb-a;Cc-b;Cd-a;Bmaster=c;Bfoo=d|\
x=U:C3-2 s=Sa:c;C4-2 s=Sa:d;Bmaster=3;Bfoo=4;Bother=3",
                rebaser: rebaser("x", "4"),
                expected: "\
x=E:C3M-4 s=Sa:cs;Bmaster=3M;Os Ccs-bs c=c!Cbs-d b=b!H=cs",
            },
            "rebase with ffwd changes in sub and meta": {
                initial: "\
a=B:Bmaster=3;C2-1 s=Sb:q;C3-2 s=Sb:r,rar=wow|\
b=B:Cq-1;Cr-q;Bmaster=r|\
x=Ca:Bmaster=2;Os",
                rebaser: rebaser("x", "3"),
                expected: "x=E:Bmaster=3;Os H=r",
            },
            "make sure unchanged repos stay closed": {
                initial: "\
a=B|\
b=B:Cj-1;Ck-1;Bmaster=j;Bfoo=k|\
x=S:C2-1 s=Sa:1,t=Sb:1;C3-2 t=Sb:j;C4-2 t=Sb:k;Bmaster=3;Bfoo=4;Bold=3",
                rebaser: rebaser("x", "4"),
                expected: "\
x=E:C3M-4 t=Sb:jt;Bmaster=3M;Ot H=jt!Cjt-k j=j",
            },
            "make sure unchanged repos stay closed -- onto-only change": {
                initial: "\
a=B|\
b=B:Cj-1;Ck-1;Bmaster=j;Bfoo=k|\
x=S:C2-1 s=Sa:1,t=Sb:1;C3-2;C4-2 t=Sb:k;Bmaster=3;Bfoo=4;Bold=3",
                rebaser: rebaser("x", "4"),
                expected: "\
x=E:C3M-4 3=3;Bmaster=3M",
            },
            "make sure unchanged repos stay closed -- local-only change": {
                initial: "\
a=B|\
b=B:Cj-1;Ck-1;Bmaster=j;Bfoo=k|\
x=S:C2-1 s=Sa:1,t=Sb:1;C3-2;C4-2 t=Sb:k;Bmaster=4;Bfoo=3;Bold=4",
                rebaser: rebaser("x", "3"),
                expected: "\
x=E:C4M-3 t=Sb:k;Bmaster=4M",
            },
            "unchanged repos stay closed -- different onto and local": {
                initial: "\
a=B:Cj-1;Bmaster=j|\
b=B:Ck-1;Bmaster=k|\
x=S:C2-1 s=Sa:1,t=Sb:1;C3-2 s=Sa:j;C4-2 t=Sb:k;Bmaster=3;Bfoo=4;Bold=3",
                rebaser: rebaser("x", "4"),
                expected: "\
x=E:C3M-4 s=Sa:j;Bmaster=3M",
            },
            "maintain submodule branch": {
                initial: "\
a=B:Ca-1;Cb-1;Bx=a;By=b|\
x=U:C3-2 s=Sa:a;C4-2 s=Sa:b;Bmaster=3;Bfoo=4;Bold=3;Os Bmaster=a!*=master",
                rebaser: rebaser("x", "4"),
                expected: "\
x=E:C3M-4 s=Sa:as;Bmaster=3M;Os Bmaster=as!Cas-b a=a!*=master",
            },
            "adding subs on both": {
                initial: "\
q=B|r=B|s=B|x=S:C2-1 s=Ss:1;C3-2 q=Sq:1;C4-2 r=Sr:1;Bmaster=3;Bfoo=4;Bold=3",
                rebaser: rebaser("x", "4"),
                expected: "\
x=E:C3M-4 q=Sq:1;Bmaster=3M",
            },
            "adding subs then changing": {
                initial: "\
q=B|\
r=B|\
s=B|\
x=S:C2-1 s=Ss:1;C3-2 q=Sq:1;C31-3 q=Sr:1;C4-2 r=Sr:1;C41-4 r=Ss:1;\
Bmaster=31;Bfoo=41;Bold=31",
                rebaser: rebaser("x", "41"),
                expected: "\
x=E:C3M-41 q=Sq:1;C31M-3M q=Sr:1;Bmaster=31M",
            },
            "open sub ffwd'd": {
                initial: `
a=B:CX-1;Bmaster=X|
x=U:C3-2 a=b;C4-2 s=Sa:X;Bmaster=3;Bfoo=4;Bold=3;Os`,
                rebaser: rebaser("x", "4"),
                expected: `
x=E:C3M-4 a=b;Bmaster=3M;Os H=X`,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               c.expected,
                                                               c.rebaser,
                                                               c.fails);
            }));
        });
        it("conflict stays open", co.wrap(function *() {
            const input = `
a=B:Ca-1 t=t;Cb-1 t=u;Ba=a;Bb=b|
x=U:C31-2 s=Sa:a;C41-2 s=Sa:b;Bmaster=31;Bfoo=41;Bold=31`;
            const w = yield RepoASTTestUtil.createMultiRepos(input);
            const repo = w.repos.x;
            const reverseCommitMap = w.reverseCommitMap;
            const originalActualCommit = reverseCommitMap["41"];
            const originalCommit = yield repo.getCommit(originalActualCommit);
            let threw = false;
            try {
                yield RebaseUtil.rebase(repo, originalCommit);
            }
            catch (e) {
                threw = true;
            }
            assert(threw, "should have thrown");
            const open = yield SubmoduleUtil.isVisible(repo, "s");
            assert(open, "should be open");
        }));
    });

    describe("abort", function () {
        const cases = {
            "simple, see if workdir is cleaned up": {
                initial: `
x=S:C2-1 x=y;C3-1 x=z;Bmaster=2;Bfoo=3;Erefs/heads/master,2,3;W x=q`,
                expected: `x=E:E;W x=~`,
            },
            "with rebase in submodule": {
                initial: `
a=B:Cq-1;Cr-1;Bmaster=q;Bfoo=r|
x=U:C3-2 s=Sa:q;C4-2 s=Sa:r;
    Bmaster=3;Bfoo=4;
    Erefs/heads/master,3,4;
    Os Erefs/heads/foo,q,r!Bfoo=q!*=foo`,
                expected: `x=E:E;Os Bfoo=q!*=foo`,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const aborter = co.wrap(function *(repos) {
                    yield RebaseUtil.abort(repos.x);
                });
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               c.expected,
                                                               aborter,
                                                               c.fails);
            }));
        });
    });

    describe("continueSubmodules", function () {
        const cases = {
            "nothing to do": {
                initial: `x=S`,
            },
            "a closed sub": {
                initial: "x=S:C2-1 s=Sa:1;Bmaster=2",
            },
            "change in sub is staged": {
                initial: "a=B:Ca-1;Ba=a|x=U:Os H=a",
                expected: "x=E:I s=Sa:a",
            },
            "rebase in a sub": {
                initial: `
a=B:Cq-1;Cr-1;Bq=q;Br=r|
x=U:C3-2 s=Sa:q;Bmaster=3;Os EHEAD,q,r!I q=q`,
                expected: `
x=E:I s=Sa:qs;Os Cqs-r q=q!H=qs!E`
            },
            "rebase in a sub, was conflicted": {
                initial: `
a=B:Cq-1;Cr-1;Bq=q;Br=r|
x=U:C3-2 s=Sa:q;Bmaster=3;I *s=S:1*S:r*S:q;Os EHEAD,q,r!I q=q`,
                expected: `
x=E:I s=Sa:qs;Os Cqs-r q=q!H=qs!E`
            },
            "rebase two in a sub": {
                initial: `
a=B:Cp-q;Cq-1;Cr-1;Bp=p;Br=r|
x=U:C3-2 s=Sa:q;Bmaster=3;Os EHEAD,p,r!I q=q!Bp=p`,
                expected: `
x=E:I s=Sa:ps;Os Cps-qs p=p!Cqs-r q=q!H=ps!E!Bp=p`
            },
            "rebase in two subs": {
                initial: `
a=B:Cp-q;Cq-1;Cr-1;Cz-1;Bp=p;Br=r;Bz=z|
x=S:C2-1 s=Sa:1,t=Sa:1;C3-2 s=Sa:q,t=Sa:q;Bmaster=3;
  Os EHEAD,p,r!I q=q!Bp=p;
  Ot EHEAD,z,r!I z=8!Bz=z;
`,
                expected: `
x=E:I s=Sa:ps,t=Sa:zt;
  Os Cps-qs p=p!Cqs-r q=q!H=ps!E!Bp=p;
  Ot Czt-r z=8!H=zt!E!Bz=z;
`,
            },
            "rebase in two subs, conflict in one": {
                initial: `
a=B:Cp-q r=8;Cq-1;Cr-1;Cz-1;Bp=p;Br=r;Bz=z|
x=S:C2-1 s=Sa:1,t=Sa:1;C3-2 s=Sa:q,t=Sa:q;Bmaster=3;
  Os EHEAD,p,r!I q=q!Bp=p;
  Ot EHEAD,z,r!I z=8!Bz=z;
`,
                expected: `
x=E:I t=Sa:zt;
  Os Cqs-r q=q!H=qs!EHEAD,p,r!Bp=p!I *r=~*r*8!W r=^<<<<;
  Ot Czt-r z=8!H=zt!E!Bz=z;
`,
                errorMessage: `\
Conflict in ${colors.red("s")}
`,
            },
            "made a commit in a sub without a rebase": {
                initial: `a=B|x=U:Cfoo#9-1;B9=9;Os I a=b`,
                expected: `x=E:I s=Sa:Ns;Os Cfoo#Ns-1 a=b!H=Ns`,
                baseCommit: "9",
                message: "foo",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const continuer = co.wrap(function *(repos, maps) {
                    const repo = repos.x;
                    const index = yield repo.index();
                    const status = yield StatusUtil.getRepoStatus(repo);
                    const baseSha = c.baseCommit || "1";
                    const baseCommit =
                          yield repo.getCommit(maps.reverseCommitMap[baseSha]);
                    const result = yield RebaseUtil.continueSubmodules(
                                                                   repo,
                                                                   index,
                                                                   status,
                                                                   baseCommit);
                    assert.equal(result.errorMessage, c.errorMessage || null);
                    const commitMap = {};
                    RepoASTTestUtil.mapSubCommits(commitMap,
                                                  result.commits,
                                                  maps.commitMap);
                    Object.keys(result.newCommits).forEach(name => {
                        commitMap[result.newCommits[name]] = "N" + name;
                    });
                    return {
                        commitMap: commitMap,
                    };
                });
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               c.expected,
                                                               continuer,
                                                               c.fails);
            }));
        });
    });

    describe("continue", function () {
        const cases = {
            "meta-only": {
                initial: `
x=S:C2-1 q=r;C3-1 q=s;Bmaster=2;Erefs/heads/master,2,3;I q=z`,
                expected: `
x=S:C2M-3 q=z;Bmaster=2M;E`,
            },
            "two, meta-only": {
                initial: `
x=S:C2-1;C3-1;C4-3;Bmaster=4;Erefs/heads/master,4,2;I qq=hh,3=3`,
                expected: `
x=S:C4M-3M 4=4;C3M-2 3=3,qq=hh;Bmaster=4M;E`,
            },
            "meta, has to open": {
                initial: `
a=B:Ca-1;Cb-1;Bmaster=a;Bfoo=b|
x=U:C3-2 s=Sa:a;
    C4-2;C5-4 s=Sa:b;
    Bmaster=5;Bfoo=5;
    I 4=4;
    Erefs/heads/master,5,3`,
                expected: `
x=E:C5M-4M s=Sa:bs;C4M-3 4=4;Bmaster=5M;E;Os Cbs-a b=b!H=bs;I 4=~`,
            },
            "with rebase in submodule": {
                initial: `
a=B:Cq-1;Cr-1;Bmaster=q;Bfoo=r|
x=U:C3-2 s=Sa:q;C4-2 s=Sa:r;
    Bmaster=3;Bfoo=4;Bold=3;
    Erefs/heads/master,3,4;
    Os EHEAD,q,r!I q=q!Bq=q!Br=r`,
                expected: `
x=E:E;C3M-4 s=Sa:qs;Bmaster=3M;Os Cqs-r q=q!H=qs!E!Bq=q!Br=r`
            },
            "with rebase in submodule, other open subs": {
                initial: `
a=B:Cq-1;Cr-1;Bmaster=q;Bfoo=r|
x=S:C2-1 a=Sa:1,s=Sa:1,z=Sa:1;C3-2 s=Sa:q;C4-2 s=Sa:r;
    Bmaster=3;Bfoo=4;Bold=3;
    Erefs/heads/master,3,4;
    Oa;Oz;
    Os EHEAD,q,r!I q=q!Bq=q!Br=r`,
                expected: `
x=E:E;C3M-4 s=Sa:qs;Bmaster=3M;Os Cqs-r q=q!H=qs!E!Bq=q!Br=r;Oa;Oz`
            },
            "with rebase in submodule, staged commit in another submodule": {
                initial: `
a=B:Cq-1;Cr-1;Cs-q;Bmaster=q;Bfoo=r;Bbar=s|
x=S:C2-1 s=Sa:1,t=Sa:1;C3-2 s=Sa:q,t=Sa:s;C4-2 s=Sa:r,t=Sa:q;
    Bmaster=3;Bfoo=4;Bold=3;
    Erefs/heads/master,3,4;
    Os EHEAD,q,r!I q=q!Bq=q!Br=r;
    Ot H=s;
    I t=Sa:s`,
                expected: `
x=E:E;C3M-4 s=Sa:qs,t=Sa:s;Bmaster=3M;
    Os Cqs-r q=q!H=qs!E!Bq=q!Br=r;I t=~;Ot`
            },
            "with rebase in submodule, workdir commit in another submodule": {
                initial: `
a=B:Cq-1;Cr-1;Cs-q;Bmaster=q;Bfoo=r;Bbar=s|
x=S:C2-1 s=Sa:1,t=Sa:1;C3-2 s=Sa:q,t=Sa:s;C4-2 s=Sa:r,t=Sa:q;
    Bmaster=3;Bfoo=4;Bold=3;
    Erefs/heads/master,3,4;
    Os EHEAD,q,r!I q=q!Bq=q!Br=r;
    Ot H=s`,
                expected: `
x=E:E;C3M-4 s=Sa:qs,t=Sa:s;Bmaster=3M;
    Os Cqs-r q=q!H=qs!E!Bq=q!Br=r;
    Ot H=s`
            },
            "staged fix in submodule": {
                initial: `
a=B:Ca-1 q=r;Cb-1 q=s;Bmaster=a;Bfoo=b|
x=U:C3-2 s=Sa:a;C4-2 s=Sa:b;Bmaster=3;Erefs/heads/master,3,4;Bold=3;
    Os EHEAD,a,b!I q=z!Ba=a!Bb=b`,
                expected: `
x=E:C3M-4 s=Sa:as;E;Bmaster=3M;Os Cas-b q=z!H=as!Ba=a!Bb=b`,
            },
            "multiple in subs": {
                initial: `
a=B:Ca1-1 f=g;Ca2-1 f=h;Bmaster=a1;Bfoo=a2|
b=B:Cb1-1 q=r;Cb2-1 q=s;Bmaster=b1;Bfoo=b2|
x=S:C2-1 s=Sa:1,t=Sb:1;C3-2 s=Sa:a1,t=Sb:b1;C4-2 s=Sa:a2,t=Sb:b2;
    Bmaster=3;Bfoo=4;Bold=3;
    Erefs/heads/master,3,4;
    Os EHEAD,a1,a2!I f=z!Ba1=a1!Ba2=a2;
    Ot EHEAD,b1,b2!I q=t!Bb1=b1!Bb2=b2`,
                expected: `
x=E:C3M-4 s=Sa:a1s,t=Sb:b1t;E;Bmaster=3M;
    Os Ca1s-a2 f=z!H=a1s!Ba1=a1!Ba2=a2;
    Ot Cb1t-b2 q=t!H=b1t!Bb1=b1!Bb2=b2`
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const continuer = makeRebaser(co.wrap(function *(repos) {
                    return yield RebaseUtil.continue(repos.x);
                }));
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               c.expected,
                                                               continuer,
                                                               c.fails);
            }));
        });
    });

    describe("listRebaseCommits", function () {
        const cases = {
            "same commit": {
                input: "S",
                from: "1",
                onto: "1",
                expected: [],
            },
            "ancestor": {
                input: "S:C2-1;Bfoo=2",
                from: "1",
                onto: "2",
                expected: [],
            },
            "descendant": {
                input: "S:C2-1;Bfoo=2",
                from: "2",
                onto: "1",
                expected: ["2"],
            },
            "descendants": {
                input: "S:C3-2;C2-1;Bfoo=3",
                from: "3",
                onto: "1",
                expected: ["2", "3"],
            },
            "merge of base": {
                input: "S:C2-1;Bmaster=2;C4-3,1;C3-1;Bfoo=4",
                from: "4",
                onto: "2",
                expected: ["3"],
            },
            "non FFWD": {
                input: "S:Cf-1;Co-1;Bf=f;Bo=o",
                from: "f",
                onto: "o",
                expected: ["f"],
            },
            "left-to-right": {
                input: "S:Co-1;Cf-b,a;Ca-1;Cb-1;Bf=f;Bo=o",
                from: "f",
                onto: "o",
                expected: ["b", "a"],
            },
            "left-to-right and deep first": {
                input: "S:Co-1;Cf-b,a;Ca-1;Cb-c;Cc-1;Bf=f;Bo=o",
                from: "f",
                onto: "o",
                expected: ["c", "b", "a"],
            },
            "double deep": {
                input: "S:Co-1;Cf-b,a;Ca-1;Cb-c,d;Cc-1;Cd-1;Bf=f;Bo=o",
                from: "f",
                onto: "o",
                expected: ["c", "d", "a"],
            },
            "and deep on the right": {
                input: "S:Co-1;Cf-b,a;Ca-q,r;Cq-1;Cr-1;Cb-1;Bf=f;Bo=o",
                from: "f",
                onto: "o",
                expected: ["b", "q", "r"],
            },
            "new commit in history more than once": {
                input: "S:Co-1;Cf-r,a;Ca-q,r;Cq-1;Cr-1;Bf=f;Bo=o",
                from: "f",
                onto: "o",
                expected: ["r", "q"],
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written = yield RepoASTTestUtil.createRepo(c.input);
                const repo = written.repo;
                const old = written.oldCommitMap;
                const from = yield repo.getCommit(old[c.from]);
                const onto = yield repo.getCommit(old[c.onto]);
                const result = yield RebaseUtil.listRebaseCommits(repo,
                                                                  from,
                                                                  onto);
                const commits = result.map(sha => written.commitMap[sha]);
                assert.deepEqual(commits, c.expected);
            }));
        });
    });
});
