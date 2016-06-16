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

const Cherrypick      = require("../../lib/util/cherrypick");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");

describe("cherrypick", function () {
    // We will always cherry-pick commit 8 from repo x and will name the
    // meta-repo cherry-picked commit 9.  Cherry-picked commits from
    // submodules will have the submodule name appended to the commit.
    //
    // One concern with these tests is that the logic used by Git to generate
    // new commit ids can result in collision when the exact same commit would
    // be generated very quickly.  For example, if you have this setup:
    //
    // S:C2-1;Bfoo=2
    //
    // And try to cherry-pick "2" to master, it will likely generate the exact
    // same physical commit id already mapped to "2" and screw up the test,
    // which expects a new commit id.  This problem means that we cannot easily
    // test that case (without adding timers), which is OK as we're not
    // actually testing libgit2's cherry-pick facility, but also that we need
    // to have unique commit histories in our submodules -- we can't have 'S'
    // everywhere for these tests.

    const picker = co.wrap(function *(repos, maps) {
        const x = repos.x;
        let reverseMap = {};
        const oldMap = maps.commitMap;
        Object.keys(oldMap).forEach(id => {
            reverseMap[oldMap[id]] = id;
        });
        assert.property(reverseMap, "8");
        const eightCommitSha = reverseMap["8"];
        const eightCommit = yield x.getCommit(eightCommitSha);
        const result  = yield Cherrypick.cherryPick(x, eightCommit);

        // Now we need to build a map from new physical commit id to new
        // logical commit id.  For the meta commit, this is easy: we map the
        // new id to the hard-coded value of "9".

        let commitMap = {};
        commitMap[result.newMetaCommit] = "9";

        // For the submodules, we need to first figure out what the old logical
        // commit (the one from the shorthand) was, then create the new logical
        // commit id by appending the submodule name.  We map the new
        // (physical) commit id to this new logical id.

        Object.keys(result.submoduleCommits).forEach(name => {
            const subCommits = result.submoduleCommits[name];
            Object.keys(subCommits).forEach(oldId => {
                const oldLogicalId = oldMap[oldId];
                const newLogicalId = oldLogicalId + name;
                const newPhysicalId = subCommits[oldId];
                commitMap[newPhysicalId] = newLogicalId;
            });
        });
        return {
            commitMap: commitMap,
        };
    });

    const cases = {
        "simplest": {
            input: "x=S:C8-2;C2-1;Bfoo=8",
            expected:"x=E:C9-1 8=8;Bmaster=9",
        },
        "no change to sub": {
            input: "a=Ax|x=S:C8-2;C2-1 s=Sa:x;Bfoo=8",
            expected: "x=E:C9-1 8=8;Bmaster=9",
        },
        "picking one sub": {
            input: "\
a=Ax:Cz-y;Cy-x;Bfoo=z|\
x=S:C8-3 s=Sa:z;C3-2;C2-1 s=Sa:x;Bfoo=8;Bmaster=2;Os Bmaster=x!*=master",
            expected:
                "x=E:C9-2 s=Sa:zs;Bmaster=9;Os Czs-x z=z!Bmaster=zs!*=master",
        },
        "picking closed sub": {
            input: "\
a=Ax:Cz-y;Cy-x;Bfoo=z|\
x=S:C8-3 s=Sa:z;C3-2;C2-1 s=Sa:x;Bfoo=8;Bmaster=2",
            expected:
                "x=E:C9-2 s=Sa:zs;Bmaster=9;Os Czs-x z=z!Bmaster=zs!*=master",
        },
        "picking two closed subs": {
            input: "\
a=Ax:Cz-y;Cy-x;Bfoo=z|\
b=Aa:Cc-b;Cb-a;Bfoo=c|\
x=S:\
C8-3 s=Sa:z,t=Sb:c;C3-2;C2-1 s=Sa:x,t=Sb:a;\
Bfoo=8;Bmaster=2",
            expected: "\
x=E:C9-2 s=Sa:zs,t=Sb:ct;\
Bmaster=9;\
Os Czs-x z=z!Bmaster=zs!*=master;\
Ot Cct-a c=c!Bmaster=ct!*=master",
        },
    };

    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                           c.expected,
                                                           picker,
                                                           c.fails);
        }));
    });
});
