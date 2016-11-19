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

const Merge           = require("../../lib//util/merge");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");
const Status          = require("../../lib/util/status");

describe("merge", function () {
    // Will do merge from repo `x`.  A merge commit in the meta-repo will be
    // named `x`; any merge commits in the sub-repos will be given the name of
    // the sub-repo in which they are made.
    // TODO: test for changes to submodule shas, and submodule deletions

    const doMerge = co.wrap(function *(upToDate,
                                       fromCommit,
                                       mode,
                                       repos,
                                       maps) {
        const x = repos.x;
        const status = yield Status.getRepoStatus(x);
        const commitMap = maps.commitMap;
        const reverseMap = maps.reverseMap;
        assert.property(reverseMap, fromCommit);
        const physicalCommit = reverseMap[fromCommit];
        const commit = yield x.getCommit(physicalCommit);
        const result = yield Merge.merge(x, status, commit, mode, "message");
        if (upToDate) {
            assert.isNull(result);
            return;                                                   // RETURN
        }
        assert.isObject(result);
        let newCommitMap = {};

        // If a new commit was generated -- it wasn't a fast-forward commit --
        // record a mapping from the new commit to it's logical name: "x".

        if (!(result.metaCommit in commitMap)) {
            newCommitMap[result.metaCommit] = "x";
        }

        // Map the new commits in submodules to the names of the submodules
        // where they were made.

        Object.keys(result.submoduleCommits).forEach(name => {
            commitMap[result.submoduleCommits[name]] = name;
        });
        return {
            commitMap: newCommitMap,
        };
    });

    // Test plan:
    // - basic merging with meta-repo: normal/ffw/force commit
    // - many scenarios with submodules
    //   - merges with open/closed unaffected submodules
    //   - where submodules are opened and closed
    //   - where they can and can't be fast-forwarded

    const MODE = Merge.MODE;
    const cases = {
        "trivial": {
            initial: "x=S",
            fromCommit: "1",
            expected: null,
        },
        "ancestor": {
            initial: "x=S:C2-1;Bmaster=2",
            fromCommit: "1",
            upToDate: true,
            expected: null,
        },
        "ff merge, not required": {
            initial: "x=S:C2-1;Bfoo=2",
            fromCommit: "2",
            expected: "x=E:Bmaster=2",
        },
        "ff merge, required": {
            initial: "x=S:C2-1;Bfoo=2",
            fromCommit: "2",
            mode: MODE.FF_ONLY,
            expected: "x=E:Bmaster=2",
        },
        "ff merge, but disallowed": {
            initial: "x=S:C2-1;Bfoo=2",
            fromCommit: "2",
            mode: MODE.FORCE_COMMIT,
            expected: "x=E:Cx-1,2 2=2;Bmaster=x",
        },
        "one merge": {
            initial: "x=S:C2-1;C3-1;Bmaster=2;Bfoo=3",
            fromCommit: "3",
            expected: "x=E:Cx-2,3 3=3;Bmaster=x",
        },
        "one merge, forced anyway": {
            initial: "x=S:C2-1;C3-1;Bmaster=2;Bfoo=3",
            fromCommit: "3",
            expected: "x=E:Cx-2,3 3=3;Bmaster=x",
            mode: MODE.FORCE_COMMIT,
        },
        "one merge, ff requested": {
            initial: "x=S:C2-1;C3-1;Bmaster=2;Bfoo=3",
            fromCommit: "3",
            mode: MODE.FF_ONLY,
            fails: true,
        },
        "ff merge adding submodule": {
            initial: "a=S|x=U:Bfoo=1;*=foo",
            fromCommit: "2",
            expected: "x=E:Bfoo=2",
        },
        "ff merge with submodule change": {
            initial: "a=S:C4-1;Bfoo=4|x=U:C5-2 s=Sa:4;Bfoo=5",
            fromCommit: "5",
            expected: "x=E:Bmaster=5;Os H=4",
        },
        "fforwardable but disallowed with submodule change": {
            initial: "a=S:C4-1;Bfoo=4|x=U:C5-2 s=Sa:4;Bfoo=5",
            fromCommit: "5",
            mode: MODE.FORCE_COMMIT,
            expected:
                "x=E:Bmaster=x;Cx-2,5 s=Sa:s;Os Cs-1,4 4=4!H=s",
        },
        "fforwardable merge with non-ffwd submodule change": {
            initial: "\
a=Aa:Cb-a;Cc-a;Bfoo=b;Bbar=c|\
x=U:C3-2 s=Sa:b;C4-3 s=Sa:c;Bmaster=3;Bfoo=4",
            fromCommit: "4",
            expected:
                "x=E:Cx-3,4 s=Sa:s;Os Cs-b,c c=c!H=s;Bmaster=x",
        },
        "fforwardable merge with non-ffwd submodule change, ff requested": {
            initial: "\
a=Aa:Cb-a;Cc-a;Bfoo=b;Bbar=c|\
x=U:C3-2 s=Sa:b;C4-3 s=Sa:c;Bmaster=3;Bfoo=4",
            fromCommit: "4",
            mode: MODE.FF_ONLY,
            expected: "x=E:Os H=b",
            fails: true,
        },
        "non-ffmerge with non-ffwd submodule change": {
            initial: "\
a=Aa:Cb-a;Cc-a;Bfoo=b;Bbar=c|\
x=U:C3-2 s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4",
            fromCommit: "4",
            expected:
                "x=E:Cx-3,4 s=Sa:s;Os Cs-b,c c=c!H=s;Bmaster=x",
        },
        "non-ffmerge with non-ffwd submodule change, sub open": {
            initial: "\
a=Aa:Cb-a;Cc-a;Bfoo=b;Bbar=c|\
x=U:C3-2 s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4;Os",
            fromCommit: "4",
            expected:
                "x=E:Cx-3,4 s=Sa:s;Os Cs-b,c c=c!H=s;Bmaster=x",
        },
        "submodule commit is up-to-date": {
            initial: "\
a=Aa:Cb-a;Cc-b;Bfoo=b;Bbar=c|\
x=U:C3-2 s=Sa:c;C4-2 s=Sa:b,x=y;Bmaster=3;Bfoo=4",
            fromCommit: "4",
            expected: "x=E:Cx-3,4 x=y;Os H=c;Bmaster=x",
        },
        "submodule commit is same": {
            initial: "\
a=Aa:Cb-a;Cc-b;Bfoo=b;Bbar=c|\
x=U:C3-2 s=Sa:c;C4-2 s=Sa:c,x=y;Bmaster=3;Bfoo=4",
            fromCommit: "4",
            expected: "x=E:Cx-3,4 x=y;Bmaster=x",
        },
        "otherwise ffwardable change to meta with two subs; one can't ffwd": {
            initial: "\
a=Aa:Cb-a;Cc-a;Cd-c;Bx=d;By=b|\
x=U:C3-2 s=Sa:b,t=Sa:c;C4-3 s=Sa:c,t=Sa:d;Bmaster=3;Bfoo=4",
            fromCommit: "4",
            expected: "\
x=E:Cx-3,4 s=Sa:s,t=Sa:d;Bmaster=x;\
Os Cs-b,c c=c!H=s;\
Ot H=d",
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const expected = c.expected;
            function manipulator(repos, maps) {
                const upToDate = null === expected;
                const mode = !("mode" in c) ? MODE.NORMAL : c.mode;
                return doMerge(upToDate, c.fromCommit, mode, repos, maps);
            }
            yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                           c.expected || {},
                                                           manipulator,
                                                           c.fails);
        }));
    });
});
