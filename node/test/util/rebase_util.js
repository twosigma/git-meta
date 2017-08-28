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

const RebaseUtil      = require("../../lib/util/rebase_util");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");

function makeRebaser(operation) {
    return co.wrap(function *(repos, maps) {
        const result = yield operation(repos, maps);

        // Now build a map from the newly generated commits to the
        // logical names that will be used in the expected case.

        let commitMap = {};
        function addNewCommit(newCommit, oldCommit, suffix) {
            const oldLogicalCommit = maps.commitMap[oldCommit];
            commitMap[newCommit] = oldLogicalCommit + suffix;
        }
        Object.keys(result.metaCommits).forEach(newCommit => {
            addNewCommit(newCommit,
                         result.metaCommits[newCommit],
                         "M");
        });
        Object.keys(result.submoduleCommits).forEach(subName => {
            const subCommits = result.submoduleCommits[subName];
            Object.keys(subCommits).forEach(newCommit => {
                addNewCommit(newCommit,
                             subCommits[newCommit],
                             subName);
            });
        });
        return {
            commitMap: commitMap,
        };
    });
}

describe("rebase", function () {
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

                return  yield RebaseUtil.rebase(repo, originalCommit);
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
});
