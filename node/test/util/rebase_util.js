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

const RebaseUtil          = require("../../lib/util/rebase_util");
const RepoASTTestUtil     = require("../../lib/util/repo_ast_test_util");
const SequencerState      = require("../../lib/util/sequencer_state");
const SequencerStateUtil  = require("../../lib/util/sequencer_state_util");

const CommitAndRef = SequencerState.CommitAndRef;
const REBASE = SequencerState.TYPE.REBASE;

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
        const newCommits = result.newCommits || {};
        for (let path in newCommits) {
            commitMap[newCommits[path]] = `N${path}`;
        }
        return {
            commitMap: commitMap,
        };
    });
}

describe("Rebase", function () {
describe("runRebase", function () {
    const cases = {
        "end": {
            state: "x=S",
            seq: new SequencerState({
                type: REBASE,
                originalHead: new CommitAndRef("1", null),
                target: new CommitAndRef("1", null),
                currentCommit: 0,
                commits: [],
            }),
        },
        "one, started detached": {
            state: `
a=B:Cf-1;Cg-1;Bf=f;Bg=g|x=U:C3-2 s=Sa:f;C4-2 s=Sa:g;H=4;Bfoo=3`,
            seq: new SequencerState({
                type: REBASE,
                originalHead: new CommitAndRef("3", null),
                target: new CommitAndRef("4", null),
                currentCommit: 0,
                commits: ["3"],
            }),
            expected: "x=E:C3M-4 s=Sa:fs;H=3M;Os Cfs-g f=f!H=fs",
        },
        "one, started on a branch": {
            state: `
a=B:Cf-1;Cg-1;Bf=f;Bg=g|x=U:C3-2 s=Sa:f;C4-2 s=Sa:g;H=4;Bfoo=3;Bold=3`,
            seq: new SequencerState({
                type: REBASE,
                originalHead: new CommitAndRef("3", "refs/heads/foo"),
                target: new CommitAndRef("4", null),
                currentCommit: 0,
                commits: ["3"],
            }),
            expected: "x=E:C3M-4 s=Sa:fs;*=foo;Bfoo=3M;Os Cfs-g f=f!H=fs",
        },
        "sub can be ffwded": {
            state: `
a=B:Cf-1;Bf=f|x=U:C3-2 s=Sa:f;C4-2 t=Sa:f;H=4;Bfoo=3`,
            seq: new SequencerState({
                type: REBASE,
                originalHead: new CommitAndRef("3", null),
                target: new CommitAndRef("4", null),
                currentCommit: 0,
                commits: ["3"],
            }),
            expected: "x=E:C3M-4 s=Sa:f;H=3M",
        },
        "two commits": {
            state: `
a=B|x=S:C2-1 q=Sa:1;Bmaster=2;Cf-1 s=Sa:1;Cg-1 t=Sa:1;Bf=f;Bg=g`,
            seq: new SequencerState({
                type: REBASE,
                originalHead: new CommitAndRef("2", "refs/heads/master"),
                target: new CommitAndRef("g", null),
                currentCommit: 0,
                commits: ["f", "g"],
            }),
            expected: "x=E:CgM-fM t=Sa:1;CfM-2 s=Sa:1;Bmaster=gM",
        },

        "conflict": {
            state: `
a=B:Ca-1;Cb-1 a=8;Ba=a;Bb=b|x=U:Cf-2 s=Sa:a;Cg-2 s=Sa:b;H=f;Bg=g`,
            seq: new SequencerState({
                type: REBASE,
                originalHead: new CommitAndRef("f", null),
                target: new CommitAndRef("g", null),
                currentCommit: 0,
                commits: ["g"],
            }),
            expected: `
x=E:QR f: g: 0 g;Os Edetached HEAD,b,a!I *a=~*a*8!W a=\
<<<<<<< HEAD
a
=======
8
>>>>>>> message
;`,
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        const runnerOp = co.wrap(function *(repos, maps) {
            const repo = repos.x;
            const seq = SequencerStateUtil.mapCommits(c.seq,
                                                      maps.reverseCommitMap);
            return yield RebaseUtil.runRebase(repo, seq);
        });
        const runner = makeRebaser(runnerOp);
        it(caseName, co.wrap(function *() {
            yield RepoASTTestUtil.testMultiRepoManipulator(c.state,
                                                           c.expected,
                                                           runner,
                                                           c.fails);
        }));
    });
});
describe("rebase", function () {
    const cases = {
        "already a rebase in progress": {
            initial: "x=S:QM 1: 1: 0 1",
            onto: "1",
            fails: true,
        },
        "dirty": {
            initial: "a=B|x=U:Os W README.md=2",
            onto: "1",
            fails: true,
        },
        "trivially nothing to do": {
            initial: "x=S",
            onto: "1",
        },
        "nothing to do, in past": {
            initial: "x=S:C2-1;Bmaster=2",
            onto: "1",
        },
        "nothing to do, detached": {
            initial: "x=S:C2-1;H=2",
            onto: "1",
        },
        "ffwd": {
            initial: "x=S:C2-1 s=S/a:1;Bfoo=2",
            onto: "2",
            expected: "x=E:Bmaster=2",
        },
        "simple rebase": {
            initial: `
a=B:Cf-1;Cg-1;Bf=f;Bg=g|x=U:C3-2 s=Sa:f;C4-2 s=Sa:g;Bother=4;Bfoo=3;Bmaster=3`,
            onto: "4",
            expected: "x=E:C3M-4 s=Sa:fs;Bmaster=3M;Os Cfs-g f=f!H=fs",
        },
        "two commits": {
            initial: `
a=B|x=S:C2-1 q=Sa:1;Bmaster=g;Cf-1 s=Sa:1;Cg-f t=Sa:1;Bonto=2;Bg=g`,
            onto: "2",
            expected: "x=E:CgM-fM t=Sa:1;CfM-2 s=Sa:1;Bmaster=gM",
        },
        "up-to-date with sub": {
            initial: "a=Aa:Cb-a;Bfoo=b|x=U:C3-2 s=Sa:b;Bmaster=3;Bfoo=2",
            onto: "2",
        },
        "ffwd with sub": {
            initial: "a=Aa:Cb-a;Bfoo=b|x=U:C3-2 s=Sa:b;Bmaster=2;Bfoo=3",
            onto: "3",
            expected: "x=E:Bmaster=3",
        },
        "rebase change in closed sub": {
            initial: `
a=B:Ca-1;Cb-a;Cc-a;Bmaster=b;Bfoo=c|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4;Bother=3`,
            onto: "4",
            expected: "x=E:C3M-4 s=Sa:bs;Bmaster=3M;Os Cbs-c b=b!H=bs",
        },
        "rebase change in sub, sub already open": {
            initial: `
a=B:Ca-1;Cb-a;Cc-a;Bmaster=b;Bfoo=c|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4;Bother=3;Os H=b`,
            onto: "4",
            expected: "x=E:C3M-4 s=Sa:bs;Bmaster=3M;Os Cbs-c b=b!H=bs",
        },
        "rebase change in sub with two commits": {
            initial: `
a=B:Ca-1;Cb-a;Cc-a;Bmaster=b;Bfoo=c|
x=U:C4-2 s=Sa:b;C3-2 s=Sa:c;Bmaster=4;Bfoo=4;Bother=3;Os H=b`,
            onto: "3",
            expected: `
x=E:C4M-3 s=Sa:bs;Bmaster=4M;Os Cbs-c b=b!H=bs`,
        },
        "rebase change in sub with two intervening commits": {
            initial: `
a=B:Ca-1;Cb-a;Cc-a;Cd-c;Bmaster=b;Bfoo=d|
x=U:C4-2 r=Sa:1;C5-4 s=Sa:c;C6-5 q=Sa:1;C7-6 s=Sa:d;C3-2 s=Sa:b;Bmaster=7;
    Bfoo=7;Bother=3`,
            onto: "3",
            expected: `
x=E:C7M-6M s=Sa:ds;C6M-5M q=Sa:1;C5M-4M s=Sa:cs;C4M-3 r=Sa:1;Bmaster=7M;
    Os Cds-cs d=d!Ccs-b c=c!H=ds`,
        },
        "rebase change in sub with two intervening commits, open": {
            initial: `
a=B:Ca-1;Cb-a;Cc-a;Cd-c;Bmaster=b;Bfoo=d|
x=U:C4-2 t=Sa:a;C5-4 s=Sa:c;C6-5 u=Sa:1;C7-6 s=Sa:d;C3-2 s=Sa:b;
    Bmaster=7;Bfoo=7;Bother=3;
    Os H=d`,
            onto: "3",
            expected: `
x=E:C7M-6M s=Sa:ds;C6M-5M u=Sa:1;C5M-4M s=Sa:cs;C4M-3 t=Sa:a;Bmaster=7M;
    Os Cds-cs d=d!Ccs-b c=c!H=ds`,
        },
        "ffwd, but not sub (should ffwd anyway)": {
            initial: "\
a=Aa:Cb-a;Cc-a;Bmaster=b;Bfoo=c|\
x=U:C3-2 s=Sa:b;C4-3 s=Sa:c;Bmaster=3;Bfoo=4;Bother=3",
            onto: "4",
            expected: "x=E:Bmaster=4",
        },
        "no ffwd, but can ffwd sub": {
            initial: `
a=B:Ca-1;Cb-a;Cc-b;Bmaster=b;Bfoo=c|
x=U:C3-2 u=Sa:a,s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4;Bother=3;Os`,
            onto: "4",
            expected: "x=E:C3M-4 u=Sa:a;Bmaster=3M;Os H=c",
        },
        "ffwd sub 2X": {
            initial: `
a=B:Ca-1;Cb-a;Cc-b;Bmaster=b;Bfoo=c|
x=U:Cr-2 r=Sa:1;C3-2 s=Sa:b;C4-3 s=Sa:c;Bmaster=4;Bother=r;Os;Bfoo=4`,
            onto: "r",
            expected: "x=E:C3M-r s=Sa:b;C4M-3M s=Sa:c;Bmaster=4M;Os H=c",
        },
        "up-to-date sub is closed after rebase": {
            initial: `
a=B:Ca-1;Cb-a;Cc-b;Bmaster=b;Bfoo=c|
x=U:C3-2 u=Sa:1,s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4;Bother=3`,
            onto: "4",
            expected: "x=E:C3M-4 u=Sa:1;Bmaster=3M",
        },
        "rebase two changes in sub": {
            initial: `
a=B:Ca-1;Cb-a;Cc-b;Cd-a;Bmaster=c;Bfoo=d|
x=U:C3-2 s=Sa:c;C4-2 s=Sa:d;Bmaster=3;Bfoo=4;Bother=3`,
            onto: "4",
            expected: `
x=E:C3M-4 s=Sa:cs;Bmaster=3M;Os Ccs-bs c=c!Cbs-d b=b`,
        },
        "rebase with ffwd changes in sub and meta": {
            initial: `
a=B:Bmaster=3;C2-1 s=Sb:q;C3-2 s=Sb:r|
b=B:Cq-1;Cr-q;Bmaster=r|
x=Ca:Bmaster=2;Os`,
            onto: "3",
            expected: "x=E:Bmaster=3;Os H=r",
        },
        "make sure unchanged repos stay closed": {
            initial: `
a=B|
b=B:Cj-1;Ck-1;Bmaster=j;Bfoo=k|
x=S:C2-1 s=Sa:1,t=Sb:1;C3-2 t=Sb:j;C4-2 t=Sb:k;Bmaster=3;Bfoo=4;Bold=3`,
            onto: "4",
            expected: `
x=E:C3M-4 t=Sb:jt;Bmaster=3M;Ot H=jt!Cjt-k j=j`,
        },
        "make sure unchanged repos stay closed -- onto-only change": {
            initial: `
a=B|
b=B:Cj-1;Ck-1;Bmaster=j;Bfoo=k|
x=S:C2-1 s=Sa:1,t=Sb:1;C3-2 q=Sa:k;C4-2 t=Sb:k;Bmaster=3;Bfoo=4;Bold=3`,
            onto: "4",
            expected: `
x=E:C3M-4 q=Sa:k;Bmaster=3M`,
        },
        "make sure unchanged repos stay closed -- local-only change": {
            initial: `
a=B|
b=B:Cj-1;Ck-1;Bmaster=j;Bfoo=k|
x=S:C2-1 s=Sa:1,t=Sb:1;C3-2 z=Sa:1;C4-2 t=Sb:k;Bmaster=4;Bfoo=3;Bold=4`,
            onto: "3",
            expected: `
x=E:C4M-3 t=Sb:k;Bmaster=4M`,
        },
        "unchanged repos stay closed -- different onto and local": {
            initial: `
a=B:Cj-1;Bmaster=j|
b=B:Ck-1;Bmaster=k|
x=S:C2-1 s=Sa:1,t=Sb:1;C3-2 s=Sa:j;C4-2 t=Sb:k;Bmaster=3;Bfoo=4;Bold=3`,
            onto: "4",
            expected: `
x=E:C3M-4 s=Sa:j;Bmaster=3M`,
        },
        "adding subs on both": {
            initial: `
q=B|r=B|s=B|x=S:C2-1 s=Ss:1;C3-2 q=Sq:1;C4-2 r=Sr:1;Bmaster=3;Bfoo=4;Bold=3`,
            onto: "4",
            expected: `
x=E:C3M-4 q=Sq:1;Bmaster=3M`,
        },
        "open sub ffwd'd": {
            initial: `
a=B:CX-1;Bmaster=X|
x=U:C3-2 a=Sa:1;C4-2 s=Sa:X;Bmaster=3;Bfoo=4;Bold=3;Os`,
            onto: "4",
            expected: `
x=E:C3M-4 a=Sa:1;Bmaster=3M;Os H=X`,
        },
        "conflict": {
            initial: `
a=B:Ca-1 t=t;Cb-1 t=u;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;C4-2 s=Sa:b;Bmaster=3;Bfoo=4;Bold=3`,
            onto: "4",
            expected: `
x=E:H=4;QR 3:refs/heads/master 4: 0 3;
    Os Edetached HEAD,a,b!I *t=~*u*t!W t=\
<<<<<<< HEAD
u
=======
t
>>>>>>> message
;`,
            errorMessage: `\
Submodule ${colors.red("s")} is conflicted.
        A rebase is in progress.
        (after resolving conflicts mark the corrected paths
        with 'git meta add', then run "git meta rebase --continue")
        (use "git meta rebase --abort" to check out the original branch)`,
        },
        "does not close open submodules when rewinding": {
            initial: `
a=B|x=S:C2-1 s=Sa:1;Bmaster=2;Os;C3-1 t=Sa:1;Bfoo=3;Bold=2`,
            onto: "3",
            expected: `x=E:C2M-3 s=Sa:1;Bmaster=2M`
        },
// TODO: I could not get libgit2 to remember or restore submodule branches when
// used in the three-way mode; it stores it in "onto_name", not in "head-name".
//        "maintain submodule branch": {
//            initial: `
//a=B:Ca-1;Cb-1;Bx=a;By=b|
//x=U:C3-2 s=Sa:a;C4-2 s=Sa:b;Bmaster=3;Bfoo=4;Bold=3;Os Bmaster=a!*=master`,
//            onto: "4",
//            expected: `
//x=E:C3M-4 s=Sa:as;Bmaster=3M;Os Bmaster=as!Cas-b a=a!*=master`,
//        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        // Will append the leter 'M' to any created meta-repo commits, and the
        // submodule name to commits created in respective submodules.

        const rebaseOp = co.wrap(function *(repos, maps) {
            const repo = repos.x;
            const reverseCommitMap = maps.reverseCommitMap;
            const onto = yield repo.getCommit(reverseCommitMap[c.onto]);
            const errorMessage = c.errorMessage || null;
            const result = yield RebaseUtil.rebase(repo, onto);
            if (null !== result.errorMessage) {
                assert.isString(result.errorMessage);
            }
            assert.equal(result.errorMessage, errorMessage);
            return result;
        });
        const rebase = makeRebaser(rebaseOp);
        it(caseName, co.wrap(function *() {
            yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                           c.expected,
                                                           rebase,
                                                           c.fails);
        }));
    });
});

