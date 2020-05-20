/*
 * Copyright (c) 2017, Two Sigma Open Source
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

const assert       = require("chai").assert;
const co           = require("co");
const colors       = require("colors");

const MergeUtil       = require("../../lib//util/merge_util");
const MergeCommon     = require("../../lib//util/merge_common");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");
const Open            = require("../../lib/util/open");

/**
 * Return the commit map required by 'RepoASTTestUtil.testMultiRepoManipulator'
 * from the specified 'result' returned by the 'merge' and 'continue' function,
 * using the specified 'maps' provided to the manipulators.
 */
function mapReturnedCommits(result, maps) {
    assert.isObject(result);
    let newCommitMap = {};

    // If a new commit was generated -- it wasn't a fast-forward commit --
    // record a mapping from the new commit to it's logical name: "x".

    const commitMap = maps.commitMap;
    if (null !== result.metaCommit && !(result.metaCommit in commitMap)) {
        newCommitMap[result.metaCommit] = "x";
    }

    // Map the new commits in submodules to the names of the submodules where
    // they were made.

    Object.keys(result.submoduleCommits).forEach(name => {
        commitMap[result.submoduleCommits[name]] = name;
    });
    return {
        commitMap: newCommitMap,
    };
}

describe("MergeUtil", function () {
    describe("fastForwardMerge", function () {
        const cases = {
            "simple": {
                initial: "a=B|x=S:C2-1 q=Sa:1;Bfoo=2",
                commit: "2",
                expected: "x=E:Bmaster=2",
            },
            "simple detached": {
                initial: "a=B|x=S:C2-1 u=Sa:1;Bfoo=2;*=",
                commit: "2",
                expected: "x=E:H=2",
            },
            "with submodule": {
                initial: "a=B:Ca-1;Ba=a|x=U:C3-2 s=Sa:a;Bfoo=3",
                commit: "3",
                expected: "x=E:Bmaster=3",
            },
            "with open submodule": {
                initial: "a=B:Ca-1;Ba=a|x=U:C3-2 s=Sa:a;Bfoo=3;Os",
                commit: "3",
                expected: "x=E:Bmaster=3;Os H=a",
            },
            "with open submodule and change": {
                initial: `
a=B:Ca-1;Ba=a|
x=U:C3-2 s=Sa:a;Bfoo=3;Os W README.md=3`,
                commit: "3",
                expected: "x=E:Bmaster=3;Os H=a!W README.md=3",
            },
            "with open submodule and conflict": {
                initial: `
a=B:Ca-1;Ba=a|
x=U:C3-2 s=Sa:a;Bfoo=3;Os W a=b`,
                commit: "3",
                fails: true,
            },
            "ff merge adding submodule": {
                initial: "a=S|x=U:Bfoo=1;*=foo",
                commit: "2",
                expected: "x=E:Bfoo=2",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            const ffwd = co.wrap(function *(repos, maps) {
                const x = repos.x;
                const reverseCommitMap = maps.reverseCommitMap;
                assert.property(reverseCommitMap, c.commit);
                const physicalCommit = reverseCommitMap[c.commit];
                const commit = yield x.getCommit(physicalCommit);
                const message = c.message || "message\n";
                yield MergeUtil.fastForwardMerge(x,
                                                 commit,
                                                 message);
                return {
                    commitMap: {},
                };
            });
            it(caseName, co.wrap(function *() {
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               c.expected,
                                                               ffwd,
                                                               c.fails);
            }));
        });
    });

    describe("merge", function () {
        // Will do merge from repo `x`.  A merge commit in the meta-repo will
        // be named `x`; any merge commits in the sub-repos will be given the
        // name of the sub-repo in which they are made.  TODO: test for changes
        // to submodule shas, and submodule deletions

        // Test plan:
        // - basic merging with meta-repo: normal/ffw/force commit; note that
        //   fast-forward merges are tested in the driver for
        //   'fastForwardMerge', so we just need to validate that it works once
        //   here
        // - many scenarios with submodules
        //   - merges with open/closed unaffected submodules
        //   - where submodules are opened and closed
        //   - where they can and can't be fast-forwarded

        const MODE = MergeCommon.MODE;
        const cases = {
            "no merge base": {
                initial: "x=S:Cx s=Sa:1;Bfoo=x",
                fromCommit: "x",
                fails: true,
            },
            "not ready": {
                initial: "x=S:QR 1: 1: 0 1",
                fromCommit: "1",
                fails: true,
            },
            "url changes": {
                initial: "a=B|b=B|x=U:C3-2 s=Sb:1;Bfoo=3",
                fromCommit: "3",
                expected: "a=B|x=E:Bmaster=3"
            },
            "ancestor url changes": {
                initial: "a=B|b=B|x=U:C4-3 q=Sa:1;C3-2 s=Sb:1;Bfoo=4",
                fromCommit: "4",
                expected: "a=B|x=E:Bmaster=4"
            },
            "genuine url merge conflicts": {
                initial: "a=B|b=B|c=B|" + 
                         "x=U:C3-2 s=Sc:1;C4-2 s=Sb:1;Bmaster=3;Bfoo=4",
                fromCommit: "4",
                fails: true
            },
            "dirty": {
                initial: "a=B|x=U:C3-1 t=Sa:1;Bfoo=3;Os W README.md=8",
                fromCommit: "3",
                fails: true,
            },
            "dirty index": {
                initial: "a=B|x=U:C3-1 t=Sa:1;Bfoo=3;Os I README.md=8",
                fromCommit: "3",
                fails: true,
            },
            "trivial -- nothing to do": {
                initial: "x=S",
                fromCommit: "1",
            },
            "up-to-date": {
                initial: "a=B|x=U:C3-2 t=Sa:1;Bmaster=3;Bfoo=2",
                fromCommit: "2",
            },
            "trivial -- nothing to do, has untracked change": {
                initial: "a=B|x=U:Os W foo=8",
                fromCommit: "2",
            },
            "staged change": {
                initial: "a=B|x=U:Os I foo=bar",
                fromCommit: "1",
                fails: true,
            },
            "submodule commit": {
                initial: "a=B|x=U:Os Cs-1!H=s",
                fromCommit: "1",
                fails: true,
            },
            "already a merge in progress": {
                initial: "x=S:Qhia#M 1: 1: 0 1",
                fromCommit: "1",
                fails: true,
            },
            "fast forward": {
                initial: "a=B|x=S:C2-1 s=Sa:1;Bfoo=2",
                fromCommit: "2",
                expected: "a=B|x=E:Bmaster=2",
            },
            "fast forward, but forced commit": {
                initial: "a=B|x=S:C2-1 s=Sa:1;Bfoo=2",
                fromCommit: "2",
                mode: MergeCommon.MODE.FORCE_COMMIT,
                expected: "a=B|x=E:Bmaster=x;Cx-1,2 s=Sa:1",
            },
            "one merge": {
                initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;C4-2 s=Sa:b;Bmaster=3;Bfoo=4`,
                fromCommit: "4",
                expected: "x=E:Cx-3,4 s=Sa:s;Bmaster=x",
            },
            "one merge, but ff only": {
                initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;C4-2 s=Sa:b;Bmaster=3;Bfoo=4`,
                fromCommit: "4",
                mode: MergeCommon.MODE.FF_ONLY,
                fails: true,
            },
            "one merge with ancestor": {
                initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;C5-4 t=Sa:b;C4-2 s=Sa:b;Bmaster=3;Bfoo=5`,
                fromCommit: "5",
                expected: `
x=E:Cx-3,5 t=Sa:b,s=Sa:s;Bmaster=x`,
            },
            "one merge with editor": {
                initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;C4-2 s=Sa:b;Bmaster=3;Bfoo=4`,
                fromCommit: "4",
                editMessage: () => Promise.resolve("foo\nbar\n# baz\n"),
                expected: `
x=E:Cfoo\nbar\n#x-3,4 s=Sa:s;Bmaster=x`,
                message: null,
            },
            "one merge with empty message": {
                initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;C4-2 s=Sa:b;Bmaster=3;Bfoo=4`,
                fromCommit: "4",
                editMessage: () => Promise.resolve(""),
                message: null,
            },
            "non-ffmerge with trivial ffwd submodule change": {
                initial: `
a=Aa:Cb-a;Bb=b|
x=U:C3-2 t=Sa:b;C4-2 s=Sa:b;Bmaster=3;Bfoo=4;Os`,
                fromCommit: "4",
                expected: "x=E:Cx-3,4 s=Sa:b;Os H=b;Bmaster=x",
            },
            "sub is same": {
                initial: `
a=Aa:Cb-a;Bb=b|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:b,t=Sa:b;Bmaster=3;Bfoo=4;Os`,
                fromCommit: "4",
                expected: "x=E:Cx-3,4 t=Sa:b;Bmaster=x",
            },
            "sub is same, closed": {
                initial: `
a=Aa:Cb-a;Bb=b|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:b,t=Sa:b;Bmaster=3;Bfoo=4`,
                fromCommit: "4",
                expected: "x=E:Cx-3,4 t=Sa:b;Bmaster=x",
            },
            "sub is behind": {
                initial: `
a=Aa:Cb-a;Bb=b|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:a;Bmaster=3;Bfoo=4;Os`,
                fromCommit: "4",
                expected: "x=E:Cx-3,4 ;Bmaster=x",
            },
            "sub is behind, closed": {
                initial: `
a=Aa:Cb-a;Bb=b|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:a;Bmaster=3;Bfoo=4`,
                fromCommit: "4",
                expected: "x=E:Cx-3,4 ;Bmaster=x",
            },
            "non-ffmerge with ffwd submodule change": {
                initial: `
a=Aa:Cb-a;Bb=b;Cc-b;Bc=c|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4;Os`,
                fromCommit: "4",
                expected: "x=E:Cx-3,4 s=Sa:c;Os H=c;Bmaster=x",
            },
            "non-ffmerge with ffwd submodule change, closed": {
                initial: `
a=Aa:Cb-a;Bb=b;Cc-b;Bc=c|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4`,
                fromCommit: "4",
                expected: "x=E:Cx-3,4 s=Sa:c;Bmaster=x",
            },
            "non-ffmerge with deeper ffwd submodule change": {
                initial: `
a=Aa:Cb-a;Bb=b;Cc-b;Cd-c;Bd=d|
x=U:C3-2 s=Sa:b;C5-4 s=Sa:d;C4-2 s=Sa:c;Bmaster=3;Bfoo=5`,
                fromCommit: "5",
                expected: "x=E:Cx-3,5 s=Sa:d;Bmaster=x",
            },
            "non-ffmerge with ffwd submodule change on lhs": {
                initial: `
a=Aa:Cb-a;Bb=b;Cc-b;Bc=c|
x=U:C3-2 s=Sa:b;C4-2 q=Sa:a;Bmaster=3;Bfoo=4`,
                fromCommit: "4",
                expected: "x=E:Cx-3,4 q=Sa:a;Bmaster=x",
            },
            "non-ffmerge with non-ffwd submodule change": {
                initial: `
a=Aa:Cb-a;Cc-a;Bfoo=b;Bbar=c|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4`,
                fromCommit: "4",
                expected: "x=E:Cx-3,4 s=Sa:s;Bmaster=x",
            },
            "non-ffmerge with non-ffwd submodule change, sub already open": {
                initial: `
a=Aa:Cb-a;Cc-a;Bfoo=b;Bbar=c|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4;Os`,
                fromCommit: "4",
                expected: "x=E:Cx-3,4 s=Sa:s;Os Cs-b,c c=c!H=s;Bmaster=x",
            },
            "non-ffmerge with non-ffwd submodule change, unrelated dnr": {
                initial: `
a=Aa:Cb-a;Cc-a;Bfoo=b;Bbar=c|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4;Os`,
                fromCommit: "4",
                doNotRecurse: ["fake"],
                expected: "x=E:Cx-3,4 s=Sa:s;Os Cs-b,c c=c!H=s;Bmaster=x",
            },
            "non-ffmerge with non-ffwd submodule change, sub is dnr": {
                initial: `
a=Aa:Cb-a;Cc-a;Bfoo=b;Bbar=c|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4;Os`,
                fromCommit: "4",
                doNotRecurse: ["s"],
                fails: true,
                errorMessage: `\
Submodule ${colors.red("s")} is conflicted.
`,
                expected: `x=E:Qmessage\n#M 3: 4: 0 4;I *s=S:1*S:b*S:c`
            },
            "submodule commit is up-to-date": {
                initial:`
a=Aa:Cb-a;Cc-b;Bfoo=b;Bbar=c|
x=U:C3-2 s=Sa:c;C4-2 s=Sa:b,t=Sa:a;Bmaster=3;Bfoo=4;Os`,
                fromCommit: "4",
                expected: "x=E:Cx-3,4 t=Sa:a;Os H=c;Bmaster=x",
            },
            "submodule commit is up-to-date, was not open": {
                initial:`
a=Aa:Cb-a;Cc-b;Bfoo=b;Bbar=c|
x=U:C3-2 s=Sa:c;C4-2 s=Sa:b,t=Sa:a;Bmaster=3;Bfoo=4`,
                fromCommit: "4",
                expected: "x=E:Cx-3,4 t=Sa:a;Bmaster=x",
            },
            "submodule commit is same": {
                initial: `
a=Aa:Cb-a;Cc-b;Bfoo=b;Bbar=c|
x=U:C3-2 s=Sa:c;C4-2 s=Sa:c,q=Sa:a;Bmaster=3;Bfoo=4`,
                fromCommit: "4",
                expected: "x=E:Cx-3,4 q=Sa:a;Bmaster=x",
            },
            "added in merge": {
                initial: `
a=B|
x=S:C2-1;C3-1 t=Sa:1;Bmaster=2;Bfoo=3`,
                fromCommit: "3",
                expected: "x=E:Cx-2,3 t=Sa:1;Bmaster=x",
            },
            "added on both sides": {
                initial: `
a=B|
x=S:C2-1 s=Sa:1;C3-1 t=Sa:1;Bmaster=2;Bfoo=3`,
                fromCommit: "3",
                expected: "x=E:Cx-2,3 t=Sa:1;Bmaster=x",
            },
            "conflicted add": {
                initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=S:C2-1 s=Sa:a;C3-1 s=Sa:b;Bmaster=2;Bfoo=3`,
                fromCommit: "3",
                expected: `x=E:Qmessage\n#M 2: 3: 0 3;I *s=~*S:a*S:b`,
                fails: true,
                errorMessage: `\
Conflicting entries for submodule ${colors.red("s")}
`,
            },
            "conflict in submodule": {
                initial: `
a=B:Ca-1 README.md=8;Cb-1 README.md=9;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;C4-2 s=Sa:b;Bmaster=3;Bfoo=4`,
                fromCommit: "4",
                fails: true,
                errorMessage: `\
Submodule ${colors.red("s")} is conflicted.
`,
                expected: `
x=E:Qmessage\n#M 3: 4: 0 4;
Os Qmessage\n#M a: b: 0 b!I *README.md=hello world*8*9!W README.md=\
<<<<<<< ours
8
=======
9
>>>>>>> theirs
;
`,
            },
            "new commit in sub in target branch but not in HEAD branch": {
                initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 t=Sa:1;C4-3 s=Sa:a;C5-3 t=Sa:b;Bmaster=4;Bfoo=5;Os;Ot`,
                fromCommit: "5",
                expected: `
x=E:Cx-4,5 t=Sa:b;Bmaster=x;Ot H=b;Os`
            },
            "new commit in sub in target branch but not in HEAD branch, closed"
            : {
                initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 t=Sa:1;C4-3 s=Sa:a;C5-3 t=Sa:b;Bmaster=4;Bfoo=5`,
                fromCommit: "5",
                expected: `
x=E:Cx-4,5 t=Sa:b;Bmaster=x`
            },
            "merge in a branch with a removed sub": {
                initial: `
a=B:Ca-1;Ba=a|
x=U:C3-2 t=Sa:1;C4-2 s;Bmaster=3;Bfoo=4`,
                fromCommit: "4",
                expected: `x=E:Cx-3,4 s;Bmaster=x`,
            },
            "merge to a branch with a removed sub": {
                initial: `
a=B:Ca-1;Ba=a|
x=U:C3-2 t=Sa:1;C4-2 s;Bmaster=4;Bfoo=3`,
                fromCommit: "3",
                expected: `x=E:Cx-4,3 t=Sa:1;Bmaster=x`,
            },
            "change with multiple merge bases": {
                initial: `
a=B:Ca-1;Ba=a|
x=S:C2-1 r=Sa:1,s=Sa:1,t=Sa:1;
    C3-2 s=Sa:a;
    C4-2 t=Sa:a;
    Cl-3,4 s,t;
    Ct-3,4 a=Sa:1,t=Sa:a;
    Bmaster=l;Bfoo=t`,
                fromCommit: "t",
                expected: "x=E:Cx-l,t a=Sa:1;Bmaster=x",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const expected = c.expected;

                const doMerge = co.wrap(function *(repos, maps) {
                    const upToDate = null === expected;
                    const mode = !("mode" in c) ? MODE.NORMAL : c.mode;
                    const x = repos.x;
                    const reverseCommitMap = maps.reverseCommitMap;
                    assert.property(reverseCommitMap, c.fromCommit);
                    const physicalCommit = reverseCommitMap[c.fromCommit];
                    const commit = yield x.getCommit(physicalCommit);
                    let message = c.message;
                    if (undefined === message) {
                        message = "message\n";
                    }
                    const defaultEditor = function () {};
                    const editMessage = c.editMessage || defaultEditor;
                    const openOption = Open.SUB_OPEN_OPTION.ALLOW_BARE;

                    const doNotRecurse = c.doNotRecurse || [];
                    const result = yield MergeUtil.merge(x,
                                                         null,
                                                         commit,
                                                         mode,
                                                         openOption,
                                                         doNotRecurse,
                                                         message,
                                                         editMessage);
                    const errorMessage = c.errorMessage || null;
                    assert.equal(result.errorMessage, errorMessage);
                    
                    if (upToDate) {
                        assert.isNull(result.metaCommit);
                        return;                                       // RETURN
                    }
                    if (!result.metaCommit) {
                        return;
                    }
                    return mapReturnedCommits(result, maps);
                });
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               expected || {},
                                                               doMerge,
                                                               c.fails);
            }));
        });
    });
    describe("continue", function () {
        const cases = {
            "no merge": {
                initial: "x=S",
                fails: true,
            },
            "continue in meta": {
                initial: `
x=S:C2-1;C3-1;Bmaster=2;I baz=bam;Qhi\n#M 2: 3: 0 3;Bfoo=3`,
                expected: "x=E:Chi\n#x-2,3 baz=bam;Bmaster=x;Q;I baz=~",
            },
            "cheap continue in meta": {
                initial: "x=S:C2;Qhi\n#M 1: 2: 0 2;B2=2",
                expected: "x=E:Chi\n#x-1,2 ;Bmaster=x;Q",
            },
            "continue with extra in non-continue sub": {
                initial: `
a=B|
x=U:C3-1;Qhi\n#M 2: 3: 0 3;B3=3;Os I README.md=8`,
                expected: `
x=E:Chi\n#x-2,3 s=Sa:s;Bmaster=x;Q;Os Chi\n#s-1 README.md=8!H=s`,
            },
            "continue in a sub": {
                initial: `
a=B:Ca;Ba=a|
x=U:C3-1;Qhi\n#M 2: 3: 0 3;B3=3;Os I README.md=8!Qyo\n#M 1: a: 0 a!Ba=a`,
                expected: `
x=E:Chi\n#x-2,3 s=Sa:s;Bmaster=x;Q;Os Cyo\n#s-1,a README.md=8!H=s!Ba=a`,
            },
            "continue in one sub, done in another": {
                initial: `
a=B:Ca-1;Cac-1 a=2;Cb-1;Cmab-a,b b=b;Bmab=mab;Bb=b;Ba=a;Bac=ac|
x=S:C2-1 s=Sa:1,t=Sa:1;
    C3-2 s=Sa:a,t=Sa:a;
    C4-2 s=Sa:ac,t=Sa:b;
    Bmaster=3;Bfoo=4;
    Qhi\n#M 3: 4: 0 4;
    Os I a=foo!Qyou\n#M a: ac: 0 ac!Bac=ac;
    Ot H=mab`,
                expected: `
x=E:Chi\n#x-3,4 s=Sa:s,t=Sa:mab;Bmaster=x;Q;
  Os Cyou\n#s-a,ac a=foo!H=s!Bac=ac;
  Ot`,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            const doContinue = co.wrap(function *(repos, maps) {
                const repo = repos.x;
                const result = yield MergeUtil.continue(repo);
                return mapReturnedCommits(result, maps);
            });
            it(caseName, co.wrap(function *() {
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               c.expected,
                                                               doContinue,
                                                               c.fails);
            }));
        });
    });
    describe("abort", function() {
        const cases = {
            "no merge": {
                initial: "x=S",
                fails: true,
            },
            "noop": {
                initial: "x=S:Qfoo#M 1: 1: 0 1",
                expected: "x=E:Q",
            },
            "noop with sub": {
                initial: "a=B|x=U:Qfoo#M 1: 1: 0 1;Os Qfoo#M 1: 1: 0 1",
                expected: "x=E:Q;Os Q",
            },
            "moved back a sub": {
                initial: `
a=B|
x=U:Qx#M 1: 1: 0 1;Os Cs-1!H=s!Bs=s`,
                expected: `x=E:Q;Os H=1!Cs-1!Bs=s`,
            },
            "from conflicts": {
                initial: `
a=B|
x=U:Qx#M 1: 1: 0 1;Os Cs-1!H=s!Bs=s!I *README.md=a*b*c`,
                expected: `x=E:Q;Os H=1!Cs-1!Bs=s`,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            const doAbort = co.wrap(function *(repos) {
                const repo = repos.x;
                yield MergeUtil.abort(repo);
            });
            it(caseName, co.wrap(function *() {
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               c.expected,
                                                               doAbort,
                                                               c.fails);
            }));
        });
    });
});
