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
const NodeGit = require("nodegit");

const GitUtil         = require("../../lib/util/git_util");
const StashUtil       = require("../../lib/util/stash_util");
const StatusUtil      = require("../../lib/util/status_util");
const SubmoduleUtil   = require("../../lib/util/submodule_util");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");

const writeLog = co.wrap(function *(repo, reverseMap, logs) {
    const log = yield NodeGit.Reflog.read(repo, "refs/meta-stash");
    const sig = yield repo.defaultSignature();
    for(let i = 0; i < logs.length; ++i) {
        const logSha = logs[logs.length - (i + 1)];
        const sha = reverseMap[logSha];
        log.append(NodeGit.Oid.fromString(sha), sig, `log of ${logSha}`);
    }
    yield log.write();
});

/**
 * Replace all the submodule stash refs in the form of `sub-stash/ss` with
 * `sub-stash/${physical id}`, where  'physical id' refers to the id of the
 * submodule stash.
 */
function refMapper(expected, mapping) {
    const refRE  = /(sub-stash\/)(ss)/;
    const reverseCommitMap = mapping.reverseCommitMap;

    let result = {};
    Object.keys(expected).forEach(repoName => {
        const ast = expected[repoName];
        const submodules = ast.openSubmodules;
        const newSubs = {};
        Object.keys(submodules).forEach(subName => {
            const sub = submodules[subName];
            const refs = sub.refs;
            const newRefs = {};
            Object.keys(refs).forEach(refName => {
                const logicalId = refs[refName];
                const physicalId = reverseCommitMap.ss;
                const newRefName = refName.replace(refRE, `$1${physicalId}`);
                newRefs[newRefName] = logicalId;
            });
            newSubs[subName] = sub.copy({
                refs: newRefs,
            });
        });
        result[repoName] = ast.copy({
            openSubmodules: newSubs,
        });
    });
    return result;
}

