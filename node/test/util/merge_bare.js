/*
 * Copyright (c) 2019, Two Sigma Open Source
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

const MergeUtil         = require("../../lib/util/merge_util");
const Open              = require("../../lib/util/open");
const MergeCommon       = require("../../lib//util/merge_common");
const RepoASTTestUtil   = require("../../lib/util/repo_ast_test_util");

describe("MergeBareUtil", function () {
    describe("merge_with_all_cases", function () {
        // Similar to tests of merge, but with no need for a working directory.
        const MODE = MergeCommon.MODE;
        const cases = {
            "3 way merge in bare": {
                initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=B:C2-1 s=Sa:1;C3-2 s=Sa:a;C4-2 s=Sa:b;Bmaster=3;Bfoo=4`,
                theirCommit: "4",
                ourCommit: "3",
            },
            "fast forward in normal mode": {
                initial: "a=B|x=S:C2-1 s=Sa:1;Bfoo=2",
                theirCommit: "2",
                ourCommit: "1",
                mode: MODE.NORMAL,
                parents: ["1"],
            },
            "fast forward in no-ff mode": {
                initial: "a=B|x=S:C2-1 s=Sa:1;Bfoo=2",
                theirCommit: "2",
                ourCommit: "1",
                parents: ["1", "2"],
            },
            "one merge": {
                initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;C4-2 s=Sa:b;Bmaster=3;Bfoo=4`,
                theirCommit: "4",
                ourCommit: "3",
            },
            "one merge with ancestor": {
                initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;C5-4 t=Sa:b;C4-2 s=Sa:b;Bmaster=3;Bfoo=5`,
                theirCommit: "5",
                ourCommit: "3",
            },
            "one merge with author and committer": {
                initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;C4-2 s=Sa:b;Bmaster=3;Bfoo=4`,
                theirCommit: "4",
                ourCommit: "3",
                authorName: "alice",
                authorEmail: "alice@example.com",
                committerName: "bob",
                committerEmail: "bob@example.com",
                verify: co.wrap(function *(repo, result) {
                    const commit = yield repo.getCommit(result.metaCommit);
                    const author = commit.author();
                    const committer = commit.committer();
                    assert.equal(author.name(), "alice");
                    assert.equal(author.email(), "alice@example.com");
                    assert.equal(committer.name(), "bob");
                    assert.equal(committer.email(), "bob@example.com");
                }),
            },
            "non-ffmerge with trivial ffwd submodule change": {
                initial: `
a=Aa:Cb-a;Bb=b|
x=U:C3-2 t=Sa:b;C4-2 s=Sa:b;Bmaster=3;Bfoo=4;Os`,
                theirCommit: "4",
                ourCommit: "3",
            },
            "sub is same": {
                initial: `
a=Aa:Cb-a;Bb=b|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:b,t=Sa:b;Bmaster=3;Bfoo=4;Os`,
                theirCommit: "4",
                ourCommit: "3",
            },
            "sub is same, closed": {
                initial: `
a=Aa:Cb-a;Bb=b|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:b,t=Sa:b;Bmaster=3;Bfoo=4`,
                theirCommit: "4",
                ourCommit: "3",
            },
            "sub is behind": {
                initial: `
a=Aa:Cb-a;Bb=b|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:a;Bmaster=3;Bfoo=4;Os`,
                theirCommit: "4",
                ourCommit: "3",
            },
            "sub is behind, closed": {
                initial: `
a=Aa:Cb-a;Bb=b|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:a;Bmaster=3;Bfoo=4`,
                theirCommit: "4",
                ourCommit: "3",
            },
            "non-ffmerge with ffwd submodule change": {
                initial: `
a=Aa:Cb-a;Bb=b;Cc-b;Bc=c|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4;Os`,
                theirCommit: "4",
                ourCommit: "3",
            },
            "non-ffmerge with ffwd submodule change, closed": {
                initial: `
a=Aa:Cb-a;Bb=b;Cc-b;Bc=c|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4`,
                theirCommit: "4",
                ourCommit: "3",
            },
            "non-ffmerge with deeper ffwd submodule change": {
                initial: `
a=Aa:Cb-a;Bb=b;Cc-b;Cd-c;Bd=d|
x=U:C3-2 s=Sa:b;C5-4 s=Sa:d;C4-2 s=Sa:c;Bmaster=3;Bfoo=5`,
                theirCommit: "5",
                ourCommit: "3",
            },
            "non-ffmerge with ffwd submodule change on lhs": {
                initial: `
a=Aa:Cb-a;Bb=b;Cc-b;Bc=c|
x=U:C3-2 s=Sa:b;C4-2 q=Sa:a;Bmaster=3;Bfoo=4`,
                theirCommit: "4",
                ourCommit: "3",
            },
            "non-ffmerge with non-ffwd submodule change": {
                initial: `
a=Aa:Cb-a;Cc-a;Bfoo=b;Bbar=c|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4`,
                theirCommit: "4",
                ourCommit: "3",
            },
            "non-ffmerge with non-ffwd submodule change, sub already open": {
                initial: `
a=Aa:Cb-a;Cc-a;Bfoo=b;Bbar=c|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4;Os`,
                theirCommit: "4",
                ourCommit: "3",
            },
            "submodule commit is up-to-date": {
                initial:`
a=Aa:Cb-a;Cc-b;Bfoo=b;Bbar=c|
x=U:C3-2 s=Sa:c;C4-2 s=Sa:b,t=Sa:a;Bmaster=3;Bfoo=4;Os`,
                theirCommit: "4",
                ourCommit: "3",
            },
            "submodule commit is up-to-date, was not open": {
                initial:`
a=Aa:Cb-a;Cc-b;Bfoo=b;Bbar=c|
x=U:C3-2 s=Sa:c;C4-2 s=Sa:b,t=Sa:a;Bmaster=3;Bfoo=4`,
                theirCommit: "4",
                ourCommit: "3",
            },
            "submodule commit is same": {
                initial: `
a=Aa:Cb-a;Cc-b;Bfoo=b;Bbar=c|
x=U:C3-2 s=Sa:c;C4-2 s=Sa:c,q=Sa:a;Bmaster=3;Bfoo=4`,
                theirCommit: "4",
                ourCommit: "3",
            },
            "submodule commit backwards": {
                initial:`
a=Aa:Cb-a;Cc-b;Bfoo=b;Bbar=c|
x=U:C3-2 s=Sa:c;C4-2 s=Sa:b;Bmaster=3;Bfoo=4;Os`,
                theirCommit: "4",
                ourCommit: "3",
            },
            "submodule commit forwards": {
                initial:`
a=Aa:Cb-a;Cc-b;Bfoo=b;Bbar=c|
x=U:C3-2 s=Sa:b;C4-2 s=Sa:c;Bmaster=3;Bfoo=4;Os`,
                theirCommit: "4",
                ourCommit: "3",
            },

            "added in merge": {
                initial: `a=B|x=S:C2-1;C3-1 t=Sa:1;Bmaster=2;Bfoo=3`,
                theirCommit: "3",
                ourCommit: "2",
            },
            "added on both sides": {
                initial: `
a=B|
x=S:C2-1 s=Sa:1;C3-1 t=Sa:1;Bmaster=2;Bfoo=3`,
                theirCommit: "2",
                ourCommit: "3",
            },
            "conflicted add": {
                initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=S:C2-1 s=Sa:a;C3-1 s=Sa:b;Bmaster=2;Bfoo=3`,
                theirCommit: "3",
                ourCommit: "2",
                fails: true,
                errorMessage: `\
CONFLICT (content): 
Conflicting entries for submodule: ${colors.red("s")}
Automatic merge failed
`,
            },
            "conflict in submodule": {
                initial: `
a=B:Ca-1 README.md=8;Cb-1 README.md=9;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;C4-2 s=Sa:b;Bmaster=3;Bfoo=4`,
                theirCommit: "4",
                ourCommit: "3",
                fails: true,
                errorMessage: `\
CONFLICT (content): 
Conflicting entries for submodule: ${colors.red("s")}
Automatic merge failed
`,
            },
            "new commit in sub in target branch but not in HEAD branch": {
                initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 t=Sa:1;C4-3 s=Sa:a;C5-3 t=Sa:b;Bmaster=4;Bfoo=5;Os;Ot`,
                theirCommit: "5",
                ourCommit: "4",
            },
            "new commit in sub in target branch but not in HEAD branch, closed"
            : {
                initial: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 t=Sa:1;C4-3 s=Sa:a;C5-3 t=Sa:b;Bmaster=4;Bfoo=5`,
                theirCommit: "5",
                ourCommit: "4",
            },
            "merge in a branch with a removed sub": {
                initial: `
a=B:Ca-1;Ba=a|
x=U:C3-2 t=Sa:1;C4-2 s;Bmaster=3;Bfoo=4`,
                theirCommit: "4",
                ourCommit: "3",
            },
            "merge to a branch with a removed sub": {
                initial: `
a=B:Ca-1;Ba=a|
x=U:C3-2 t=Sa:1;C4-2 s;Bmaster=4;Bfoo=3`,
                theirCommit: "3",
                ourCommit: "4",
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
                theirCommit: "t",
                ourCommit: "l",
            },            
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            let authorName, authorEmail, committerName, committerEmail;
            this.beforeEach(function () {
                if (c.authorName && c.authorEmail) {
                    authorName = process.env.GIT_AUTHOR_NAME;
                    authorEmail = process.env.GIT_AUTHOR_EMAIL;
                    process.env.GIT_AUTHOR_NAME = c.authorName;
                    process.env.GIT_AUTHOR_EMAIL = c.authorEmail;
                }
                if (c.committerName && c.committerEmail) {
                    committerName = process.env.GIT_COMMITTER_NAME;
                    committerEmail = process.env.GIT_COMMITTER_EMAIL;
                    process.env.GIT_COMMITTER_NAME = c.committerName;
                    process.env.GIT_COMMITTER_EMAIL = c.committerEmail;
                }
            });
            this.afterEach(function () {
                if (authorName && authorEmail) {
                    process.env.GIT_AUTHOR_NAME = authorName;
                    process.env.GIT_AUTHOR_EMAIL = authorEmail;
                }
                if (committerName && committerEmail) {
                    process.env.GIT_AUTHOR_NAME = committerName;
                    process.env.GIT_AUTHOR_EMAIL = committerEmail;
                }
            });
            it(caseName, co.wrap(function *() {
                // expect no changes to the repo
                const expected = "x=E"; 

                const doMerge = co.wrap(function *(repos, maps) {
                    const upToDate = null === expected;
                    const x = repos.x;
                    const reverseCommitMap = maps.reverseCommitMap;
                    assert.property(reverseCommitMap, c.theirCommit);
                    const theirSha = reverseCommitMap[c.theirCommit];
                    const theirCommit = yield x.getCommit(theirSha);
                    const ourSha = reverseCommitMap[c.ourCommit];
                    const ourCommit = yield x.getCommit(ourSha);

                    let message = c.message;
                    if (undefined === message) {
                        message = "message\n";
                    }
                    const mode = !("mode" in c) ? MODE.FORCE_COMMIT : c.mode;
                    const openOption = Open.SUB_OPEN_OPTION.FORCE_BARE;
                    const defaultEditor = function () {};
                    const result = yield MergeUtil.merge(x,
                                                        ourCommit,
                                                        theirCommit,
                                                        mode,
                                                        openOption,
                                                        [],
                                                        message,
                                                        defaultEditor);
                    const errorMessage = c.errorMessage || null;
                    assert.equal(result.errorMessage, errorMessage);
                    if (upToDate) {
                        assert.isNull(result.metaCommit);
                        return;                                       // RETURN
                    }
                    if (c.verify) {
                        yield c.verify(x, result);
                    }
                    if (result.metaCommit) {
                        const parents = c.parents ?
                            c.parents.map(v => reverseCommitMap[v]) :
                            [theirSha, ourSha];
                        const mergedCommit
                            = yield x.getCommit(result.metaCommit);
                        const mergeParents
                            = yield mergedCommit.getParents(null, null);
                        const mergeParentShas
                            = new Set(mergeParents.map(c => c.sha()));
                        const parentsMatch = parents
                            .map(c => mergeParentShas.has(c))
                            .reduce( (acc, curr) => acc && curr, true);
                        assert.isTrue(
                            parentsMatch, 
                            "parents (" + mergeParentShas + ") " +
                            "of created meta commit do not match expected: " +
                            parents);
                    }
                    return {commitMap: {}};
                });
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               expected || {},
                                                               doMerge,
                                                               c.fails);
            }));
        });
    });
});
