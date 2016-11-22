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

const Rebase          = require("../../lib/util/rebase");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");
const Status          = require("../../lib/util/status");

describe("rebase", function () {

    // Will append the leter 'M' to any created meta-repo commits, and the
    // submodule name to commits created in respective submodules.

    function rebaser(repoName, commit) {
        return co.wrap(function *(repos, maps) {
            assert.property(repos, repoName);
            const repo = repos[repoName];
            const status = yield Status.getRepoStatus(repo);
            const reverseMap = maps.reverseMap;
            assert.property(reverseMap, commit);
            const originalActualCommit = reverseMap[commit];
            const originalCommit = yield repo.getCommit(originalActualCommit);
            const result = yield Rebase.rebase(repo, originalCommit, status);

            // Now build a map from the newly generated commits to the logical
            // names that will be used in the expected case.

            let commitMap = {};
            function addNewCommit(newCommit, oldCommit, suffix) {
                const oldLogicalCommit = maps.commitMap[oldCommit];
                commitMap[newCommit] = oldLogicalCommit + suffix;
            }
            Object.keys(result.metaCommits).forEach(newCommit => {
                addNewCommit(newCommit, result.metaCommits[newCommit], "M");
            });
            Object.keys(result.submoduleCommits).forEach(subName => {
                const subCommits = result.submoduleCommits[subName];
                Object.keys(subCommits).forEach(newCommit => {
                    addNewCommit(newCommit, subCommits[newCommit], subName);
                });
            });
            return {
                commitMap: commitMap,
            };
        });
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
        "rebase change in sub": {
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
x=U:C3-2 3=3,s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4;Bother=3",
            rebaser: rebaser("x", "4"),
            expected: "x=E:C3M-4 3=3;Bmaster=3M;Os H=c",
        },
        "rebase two changes in sub": {
            initial: "\
a=Aa:Cb-a;Cc-b;Cd-a;Bmaster=c;Bfoo=d|\
x=U:C3-2 s=Sa:c;C4-2 s=Sa:d;Bmaster=3;Bfoo=4;Bother=3",
            rebaser: rebaser("x", "4"),
            expected: "\
x=E:C3M-4 s=Sa:cs;Bmaster=3M;Os Ccs-bs c=c!Cbs-d b=b!H=cs",
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
