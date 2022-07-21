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

const RepoAST             = require("../../lib/util/repo_ast");
const RepoASTTestUtil     = require("../../lib/util/repo_ast_test_util");
const StatusUtil          = require("../../lib/util/status_util");
const SubmoduleRebaseUtil = require("../../lib/util/submodule_rebase_util");

describe("SubmoduleRebaseUtil", function () {
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
    const first = yield SubmoduleRebaseUtil.callNext(rebase);
    assert.equal(first.id().tostrS(), ontoSha);
    const second = yield SubmoduleRebaseUtil.callNext(rebase);
    assert.isNull(second);
}));

describe("processRebase", function () {
    const cases = {
        "no conflicts": {
            initial: "x=S:C2-1;Cr-1;Bmaster=2;Br=r",
            expected: "x=E:Crr-2 r=r;H=rr",
            conflictedCommit: null,
        },
        "nothing to commit": {
            initial: "x=S:C2-1;Cr-1 ;Bmaster=2;Br=r",
            expected: "x=E:H=2",
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
                        "2": new RepoAST.File(content, false),
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
                const op = yield SubmoduleRebaseUtil.callNext(rebase);
                const result = yield SubmoduleRebaseUtil.processRebase(repo,
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
        "skip if branch and head same": {
            initial: "x=S:Cr-1;Bmaster=r",
            upstream: null,
            conflictedCommit: null,
            expected: "x=E:H=r",
        },
        "skip none": {
            initial: "x=S:C2-1;Cr-1;Bmaster=2;Br=r",
            expected: "x=E:Crr-2 r=r;H=rr",
            upstream: "1",
            conflictedCommit: null,
        },
        "up-to-date": {
            initial: "x=S:Cr-1; C3-2; C2-r;Bmaster=3;Br=r",
            expected: "x=E:H=3",
            upstream: null,
            conflictedCommit: null,
        },
        "up-to-date with upstream": {
            initial: "x=S:Cr-1; C3-2; C2-r;Bmaster=3;Br=r",
            expected: "x=E:H=3",
            upstream: "1",
            conflictedCommit: null,
        },
        "ffwd when all included": {
            initial: "x=S:Cr-3; C3-2; C2-1;Bmaster=2;Br=r",
            expected: "x=E:H=r",
            upstream: null,
            conflictedCommit: null,
        },
        "ffwd when enough included included": {
            initial: "x=S:Cr-3; C3-2; C2-1;Bmaster=3;Br=r",
            expected: "x=E:H=r",
            upstream: "2",
            conflictedCommit: null,
        },
        "ffwd when enough included included, and equal": {
            initial: "x=S:Cr-3; C3-2; C2-1;Bmaster=3;Br=r",
            expected: "x=E:H=r",
            upstream: "3",
            conflictedCommit: null,
        },
        "not ffwd when skipped commit": {
            initial: "x=S:Cr-3; C3-2; C2-1;Bmaster=2;Br=r",
            upstream: "3",
            expected: "x=E:Crr-2 r=r;H=rr",
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
        "excessive upstream": {
            initial: "x=S:C2-1;C3-2;Cr-2;Bmaster=3;Br=r",
            expected: "x=E:Crr-3 r=r;H=rr",
            upstream: "1",
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
                const result = yield SubmoduleRebaseUtil.rewriteCommits(
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
            expected: "x=E:Cadded 's'#M-2 s=Sa:a;Bmaster=M",
            baseCommit: "2",
        },
        "rebase in a sub": {
            initial: `
a=B:Cq-1;Cr-1;Bq=q;Br=r|
x=U:C3-2 s=Sa:q;Bmaster=3;Os EHEAD,q,r!I q=q`,
            expected: `
x=E:CM-3 s=Sa:qs;Bmaster=M;Os Cqs-r q=q!H=qs!E`,
            baseCommit: "3",
        },
        "rebase in a sub, was conflicted": {
            initial: `
a=B:Cq-1;Cr-1;Bq=q;Br=r|
x=U:C3-2 s=Sa:q;Bmaster=3;I *s=S:1*S:r*S:q;Os EHEAD,q,r!I q=q!Bq=q`,
            expected: `
x=E:CM-3 s=Sa:qs;Bmaster=M;I s=~;Os Cqs-r q=q!H=qs!E!Bq=q`,
            baseCommit: "3",
        },
        "rebase two in a sub": {
            initial: `
a=B:Cp-q;Cq-1;Cr-1;Bp=p;Br=r|
x=U:C3-2 s=Sa:q;Bmaster=3;Os EHEAD,p,r!I q=q!Bp=p`,
            baseCommit: "3",
            expected: `
x=E:CM-3 s=Sa:ps;I s=~;Bmaster=M;Os Cps-qs p=p!Cqs-r q=q!H=ps!E!Bp=p`
        },
        "rebase in two subs": {
            initial: `
a=B:Cp-q;Cq-1;Cr-1;Cz-1;Bp=p;Br=r;Bz=z|
x=S:C2-1 s=Sa:1,t=Sa:1;C3-2 s=Sa:q,t=Sa:q;Bmaster=3;
  Os EHEAD,p,r!I q=q!Bp=p;
  Ot EHEAD,z,r!I z=8!Bz=z;
`,
            baseCommit: "3",
            expected: `
x=E:CM-3 s=Sa:ps,t=Sa:zt;Bmaster=M;
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
Submodule ${colors.red("s")} is conflicted.
`,
        },
        "made a commit in a sub without a rebase": {
            initial: `a=B|x=U:Cfoo#9-1;B9=9;Os I a=b`,
            expected: `x=E:Cfoo#M-2 s=Sa:Ns;Bmaster=M;Os Cfoo#Ns-1 a=b!H=Ns`,
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
                const result = yield SubmoduleRebaseUtil.continueSubmodules(
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
                if (null !== result.metaCommit) {
                    commitMap[result.metaCommit] = "M";
                }
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
});
