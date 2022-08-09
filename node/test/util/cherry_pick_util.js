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
const colors  = require("colors");
const fs      = require("fs-promise");
const NodeGit = require("nodegit");
const path    = require("path");


const Add             = require("../../lib/util/add");
const ConflictUtil    = require("../../lib/util/conflict_util");
const CherryPickUtil  = require("../../lib/util/cherry_pick_util");
const Open            = require("../../lib/util/open");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");
const ReadRepoASTUtil = require("../../lib/util/read_repo_ast_util");
const Submodule       = require("../../lib/util/submodule");
const SubmoduleChange = require("../../lib/util/submodule_change");
const UserError       = require("../../lib/util/user_error");


/**
 * Return a commit map as expected from  a manipulator for `RepoASTTestUtil`
 * from a result having the `newMetaCommit` and `submoduleCommits` properties
 * as returned by `rewriteCommit`.  We remap as follows:
 *
 * * new meta commit will be called "9" (we generally cherry-pick from "8")
 * * new submodule commits will be $old-logical-name + submoduleName, e.g.:
 *   "as" would be the name of a commit named "a" cherry-picked for submodule
 *   "s".
 *
 * @param {Object} maps
 * @param {Object} result
 * @return {Object}
 */
function mapCommits(maps, result) {
    const oldMap = maps.commitMap;

    let commitMap = {};
    if (null !== result.newMetaCommit) {
        // By convention, we name the cherry-pick generated meta-repo commit,
        // if it exists, "9".

        commitMap[result.newMetaCommit] = "9";
    }

    // For the submodules, we need to first figure out what the old
    // logical commit (the one from the shorthand) was, then create the
    // new logical commit id by appending the submodule name.  We map
    // the new (physical) commit id to this new logical id.

    Object.keys(result.submoduleCommits).forEach(name => {
        const subCommits = result.submoduleCommits[name];
        Object.keys(subCommits).forEach(newPhysicalId => {
            const oldId = subCommits[newPhysicalId];
            const oldLogicalId = oldMap[oldId];
            const newLogicalId = oldLogicalId + name;
            commitMap[newPhysicalId] = newLogicalId;
        });
    });
    return {
        commitMap: commitMap,
    };
}

describe("CherryPickUtil", function () {
const Conflict = ConflictUtil.Conflict;
const ConflictEntry = ConflictUtil.ConflictEntry;
const FILEMODE = NodeGit.TreeEntry.FILEMODE;

describe("changeSubmodules", function () {
    const cases = {
        "noop": {
            input: "x=S",
            submodules: {},
        },
        "simple": {
            input: "x=S",
            submodules: {
                "s": new Submodule("/a", "1"),
            },
            expected: "x=S:I s=S/a:1",
        },
        "update open": {
            input: "a=B|x=U:Os Ca-1!Ba=a",
            submodules: {
                "s": new Submodule("a", "a"),
            },
            expected: "x=E:I s=Sa:a;Os Ba=a",
        },
        "update open, need fetch": {
            input: "a=B:Ca-1;Ba=a|x=U:Os",
            submodules: {
                "s": new Submodule("a", "a"),
            },
            expected: "x=E:I s=Sa:a;Os H=a",
        },
        "simple and update open": {
            input: "a=B:Ca-1;Ba=a|x=U:Os",
            submodules: {
                "a": new Submodule("a", "1"),
                "s": new Submodule("a", "a"),
            },
            expected: "x=E:I a=Sa:1,s=Sa:a;Os H=a",
        },
        "nested": {
            input: "x=S",
            submodules: {
                "s/t/u": new Submodule("/a", "1"),
            },
            expected: "x=S:I s/t/u=S/a:1",
        },
        "multiple": {
            input: "x=S",
            submodules: {
                "s/t/u": new Submodule("/a", "1"),
                "z/t/u": new Submodule("/b", "1"),
            },
            expected: "x=S:I s/t/u=S/a:1,z/t/u=S/b:1",
        },
        "added": {
            input: "a=B|x=U",
            submodules: {
                "s": new Submodule("/a", "1"),
            },
            expected: "x=E:I s=S/a:1",
        },
        "removed": {
            input: "a=B|x=U",
            submodules: {
                "s": null,
            },
            expected: "x=E:I s",
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const adder = co.wrap(function *(repos, maps) {
                const repo = repos.x;
                const subs = {};
                Object.keys(c.submodules).forEach(name => {
                    const sub = c.submodules[name];
                    if (null !== sub) {
                        const sha = maps.reverseCommitMap[sub.sha];
                        const url = maps.reverseUrlMap[sub.url] || sub.url;
                        subs[name] = new Submodule(url, sha);
                    }
                    else {
                        subs[name] = null;
                    }
                });
                const opener = new Open.Opener(repo, null);
                const index = yield repo.index();
                yield CherryPickUtil.changeSubmodules(repo,
                                                      opener,
                                                      index,
                                                      subs);
                yield index.write();
            });
            yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                           c.expected,
                                                           adder,
                                                           c.fails);
        }));
    });
});