describe("StashUtil", function () {
    describe("makeLogMessage", function () {
        const cases = {
            "simple": {
                input: "S",
                expectedPre: "WIP on master: ",
                expectedPost: " the first commit",
            },
            "detached": {
                input: "S:H=1",
                expectedPre: "WIP on (no branch): ",
                expectedPost: " the first commit",
            },
            "multiline comit": {
                input: "S:Chello\nworld\n#2-1;Bmaster=2",
                expectedPre: "WIP on master: ",
                expectedPost: " hello",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const written = yield RepoASTTestUtil.createRepo(c.input);
                const repo = written.repo;
                const result = yield StashUtil.makeLogMessage(repo);
                const head = yield repo.getHeadCommit();
                const expected = c.expectedPre +
                    GitUtil.shortSha(head.id().tostrS()) +
                    c.expectedPost;
                assert.equal(result, expected);
            }));
        });
    });
    describe("stashRepo", function () {
        // We'll make a new branch, `i`, pointing to the logical commit `i`,
        // with message "i" containing the state of the index and a branch
        // named `w` pointing to the commit `w`, with the message "w"
        // contianing the state of the workdir.
        const cases = {
            "trivial": {
                input: "x=N:C1;Bmaster=1;*=master",
                expected: "x=E:Ci#i 1=1;Cw#w 1=1;Bi=i;Bw=w",
            },
            "loose file": {
                input: "x=N:C1;Bmaster=1;*=master;W foo=bar",
                expected: "x=E:Ci#i 1=1;Cw#w 1=1;Bi=i;Bw=w",
            },
            "index change": {
                input: "x=N:C1;Bmaster=1;*=master;I foo=bar",
                expected: `
x=E:Ci#i foo=bar,1=1;Cw#w foo=bar,1=1;Bi=i;Bw=w`,
            },
            "workdir change": {
                input: "x=N:C1;Bmaster=1;*=master;W 1=8",
                expected: `x=E:Ci#i 1=1;Cw#w 1=8;Bi=i;Bw=w`,
            },
            "workdir addition": {
                input: "x=N:C1;Bmaster=1;*=master;W foo=bar",
                expected: "x=E:Ci#i 1=1;Cw#w 1=1,foo=bar;Bi=i;Bw=w",
                includeUntracked: true,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const stasher = co.wrap(function *(repos) {
                    const repo = repos.x;
                    const status = yield StatusUtil.getRepoStatus(repo, {
                        showMetaChanges: true,
                    });
                    const includeUntracked = c.includeUntracked || false;
                    const result = yield StashUtil.stashRepo(repo,
                                                             status,
                                                             includeUntracked);
                    const sig = yield repo.defaultSignature();
                    const commitMap = {};
                    const commitAndBranch = co.wrap(function *(treeId, type) {
                        const tree = yield NodeGit.Tree.lookup(repo, treeId);
                        const commitId = yield NodeGit.Commit.create(repo,
                                                                     null,
                                                                     sig,
                                                                     sig,
                                                                     null,
                                                                     type,
                                                                     tree,
                                                                     0,
                                                                     []);
                        const commit = yield repo.getCommit(commitId);
                        yield NodeGit.Branch.create(repo, type, commit, 1);
                        commitMap[commitId.tostrS()] = type;
                    });
                    yield commitAndBranch(result.index, "i");
                    yield commitAndBranch(result.workdir, "w");
                    return {
                        commitMap: commitMap,
                    };
                });
                yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                               c.expected,
                                                               stasher,
                                                               c.fails);
            }));
        });
    });
    describe("save", function () {
        // We create stash commits based on the following scheme:
        // - s -- the stash commit
        // - sN -- stash commit for submodule N
        // - siN -- stash index commit for submodule N
        // - suN -- stash for untracked files for submodule N

        const cases = {
            "trivial": {
                state: "x=N:C1;Bmaster=1;*=master",
                expected: `x=E:Cstash#s-1 ;Fmeta-stash=s`,
            },
            "minimal": {
                state: "x=S:C2-1 README.md;Bmaster=2",
                expected: `x=E:Cstash#s-2, ;Fmeta-stash=s`,
            },
            "with message": {
                state: "x=S:C2-1 README.md;Bmaster=2",
                expected: `x=E:Cstash#s-2, ;Fmeta-stash=s`,
                message: "hello world",
                expectedMessage: "hello world",
            },
            "closed sub": {
                state: "a=B|x=S:C2-1 README.md,s=Sa:1;Bmaster=2",
                expected: `x=E:Cstash#s-2, ;Fmeta-stash=s`,
            },
            "open sub": {
                state: "a=B|x=S:C2-1 README.md,s=Sa:1;Bmaster=2;Os",
                expected: `x=E:Cstash#s-2 ;Fmeta-stash=s`,
            },
            "open sub on updated commit, unstaged": {
                state: `a=B:Css-1;Bss=ss|
                        x=S:C2-1 README.md,s=Sa:1;Bmaster=2;Os H=ss`,
                expected: `x=E:Cstash#s-2 s=Sa:ss;Fmeta-stash=s;
                           Os Fsub-stash/ss=ss!H=1`,
            },
            "open sub with an added file": {
                state: "a=B|x=S:C2-1 README.md,s=Sa:1;Bmaster=2;Os W foo=bar",
                expected: `x=E:Cstash#s-2 ;Fmeta-stash=s`,
            },
            "open sub with index change": {
                state: "a=B|x=S:C2-1 README.md,s=Sa:1;Bmaster=2;Os I foo=bar",
                expected: `
x=E:Fmeta-stash=s;
    Os Fsub-stash/ss=ss!
       Fstash=ss!
       C*#ss-1,sis foo=bar!
       C*#sis-1 foo=bar;
    Cstash#s-2 s=Sa:ss`,
            },
            "open sub with index and workdir change same file": {
                state: `
a=B|x=S:C2-1 README.md,s=Sa:1;Bmaster=2;Os I README.md=foo!W README.md=bar`,
                expected: `
x=E:Fmeta-stash=s;
    Os Fsub-stash/ss=ss!
       Fstash=ss!
       C*#ss-1,sis README.md=bar!
       C*#sis-1 README.md=foo;
    Cstash#s-2 s=Sa:ss`,
            },
            "open sub with workdir change": {
                state: `
a=B|
x=S:C2-1 README.md,s=Sa:1;Bmaster=2;Os W README.md=meh`,
                expected: `
x=E:Fmeta-stash=s;
    Os Fsub-stash/ss=ss!
       Fstash=ss!
       C*#ss-1,sis README.md=meh!
       C*#sis-1 ;
    Cstash#s-2 s=Sa:ss`,
            },
            "open sub with index and workdir change": {
                state: `
a=B|
x=S:C2-1 README.md,s=Sa:1;Bmaster=2;Os W README.md=meh!I foo=bar`,
                expected: `
x=E:Fmeta-stash=s;
    Os Fsub-stash/ss=ss!
       Fstash=ss!
       C*#ss-1,sis README.md=meh,foo=bar!
       C*#sis-1 foo=bar;
    Cstash#s-2 s=Sa:ss`,
            },
            "open sub with an added file and includeUntracked": {
                state: "a=B|x=S:C2-1 README.md,s=Sa:1;Bmaster=2;Os W foo=bar",
                includeUntracked: true,
                expected: `
x=E:Fmeta-stash=s;
    Os Fsub-stash/ss=ss!
       Fstash=ss!
       C*#ss-1,sis,sus !
       C*#sis-1 !
       C*#sus foo=bar;
    Cstash#s-2 s=Sa:ss`,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            const includeUntracked = c.includeUntracked || false;
            const stasher = co.wrap(function *(repos, mapping) {
                const repo = repos.x;
                const stashMessage = c.message || null;
                let expMessage = c.expectedMessage;
                if (undefined === expMessage) {
                    expMessage = yield StashUtil.makeLogMessage(repo);
                }
                const status = yield StatusUtil.getRepoStatus(repo, {
                    showMetaChanges: false,
                });
                const result = yield StashUtil.save(repo,
                                                    status,
                                                    includeUntracked,
                                                    stashMessage);
                const commitMap = {};
                const stashId = yield NodeGit.Reference.lookup(
                                                            repo,
                                                            "refs/meta-stash");
                // read the reflog
                const log = yield NodeGit.Reflog.read(repo, "refs/meta-stash");
                assert(1 === log.entrycount());
                const entry = log.entryByIndex(0);
                const message = entry.message();
                assert.equal(message, expMessage);
                commitMap[stashId.target().tostrS()] = "s";
                // Look up the commits made for stashed submodules and create
                // the appropriate mappings.

                for (let subName in result) {
                    const subSha = result[subName];
                    if (!(subSha in mapping.commitMap)) {
                        commitMap[subSha] = `s${subName}`;
                    }

                    const subRepo = yield SubmoduleUtil.getRepo(repo, subName);
                    const subStash = yield subRepo.getCommit(subSha);
                    if (subStash.parentcount() > 1) {
                        const indexCommit = yield subStash.parent(1);
                        commitMap[indexCommit.id().tostrS()] = `si${subName}`;
                        if (includeUntracked) {
                            const untrackedCommit = yield subStash.parent(2);
                            commitMap[untrackedCommit.id().tostrS()] =
                                                                `su${subName}`;
                        }
                    }
                }

                // In some cases, the first or second parent might be
                // an existing commit, but the test framework only
                // wants commitMap to contain commits it has never
                // seen, so we have to remove the ones that already
                // existed.
                for (const c of Object.keys(commitMap)) {
                    if (c in mapping.commitMap) {
                        delete commitMap[c];
                    }
                }
                return {
                    commitMap: commitMap,
                };
            });
            it(caseName, co.wrap(function *() {
                yield RepoASTTestUtil.testMultiRepoManipulator(c.state,
                                                               c.expected,
                                                               stasher,
                                                               c.fails, {
                    expectedTransformer: refMapper,
                });
            }));
        });
    });
    describe("createReflogIfNeeded", function () {
        it("breathing", co.wrap(function *() {
            const w = yield RepoASTTestUtil.createRepo("S:C2-1;Bmaster=2");
            const repo = w.repo;
            const head = yield repo.getHeadCommit();
            const headSha = head.id().tostrS();
            const first = yield head.parent(0);
            const firstSha = first.id().tostrS();
            yield StashUtil.createReflogIfNeeded(repo,
                                                 "refs/foo",
                                                 headSha,
                                                 "foo");
            yield StashUtil.createReflogIfNeeded(repo,
                                                 "refs/foo",
                                                 firstSha,
                                                 "bar");
            const log = yield NodeGit.Reflog.read(repo, "refs/foo");
            assert.equal(log.entrycount(), 1);
            const zero = log.entryByIndex(0);
            const zeroSha = "0000000000000000000000000000000000000000";
            assert.equal(zero.idOld().tostrS(), zeroSha);
            assert.equal(zero.idNew().tostrS(), headSha);
            assert.equal(zero.message(), "foo");
        }));
    });
    describe("setStashHead", function () {
        const cases = {
            "no stash": {
                state: "x=S",
                sha: "1",
                expected: "x=E:Fstash=1",
                reflogSize: 1,
            },
            "wrong stash": {
                state: "x=S:C2-1;Fstash=2",
                sha: "1",
                expected: "x=S:Fstash=1",
                reflogSize: 1,
            },
            "write stash": {
                state: "x=S:Fstash=1",
                sha: "1",
                reflogSize: 0,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            const setter = co.wrap(function *(repos, mapping) {
                const repo = repos.x;
                const sha = mapping.reverseCommitMap[c.sha];
                yield StashUtil.setStashHead(repo, sha);
                const log = yield NodeGit.Reflog.read(repo, "refs/stash");
                assert.equal(log.entrycount(), c.reflogSize);
            });
            it(caseName, co.wrap(function *() {
                yield RepoASTTestUtil.testMultiRepoManipulator(c.state,
                                                               c.expected,
                                                               setter,
                                                               c.fails);
            }));
        });
    });
    describe("apply", function () {
        const cases = {
            "nothing to do": {
                state: "x=S:Cs-1 ;Bs=s",
                sha: "s",
                result: {},
            },
            "untracked": {
                state: `
a=B|
x=U:Cs-2 s=Sa:ss;Bs=s;
    Os Fsub-stash/ss=ss!
       Css-1,sis,sus !
       Csis-1 !
       Csus foo=bar;`,
                sha: "s",
                result: {
                    s: "ss",
                },
                expected: `
x=E:Os Fsub-stash/ss=ss!
       Css-1,sis,sus !
       Csis-1 !
       Csus foo=bar!
       W foo=bar;`
            },
            "conflict": {
                state: `
a=B|
x=U:Cs-2 s=Sa:ss;Bs=s;
    Os Fsub-stash/ss=ss!
       W foo=baz!
       Css-1,sis,sus !
       Csis-1 !
       Csus foo=bar;`,
                sha: "s",
                result: null,
                expected: `
x=E:Os Fsub-stash/ss=ss!
       Fstash=ss!
       Css-1,sis,sus !
       Csis-1 !
       Csus foo=bar!
       W foo=baz;`
            },
            "missing": {
                state: `a=B:Cy-1;By=y|x=U:Cs-2 s=Sa:y;Bs=s;Os`,
                sha: "s",
                result: null,
            },
            "missing, closed": {
                state: `a=B:Cy-1;By=y|x=U:Cs-2 s=Sa:y;Bs=s`,
                sha: "s",
                result: null,
                expected: "x=E:Os",
            },
            "index and workdir change same file": {
                state: `
a=B|
x=U:Fmeta-stash=s;Cstash#s-2 s=Sa:ss;
    Os Bss=ss!
       C*#ss-1,sis README.md=bar!
       C*#sis-1 README.md=foo`,
                sha: "s",
                result: {
                    s: "ss",
                },
                reinstateIndex: true,
                expected: `
x=E:Os Bss=ss!
       C*#ss-1,sis README.md=bar!
       C*#sis-1 README.md=foo!
       I README.md=foo!
       W README.md=bar`,
            },

        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            const reinstateIndexValues = (undefined === c.reinstateIndex) ?
                [false, true] : [c.reinstateIndex];
            reinstateIndexValues.forEach(function(reinstateIndex) {
                const applier = co.wrap(function* (repos, mapping) {
                    const repo = repos.x;
                    assert.property(mapping.reverseCommitMap, c.sha);
                    const sha = mapping.reverseCommitMap[c.sha];
                    const result = yield StashUtil.apply(repo, sha,
                        reinstateIndex);
                    if (null === c.result) {
                        assert.isNull(result);
                    }
                    else {
                        const expected = {};
                        Object.keys(c.result).forEach(name => {
                            const sha = c.result[name];
                            expected[name] = mapping.reverseCommitMap[sha];
                        });
                        assert.deepEqual(result, expected);
                    }
                });
                it(caseName, co.wrap(function* () {
                    yield RepoASTTestUtil.testMultiRepoManipulator(c.state,
                        c.expected,
                        applier,
                        c.fails);
                }));
            });
        });
    });
    describe("removeStash", function () {
        const cases = {
            "no log": {
                init: "x=S",
                index: 0,
                log: [],
                fails: true,
            },
            "out of bounds": {
                init: "x=S:C2;Fmeta-stash=2",
                index: 1,
                log: ["2"],
                fails: true,
            },
            "pop top to empty": {
                init: "x=S:C2;Fmeta-stash=2;B2=2",
                index: 0,
                log: ["2"],
                expected: "x=E:Fmeta-stash=",
            },
            "pop top to another": {
                init: "x=S:C2;C3;Fmeta-stash=2;B2=2;B3=3",
                index: 0,
                log: ["2","3"],
                expected: "x=E:Fmeta-stash=3",
            },
            "remove from other end": {
                init: "x=S:C2;C3;Fmeta-stash=2;B2=2;B3=3",
                index: 1,
                log: ["2","3"],
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            const remover = co.wrap(function *(repos, mapping) {
                const repo = repos.x;
                const logs = c.log;
                yield writeLog(repo, mapping.reverseCommitMap, logs);
                yield StashUtil.removeStash(repo, c.index);
                const map = mapping.commitMap;
                const newLog = yield NodeGit.Reflog.read(repo,
                                                         "refs/meta-stash");
                const newRefLog = [];
                for (let i = 0; i < newLog.entrycount(); ++i) {
                    const entry = newLog.entryByIndex(i);
                    const sha = map[entry.idNew().tostrS()];
                    newRefLog.push(sha);
                }
                if (0 !== logs.length) {
                    logs.splice(c.index, 1);
                }
                assert.deepEqual(newRefLog, logs);
            });
            it(caseName, co.wrap(function *() {
                yield RepoASTTestUtil.testMultiRepoManipulator(c.init,
                                                               c.expected,
                                                               remover,
                                                               c.fails);
            }));
        });
    });
    describe("pop", function () {
        const cases = {
            "nothing to pop": {
                init: "x=S",
                fails: true,
            },
            "failed": {
                init: `
a=B|
x=U:Cs-2 s=Sa:ss;Bs=s;Fmeta-stash=s;
    Os Bss=ss!
       W foo=baz!
       Css-1,sis,sus !
       Csis-1 !
       Csus foo=bar;`,
                fails: true,
                log: ["s"],
                expected: `
x=E:Os Bss=ss!Fstash=ss!
       W foo=baz!
       Css-1,sis,sus !
       Csis-1 !
       Csus foo=bar;`,

            },
            "works": {
                init: `
a=B|
x=U:Cs-2 s=Sa:ss;Fmeta-stash=s;Bs=s;
    Os Bss=ss!
       Css-1,sis,sus !
       Csis-1 !
       Csus foo=bar`,
                log: ["s"],
                subStash: { s: "ss" },
                expected: `
x=E:Fmeta-stash=;
    Os Bss=ss!
       Css-1,sis,sus !
       Csis-1 !
       Csus foo=bar!
       W foo=bar`
            },
            "works, second": {
                init: `
a=B|
x=U:Cs-2 s=Sa:ss;Fmeta-stash=2;Bs=s;
    Os Bss=ss!
       Css-1,sis,sus !
       Csis-1 !
       Csus foo=bar`,
                log: ["2", "s"],
                subStash: { s: "ss" },
                index: 1,
                expected: `
x=E:Fmeta-stash=2;
    Os Bss=ss!
       Css-1,sis,sus !
       Csis-1 !
       Csus foo=bar!
       W foo=bar`
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            const reinstateIndexValues = (undefined === c.reinstateIndex) ?
                [false, true] : [c.reinstateIndex];
            reinstateIndexValues.forEach(function(reinstateIndex){
                const popper = co.wrap(function *(repos, mapping) {
                    const repo = repos.x;
                    const revMap = mapping.reverseCommitMap;
                    yield writeLog(repo, revMap, c.log || []);

                    // set up stash refs in submodules, if requested

                    const subStash = c.subStash || {};
                    for (let subName in subStash) {
                        const sha = revMap[subStash[subName]];
                        const subRepo = yield SubmoduleUtil.getRepo(repo,
                            subName);
                        const refName = `refs/sub-stash/${sha}`;
                        NodeGit.Reference.create(subRepo,
                            refName,
                            NodeGit.Oid.fromString(sha),
                            1,
                            "test stash");
                    }
                    const index = (undefined === c.index) ? 0 : c.index;
                    yield StashUtil.pop(repo, index, reinstateIndex, true);
                });
                it(caseName, co.wrap(function *() {
                    yield RepoASTTestUtil.testMultiRepoManipulator(c.init,
                        c.expected,
                        popper,
                        c.fails, {
                            expectedTransformer: refMapper,
                        });
                }));
            });
        });
    });

    describe("list", function () {
        const cases = {
            "no stashes": {
                state: "x=S",
                logs: [],
                expected: "",
            },
            "one stash": {
                state: "x=S",
                logs: ["1"],
                expected: "meta-stash@{0}: log of 1\n",
            },
            "two stash": {
                state: "x=S:C2-1;Bmaster=2",
                logs: ["2", "1"],
                expected: `\
meta-stash@{0}: log of 2
meta-stash@{1}: log of 1
`,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const w = yield RepoASTTestUtil.createMultiRepos(c.state);
                const repo = w.repos.x;
                yield writeLog(repo, w.reverseCommitMap, c.logs);
                const result = yield StashUtil.list(repo);
                const resultLines = result.split("\n");
                const expectedLines = c.expected.split("\n");
                assert.deepEqual(resultLines, expectedLines);
            }));
        });
    });

    describe("shadow", function () {
        const cases = {
            "clean": {
                state: "x=S",
                includeMeta: true,
            },
            "a new file": {
                state: "x=S:W foo/bar=2",
                expected: "x=E:Cm-1 foo/bar=2;Bm=m",
                includeMeta: true,
            },
            "a new file, included in subrepo list": {
                state: "x=S:W foo/bar=2",
                includedSubrepos: ["foo/bar"],
                expected: "x=E:Cm-1 foo/bar=2;Bm=m",
                includeMeta: true,
            },
            "a new file, untracked not included": {
                state: "x=S:W foo/bar=2",
                includeMeta: true,
                includeUntracked: false,
            },
            "a new file, tracked but not included in subrepo list": {
                state: "x=S:W foo/bar=2",
                includedSubrepos: ["bar/"],
                includeMeta: true,
            },
            "with a message": {
                state: "x=S:W foo/bar=2",
                expected: "x=E:Cfoo\n#m-1 foo/bar=2;Bm=m",
                message: "foo",
                includeMeta: true,
                incrementTimestamp: true,
            },
            "deleted file": {
                state: "x=S:W README.md",
                expected: "x=E:Cm-1 README.md;Bm=m",
                includeMeta: true,
            },
            "change in index": {
                state: "x=S:I README.md=3",
                expected: "x=E:Cm-1 README.md=3;Bm=m",
                includeMeta: true,
            },
            "new file in index": {
                state: "x=S:I foo/bar=8",
                expected: "x=E:Cm-1 foo/bar=8;Bm=m",
                includeMeta: true,
            },
            "unchanged submodule": {
                state: "a=B|x=U:W README.md=2;Os",
                expected: "x=E:Cm-2 README.md=2;Bm=m",
                includeMeta: true,
            },
            "new, staged commit in opened submodule": {
                state: "a=B:Ca-1;Ba=a|x=U:I s=Sa:a;Os",
                expected: "x=E:Cm-2 s=Sa:a;Bm=m",
                includeMeta: true,
            },
            "new, staged commit in unopened submodule": {
                state: "a=B:Ca-1;Ba=a|x=U:I s=Sa:a",
                expected: "x=E:Cm-2 s=Sa:a;Bm=m",
                includeMeta: true,
            },
            "new, unstaged commit in opened submodule": {
                state: "a=B:Ca-1;Ba=a|x=U:C3-2;Bmaster=3;Os H=a",
                expected: "x=E:Cm-3 s=Sa:a;Bm=m",
                includeMeta: true,
            },
            "new file in open submodule, untracked not included": {
                state: "a=B|x=U:Os W x/y/z=3",
                includeMeta: true,
                expected: `
x=E:Cm-2 s=Sa:s;Bm=m;Os W x/y/z=3!Cs-1 x/y/z=3!Bs=s`,
            },
            "new file in open submodule, staged": {
                state: "a=B|x=U:Os I x/y/z=3",
                expected: `
x=E:Cm-2 s=Sa:s;Bm=m;Os I x/y/z=3!Cs-1 x/y/z=3!Bs=s`,
                includeMeta: true,
                includeUntracked: false,
            },
            "new submodule with a commit": {
                state: "a=B|x=S:I s=Sa:;Os Cq-1!H=q",
                includeMeta: false,
                expected: `
x=E:Cm-1 s=Sa:q;Bm=m`
            },
            "new submodule with a new file": {
                state: "a=B|x=S:I s=Sa:;Os W foo=bar",
                includeMeta: false,
                expected: `
x=E:Cm-1 s=Sa:s;Bm=m;Os Cs foo=bar!Bs=s!W foo=bar`
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            const shadower = co.wrap(function *(repos, mapping) {
                // If a meta commit was made, map it to "m" and create a branch
                // named "m" pointing to it.  For each submodule commit made,
                // map the commit to one with that submodule's name, and make a
                // branch in the submodule with that name.

                const repo = repos.x;
                const message = c.message || "message\n";
                const meta = c.includeMeta;
                const includeUntracked =
                        undefined === c.includeUntracked || c.includeUntracked;
                const incrementTimestamp =
                        (undefined === c.incrementTimestamp) ?
                        false : c.incrementTimestamp;
                const includedSubrepos =
                        (undefined === c.includedSubrepos) ?
                        [] : c.includedSubrepos;
                const result = yield StashUtil.makeShadowCommit(
                                                            repo,
                                                            message,
                                                            incrementTimestamp,
                                                            meta,
                                                            includeUntracked,
                                                            includedSubrepos,
                                                            false);

                const commitMap = {};
                if (null !== result) {
                    const metaSha = result.metaCommit;
                    const commit = yield repo.getCommit(metaSha);
                    const head = yield repo.getHeadCommit();
                    if (incrementTimestamp) {
                        assert.equal(commit.time(), head.time() + 1);
                    }
                    commitMap[metaSha] = "m";
                    yield NodeGit.Branch.create(repo, "m", commit, 1);
                    for (let path in result.subCommits) {
                        const subSha = result.subCommits[path];
                        const subRepo = yield SubmoduleUtil.getRepo(repo,
                                                                    path);
                        const subCommit = yield subRepo.getCommit(subSha);
                        if (!(subSha in mapping.commitMap)) {
                            commitMap[subSha] = path;
                            yield NodeGit.Branch.create(subRepo,
                                                        path,
                                                        subCommit,
                                                        1);
                        }
                    }
                }
                return {
                    commitMap: commitMap,
                };
            });
            it(caseName, co.wrap(function *() {
                yield RepoASTTestUtil.testMultiRepoManipulator(c.state,
                                                               c.expected,
                                                               shadower,
                                                               c.fails);
            }));
        });
    });
});