describe("abort", function () {
    const cases = {
        "no sequencer, fails": {
            initial: "x=S",
            fails: true,
        },
        "sequencer not a rebase, fails": {
            initial: "x=S:QM 1: 1: 0 1",
            fails: true,
        },
        "see if head is reset": {
            initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;C4-2 s=Sa:b;H=4;Bmaster=3;Bfoo=4;QR 3: 4: 0 2`,
            expected: `x=E:H=3;Q`
        },
        "check that branch is restored": {
            initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;C4-2 s=Sa:b;H=4;Bmaster=3;Bfoo=4;
    QR 3:refs/heads/master 4: 0 2`,
            expected: `x=E:*=master;Q`
        },
        "submodule wd cleaned up": {
            initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;C4-2 s=Sa:b;H=4;Bmaster=3;Bfoo=4;
    QR 3: 4: 0 2;
    Os W README.md=88`,
            expected: `x=E:H=3;Q;Os H=a`
        },
        "submodule rebase cleaned up": {
            initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;C4-2 s=Sa:b;H=4;Bmaster=3;Bfoo=4;
    QR 3: 4: 0 2;
    Os Edetached HEAD,a,b`,
            expected: `x=E:H=3;Q;Os H=a`
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
        "no sequencer, fails": {
            initial: "x=S",
            fails: true,
        },
        "sequencer not a rebase, fails": {
            initial: "x=S:QM 1: 1: 0 1",
            fails: true,
        },
        "conflict fails": {
            initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;C4-2 s=Sa:b;H=4;Bmaster=3;Bfoo=4;
    QR 3: 4: 0 2;
    Os I *a=1*2*3!W a=2`,
            fails: true,
        },
        "continue finishes with new commit": {
            initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;C4-2 s=Sa:b;Bmaster=3;Bfoo=4;H=4;Bold=3;
    QR 3:refs/heads/master 4: 0 3;
    Os I foo=bar`,
            expected: `
x=E:C3M-4 s=Sa:Ns;Bmaster=3M;*=master;Q;Os CNs-b foo=bar!H=Ns;`,
        },
        "continue makes a new conflict with current op": {
            initial: `
a=B:Ca-1;Cb-a c=d;Cc-1;Bb=b;Bc=c|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4;H=4;
    QR 3: 4: 0 3;
    Os I foo=bar!Edetached HEAD,b,c!H=c!Bb=b!Bc=c`,
            errorMessage: `\
Submodule ${colors.red("s")} is conflicted.
`,
            expected: `
x=E:Os Cas-c foo=bar!H=as!Edetached HEAD,b,c!Bb=b!Bc=c!I *c=~*c*d!
    W c=^<<<<<`,
        },
        "with rebase in submodule": {
            initial: `
a=B:Cq-1;Cr-1;Bmaster=q;Bfoo=r|
x=U:C3-2 s=Sa:q;C4-2 s=Sa:r;
    Bmaster=4;Bfoo=4;Bold=3;
    QR 3:refs/heads/master 4: 0 3;
    Os EHEAD,q,r!I q=q!Bq=q!Br=r`,
            expected: `
x=E:Q;C3M-4 s=Sa:qs;Bmaster=3M;Os Cqs-r q=q!H=qs!E!Bq=q!Br=r`
        },
        "with rebase in submodule, other open subs": {
            initial: `
a=B:Cq-1;Cr-1;Bmaster=q;Bfoo=r|
x=S:C2-1 a=Sa:1,s=Sa:1,z=Sa:1;C3-2 s=Sa:q;C4-2 s=Sa:r;
    Bmaster=4;Bfoo=4;Bold=3;
    QR 3:refs/heads/master 4: 0 3;
    Oa;Oz;
    Os EHEAD,q,r!I q=q!Bq=q!Br=r`,
            expected: `
x=E:Q;C3M-4 s=Sa:qs;Bmaster=3M;Os Cqs-r q=q!H=qs!E!Bq=q!Br=r;Oa;Oz`
        },
        "with rebase in submodule, staged commit in another submodule": {
            initial: `
a=B:Cq-1;Cr-1;Cs-q;Bmaster=q;Bfoo=r;Bbar=s|
x=S:C2-1 s=Sa:1,t=Sa:1;C3-2 s=Sa:q,t=Sa:s;C4-2 s=Sa:r,t=Sa:q;
    Bmaster=4;Bfoo=4;Bold=3;
    QR 3:refs/heads/master 4: 0 3;
    Os EHEAD,q,r!I q=q!Bq=q!Br=r;
    Ot H=s;
    I t=Sa:s`,
            expected: `
x=E:Q;C3M-4 s=Sa:qs,t=Sa:s;Bmaster=3M;
    Os Cqs-r q=q!H=qs!E!Bq=q!Br=r;I t=~;Ot`
        },
        "with rebase in submodule, workdir commit in another submodule": {
            initial: `
a=B:Cq-1;Cr-1;Cs-q;Bmaster=q;Bfoo=r;Bbar=s|
x=S:C2-1 s=Sa:1,t=Sa:1;C3-2 s=Sa:q,t=Sa:s;C4-2 s=Sa:r,t=Sa:q;
    Bmaster=4;Bfoo=4;Bold=3;
    QR 3:refs/heads/master 4: 0 3;
    Os EHEAD,q,r!I q=q!Bq=q!Br=r;
    Ot H=s`,
            expected: `
x=E:Q;C3M-4 s=Sa:qs,t=Sa:s;Bmaster=3M;
    Os Cqs-r q=q!H=qs!E!Bq=q!Br=r;
    Ot H=s`
        },
        "staged fix in submodule": {
            initial: `
a=B:Ca-1 q=r;Cb-1 q=s;Bmaster=a;Bfoo=b|
x=U:C3-2 s=Sa:a;C4-2 s=Sa:b;Bmaster=4;QR 3:refs/heads/master 4: 0 3;Bold=3;
    Os EHEAD,a,b!I q=z!Ba=a!Bb=b`,
            expected: `
x=E:C3M-4 s=Sa:as;Q;Bmaster=3M;Os Cas-b q=z!H=as!Ba=a!Bb=b`,
        },
        "multiple in subs": {
            initial: `
a=B:Ca1-1 f=g;Ca2-1 f=h;Bmaster=a1;Bfoo=a2|
b=B:Cb1-1 q=r;Cb2-1 q=s;Bmaster=b1;Bfoo=b2|
x=S:C2-1 s=Sa:1,t=Sb:1;C3-2 s=Sa:a1,t=Sb:b1;C4-2 s=Sa:a2,t=Sb:b2;
    Bmaster=4;Bfoo=4;Bold=3;
    QR 3:refs/heads/master 4: 0 3;
    Os EHEAD,a1,a2!I f=z!Ba1=a1!Ba2=a2;
    Ot EHEAD,b1,b2!I q=t!Bb1=b1!Bb2=b2`,
            expected: `
x=E:C3M-4 s=Sa:a1s,t=Sb:b1t;Q;Bmaster=3M;
    Os Ca1s-a2 f=z!H=a1s!Ba1=a1!Ba2=a2;
    Ot Cb1t-b2 q=t!H=b1t!Bb1=b1!Bb2=b2`
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const continuer = makeRebaser(co.wrap(function *(repos) {
                const errorMessage = c.errorMessage || null;
                const result = yield RebaseUtil.continue(repos.x);
                if (null !== result.errorMessage) {
                    assert.isString(result.errorMessage);
                }
                assert.equal(result.errorMessage, errorMessage);
                return result;
            }));
            yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                           c.expected,
                                                           continuer,
                                                           c.fails);
        }));
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