describe("containsUrlChanges", function () {
    const cases = {
        "no subs, no parent": {
            input: "S",
            expected: false,
        },
        "added a sub": {
            input: "S:C2-1 s=Sa:1;H=2",
            expected: false,
        },
        "removed a sub": {
            input: "S:C2-1 s=Sa:1;C3-2 s;H=3",
            expected: false,
        },
        "changed a sha": {
            input: "S:Ca-1;C2-1 s=Sa:1;C3-2 s=Sa:a;H=3;Ba=a",
            expected: false,
        },
        "changed a URL": {
            input: "S:C2-1 s=Sa:1;C3-2 s=Sb:1;H=3",
            expected: true,
        },
        "with ancestor": {
            input: "S:C2-1 s=Sa:1;C3-2 s=Sb:1;C4-3;H=4",
            expected: true,
            base: "2",
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const written = yield RepoASTTestUtil.createRepo(c.input);
            const repo = written.repo;
            const oldCommitMap = written.oldCommitMap;
            let base;
            if ("base" in c) {
                assert.property(oldCommitMap, c.base);
                base = yield repo.getCommit(oldCommitMap[c.base]);
            }
            const head = yield repo.getHeadCommit();
            const result =
                     yield CherryPickUtil.containsUrlChanges(repo, head, base);
            assert.equal(result, c.expected);
        }));
    });
});
describe("computeChangesFromIndex", function () {
    const Conflict      = ConflictUtil.Conflict;
    const ConflictEntry = ConflictUtil.ConflictEntry;
    const FILEMODE      = NodeGit.TreeEntry.FILEMODE;
    const cases = {
        "ffwd change": {
            input: "a=B:Ca-1;Ba=a|x=U:Ct-2 s=Sa:a;Bt=t",
            simpleChanges: {
                "s": new Submodule("a", "a"),
            },
        },
        "non-ffwd change": {
            input: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;Ct-2 s=Sa:b;Bt=t;Bmaster=3`,
            changes: {
                "s": new SubmoduleChange("1", "b", null),
            },
        },
        "addition": {
            input: "a=B|x=S:Ct-1 s=Sa:1;Bt=t",
            simpleChanges: {
                "s": new Submodule("a", "1"),
            },
        },
        "addition in ancestor": {
            input: "a=B|x=S:Ct-2 s=Sa:1;C2-1 t=Sa:1;Bt=t",
            simpleChanges: {
                "s": new Submodule("a", "1"),
            },
        },
        "double addition": {
            input: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=S:C2-1 s=Sa:a;Ct-1 s=Sa:b;Bmaster=2;Bt=t`,
            conflicts: {
                "s": new Conflict(null,
                                  new ConflictEntry(FILEMODE.COMMIT, "a"),
                                  new ConflictEntry(FILEMODE.COMMIT, "b")),
            },
        },
        "same double addition": {
            input: `
a=B:Ca-1;Ba=a|
x=S:C2-1 s=Sa:a;Ct-1 s=Sa:a;Bmaster=2;Bt=t`,
        },
        "deletion": {
            input: "a=B|x=U:Ct-2 s;Bt=t",
            simpleChanges: {
                "s": null,
            },
        },
        "double deletion": {
            input: "a=B|x=U:C3-2 s;Ct-2 s;Bt=t;Bmaster=3",
        },
        "change, but gone on HEAD": {
            input: "a=B:Ca-1;Ba=a|x=U:C3-2 s;Ct-2 s=Sa:a;Bt=t;Bmaster=3",
            conflicts: {
                "s": new Conflict(new ConflictEntry(FILEMODE.COMMIT, "1"),
                                  null,
                                  new ConflictEntry(FILEMODE.COMMIT, "a")),
            },
        },
        "change, but never on HEAD": {
            input: "a=B:Ca-1;Ba=a|x=U:Bmaster=1;Ct-2 s=Sa:a;Bt=t",
            conflicts: {
                "s": new Conflict(new ConflictEntry(FILEMODE.COMMIT, "1"),
                                  null,
                                  new ConflictEntry(FILEMODE.COMMIT, "a")),
            },
        },
        "deletion, but not a submodule any more": {
            input: "a=B|x=U:C3-2 s=foo;Ct-2 s;Bmaster=3;Bt=t",
            conflicts: {
                "s": new Conflict(new ConflictEntry(FILEMODE.COMMIT, "1"),
                                  new ConflictEntry(FILEMODE.BLOB, "foo"),
                                  null),
            },
            fails: true,
        },
        "deletion, but was changed on HEAD": {
            input: `
a=B:Ca-1;Ba=a|
x=U:C3-2 s=Sa:a;Ct-2 s;Bt=t;Bmaster=3`,
            conflicts: {
                "s": new Conflict(new ConflictEntry(FILEMODE.COMMIT, "1"),
                                  new ConflictEntry(FILEMODE.COMMIT, "a"),
                                  null),
            },
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const w = yield RepoASTTestUtil.createMultiRepos(c.input);
            const repos = w.repos;
            const repo = repos.x;
            const commitMap = w.commitMap;
            const reverseCommitMap = w.reverseCommitMap;
            const urlMap = w.urlMap;
            const head = yield repo.getHeadCommit();
            const target = yield repo.getCommit(reverseCommitMap.t);
            const index =
                    yield NodeGit.Cherrypick.commit(repo, target, head, 0, []);
            let result;
            let exception;
            try {
                result = yield CherryPickUtil.computeChanges(repo,
                                                             index,
                                                             target);
            } catch (e) {
                exception = e;
            }
            if (undefined !== exception) {
                if (!c.fails || !(exception instanceof UserError)) {
                    throw exception;
                }
                return;                                               // RETURN
            }
            assert.equal(c.fails || false, false);
            const changes = {};
            for (let name in result.changes) {
                const change = result.changes[name];
                changes[name] = new SubmoduleChange(commitMap[change.oldSha],
                                                    commitMap[change.newSha],
                                                    null);
            }
            assert.deepEqual(changes, c.changes || {});

            const simpleChanges = {};
            for (let name in result.simpleChanges) {
                const change = result.simpleChanges[name];
                let mapped = null;
                if (null !== change) {
                    mapped = new Submodule(urlMap[change.url],
                                           commitMap[change.sha]);
                }
                simpleChanges[name] = mapped;
            }

            const mapConflict = co.wrap(function *(entry) {
                if (null === entry) {
                    return entry;
                }
                if (FILEMODE.COMMIT === entry.mode) {
                    return new ConflictEntry(entry.mode,
                                             commitMap[entry.id]);
                }
                const data =
                          yield repo.getBlob(NodeGit.Oid.fromString(entry.id));
                return new ConflictEntry(entry.mode, data.toString());
            });
            assert.deepEqual(simpleChanges, c.simpleChanges || {}, "simple");

            const conflicts = {};
            for (let name in result.conflicts) {
                const conflict = result.conflicts[name];
                const ancestor = yield mapConflict(conflict.ancestor);
                const our = yield mapConflict(conflict.our);
                const their = yield mapConflict(conflict.their);
                conflicts[name] = new Conflict(ancestor, our, their);
            }
            assert.deepEqual(conflicts, c.conflicts || {});
        }));
    });
    it("works around a libgit2 bug", co.wrap(function*() {
        const w = yield RepoASTTestUtil.createMultiRepos(`
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=S:C2-1 s=Sa:1;C3-2 s=Sa:a;Ct-2 s=Sa:b;Bmaster=3;Bt=t`
        );
        const repos = w.repos;
        const repo = repos.x;
        const reverseCommitMap = w.reverseCommitMap;
        const head = yield repo.getHeadCommit();
        const target = yield repo.getCommit(reverseCommitMap.t);
        const index =
              yield NodeGit.Cherrypick.commit(repo, target, head, 0, []);
        yield index.remove("s", 1);
        const result = yield CherryPickUtil.computeChanges(repo,
                                                           index,
                                                           target);

        const change = result.changes.s;
        const expect = new SubmoduleChange(reverseCommitMap["1"],
                                           reverseCommitMap.b,
                                           reverseCommitMap.a);
        assert.deepEqual(expect, change);
    }));
});

