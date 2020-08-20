/*
 * Copyright (c) 2018, Two Sigma Open Source
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

const BulkNotesUtil       = require("../../lib/util/bulk_notes_util");
const DestitchUtil        = require("../../lib/util/destitch_util");
const RepoASTTestUtil     = require("../../lib/util/repo_ast_test_util");
const StitchUtil          = require("../../lib/util/stitch_util");
const SyntheticBranchUtil = require("../../lib/util/synthetic_branch_util");
const UserError           = require("../../lib/util/user_error");

/**
 *  Replace refs and notes with their equivalent logical mapping and otherwise
 *  handle things we can't map well with our shorthand.
 */
function refMapper(actual, mapping) {
    const fetchedSubRe = /(commits\/)(.*)/;
    const commitMap = mapping.commitMap;
    let result = {};

    // Map refs

    Object.keys(actual).forEach(repoName => {
        const ast = actual[repoName];
        const refs = ast.refs;
        const newRefs = {};
        Object.keys(refs).forEach(refName => {
            const ref = refs[refName];
            const fetchedSubMatch = fetchedSubRe.exec(refName);
            if (null !== fetchedSubMatch) {
                const sha = fetchedSubMatch[2];
                const logical = commitMap[sha];
                const newRefName = refName.replace(fetchedSubRe,
                                                   `$1${logical}`);
                newRefs[newRefName] = ref;
                return;                                               // RETURN
            }
            newRefs[refName] = ref;
        });

        // Wipe out notes, we validate these by expicitly reading and
        // processing the new notes.

        result[repoName] = ast.copy({
            refs: newRefs,
            notes: {},
        });
    });
    return result;
}

/**
 * Return the result of mapping logical commit IDs to actual commit SHAs in the
 * specified `map` using the specified `revMap`.
 *
 * @param {Object} revMap
 * @param {Object} map      SHA -> { metaRepoCommit, subCommits }
 */
function mapDestitched(revMap, map) {
    const result = {};
    Object.keys(map).forEach(id => {
        const commitData = map[id];
        const sha = revMap[id];
        const metaSha = revMap[commitData.metaRepoCommit];
        const subCommits = {};
        Object.keys(commitData.subCommits).forEach(sub => {
            const subId = commitData.subCommits[sub];
            subCommits[sub] = revMap[subId];
        });
        result[sha] = {
            metaRepoCommit: metaSha,
            subCommits: subCommits,
        };
    });
    return result;
}

