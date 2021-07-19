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

const BulkNotesUtil       = require("../../lib/util/bulk_notes_util");
const RepoAST             = require("../../lib/util/repo_ast");
const RepoASTTestUtil     = require("../../lib/util/repo_ast_test_util");
const RepoASTUtil         = require("../../lib/util/repo_ast_util");
const StitchUtil          = require("../../lib/util/stitch_util");
const SubmoduleChange     = require("../../lib/util/submodule_change");
const SubmoduleConfigUtil = require("../../lib/util/submodule_config_util");
const SubmoduleUtil       = require("../../lib/util/submodule_util");
const TreeUtil            = require("../../lib/util/tree_util");

const FILEMODE            = NodeGit.TreeEntry.FILEMODE;

/**
 *  Replace refs and notes with their equivalent logical mapping.
 */
function refMapper(actual, mapping) {
    const fetchedSubRe = /(commits\/(?:[a-z/]*\/)?)(.*)/;
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

        // map notes

        const notes = ast.notes;
        const newNotes = {};
        Object.keys(notes).forEach(refName => {
            const commits = notes[refName];
            if (StitchUtil.referenceNoteRef === refName ||
                StitchUtil.changeCacheRef === refName) {
                // We can't check these in the normal way, so we have a
                // special test case instead.

                return;                                               // RETURN
            }
            if ("refs/notes/stitched/converted" !== refName) {
                newNotes[refName] = commits;
                return;                                               // RETURN
            }
            const newCommits = {};
            Object.keys(commits).forEach(originalSha => {
                let stitchedSha = commits[originalSha];
                if ("" !== stitchedSha) {
                    stitchedSha = commitMap[stitchedSha];
                }
                newCommits[originalSha] = stitchedSha;
            });
            newNotes[refName] = newCommits;
        });
        result[repoName] = ast.copy({
            refs: newRefs,
            notes: newNotes,
        });
    });
    return result;
}

/**
 * Return the submodule changes in the specified `commit` in the specified
 * `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 */
const getCommitChanges = co.wrap(function *(repo, commit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);

    const commitParents = yield commit.getParents();
    let parentCommit = null;
    if (0 !== commitParents.length) {
        parentCommit = commitParents[0];
    }
    return yield SubmoduleUtil.getSubmoduleChanges(repo,
                                                   commit,
                                                   parentCommit,
                                                   true);
});