describe("pickSubs", function () {
    // Most of the logic is done via `RebaseUtil.rewriteCommits`.  We need to
    // validate that we invoke that method correctly and that we fetch commits
    // as needed.

    const cases = {
        "no subs": {
            state: "x=S",
            subs: {},
        },
        "pick a sub": {
            state: `a=B:Ca-1;Cb-1;Ba=a;Bb=b|x=U:C3-2 s=Sa:a;H=3`,
            subs: {
                "s": new SubmoduleChange("1", "b", null),
            },
            expected: `x=E:Os Cbs-a b=b!H=bs;I s=Sa:bs`,
        },
        "pick two": {
            state: `
a=B:Ca-1;Caa-1;Cb-1;Cc-b;Ba=a;Bb=b;Bc=c;Baa=aa|
x=U:C3-2 s=Sa:a,t/u=Sa:a;H=3
`,
            subs: {
                "s": new SubmoduleChange("1", "aa", null),
                "t/u": new SubmoduleChange("1", "c", null),
            },
            expected: `
x=E:Os Caas-a aa=aa!H=aas;Ot/u Cct/u-bt/u c=c!Cbt/u-a b=b!H=ct/u;
  I s=Sa:aas,t/u=Sa:ct/u`,
        },
        "a conflict": {
            state: `a=B:Ca-1;Cb-1 a=foo;Ba=a;Bb=b|x=U:C3-2 s=Sa:a;H=3`,
            subs: {
                "s": new SubmoduleChange("1", "b", null),
            },
            conflicts: {
                "s": "b",
            },
            expected: `x=E:Os I *a=~*a*foo!Edetached HEAD,b,a!W a=\
<<<<<<< HEAD
a
=======
foo
>>>>>>> message
;`,
        },
        "commit and a conflict": {
            state: `
a=B:Ca-1;Cb-1;Cc-b a=foo;Ba=a;Bb=b;Bc=c|
x=U:C3-2 s=Sa:a;H=3`,
            subs: {
                "s": new SubmoduleChange("1", "c", null),
            },
            conflicts: {
                "s": "c",
            },
            expected: `
x=E:I s=Sa:bs;Os Cbs-a b=b!H=bs!I *a=~*a*foo!Edetached HEAD,c,a!W a=\
<<<<<<< HEAD
a
=======
foo
>>>>>>> message
;`,
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        const picker = co.wrap(function *(repos, maps) {
            const repo = repos.x;
            const index = yield repo.index();
            const commitMap = maps.commitMap;
            const reverseMap = maps.reverseCommitMap;
            const subs = {};
            Object.keys(c.subs).forEach(name => {
                const change = c.subs[name];
                subs[name] = new SubmoduleChange(reverseMap[change.oldSha],
                                                 reverseMap[change.newSha],
                                                 null);
            });
            const opener = new Open.Opener(repo, null);
            const result = yield CherryPickUtil.pickSubs(repo,
                                                         opener,
                                                         index,
                                                         subs);
            yield index.write();
            const conflicts = {};
            Object.keys(result.conflicts).forEach(name => {
                const sha = result.conflicts[name];
                conflicts[name] = commitMap[sha];
            });
            assert.deepEqual(conflicts, c.conflicts || {}, "conflicts");
            const mappedCommits = {};
            Object.keys(result.commits).forEach(name => {
                const subCommits = result.commits[name];
                Object.keys(subCommits).forEach(newSha => {
                    const oldSha = subCommits[newSha];
                    const oldLogicalSha = commitMap[oldSha];
                    const newLogicalSha = oldLogicalSha + name;
                    mappedCommits[newSha] = newLogicalSha;
                });
            });
            return {
                commitMap: mappedCommits,
            };
        });

        it(caseName, co.wrap(function *() {
            yield RepoASTTestUtil.testMultiRepoManipulator(c.state,
                                                           c.expected,
                                                           picker,
                                                           c.fails);
        }));
    });
});
describe("writeConflicts", function () {
    const cases = {
        "trivial": {
            state: "x=S",
            conflicts: {},
            result: "",
        },
        "with a conflict": {
            state: "x=S",
            conflicts: {
                "README.md": new Conflict(null,
                                          null,
                                          new ConflictEntry(FILEMODE.COMMIT,
                                                            "1")),
            },
            expected: "x=E:I *README.md=~*~*S:1;W README.md=hello world",
            result: `\
Conflicting entries for submodule ${colors.red("README.md")}
`,
        },
        "two conflicts": {
            state: "x=S",
            conflicts: {
                z: new Conflict(null,
                                null,
                                new ConflictEntry(FILEMODE.COMMIT, "1")),
                a: new Conflict(null,
                                null,
                                new ConflictEntry(FILEMODE.COMMIT, "1")),
            },
            expected: "x=E:I *z=~*~*S:1,*a=~*~*S:1",
            result: `\
Conflicting entries for submodule ${colors.red("a")}
Conflicting entries for submodule ${colors.red("z")}
`,
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const writer = co.wrap(function *(repos, maps) {
                const repo = repos.x;
                const index = yield repo.index();
                const conflicts = {};
                function mapEntry(entry) {
                    if (null === entry || FILEMODE.COMMIT !== entry.mode) {
                        return entry;
                    }
                    return new ConflictEntry(entry.mode,
                                             maps.reverseCommitMap[entry.id]);
                }
                for (let name in c.conflicts) {
                    const con = c.conflicts[name];
                    conflicts[name] = new Conflict(mapEntry(con.ancestor),
                                                   mapEntry(con.our),
                                                   mapEntry(con.their));
                }
                const result =
                   yield CherryPickUtil.writeConflicts(repo, index, conflicts);
                yield index.write();
                assert.equal(result, c.result);
            });
            yield RepoASTTestUtil.testMultiRepoManipulator(c.state,
                                                           c.expected,
                                                           writer,
                                                           c.fails);
        }));
    });
});
describe("rewriteCommit", function () {
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
    //
    // Cases to check:
    // * add when already exists
    // * delete when already delete
    // * change when deleted
    // * conflicts

    const cases = {
        "picking one sub": {
            input: `
a=Ax:Cz-y;Cy-x;Bfoo=z|
x=S:C8-3 s=Sa:z;C3-2 s=Sa:y;C2-1 s=Sa:x;Bfoo=8;Bmaster=2;Os H=x`,
            expected: "x=E:C9-2 s=Sa:zs;Bmaster=9;Os Czs-x z=z!H=zs",
        },
        "nothing to commit": {
            input: "a=B|x=S:C2-1;C8-1 ;Bmaster=2;B8=8",
        },
        "URL change will fail": {
            input: `
a=Ax:Cz-y;Cy-x;Bfoo=z|b=B|
x=S:C8-3 s=Sb:z;C3-2 s=Sa:y;C2-1 s=Sa:x;Bfoo=8;Bmaster=2`,
            fails: true,
        },
        "meta change will fail": {
            input: `
a=Ax:Cz-y;Cy-x;Bfoo=z|
x=S:C8-3 s=Sa:z,README.md=9;C3-2 s=Sa:y;C2-1 s=Sa:x;Bfoo=8;Bmaster=2`,
            fails: true,
        },
        "picking one ffwd sub": {
            input: `
a=Ax:Cz-x;Bfoo=z|
x=S:C8-2 s=Sa:z;C3-2;C2-1 s=Sa:x;Bfoo=8;Bmaster=3;Os H=x`,
            expected: "x=E:C9-3 s=Sa:z;Bmaster=9;Os",
        },
        "picking one non-trivial ffwd sub": {
            input: `
a=Ax:Cz-y;Cy-x;Bfoo=z|
x=S:C8-2 s=Sa:z;C3-2 s=Sa:y;C2-1 s=Sa:x;Bfoo=8;Bmaster=3;Os`,
            expected: "x=E:C9-3 s=Sa:z;Bmaster=9;Os H=z",
        },
        "picking one non-trivial ffwd sub, closes": {
            input: `
a=Ax:Cz-y;Cy-x;Bfoo=z|
x=S:C8-2 s=Sa:z;C3-2 s=Sa:y;C2-1 s=Sa:x;Bfoo=8;Bmaster=3`,
            expected: "x=E:C9-3 s=Sa:z;Bmaster=9",
        },
        "picking one sub introducing two commits": {
            input: `
a=Aw:Cz-y;Cy-x;Cx-w;Bfoo=z|
x=S:C8-3 s=Sa:z;C3-2 s=Sa:x;C2-1 s=Sa:w;Bfoo=8;Bmaster=2;Os H=w`,
            expected: `
x=E:C9-2 s=Sa:zs;Bmaster=9;Os Czs-ys z=z!Cys-w y=y!H=zs`,
        },
        "picking closed sub": {
            input: `
a=Ax:Cz-y;Cy-x;Bfoo=z|
x=S:C8-3 s=Sa:z;C3-2 s=Sa:y;C2-1 s=Sa:x;Bfoo=8;Bmaster=2`,
            expected: "x=E:C9-2 s=Sa:zs;Bmaster=9;Os Czs-x z=z!H=zs",
        },
        "picking closed sub with change": {
            input: "\
a=Ax:Cw-x;Cz-x;Cy-x;Bfoo=z;Bbar=y;Bbaz=w|\
x=S:C4-2 s=Sa:w;C8-3 s=Sa:z;C3-2;C2-1 s=Sa:y;Bfoo=8;Bmaster=4",
            expected: "x=E:C9-4 s=Sa:zs;Bmaster=9;Os Czs-w z=z!H=zs",
        },
        "picking two closed subs": {
            input: `
a=Ax:Cz-y;Cy-x;Bfoo=z|
b=Aa:Cc-b;Cb-a;Bfoo=c|
x=S:C8-3 s=Sa:z,t=Sb:c;C3-2 s=Sa:y,t=Sb:b;C2-1 s=Sa:x,t=Sb:a;
Bfoo=8;Bmaster=2`,
            expected: `
x=E:C9-2 s=Sa:zs,t=Sb:ct;
Bmaster=9;
Os Czs-x z=z!H=zs;
Ot Cct-a c=c!H=ct`,
        },
        "new sub on head": {
            input: `
a=B|
x=U:C8-2 r=Sa:1;C4-2 t=Sa:1;Bmaster=4;Bfoo=8`,
            expected: "x=E:C9-4 r=Sa:1;Bmaster=9",
        },
        "don't pick subs from older commit": {
            input: `
a=B:Cr-1;Cq-r;Bq=q|
x=S:C2-1 s=Sa:1,t=Sa:1;C3-2 s=Sa:q,t=Sa:r;C8-3 t=Sa:q;Bmaster=2;Bfoo=8`,
            expected: `
x=E:C9-2 t=Sa:qt;Bmaster=9;Ot Cqt-1 q=q!H=qt`,
        },
        "remove a sub": {
            input: "a=B|x=U:C3-2;Bmaster=3;C8-2 s;Bfoo=8",
            expected: "a=B|x=E:C9-3 s;Bmaster=9",
        },
        "conflict in a sub pick": {
            input: `
a=B:Ca-1;Cb-1 a=8;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;C8-2 s=Sa:b;Bmaster=3;Bfoo=8`,
            expected: `
x=E:Os Edetached HEAD,b,a!I *a=~*a*8!W a=\
<<<<<<< HEAD
a
=======
8
>>>>>>> message
;
`,
            errorMessage: `\
Submodule ${colors.red("s")} is conflicted.
        A testCommand is in progress.
        (after resolving conflicts mark the corrected paths
        with 'git meta add', then run "git meta testCommand --continue")
        (use "git meta testCommand --abort" to check out the original branch)`,
        },
        "conflict in a sub pick, success in another": {
            input: `
a=B:Ca-1;Cb-1 a=8;Cc-1;Ba=a;Bb=b;Bc=c|
x=S:C2-1 s=Sa:1,t=Sa:1;C3-2 s=Sa:a,t=Sa:a;C8-2 s=Sa:b,t=Sa:c;Bmaster=3;Bfoo=8`,
            expected: `
x=E:I t=Sa:ct;Ot Cct-a c=c!H=ct;
Os Edetached HEAD,b,a!I *a=~*a*8!W a=\
<<<<<<< HEAD
a
=======
8
>>>>>>> message
;
`,
            errorMessage: `\
Submodule ${colors.red("s")} is conflicted.
        A testCommand is in progress.
        (after resolving conflicts mark the corrected paths
        with 'git meta add', then run "git meta testCommand --continue")
        (use "git meta testCommand --abort" to check out the original branch)`,
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        const picker = co.wrap(function *(repos, maps) {
            const x = repos.x;
            const reverseCommitMap = maps.reverseCommitMap;
            assert.property(reverseCommitMap, "8");
            const eightCommitSha = reverseCommitMap["8"];
            const eightCommit = yield x.getCommit(eightCommitSha);
            const result  = yield CherryPickUtil.rewriteCommit(x, eightCommit,
                "testCommand");
            assert.equal(result.errorMessage, c.errorMessage || null);
            return mapCommits(maps, result);
        });

        it(caseName, co.wrap(function *() {
            yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                           c.expected,
                                                           picker,
                                                           c.fails);
        }));
    });
});
describe("cherryPick", function () {
    // Most of the work of cherry-pick is done by `rewriteCommit` and other
    // methods.  We just need to validate here that we're ensuring the contract
    // that we're in a good state, that we properly record and cleanup the
    // sequencer.

    const cases = {
        "picking one sub": {
            input: `
a=Ax:Cz-y;Cy-x;Bfoo=z|
x=S:C8-3 s=Sa:z;C3-2 s=Sa:y;C2-1 s=Sa:x;Bfoo=8;Bmaster=2;Os H=x`,
            expected: "x=E:C9-2 s=Sa:zs;Bmaster=9;Os Czs-x z=z!H=zs",
        },
        "skip duplicated cherry picks": {
            input: `
a=Ax:Cz-y;Cy-x;Bfoo=z|
x=S:C8-3 s=Sa:z;C3-2 s=Sa:y;C2-1 s=Sa:x;Bfoo=8;Bmaster=2;Os H=x`,
            expected: "x=E:C9-2 s=Sa:zs;Bmaster=9;Os Czs-x z=z!H=zs",
            duplicate: true,
        },
        "nothing to commit": {
            input: "a=B|x=S:C2-1;C8-1 ;Bmaster=2;B8=8",
        },
        "in-progress will fail": {
            input: `
a=Ax:Cz-y;Cy-x;Bfoo=z|
x=S:QC 2: 1: 0 2;C8-3 s=Sa:z;C3-2 s=Sa:y;C2-1 s=Sa:x;Bfoo=8;Bmaster=2`,
            fails: true,
        },
        "dirty will fail": {
            input: `
a=Ax:Cz-y;Cy-x;Bfoo=z|
x=S:C8-3 s=Sa:z;C3-2 s=Sa:y;C2-1 s=Sa:x;Bfoo=8;Bmaster=2;Os W x=9`,
            fails: true,
        },
        "conflict in a sub pick": {
            input: `
a=B:Ca-1;Cb-1 a=8;Ba=a;Bb=b|
x=U:C3-2 s=Sa:a;C8-2 s=Sa:b;Bmaster=3;Bfoo=8`,
            expected: `
x=E:QC 3: 8: 0 8;Os Edetached HEAD,b,a!I *a=~*a*8!W a=\
<<<<<<< HEAD
a
=======
8
>>>>>>> message
;
`,
            errorMessage: `\
Submodule ${colors.red("s")} is conflicted.
        A cherry-pick is in progress.
        (after resolving conflicts mark the corrected paths
        with 'git meta add', then run "git meta cherry-pick --continue")
        (use "git meta cherry-pick --abort" to check out the original branch)`,
        },
    };

    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        const picker = co.wrap(function *(repos, maps) {
            const x = repos.x;
            const reverseCommitMap = maps.reverseCommitMap;
            assert.property(reverseCommitMap, "8");
            const eightCommitSha = reverseCommitMap["8"];
            const eightCommit = yield x.getCommit(eightCommitSha);
            const result  = yield CherryPickUtil.cherryPick(x, [eightCommit]);

            if (c.duplicate) {
                const res = yield CherryPickUtil.cherryPick(x, [eightCommit]);
                assert.isNull(res.newMetaCommit);
            }
            assert.equal(result.errorMessage, c.errorMessage || null);

            return mapCommits(maps, result);
        });
        it(caseName, co.wrap(function *() {
            yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                           c.expected,
                                                           picker,
                                                           c.fails);
        }));
    });
});
describe("continue", function () {
    const cases = {
        "no cherry-pick": {
            input: "a=B|x=U:Os I foo=bar;Cfoo#g;Bg=g",
            fails: true,
        },
        "conflicted": {
            input: "a=B|x=U:Os I foo=bar,*x=a*b*c;Cfoo#g;Bg=g;QC 2: g: 0 g",
            fails: true,
        },
        "continue with a staged submodule commit": {
            input: "a=B:Ca-1;Ba=a|x=U:I s=Sa:a;Cmoo#g;Bg=g;QC 2: g: 0 g",
            expected: "x=E:Cmoo#CP-2 s=Sa:a;Bmaster=CP;Q;I s=~",
        },
        "regular continue": {
            input: `
a=B:Ca-1;Cb-1;Ba=a;Bb=b|
x=U:C3-2 s=Sa:b;Cfoo#g-2;Bg=g;QC 1: g: 0 g;Bmaster=3;Os EHEAD,b,a!I b=b`,
            expected: `
x=E:Q;Cfoo#CP-3 s=Sa:bs;Bmaster=CP;Os Cbs-a b=b!E`,
        },
        "nothing to do": {
            input: "a=B|x=U:Os;Cfoo#g;Bg=g;QC 2: g: 0 g",
            expected: "x=E:Q",
        },
        "continue with staged files": {
            input: "a=B|x=U:Os I foo=bar;Cfoo#g;Bg=g;QC 2: g: 0 g",
            expected: `
x=E:Cfoo#CP-2 s=Sa:Ns;Bmaster=CP;Os Cfoo#Ns-1 foo=bar;Q`,
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const continuer = co.wrap(function *(repos, maps) {
                const repo = repos.x;
                const result = yield CherryPickUtil.continue(repo);
                const commitMap = {};
                RepoASTTestUtil.mapSubCommits(commitMap,
                                              result.submoduleCommits,
                                              maps.commitMap);
                Object.keys(result.newSubmoduleCommits).forEach(name => {
                    const sha = result.newSubmoduleCommits[name];
                    commitMap[sha] = `N${name}`;
                });
                if (null !== result.newMetaCommit) {
                    commitMap[result.newMetaCommit] = "CP";
                }
                assert.equal(result.errorMessage, c.errorMessage || null);
                return {
                    commitMap: commitMap,
                };
            });
            yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                           c.expected,
                                                           continuer,
                                                           c.fails);
        }));
    });

    it("handles multiple commits", co.wrap(function*() {
        const start = `a=B:C2-1 a=a1;
                           C3-2 a=a3;
                           C4-3 a=a4;
                           C5-3 a=a5;
                           C6-3 a=a6;
                           Bb3=3;Bb4=4;Bb5=5;Bb6=6|
              x=S:Cm2-1 s=Sa:2;
                  Cm3-m2 s=Sa:3;
                  Cm4-m2 s=Sa:4;
                  Cm5-m2 s=Sa:5;
                  Cm6-m2 s=Sa:6;
                  Bmaster=m3;Bm4=m4;Bm5=m5;Bm6=m6;Os`;
        const repoMap = yield RepoASTTestUtil.createMultiRepos(start);
        const repo = repoMap.repos.x;
        const commits = [
            (yield repo.getCommit(repoMap.reverseCommitMap.m4)),
            (yield repo.getCommit(repoMap.reverseCommitMap.m5)),
            (yield repo.getCommit(repoMap.reverseCommitMap.m6)),
        ];
        const result = yield CherryPickUtil.cherryPick(repo, commits);
        // I expect, here, that commit m4 has successfully applied, and
        // then m5 has hit a conflict...
        assert.equal("m5", repoMap.commitMap[result.pickingCommit.id()]);
        assert.isNull(result.newMetaCommit);
        let rast = yield ReadRepoASTUtil.readRAST(repo, false);
        const remainingCommits = [
            commits[0].id().tostrS(),
            commits[1].id().tostrS(),
            commits[2].id().tostrS()
        ];

        assert.deepEqual(remainingCommits, rast.sequencerState.commits);
        assert.equal(1, rast.sequencerState.currentCommit);

        //now, let's resolve & continue
        yield fs.writeFile(path.join(repo.workdir(), "s", "a"), "resolv");
        yield Add.stagePaths(repo, ["s/a"], true, false);
        const contResult = yield CherryPickUtil.continue(repo);

        assert.equal("m6", repoMap.commitMap[contResult.pickingCommit.id()]);
        assert.isNull(contResult.newMetaCommit);

        rast = yield ReadRepoASTUtil.readRAST(repo, false);
        assert.deepEqual(remainingCommits, rast.sequencerState.commits);
        assert.equal(2, rast.sequencerState.currentCommit);

        //finally, we'll do it again, which should finish this up
        yield fs.writeFile(path.join(repo.workdir(), "s", "a"), "resolv2");
        try {
            yield CherryPickUtil.continue(repo);
            assert.equal(1, 2); //fail
        } catch (e) {
            //can't continue until we resolve
        }
        yield Add.stagePaths(repo, ["s/a"], true, false);
        const contResult2 = yield CherryPickUtil.continue(repo);
        assert.isNull(contResult2.errorMessage);
        rast = yield ReadRepoASTUtil.readRAST(repo, false);
        assert.isNull(rast.sequencerState);
    }));
});