describe("destitch_util", function () {
describe("findSubmodule", function () {
    const cases = {
        "empty": {
            subs: {},
            filename: "foo",
            expected: null,
        },
        "direct match": {
            subs: {
                "foo/bar": "",
                "bam": "",
            },
            filename: "foo/bar",
            expected: "foo/bar",
        },
        "inside it": {
            subs: {
                "foo/bar": "",
                "bam": "",
            },
            filename: "foo/bar/bam/baz/ttt.xx",
            expected: "foo/bar",
        },
        "missed": {
            subs: {
                "f/bar": "",
                "bam": "",
            },
            filename: "foo/bar/bam/baz/ttt.xx",
            expected: null,
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, function () {
            const result = DestitchUtil.findSubmodule(c.subs, c.filename);
            assert.equal(result, c.expected);
        });
    });
});
describe("computeChangedSubmodules", function () {
    const cases = {
        "no changes": {
            state: "S",
            subs: { "foo/bar": "" },
            stitched: "1",
            parent: "1",
            expected: [],
        },
        "sub not found": {
            state: "S:C2-1 heya=baa;B2=2",
            subs: { "foo/bar": "" },
            stitched: "2",
            parent: "1",
            expected: [],
            fails: true,
        },
        "sub found": {
            state: "S:C2-1 hey/there/bob=baa;B2=2",
            subs: { "hey/there": "" },
            stitched: "2",
            parent: "1",
            expected: ["hey/there"],
        },
        "removal": {
            state: "S:C2-1 hey/there/bob=baa;C3-2 hey/there/bob;B3=3",
            subs: { "hey/there": "" },
            stitched: "3",
            parent: "2",
            expected: ["hey/there"],
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const written = yield RepoASTTestUtil.createRepo(c.state);
            const repo = written.repo;
            const revMap = written.oldCommitMap;
            const stitched = yield repo.getCommit(revMap[c.stitched]);
            const parent = yield repo.getCommit(revMap[c.parent]);
            let result;
            let error;
            try {
                result = yield DestitchUtil.computeChangedSubmodules(repo,
                                                                     c.subs, 
                                                                     stitched,
                                                                     parent);
            } catch (e) {
                error = e;
            }
            if (undefined !== error) {
                if (!c.fails || !(error instanceof UserError)) {
                    throw error;
                }
                return;                                               // RETURN
            }
            assert(!c.fails, "did not fail");
            const sorted = Array.from(result).sort();
            assert.deepEqual(sorted, c.expected.sort());
        }));
    });
});
describe("makeDestitchedCommit", function () {
    const cases = {
        "no changes": {
            state: "x=S",
            metaRepoCommits: [],
            stitchedCommit: "1",
            changedSubmodules: {},
            subUrls: {},
            expected: "x=E:Cthe first commit#d ;Bd=d",
        },
        "with a base commit": {
            state: "x=S",
            metaRepoCommits: ["1"],
            stitchedCommit: "1",
            changedSubmodules: {},
            subUrls: {},
            expected: "x=E:Cthe first commit#d-1 ;Bd=d",
        },
        "bad sub": {
            state: "x=S:C2 foo=bar;B2=2",
            metaRepoCommits: [],
            stitchedCommit: "2",
            changedSubmodules: {
                "foo": "1",
            },
            subUrls: {"foo": "bam"},
            fails: true,
        },
        "deletion": {
            state: "x=S:C2-1 s=Sa:1;Cw s/a=ss;Cx-w s/a;H=2;Bx=x",
            metaRepoCommits: ["2"],
            stitchedCommit: "x",
            changedSubmodules: { "s": "1" },
            subUrls: {s: "a"},
            expected: "x=E:Cd-2 s;Bd=d",
        },
        "actual change": {
            state: `
a=B:Ca foo=bar;Ba=a|
x=S:C2-1 s=Sa:a;B2=2;Cx s/foo=bam;Bx=x;Ba=a`,
            metaRepoCommits: ["2"],
            stitchedCommit: "x",
            changedSubmodules: { s: "a" },
            subUrls: { s: "a" },
            expected: `x=E:Cs-a foo=bam;Cd-2 s=Sa:s;Bd=d;Bs=s`
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        const destitcher = co.wrap(function *(repos, maps) {
            const repo = repos.x;
            const revMap = maps.reverseCommitMap;
            const metaRepoCommits =
               yield c.metaRepoCommits.map(co.wrap(function *(metaRepoCommit) {
                const sha = revMap[metaRepoCommit];
                return yield repo.getCommit(sha);
            }));
            const stitchedSha = revMap[c.stitchedCommit];
            const stitchedCommit = yield repo.getCommit(stitchedSha);
            const subUrls = {};
            Object.keys(c.subUrls).forEach(sub => {
                const url = c.subUrls[sub];
                subUrls[sub] = maps.reverseUrlMap[url] || url;
            });
            const changedSubmodules = {};
            Object.keys(c.changedSubmodules).forEach(sub => {
                const sha = c.changedSubmodules[sub];
                changedSubmodules[sub] = revMap[sha];
            });
            const result = yield DestitchUtil.makeDestitchedCommit(
                                                           repo,
                                                           metaRepoCommits,
                                                           stitchedCommit,
                                                           changedSubmodules,
                                                           subUrls);
            const commits = {};

            // Need to anchor the destitched commit

            yield NodeGit.Reference.create(repo,
                                           "refs/heads/d",
                                           result.metaRepoCommit,
                                           1,
                                           "destitched");

            commits[result.metaRepoCommit] = "d";
            for (let sub in result.subCommits) {
                const sha = result.subCommits[sub];
                commits[sha] = sub;
                yield NodeGit.Reference.create(repo,
                                               `refs/heads/${sub}`,
                                               sha,
                                               1,
                                               "destitched");
            }
            return {
                commitMap: commits,
            };
        });
        it(caseName, co.wrap(function *() {
            yield RepoASTTestUtil.testMultiRepoManipulator(c.state,
                                                           c.expected,
                                                           destitcher,
                                                           c.fails);
        }));
    });
});
describe("destitchChain", function () {
    const cases = {
        "already stitched, noop": {
            state: "x=S",
            commit: "1",
            url: "foo",
            already: { "1": { metaRepoCommit: "1", subCommits: {}}},
            newly: {},
            expectedNewly: {},
            result: "1",
        },
        "newly stitched, noop": {
            state: "x=S",
            commit: "1",
            url: "foo",
            already: {},
            newly: { "1": { metaRepoCommit: "1", subCommits: {}}},
            expectedNewly: { "1": { metaRepoCommit: "1", subCommits: {}}},
            result: "1",
        },
        "bad, orphan": {
            state: `
a=B:Ca;Ba=a|
x=B:C2 foo/bar=Sa:a;B2=2;Cy foo/bar/a=baz;By=y`,
            commit: "y",
            url: "a",
            already: {},
            newly: {},
            expectedNewly: {},
            fails: true,
        },
        "destitch one": {
            state: `
a=B:Ca;Ba=a;C2 s=Sa:a;B2=2|
x=B:Cx s/a=bam;Cy-x s/a=baz;By=y`,
            commit: "y",
            url: "a",
            already: { "x": { metaRepoCommit: "2", subCommits: {}}},
            newly: {},
            expectedNewly: {
                "y": {
                    metaRepoCommit: "d.y",
                    subCommits: {
                        "s": "s.y.s",
                    },
                },
            },
            result: "d.y",
            expected: `
x=E:Cs.y.s-a a=baz;Cd.y-2 s=Sa:s.y.s;Bs.y.s=s.y.s;Bd.y=d.y`,
        },
        "destitch one, some unchanged": {
            state: `
a=B:Ca;Ba=a;C2 s=Sa:a,t=Sa:a;B2=2|
x=B:Cx s/a=a,t/a=a;Cy-x s/a=baz;By=y`,
            commit: "y",
            url: "a",
            already: { "x": { metaRepoCommit: "2", subCommits: {}}},
            newly: {},
            expectedNewly: {
                "y": {
                    metaRepoCommit: "d.y",
                    subCommits: {
                        "s": "s.y.s",
                    },
                },
            },
            result: "d.y",
            expected: `
x=E:Cs.y.s-a a=baz;Cd.y-2 s=Sa:s.y.s;Bs.y.s=s.y.s;Bd.y=d.y`,
        },
        "destitch with an ancestor": {
            state: `
a=B:Ca;Ba=a;C2 s=Sa:a;B2=2|
x=B:Cx s/a=bam;Cy-x s/a=baz;Cz-y s/a=ya;Bz=z`,
            commit: "z",
            url: "a",
            already: { "x": { metaRepoCommit: "2", subCommits: {}}},
            newly: {},
            expectedNewly: {
                "y": {
                    metaRepoCommit: "d.y",
                    subCommits: {
                        "s": "s.y.s",
                    },
                },
                "z": {
                    metaRepoCommit: "d.z",
                    subCommits: {
                        "s": "s.z.s",
                    },
                },
            },
            result: "d.z",
            expected: `
x=E:Cs.y.s-a a=baz;Cd.y-2 s=Sa:s.y.s;Bs.y.s=s.y.s;Bd.y=d.y;
    Cs.z.s-s.y.s a=ya;Cd.z-d.y s=Sa:s.z.s;Bd.z=d.z;Bs.z.s=s.z.s`,
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        const destitcher = co.wrap(function *(repos, maps) {
            const repo = repos.x;
            const revMap = maps.reverseCommitMap;
            const commitMap = maps.commitMap;
            const sha = revMap[c.commit];
            const commit = yield repo.getCommit(sha);
            const baseUrl = maps.reverseUrlMap[c.url] || c.url;
            const already = mapDestitched(revMap, c.already);
            for (let sha in already) {
                already[sha] = JSON.stringify(already[sha], null, 4);
            }
            yield BulkNotesUtil.writeNotes(repo,
                                           StitchUtil.referenceNoteRef,
                                           already);
            const originalNewly = mapDestitched(revMap, c.newly);
            const newly = Object.assign({}, originalNewly);
            const result = yield DestitchUtil.destitchChain(repo,
                                                            commit,
                                                            baseUrl,
                                                            newly);

            // clean up the ref so we don't get cofused when checking final
            // state.

            NodeGit.Reference.remove(repo, StitchUtil.referenceNoteRef);
            const commits = {};

            // Anchor generated commits and generate commit map.

            const actualNewly = {};
            yield Object.keys(newly).map(co.wrap(function *(stitchedSha) {
                const commitInfo = newly[stitchedSha];
                const stitchedId = commitMap[stitchedSha];
                const newMetaSha = commitInfo.metaRepoCommit;
                let newMetaId;
                const inOriginal = stitchedSha in originalNewly;

                // Only make ref and add to commit map if the commit was
                // created.

                if (inOriginal) {
                    newMetaId = commitMap[newMetaSha];
                } else {
                    newMetaId = `d.${stitchedId}`;
                    yield NodeGit.Reference.create(repo,
                                                   `refs/heads/${newMetaId}`,
                                                   newMetaSha,
                                                   1,
                                                   "destitched");
                    commits[newMetaSha] = newMetaId;
                }
                const actualSubCommits = {};
                const subCommits = commitInfo.subCommits;
                yield Object.keys(subCommits).map(co.wrap(function *(sub) {
                    const newSubSha = subCommits[sub];
                    let newSubId;
                    if (inOriginal) {
                        newSubId = commitMap[newSubSha];
                    } else {
                        newSubId = `s.${stitchedId}.${sub}`;
                        yield NodeGit.Reference.create(
                                                      repo,
                                                      `refs/heads/${newSubId}`,
                                                       newSubSha,
                                                       1,
                                                       "destitched");
                        commits[newSubSha] = newSubId;
                    }
                    actualSubCommits[sub] = newSubId;
                }));
                actualNewly[stitchedId] = {
                    metaRepoCommit: newMetaId,
                    subCommits: actualSubCommits,
                };
            }));
            const resultId = commitMap[result] || commits[result];
            assert.equal(resultId, c.result);
            assert.deepEqual(actualNewly, c.expectedNewly);
            return {
                commitMap: commits,
            };
        });
        it(caseName, co.wrap(function *() {
            yield RepoASTTestUtil.testMultiRepoManipulator(c.state,
                                                           c.expected,
                                                           destitcher,
                                                           c.fails);
        }));
    });
});
describe("getDestitched", function () {
    it("nowhere", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const headSha = head.id().tostrS();
        const result = yield DestitchUtil.getDestitched(repo, {}, headSha);
        assert.isNull(result);
    }));
    it("in newly", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const headSha = head.id().tostrS();
        const newly = {};
        newly[headSha] = {
            metaCommit: "1",
            subCommits: {},
        };
        const result = yield DestitchUtil.getDestitched(repo, newly, headSha);
        assert.deepEqual(result, newly[headSha]);
    }));
    it("in local", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const headSha = head.id().tostrS();
        const destitched = {
            metaCommit: "1",
            subCommits: {},
        };
        const sig = yield repo.defaultSignature();
        const refName = DestitchUtil.localReferenceNoteRef;
        const data = JSON.stringify(destitched, null, 4);
        yield NodeGit.Note.create(repo, refName, sig, sig, headSha, data, 1);
        const result = yield DestitchUtil.getDestitched(repo, {}, headSha);
        assert.deepEqual(result, destitched);
    }));
    it("in remote", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const headSha = head.id().tostrS();
        const destitched = {
            metaCommit: "1",
            subCommits: {},
        };
        const sig = yield repo.defaultSignature();
        const refName = StitchUtil.referenceNoteRef;
        const data = JSON.stringify(destitched, null, 4);
        yield NodeGit.Note.create(repo, refName, sig, sig, headSha, data, 1);
        const result = yield DestitchUtil.getDestitched(repo, {}, headSha);
        assert.deepEqual(result, destitched);
    }));
});
describe("pushSyntheticRefs", function () {
    it("breathing", co.wrap(function *() {

        // We're going to set up a typical looking state where we've destitched
        // two commits:
        //
        // s -- first to destitch
        // t -- second
        // 2 -- destitched version of s, introduces commit b in sub s
        // 3 -- destitched version of t, introduces commit c in sub t
        //
        // After the push, we should see synthetic refs in b and c.

        const state = `
a=B|b=B|c=B|
x=S:Cs s/b=b;Ct-s t/c=c;Bs=s;Bt=t;
    Cb;Cc;Bb=b;Bc=c;C2-1 s=S../b:b;C3-2 t=S../c:c;H=3;B2=2`;
        const written = yield RepoASTTestUtil.createMultiRepos(state);
        const repos = written.repos;
        const x = repos.x;
        const sCommit = yield x.getBranchCommit("s");
        const sSha = sCommit.id().tostrS();
        const tCommit = yield x.getBranchCommit("t");
        const tSha = tCommit.id().tostrS();
        const twoCommit = yield x.getHeadCommit();
        const twoSha = twoCommit.id().tostrS();
        const threeCommit = yield x.getHeadCommit();
        const threeSha = threeCommit.id().tostrS();
        const bCommit = yield x.getBranchCommit("b");
        const bSha = bCommit.id().tostrS();
        const cCommit = yield x.getBranchCommit("c");
        const cSha = cCommit.id().tostrS();
        const newCommits = {};
        newCommits[sSha] = {
            metaRepoCommit: twoSha,
            subCommits: {
                s: bSha,
            },
        };
        newCommits[tSha] = {
            metaRepoCommit: threeSha,
            subCommits: {
                t: cSha,
            },
        };
        const baseUrl = written.reverseUrlMap.a;
        yield DestitchUtil.pushSyntheticRefs(x,
                                             baseUrl,
                                             twoCommit,
                                             newCommits);
        const b = repos.b;
        const bRefName = SyntheticBranchUtil.getSyntheticBranchForCommit(bSha);
        const bRef = yield NodeGit.Reference.lookup(b, bRefName);
        assert(undefined !== bRef);
        assert.equal(bRef.target().tostrS(), bSha);

        const c = repos.c;
        const cRefName = SyntheticBranchUtil.getSyntheticBranchForCommit(cSha);
        const cRef = yield NodeGit.Reference.lookup(c, cRefName);
        assert.equal(cRef.target().tostrS(), cSha);
    }));
});
describe("recordLocalNotes", function () {
    it("breathing", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S:C2-1;B2=2");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const headSha = head.id().tostrS();
        const two = yield repo.getBranchCommit("2");
        const twoSha = two.id().tostrS();
        const newCommits = {};
        newCommits[headSha] = {
            metaRepoCommit: twoSha,
            subCommits: { s: headSha },
        };
        yield DestitchUtil.recordLocalNotes(repo, newCommits);
        const notes = yield BulkNotesUtil.readNotes(
                                           repo,
                                           DestitchUtil.localReferenceNoteRef);
        const expected = {};
        Object.keys(newCommits).forEach(sha => {
            expected[sha] = JSON.stringify(newCommits[sha], null, 4);
        });
        assert.deepEqual(notes, expected);
    }));
});
describe("destitch", function () {
    const cases = {
        "already done": {
            state: "a=B|x=S:Ra=a;C2;B2=2",
            already: {
                "1": {
                    metaRepoCommit: "2",
                    subCommits: {}
                },
            },
            commitish: "HEAD",
            remote: "a",
            ref: "refs/heads/foo",
            expected: "x=E:Bfoo=2",
        },
        "already done, no ref": {
            state: "a=B|x=S:Ra=a;C2;B2=2",
            already: {
                "1": {
                    metaRepoCommit: "2",
                    subCommits: {}
                },
            },
            commitish: "HEAD",
            remote: "a",
        },
        "destitch one": {
            state: `
a=B|b=B|
x=B:Ra=a;Cb foo=bar;Bb=b;C2 s=S../b:b;B2=2;Cy s/foo=bar;Cx-y s/foo=bam;Bx=x`,
            already: {
                "y": {
                    metaRepoCommit: "2",
                    subCommits: { s: "b" },
                },
            },
            commitish: "x",
            remote: "a",
            ref: "refs/heads/foo",
            expected: `
x=E:Cs.x.s-b foo=bam;Cd.x-2 s=S../b:s.x.s;Bfoo=d.x;Bs.x.s=s.x.s|
b=E:Fcommits/s.x.s=s.x.s`,
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        const destitcher = co.wrap(function *(repos, maps) {
            const repo = repos.x;
            const revMap = maps.reverseCommitMap;
            const commitMap = maps.commitMap;
            const already = mapDestitched(revMap, c.already);
            const alreadyContent = {};
            Object.keys(already).forEach(sha => {
                alreadyContent[sha] = JSON.stringify(already[sha], null, 4);
            });

            // We're going to prime the remote refs based on `c.already` so we
            // can exercise this capability, but we'll remove them afterwards
            // so that we don't see a state change.

            yield BulkNotesUtil.writeNotes(repo,
                                           StitchUtil.referenceNoteRef,
                                           alreadyContent);
            yield DestitchUtil.destitch(repo,
                                        c.commitish,
                                        c.remote,
                                        c.ref || null);
            NodeGit.Reference.remove(repo, StitchUtil.referenceNoteRef);

            // At this point, the only stored ones are those newly created.
            const localNotesRef = DestitchUtil.localReferenceNoteRef;
            const localNotes =
                            yield BulkNotesUtil.readNotes(repo, localNotesRef);
            const notes = BulkNotesUtil.parseNotes(localNotes);
            const commits = {};
            for (let stitchedSha in notes) {
                const data = notes[stitchedSha];
                const stitchedId = commitMap[stitchedSha];
                const metaId = `d.${stitchedId}`;
                commits[data.metaRepoCommit] = metaId;
                for (let subName in data.subCommits) {
                    const newSubSha = data.subCommits[subName];
                    const id = `s.${stitchedId}.${subName}`;

                    // We have to anchor these commits with a branch.

                    yield NodeGit.Reference.create(repo,
                                                   `refs/heads/${id}`,
                                                   newSubSha,
                                                   1,
                                                   "testing");

                    commits[newSubSha] = id;
                }
            }
            return {
                commitMap: commits,
            };
        });
        it(caseName, co.wrap(function *() {
            yield RepoASTTestUtil.testMultiRepoManipulator(c.state,
                                                           c.expected,
                                                           destitcher,
                                                           c.fails, {
                includeRefsCommits : true,
                actualTransformer: refMapper,
            });
        }));
    });
});
});