describe("StitchUtil", function () {
describe("readAllowedToFailList", function () {
    it("breathing", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo(`
S:N refs/notes/stitched/allowed_to_fail 1=`);
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const headSha = head.id().tostrS();
        const result = yield StitchUtil.readAllowedToFailList(repo);
        assert(result.has(headSha));
    }));
});
describe("makeConvertedNoteContent", function () {
    it("with target sha", function () {
        const result = StitchUtil.makeConvertedNoteContent("foo");
        assert.equal(result, "foo");
    });
    it("without target sha", function () {
        const result = StitchUtil.makeConvertedNoteContent(null);
        assert.equal(result, "");
    });
});
describe("makeStitchCommitMessage", function () {
    it("just a meta", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const tree = yield head.getTree();
        const sig = NodeGit.Signature.create("me", "me@me", 3, 60);
        const commitId = yield NodeGit.Commit.create(repo,
                                                     null,
                                                     sig,
                                                     sig,
                                                     null,
                                                     "hello world\n",
                                                     tree,
                                                     0,
                                                     []);
        const commit = yield repo.getCommit(commitId);
        const result = StitchUtil.makeStitchCommitMessage(commit, {});
        const expected = "hello world\n";
        assert.equal(result, expected);
    }));
    it("same sub", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const tree = yield head.getTree();
        const sig = NodeGit.Signature.create("me", "me@me", 3, 60);
        const commitId = yield NodeGit.Commit.create(repo,
                                                     null,
                                                     sig,
                                                     sig,
                                                     null,
                                                     "hello world\n",
                                                     tree,
                                                     0,
                                                     []);
        const commit = yield repo.getCommit(commitId);
        const result = StitchUtil.makeStitchCommitMessage(commit, {
            "foo/bar": commit,
        });
        const expected = "hello world\n";
        assert.equal(result, expected);
    }));
    it("diff sub message", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const tree = yield head.getTree();
        const sig = NodeGit.Signature.create("me", "me@me", 3, 60);
        const commitId = yield NodeGit.Commit.create(repo,
                                                     null,
                                                     sig,
                                                     sig,
                                                     null,
                                                     "hello world\n",
                                                     tree,
                                                     0,
                                                     []);
        const commit = yield repo.getCommit(commitId);
        const fooBarId = yield NodeGit.Commit.create(repo,
                                                     null,
                                                     sig,
                                                     sig,
                                                     null,
                                                     "foo bar\n",
                                                     tree,
                                                     0,
                                                     []);
        const fooBar = yield repo.getCommit(fooBarId);
        const result = StitchUtil.makeStitchCommitMessage(commit, {
            "foo/bar": fooBar,
        });
        const expected = `\
hello world

From 'foo/bar'

foo bar
`;
        assert.equal(result, expected);
    }));
    it("diff sub name", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const tree = yield head.getTree();
        const sig = NodeGit.Signature.create("me", "me@me", 3, 60);
        const commitId = yield NodeGit.Commit.create(repo,
                                                     null,
                                                     sig,
                                                     sig,
                                                     null,
                                                     "hello world\n",
                                                     tree,
                                                     0,
                                                     []);
        const commit = yield repo.getCommit(commitId);
        const fooBarSig = NodeGit.Signature.create("you", "me@me", 3, 60);
        const fooBarId = yield NodeGit.Commit.create(repo,
                                                     null,
                                                     fooBarSig,
                                                     fooBarSig,
                                                     null,
                                                     "hello world\n",
                                                     tree,
                                                     0,
                                                     []);
        const fooBar = yield repo.getCommit(fooBarId);
        const result = StitchUtil.makeStitchCommitMessage(commit, {
            "foo/bar": fooBar,
        });
        const expected = `\
hello world

From 'foo/bar'
Author: you <me@me>
`;
        assert.equal(result, expected);
    }));
    it("diff sub email", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const tree = yield head.getTree();
        const sig = NodeGit.Signature.create("me", "me@me", 3, 60);
        const commitId = yield NodeGit.Commit.create(repo,
                                                     null,
                                                     sig,
                                                     sig,
                                                     null,
                                                     "hello world\n",
                                                     tree,
                                                     0,
                                                     []);
        const commit = yield repo.getCommit(commitId);
        const fooBarSig = NodeGit.Signature.create("me", "you@you", 3, 60);
        const fooBarId = yield NodeGit.Commit.create(repo,
                                                     null,
                                                     fooBarSig,
                                                     fooBarSig,
                                                     null,
                                                     "hello world\n",
                                                     tree,
                                                     0,
                                                     []);
        const fooBar = yield repo.getCommit(fooBarId);
        const result = StitchUtil.makeStitchCommitMessage(commit, {
            "foo/bar": fooBar,
        });
        const expected = `\
hello world

From 'foo/bar'
Author: me <you@you>
`;
        assert.equal(result, expected);
    }));
    it("diff time", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const tree = yield head.getTree();
        const sig = NodeGit.Signature.create("me", "me@me", 3, 60);
        const commitId = yield NodeGit.Commit.create(repo,
                                                     null,
                                                     sig,
                                                     sig,
                                                     null,
                                                     "hello world\n",
                                                     tree,
                                                     0,
                                                     []);
        const commit = yield repo.getCommit(commitId);
        const fooBarSig = NodeGit.Signature.create("me", "me@me", 2, 60);
        const fooBarId = yield NodeGit.Commit.create(repo,
                                                     null,
                                                     fooBarSig,
                                                     fooBarSig,
                                                     null,
                                                     "hello world\n",
                                                     tree,
                                                     0,
                                                     []);
        const fooBar = yield repo.getCommit(fooBarId);
        const result = StitchUtil.makeStitchCommitMessage(commit, {
            "foo/bar": fooBar,
        });
        const expected = `\
hello world

From 'foo/bar'
Date:   1/1/1970, 01:00:02 100
`;
        assert.equal(result, expected);
    }));
    it("diff offset", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const tree = yield head.getTree();
        const sig = NodeGit.Signature.create("me", "me@me", 3, 60);
        const commitId = yield NodeGit.Commit.create(repo,
                                                     null,
                                                     sig,
                                                     sig,
                                                     null,
                                                     "hello world\n",
                                                     tree,
                                                     0,
                                                     []);
        const commit = yield repo.getCommit(commitId);
        const fooBarSig = NodeGit.Signature.create("me", "me@me", 3, 120);
        const fooBarId = yield NodeGit.Commit.create(repo,
                                                     null,
                                                     fooBarSig,
                                                     fooBarSig,
                                                     null,
                                                     "hello world\n",
                                                     tree,
                                                     0,
                                                     []);
        const fooBar = yield repo.getCommit(fooBarId);
        const result = StitchUtil.makeStitchCommitMessage(commit, {
            "foo/bar": fooBar,
        });
        const expected = `\
hello world

From 'foo/bar'
Date:   1/1/1970, 02:00:03 200
`;
        assert.equal(result, expected);
    }));
});
describe("makeReferenceNoteContent", function () {
    it("breathing", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const headSha = head.id().tostrS();
        const subs = {};
        subs["foo/bar"] = head;
        const result =
                    JSON.parse(StitchUtil.makeReferenceNoteContent("1", subs));
        const expected = {
            metaRepoCommit: "1",
            submoduleCommits: {},
        };
        expected.submoduleCommits["foo/bar"] = headSha;
        assert.deepEqual(result, expected);
    }));
});
describe("listCommitsInOrder", function () {
    const cases = {
        "trival": {
            input: {
                a: [],
            },
            entry: "a",
            expected: ["a"],
        },
        "skipped entry": {
            input: {},
            entry: "a",
            expected: [],
        },
        "one parent": {
            input: {
                a: ["b"],
                b: [],
            },
            entry: "a",
            expected: ["b", "a"],
        },
        "one parent, skipped": {
            input: {
                b: [],
            },
            entry: "b",
            expected: ["b"],
        },
        "two parents": {
            input: {
                b: ["a", "c"],
                a: [],
                c: [],
            },
            entry: "b",
            expected: ["a", "c", "b"],
        },
        "chain": {
            input: {
                a: ["b"],
                b: ["c"],
                c: [],
            },
            entry: "a",
            expected: ["c", "b", "a"],
        },
        "reference the same commit twice in history": {
            input: {
                c: ["b"],
                a: ["b"],
                d: ["a", "c"],
                b: ["e", "f"],
                e: ["f"],
                f: [],
            },
            entry: "d",
            expected: ["f", "e", "b", "a", "c", "d"],
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, function () {
            const result = StitchUtil.listCommitsInOrder(c.entry, c.input);
            assert.deepEqual(c.expected, result);
        });
    });
});
describe("refMapper", function () {
    const Commit    = RepoAST.Commit;
    const cases = {
        "trivial": {
            input: {
            },
            expected: {
            },
        },
        "simple": {
            input: {
                x: new RepoAST(),
            },
            expected: {
                x: new RepoAST(),
            },
        },
        "no transform": {
            input: {
                x: new RepoAST({
                    commits: { "1": new Commit() },
                    refs: {
                        "foo/bar": "1",
                    },
                }),
            },
            expected: {
                x: new RepoAST({
                    commits: { "1": new Commit() },
                    refs: {
                        "foo/bar": "1",
                    },
                }),
            },
        },
        "note": {
            input: {
                x: new RepoAST({
                    head: "fffd",
                    commits: {
                        "fffd": new Commit(),
                    },
                    notes: {
                        "refs/notes/stitched/converted": {
                            "fffd": "ffff",
                        },
                    },
                }),
            },
            expected: {
                x: new RepoAST({
                    head: "fffd",
                    commits: {
                        "fffd": new Commit(),
                    },
                    notes: {
                        "refs/notes/stitched/converted": {
                            "fffd": "1",
                        },
                    },
                }),
            },
            commitMap: {
                "ffff": "1",
            },
        },
        "note, empty": {
            input: {
                x: new RepoAST({
                    head: "fffd",
                    commits: {
                        "fffd": new Commit(),
                    },
                    notes: {
                        "refs/notes/stitched/converted": {
                            "fffd": "",
                        },
                    },
                }),
            },
            expected: {
                x: new RepoAST({
                    head: "fffd",
                    commits: {
                        "fffd": new Commit(),
                    },
                    notes: {
                        "refs/notes/stitched/converted": {
                            "fffd": "",
                        },
                    },
                }),
            },
            commitMap: {
                "ffff": "1",
            },
        },
        "note, unrelated": {
            input: {
                x: new RepoAST({
                    head: "fffd",
                    commits: {
                        "fffd": new Commit(),
                    },
                    notes: {
                        "refs/notes/foo": {
                            "fffd": "ffff",
                        },
                    },
                }),
            },
            expected: {
                x: new RepoAST({
                    head: "fffd",
                    commits: {
                        "fffd": new Commit(),
                    },
                    notes: {
                        "refs/notes/foo": {
                            "fffd": "ffff",
                        },
                    },
                }),
            },
            commitMap: {
                "ffff": "1",
            },
        },
        "fetched sub": {
            input: {
                x: new RepoAST({
                    commits: {
                        "fffd": new Commit(),
                    },
                    refs: {
                        "commits/ffff": "fffd",
                    },
                }),
            },
            expected: {
                x: new RepoAST({
                    commits: {
                        "fffd": new Commit(),
                    },
                    refs: {
                        "commits/1": "fffd",
                    },
                }),
            },
            commitMap: {
                "ffff": "1",
                "aabb": "2",
            },
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, () => {
            const result = refMapper(c.input, {
                commitMap: c.commitMap || {},
            });
            RepoASTUtil.assertEqualRepoMaps(result, c.expected);
        });
    });

});
describe("computeModulesFile", function () {
    const cases = {
        "one kept": {
            newUrls: { foo: "bar/baz" },
            keepAsSubmodule: (name) => name === "foo",
            expected: { foo: "bar/baz" },
        },
        "one not": {
            newUrls: { foo: "bar/baz", bar: "zip/zap", },
            keepAsSubmodule: (name) => name === "foo",
            expected: { foo: "bar/baz" },
        },
        "path omitted": {
            newUrls: { foo: "bar/baz" },
            keepAsSubmodule: (name) => name === "foo",
            expected: {},
            adjustPath: () => null,
        },
        "path changed": {
            newUrls: { foo: "bar/baz" },
            keepAsSubmodule: (name) => name === "foo",
            adjustPath: () => "bam/bap",
            expected: { "bam/bap": "bar/baz" },
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const written = yield RepoASTTestUtil.createRepo("S");
            const repo = written.repo;
            const text = SubmoduleConfigUtil.writeConfigText(c.expected);
            const BLOB = 3;
            const db = yield repo.odb();
            const id = yield db.write(text, text.length, BLOB);
            const adjustPath = c.adjustPath || ((x) => x);
            const result = yield StitchUtil.computeModulesFile(
                                                        repo,
                                                        c.newUrls,
                                                        c.keepAsSubmodule,
                                                        adjustPath);
            assert.instanceOf(result, TreeUtil.Change);
            assert.equal(id.tostrS(), result.id.tostrS(), "ids");
            assert.equal(FILEMODE.BLOB, result.mode, "mode");
        }));
    });
});
describe("writeSubmoduleChangeCache", function () {
    it("breathing", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S:C2-1;H=2");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const headSha = head.id().tostrS();
        const next = (yield head.getParents())[0];
        const nextSha = next.id().tostrS();
        const changes = {};
        changes[headSha] = {
            "foo/bar": new SubmoduleChange("1", "2", null)
        };
        changes[nextSha] = {
            "baz/bam": new SubmoduleChange("3", "4", null)
        };
        yield StitchUtil.writeSubmoduleChangeCache(repo, changes);
        const refName = StitchUtil.changeCacheRef;
        const headNote = yield NodeGit.Note.read(repo, refName, headSha);
        const headObj = JSON.parse(headNote.message());
        assert.deepEqual(headObj, {
            "foo/bar": { oldSha: "1", newSha: "2"},
        });
        const nextNote = yield NodeGit.Note.read(repo, refName, nextSha);
        const nextObj = JSON.parse(nextNote.message());
        assert.deepEqual(nextObj, {
            "baz/bam": { oldSha: "3", newSha: "4" },
        });
    }));
});
describe("readSubmoduleChangeCache", function () {
    it("breathing", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S:C2-1;H=2");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const headSha = head.id().tostrS();
        const next = (yield head.getParents())[0];
        const nextSha = next.id().tostrS();
        const changes = {};
        changes[headSha] = {
            "foo/bar": new SubmoduleChange("1", "2", null)
        };
        changes[nextSha] = {
            "baz/bam": new SubmoduleChange("3", "4", null)
        };
        yield StitchUtil.writeSubmoduleChangeCache(repo, changes);
        const read = yield StitchUtil.readSubmoduleChangeCache(repo);
        const expected = {};
        expected[headSha] = {
            "foo/bar": {
                oldSha: "1",
                newSha: "2",
            },
        };
        expected[nextSha] = {
            "baz/bam": {
                oldSha: "3",
                newSha: "4",
            },
        };
        assert.deepEqual(read, expected);
    }));
});
describe("sameInAnyOtherParent", function () {
    const cases  = {
        "no other parents": {
            state: "B:Ca;C2-1 s=S.:a;Ba=a;Bmaster=2",
            expected: false,
        },
        "missing in other parent": {
            state: "B:Ca;C3-1,2 s=S.:a;C2-1 foo=bar;Ba=a;Bmaster=3",
            expected: false,
        },
        "different in other parent": {
            state: `
B:Ca;Cb;C3-1,2 s=S.:a;C2-1 s=S.:b;Ba=a;Bmaster=3;Bb=b`,
            expected: false,
        },
        "same in other parent": {
            state: "B:Ca;C3-1,2 s=S.:a;C2-1 s=S.:a;Ba=a;Bmaster=3",
            expected: true,
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const written = yield RepoASTTestUtil.createRepo(c.state);
            const repo = written.repo;
            const head = yield repo.getHeadCommit();
            const a = yield repo.getBranchCommit("a");
            const aSha = a.id().tostrS();
            const result = yield StitchUtil.sameInAnyOtherParent(repo,
                                                                 head,
                                                                 "s",
                                                                 aSha);
            assert.equal(result, c.expected);
        }));
    });
});
describe("writeStitchedCommit", function () {
    const cases = {
        "trivial, no subs": {
            input: "x=S",
            commit: "1",
            parents: [],
            keepAsSubmodule: () => false,
            subCommits: {},
            expected: `
x=E:Cthe first commit#s ;Bstitched=s`,
        },
        "trivial, no subs, with a parent": {
            input: "x=S:C2;Bp=2",
            commit: "1",
            parents: ["2"],
            keepAsSubmodule: () => false,
            subCommits: {},
            expected: `x=E:Cthe first commit#s-2 ;Bstitched=s`,
        },
        "new stitched sub": {
            input: `
x=B:Ca;Cfoo#2-1 s=S.:a;Ba=a;Bmaster=2`,
            commit: "2",
            parents: [],
            keepAsSubmodule: () => false,
            subCommits: { s: "a" },
            expected: `x=E:C*#s s/a=a;Bstitched=s`,
        },
        "new stitched sub, with parent": {
            input: `
x=B:Ca;C2-1 s=S.:a;Ba=a;Bmaster=2`,
            commit: "2",
            parents: ["1"],
            keepAsSubmodule: () => false,
            subCommits: { s: "a" },
            expected: `x=E:C*#s-1 s/a=a;Bstitched=s`,
        },
        "2 new stitched subs": {
            input: `
x=B:Ca;Cb;C2-1 s=S.:a,t=S.:b;Ba=a;Bb=b;Bmaster=2`,
            commit: "2",
            parents: [],
            keepAsSubmodule: () => false,
            subCommits: { s: "a", t: "b" },
            expected: `
x=E:C*#s s/a=a,t/b=b;Bstitched=s`,
        },
        "modified stitched": {
            input: `
x=B:Ca;Cb;Cc;C2-1 s=S.:a,t=S.:b;C3-2 s=S.:c;Ba=a;Bb=b;Bc=c;Bmaster=3`,
            commit: "3",
            parents: [],
            keepAsSubmodule: () => false,
            subCommits: { s: "c" },
            expected: `x=E:C*#s s/c=c;Bstitched=s`,
        },
        "deletion stitched": {
            input: `
x=B:Ca;Cb-a f=c,a; C2-1 s=S.:a;C3-2 s=S.:b;Bb=b;Bmaster=3;
    Cr s/a=a;Br=r`,
            commit: "3",
            parents: ["r"],
            keepAsSubmodule: () => false,
            subCommits: { s: "b" },
            expected: `x=E:C*#s-r s/f=c,s/a;Bstitched=s`,
        },
        "submodule deletion stitched": {
            input: `
x=B:Ca;Cb-a;Cc a/b=1,c/d=2;C2-1 s=S.:a,t/u=S.:c;C3-2 s=S.:b,t/u;
    Bb=b;Bc=c;Bmaster=3;
    Cr s/a=a,t/u/a/b=1,t/u/c/d=2;Br=r`,
            commit: "3",
            parents: ["r"],
            keepAsSubmodule: () => false,
            subCommits: { s: "b" },
            expected: `x=E:C*#s-r s/b=b,t/u/a/b,t/u/c/d;Bstitched=s`,
        },
        "submodule deletion, but new subs added under it": {
            input: `
x=B:Ca;Cb-a;C2-1 s=S.:a,t=S.:b;C3-2 s=S.:b,t/u=Sa:a,t;
    Bb=b;Bmaster=3;
    Cr s/a=a,t/b=b;Br=r`,
            commit: "3",
            parents: ["r"],
            keepAsSubmodule: () => false,
            subCommits: { s: "b", "t/u": "a" },
            expected: `x=E:C*#s-r s/b=b,t/b,t/u/a=a;Bstitched=s`,
        },
        "removed stitched": {
            input: `
x=B:Ca;Cb;Cc s/a=b;Cfoo#2-1 s=S.:a,t=S.:b;C3-2 s;Ba=a;Bb=b;Bc=c;Bmaster=3`,
            commit: "3",
            parents: ["c"],
            keepAsSubmodule: () => false,
            subCommits: {},
            expected: `x=E:Cs-c s/a;Bstitched=s`,
        },
        "kept": {
            input: `
x=B:Ca;Cb;C2-1 s=S.:a,t=S.:b;Ba=a;Bb=b;Bmaster=2`,
            commit: "2",
            parents: [],
            keepAsSubmodule: (name) => "t" === name,
            subCommits: { s: "a" },
            expected: `x=E:C*#s s/a=a,t=S.:b;Bstitched=s`,
        },
        "modified kept": {
            input: `
x=B:Ca;Cb;Ba=a;Bb=b;C2-1 s=S.:a;C3-2 s=S.:b;Cp foo=bar,s=S.:a;Bmaster=3;Bp=p`,
            commit: "3",
            parents: ["p"],
            keepAsSubmodule: (name) => "s" === name,
            subCommits: {},
            expected: `x=E:Cs-p s=S.:b;Bstitched=s`,
        },
        "removed kept": {
            input: `
x=B:Ca;Ba=a;C2-1 s=S.:a;C3-2 s;Cp foo=bar,s=S.:a;Bmaster=3;Bp=p`,
            commit: "3",
            parents: ["p"],
            keepAsSubmodule: (name) => "s" === name,
            subCommits: {},
            expected: `x=E:Cs-p s;Bstitched=s`,
        },
        "empty commit, but not skipped": {
            input: `
x=B:Ca;Cfoo#2 ;Ba=a;Bmaster=2;Bfoo=1`,
            commit: "2",
            parents: ["1"],
            keepAsSubmodule: () => false,
            subCommits: {},
            expected: `x=E:C*#s-1 ;Bstitched=s`,
        },
        "empty commit, skipped": {
            input: `
x=B:Ca;Cfoo#2 ;Ba=a;Bmaster=2;Bfoo=1`,
            commit: "2",
            parents: [],
            keepAsSubmodule: () => false,
            skipEmpty: true,
            isNull: true,
            subCommits: {},
        },
        "skipped empty, with parent": {
            input: `
x=B:Ca;C2-1 ;Ba=a;Bmaster=2;Bstitched=1`,
            commit: "2",
            parents: ["1"],
            keepAsSubmodule: () => false,
            skipEmpty: true,
            subCommits: {},
        },
        "adjusted to new path": {
            input: `
x=B:Ca;Cfoo#2-1 s=S.:a;Ba=a;Bmaster=2`,
            commit: "2",
            parents: [],
            keepAsSubmodule: () => false,
            adjustPath: () => "foo/bar",
            subCommits: { "foo/bar": "a" },
            expected: `x=E:C*#s foo/bar/a=a;Bstitched=s`,
        },
        "missing commit": {
            input: `
a=B|b=B:Cb-1;Bb=b|x=U:C3-2 s=Sa:b;H=3`,
            commit: "3",
            parents: [],
            keepAsSubmodule: () => false,
            fails: true,
        },
        "missing commit, in allowed_to_fail list": {
            input: `
a=B|b=B:Cb-1;Bb=b|x=U:C3-2 s=Sa:b;H=3`,
            commit: "3",
            parents: [],
            keepAsSubmodule: () => false,
            allowed_to_fail: ["3"],
            subCommits: {},
            expected: `x=E:Cs ;Bstitched=s`,
        },
        "omit, from subCommits, non-new commits (existed in one parent)": {
            input: `
a=B:Ca a=a;Ba=a|
x=S:C2-1 s=Sa:a;C3-1 t=Sa:a;C4-2,3 t=Sa:a,u=Sa:a;H=4;Ba=a`,
            commit: "4",
            parents: [],
            keepAsSubmodule: () => false,
            subCommits: { "u": "a" },
            expected: `x=E:C*#s u/a=a,t/a=a;Bstitched=s`,
        },
        "omit, from subCommits, with adjusted path": {
            input: `
a=B:Ca a=a;Ba=a|
x=S:C2-1 s=Sa:a;C3-1 t=Sa:a;C4-2,3 t=Sa:a,u=Sa:a;H=4;Ba=a`,
            commit: "4",
            parents: [],
            keepAsSubmodule: () => false,
            subCommits: { "foo/bar/u": "a" },
            adjustPath: (path) => `foo/bar/${path}`,
            expected: `x=E:C*#s foo/bar/u/a=a,foo/bar/t/a=a;Bstitched=s`,
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const stitcher = co.wrap(function *(repos, maps) {
                const x = repos.x;
                const revMap = maps.reverseCommitMap;
                const commit = yield x.getCommit(revMap[c.commit]);
                const parents =
                              yield c.parents.map(co.wrap(function *(sha) {
                    return yield x.getCommit(revMap[sha]);
                }));
                const adjustPath = c.adjustPath || ((x) => x);
                const skipEmpty = c.skipEmpty || false;

                const changes = yield getCommitChanges(x, commit);
                const allowed_list = c.allowed_to_fail || [];
                const allowed_to_fail = new Set((allowed_list).map(c => {
                    return revMap[c];
                }));
                const stitch = yield StitchUtil.writeStitchedCommit(
                                                        x,
                                                        commit,
                                                        changes,
                                                        parents,
                                                        c.keepAsSubmodule,
                                                        adjustPath,
                                                        skipEmpty,
                                                        allowed_to_fail);
                const subCommits = {};
                for (let path in stitch.subCommits) {
                    const commit = stitch.subCommits[path];
                    const sha = commit.id().tostrS();
                    subCommits[path] = maps.commitMap[sha];
                }
                assert.deepEqual(subCommits, c.subCommits);
                if (true === c.isNull) {
                    assert(null === stitch.stitchedCommit,
                            "stitchedCommit should have been null");
                    return;
                } else {
                    // Need to root the commit we wrote
                    yield NodeGit.Reference.create(x,
                                                   "refs/heads/stitched",
                                                   stitch.stitchedCommit,
                                                   1,
                                                   "stitched");
                }
                const stitchSha = stitch.stitchedCommit.id().tostrS();
                const commitMap = {};
                if (!(stitchSha in maps.commitMap)) {
                    commitMap[stitch.stitchedCommit.id().tostrS()] = "s";
                }
                return {
                    commitMap,
                };
            });
            yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                           c.expected,
                                                           stitcher,
                                                           c.fails, {
                actualTransformer: refMapper,
            });
        }));
    });
    it("messaging", co.wrap(function *() {

        const state = "B:Ca;C2-1 s=S.:a;Ba=a;Bmaster=2";
        const written = yield RepoASTTestUtil.createRepo(state);
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const changes = yield getCommitChanges(repo, head);
        const allowed_to_fail = new Set();
        const stitch = yield StitchUtil.writeStitchedCommit(repo,
                                                            head,
                                                            changes,
                                                            [],
                                                            () => false,
                                                            (x) => x,
                                                            false,
                                                            allowed_to_fail);
        const expected = StitchUtil.makeStitchCommitMessage(head,
                                                            stitch.subCommits);
        const stitchedCommit = stitch.stitchedCommit;
        const actual = stitchedCommit.message();
        assert.deepEqual(expected.split("\n"), actual.split("\n"));
    }));
});
describe("listSubmoduleChanges", function () {
    it("empty", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const result = yield StitchUtil.listSubmoduleChanges(repo, [head]);
        const expected = {};
        expected[head.id().tostrS()] = {};
        assert.deepEqual(result, expected);
    }));
    it("with one", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S:C2-1 s=Sa:1;H=2");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const expected = {};
        const parents = yield head.getParents();
        const parent = parents[0];
        const firstSha = parent.id().tostrS();
        expected[head.id().tostrS()] = {
            "s": new SubmoduleChange(null, firstSha, null),
        };
        expected[firstSha] = {};
        const result =
                   yield StitchUtil.listSubmoduleChanges(repo, [head, parent]);
        assert.deepEqual(result, expected);
    }));
});
describe("listFetches", function () {
    const cases = {
        "trivial": {
            state: "S",
            toFetch: [],
            keepAsSubmodule: () => false,
            expected: {},
        },
        "a sub, not picked": {
            state: "S:C2-1 s=S/a:1;Bmaster=2",
            toFetch: ["1"],
            keepAsSubmodule: () => false,
            expected: {},
        },
        "added sub": {
            state: "S:C2-1 s=S/a:1;Bmaster=2",
            toFetch: ["2"],
            keepAsSubmodule: () => false,
            expected: {
                "s": [
                    { metaSha: "2", url: "/a", sha: "1" },
                ],
            },
        },
        "added sub kept": {
            state: "S:C2-1 s=S/a:1;Bmaster=2",
            toFetch: ["2"],
            keepAsSubmodule: (name) => "s" === name,
            expected: {},
        },
        "adjusted to null": {
            state: "S:C2-1 s=S/a:1;Bmaster=2",
            toFetch: ["2"],
            keepAsSubmodule: () => false,
            adjustPath: () => null,
            expected: {},
        },
        "changed sub": {
            state: "S:Cx-1;Bx=x;C2-1 s=S/a:1;C3-2 s=S/a:x;Bmaster=3",
            toFetch: ["3"],
            keepAsSubmodule: () => false,
            expected: {
                "s": [
                    { metaSha: "3", url: "/a", sha: "x" },
                ],
            },
        },
        "changed sub kept": {
            state: "S:Cx-1;Bx=x;C2-1 s=S/a:1;C3-2 s=S/a:x;Bmaster=3",
            toFetch: ["3"],
            keepAsSubmodule: (name) => "s" === name,
            expected: {},
        },
        "two changes in a sub": {
            state: "S:Cx-1;Bx=x;C2-1 s=S/a:1;C3-2 s=S/a:x;Bmaster=3",
            toFetch: ["2", "3"],
            keepAsSubmodule: () => false,
            expected: {
                "s": [
                    { metaSha: "3", url: "/a", sha: "x" },
                    { metaSha: "2", url: "/a", sha: "1" },
                ],
            },
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const written = yield RepoASTTestUtil.createRepo(c.state);
            const repo = written.repo;
            const revMap = written.oldCommitMap;
            const commitMap = written.commitMap;
            const toFetch = yield c.toFetch.map(co.wrap(function *(e) {
                const sha = revMap[e];
                return yield repo.getCommit(sha);
            }));
            const adjustPath = c.adjustPath || ((x) => x);
            const changes = yield StitchUtil.listSubmoduleChanges(repo,
                                                                  toFetch);
            const result = yield StitchUtil.listFetches(repo,
                                                        toFetch,
                                                        changes,
                                                        c.keepAsSubmodule,
                                                        adjustPath);
            function mapFetch(f) {
                return {
                    url: f.url,
                    metaSha: commitMap[f.metaSha],
                    sha: commitMap[f.sha],
                };
            }
            for (let name in result) {
                result[name] = result[name].map(mapFetch);
            }
            assert.deepEqual(result, c.expected);
        }));
    });
});
describe("fetchSubCommits", function () {
    const cases = {
        "trivial": {
            input: "a=B|x=S",
            fetches: [],
            url: "a",
        },
        "one, w sub": {
            input: "a=B:Cz-1;Bz=z|x=U",
            fetches: [
                {
                    url: "../a",
                    sha: "z",
                    metaSha: "2"
                }
            ],
            url: "a",
            expected: "x=E:Fcommits/x/z=z",
        },
        "one, w sub no need to fetch": {
            input: "a=B|x=U",
            fetches: [
                {
                    url: "a",
                    sha: "1",
                    metaSha: "2"
                }
            ],
            url: "a",
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const fetcher = co.wrap(function *(repos, maps) {
                const x = repos.x;
                const revMap = maps.reverseCommitMap;
                const fetches = c.fetches.map(e => {
                    return {
                        url: e.url,
                        sha: revMap[e.sha],
                        metaSha: revMap[e.metaSha],
                    };
                });
                const url = maps.reverseUrlMap[c.url];
                yield StitchUtil.fetchSubCommits(x, "x", url, fetches);
            });
            yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                           c.expected,
                                                           fetcher,
                                                           c.fails, {
                includeRefsCommits: true,
                actualTransformer: refMapper,
            });

        }));
    });
});
describe("makeAdjustPathFunction", function () {
    const cases = {
        "null root": {
            root: null,
            filename: "foo",
            expected: "foo",
        },
        "match it": {
            root: "foo/",
            filename: "foo/bar",
            expected: "bar",
        },
        "miss it": {
            root: "foo/",
            filename: "meh",
            expected: null,
        },
        "match it with missing slash": {
            root: "foo",
            filename: "foo/bar",
            expected: "bar",
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, function () {
            const adjustPath = StitchUtil.makeAdjustPathFunction(c.root);
            const result = adjustPath(c.filename);
            assert.equal(result, c.expected);
        });
    });
});
describe("readConvertedContent", function () {
    it("empty", function () {
        assert.equal(StitchUtil.readConvertedContent(""), null);
    });
    it("not empty", function () {
        assert.equal(StitchUtil.readConvertedContent("1"), "1");
    });
});
describe("readConvertedCommit", function () {
    it("missing", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo(`S`);
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const headSha = head.id().tostrS();
        const result = yield StitchUtil.readConvertedCommit(repo, headSha);
        assert.isUndefined(result);
    }));
    it("there", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo(`
S:N refs/notes/stitched/converted 1=`);
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const headSha = head.id().tostrS();
        const result = yield StitchUtil.readConvertedCommit(repo, headSha);
        assert.isNull(result);
    }));
});
describe("readConvertedCommits", function () {
    it("breathing", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo(`
S:C2-1;B2=2;N refs/notes/stitched/converted 1=;
  N refs/notes/stitched/converted 2=1`);
        const repo = written.repo;
        const one = yield repo.getHeadCommit();
        const oldGetCommit = repo.getCommit.bind(repo);
        repo.getCommit = co.wrap(function* (sha) {
            if (sha === "1") {
                return one;
            }
            return yield oldGetCommit(sha);
        });

        const two = yield repo.getBranchCommit("2");
        const twoSha = two.id().tostrS();
        const result = yield StitchUtil.readConvertedCommits(repo);
        const expected = {};
        expected[twoSha] = "1";
        assert.deepEqual(expected, result);
    }));
});
describe("makeGetConvertedCommit", function () {
    it("empty", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo(`S`);
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const headSha = head.id().tostrS();
        const fun = StitchUtil.makeGetConvertedCommit(repo, {});
        const result = yield fun(headSha);
        assert.isUndefined(result);
    }));
    it("got one", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo(`
S:N refs/notes/stitched/converted 1=`);
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const headSha = head.id().tostrS();
        const fun = StitchUtil.makeGetConvertedCommit(repo, {});
        const result = yield fun(headSha);
        assert.isUndefined(result);

        // Now delete and make sure we're remembering the result.

        NodeGit.Reference.remove(repo, StitchUtil.convertedNoteRef);
        const nextResult = yield fun(headSha);
        assert.isUndefined(nextResult);
    }));
    it("got one from cache", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo(`S`);
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const headSha = head.id().tostrS();
        const cache = {};
        cache[headSha] = null;
        const fun = StitchUtil.makeGetConvertedCommit(repo, cache);
        const result = yield fun(headSha);
        assert.isNull(result);
    }));
});
describe("listCommitsToStitch", function () {
    // We don't need to validate the ordering part; that is check in the
    // test driver for 'listCommitsInOrder'.  We need to validate basic
    // functionality, and that we stop at previously converted commits.

    it("trivial", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const getConv = StitchUtil.makeGetConvertedCommit(repo, {});
        const result =
                     yield StitchUtil.listCommitsToStitch(repo, head, getConv);
        const headSha = head.id().tostrS();
        const resultShas = result.map(c => c.id().tostrS());
        assert.deepEqual([headSha], resultShas);
    }));

    it("note present, stitched commit missing", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const headSha = head.id().tostrS();
        const notes = {};
        notes[headSha] = StitchUtil.makeConvertedNoteContent(null);
        yield BulkNotesUtil.writeNotes(repo,
                                       StitchUtil.convertedNoteRef,
                                       notes);
        const getConv = StitchUtil.makeGetConvertedCommit(repo, {});
        const result =
                     yield StitchUtil.listCommitsToStitch(repo, head, getConv);
        const resultShas = result.map(c => c.id().tostrS());
        assert.deepEqual([headSha], resultShas);
    }));

    it("with parents", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo(
                                    "S:C3-2,4;C4-2;C2-1;C5-3,4;Bmaster=5");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const getConv = StitchUtil.makeGetConvertedCommit(repo, {});
        const result =
                     yield StitchUtil.listCommitsToStitch(repo, head, getConv);
        const expected = ["1", "2", "4", "3", "5"];
        const resultShas = result.map(c => {
            const sha = c.id().tostrS();
            return written.commitMap[sha];
        });
        assert.deepEqual(expected, resultShas);
    }));

    it("with parents and marker", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo(
                                    "S:C3-2,4;C4-2;C2-1;C5-3,4;Bmaster=5");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const twoSha = written.oldCommitMap["2"];
        const notes = {};
        notes[twoSha] = StitchUtil.makeConvertedNoteContent(twoSha);
        yield BulkNotesUtil.writeNotes(repo,
                                       StitchUtil.convertedNoteRef,
                                       notes);
        const getConv = StitchUtil.makeGetConvertedCommit(repo, {});
        const result =
                     yield StitchUtil.listCommitsToStitch(repo, head, getConv);
        const expected = ["4", "3", "5"];
        const resultShas = result.map(c => {
            const sha = c.id().tostrS();
            return written.commitMap[sha];
        });
        assert.deepEqual(expected, resultShas);
    }));
});
describe("stitch", function () {
    const cases = {
        "breathing": {
            input: `
x=B:Ca;Cfoo#2-1 s=S.:a;Ba=a;Bmaster=2`,
            commit: "2",
            targetBranchName: "my-branch",
            keepAsSubmodule: () => false,
            numParallel: 8,
            preloadCache: true,
            expected: `
x=E:C*#s2-s1 s/a=a;C*#s1 ;
Bmy-branch=s2;
N refs/notes/stitched/converted 2=s2;
N refs/notes/stitched/converted 1=s1`,
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const stitcher = co.wrap(function *(repos, maps) {
                const x = repos.x;
                const options = {
                    numParallel: c.numParallel,
                    keepAsSubmodule: c.keepAsSubmodule,
                    preloadCache: c.preloadCache,
                };
                if ("fetch" in c) {
                    options.fetch = c.fetch;
                }
                if ("url" in c) {
                    options.url = c.url;
                }
                if ("joinRoot" in c) {
                    options.joinRoot = c.joinRoot;
                }
                if ("skipEmpty" in c) {
                    options.skipEmpty = c.skipEmpty;
                }
                const revMap = maps.reverseCommitMap;
                yield StitchUtil.stitch(x.path(),
                                        revMap[c.commit],
                                        c.targetBranchName,
                                        options);
                const noteRefs = [];
                function listNoteRefs(_, objectId) {
                    noteRefs.push(objectId.tostrS());
                }
                yield NodeGit.Note.foreach(x,
                                           StitchUtil.convertedNoteRef,
                                           listNoteRefs);
                const commitMap = {};
                yield noteRefs.map(co.wrap(function *(noteRef) {
                    const note = yield NodeGit.Note.read(
                                                   x,
                                                   StitchUtil.convertedNoteRef,
                                                   noteRef);
                    const content = note.message();
                    if ("" !== content) {
                        const name = "s" + maps.commitMap[noteRef];
                        commitMap[content] = name;
                    }
                }));
                return {
                    commitMap,
                };
            });
            yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                           c.expected,
                                                           stitcher,
                                                           c.fails, {
                actualTransformer: refMapper,
            });
        }));
    });
});
});