describe("abort", function () {
    const cases = {
        "no cherry": {
            input: "x=S",
            fails: true,
        },
        "some changes in meta": {
            input: "x=S:C2-1 s=S/a:1;Bmaster=2;QC 1: 2: 0 2",
            expected: "x=S",
        },
        "some conflicted changes in meta": {
            input: `
x=S:C2-1 s=S/a:1;Bmaster=2;QC 1: 2: 0 2;I *s=~*~*s=S:1`,
            expected: "x=S",
        },

        "sub with a conflict": {
            input: `
a=B:Ca-1;Cb-1 a=8;Ba=a;Bb=b|
x=U:QC 3: 8: 0 8;C3-2 s=Sa:a;C8-2 s=Sa:b;Bmaster=3;Bfoo=8;
  Os Ba=a!Bb=b!Edetached HEAD,b,a!I *a=~*a*8!W a=\
<<<<<<< HEAD
a
=======
8
>>>>>>> message
;
`,
            expected: `x=E:Q;Os E!I a=~!W a=~!Ba=a!Bb=b`,
        }
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const aborter = co.wrap(function *(repos) {
                const repo = repos.x;
                yield CherryPickUtil.abort(repo);
            });
            yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                           c.expected,
                                                           aborter,
                                                           c.fails);
        }));
    });
});
});

describe("resolveUrlConflicts", function() {
    const cases = {
        "choose our urls": {
            ancestors: { a: "a", b: "b", c: "c" },
            ours: { a: "../a", c: "c", d: "d" },
            theirs: { a: "a", b: "b", c: "c" },
            expected: { a: "../a", c: "c", d: "d" },
            numConflict: 0
        },
        "choose their urls": {
            ancestors: { a: "a", b: "b", c: "c" },
            theirs: { a: "../a", c: "c", d: "d" },
            ours: { a: "a", b: "b", c: "c" },
            expected: { a: "../a", c: "c", d: "d" },
            numConflict: 0
        },
        "choose new and consensus": {
            ancestors: { a: "a", b: "b", c: "c" },
            ours: { a: "../a", c: "c", d: "d" },
            theirs: { a: "../a", c: "c", d: "d" },
            expected: { a: "../a", c: "c", d: "d" },
            numConflict: 0
        },
        conflict: {
            ancestors: { a: "a" },
            ours: { a: "x" },
            theirs: { a: "y" },
            expected: {},
            numConflict: 1
        }
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(
            caseName,
            function() {
                const result = CherryPickUtil.resolveUrlsConflicts(
                    c.ancestors,
                    c.ours,
                    c.theirs
                );
                assert.equal(
                    Object.keys(result.conflicts).length,
                    c.numConflict
                );
                assert.deepEqual(result.urls, c.expected);
            }
        );
    });
});
