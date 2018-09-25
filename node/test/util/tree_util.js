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

const assert  = require("chai").assert;
const co      = require("co");
const fs      = require("fs-promise");
const NodeGit = require("nodegit");
const path    = require("path");

const RepoStatus          = require("../../lib/util/repo_status");
const SubmoduleConfigUtil = require("../../lib/util/submodule_config_util");
const TestUtil            = require("../../lib/util/test_util");
const TreeUtil            = require("../../lib/util/tree_util");

describe("TreeUtil", function () {
    const Change = TreeUtil.Change;
    const FILEMODE = NodeGit.TreeEntry.FILEMODE;

    describe("buildDirectoryTree", function () {
        const cases = {
            "trivial": { input: {}, expected: {}, },
            "simple": {
                input: { a: "b" },
                expected: { a: "b" },
            },
            "deep": {
                input: { "a/b": "c" },
                expected: {
                    a: { b: "c" },
                },
            },
            "overlap": {
                input: { "a/b": "1", "a/d": "2" },
                expected: {
                    a: {
                        b: "1",
                        d: "2",
                    },
                },
            },
            "deep overlap": {
                input: { "a/b": "1", "a/c/d": "2" },
                expected: {
                    a: {
                        b: "1",
                        c: { d: "2", }
                    },
                },
            },
            "deep overlap reversed": {
                input: { "a/c/d": "2", "a/b": "1" },
                expected: {
                    a: {
                        c: { d: "2", },
                        b: "1",
                    },
                },
            },
            "deleted tree changed to parent": {
                input: {
                    "a": null,
                    "a/b": "1",
                },
                expected: {
                    "a": {
                        "b": "1",
                    },
                },
            },
            "deleted tree changed to parent, order reversed": {
                input: {
                    "a/b": "1",
                    "a": null,
                },
                expected: {
                    "a": {
                        "b": "1",
                    },
                }
            },
            "creation and deletion": {
                input: {
                    "a/b": "1",
                    "a": null,
                },
                expected: {
                    a: { b: "1" },
                },
            },
            "deletion and creation": {
                input: {
                    "a": null,
                    "a/b": "1",
                },
                expected: {
                    a: { b: "1" },
                },
            },
        };
        Object.keys(cases).forEach((caseName) => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = TreeUtil.buildDirectoryTree(c.input);
                assert.deepEqual(result, c.expected);
            });
        });
    });

    describe("Change", function () {
        it("breathing", function () {
            const sha = "1de1b41118f04f51082e544dd575881bf036bc60";
            const id = NodeGit.Oid.fromString(sha);
            const change = new Change(id, FILEMODE.BLOB);
            assert.equal(change.id.tostrS(), sha);
            assert.equal(change.mode, FILEMODE.BLOB);
        });
    });

    describe("writeTree", function () {
        const hashObject = co.wrap(function *(repo, data) {
            const db = yield repo.odb();
            const BLOB = 3;
            const res = yield db.write(data, data.length, BLOB);
            return res;
        });
        const makeRepo = co.wrap(function *() {
            const repoPath = yield TestUtil.makeTempDir();
            return yield NodeGit.Repository.init(repoPath, 0);
        });
        it("trivial", co.wrap(function *() {
            const repo = yield makeRepo();
            const result = yield TreeUtil.writeTree(repo, null, {});
            assert.instanceOf(result, NodeGit.Tree);
            assert.equal(result.entryCount(), 0);
        }));
        it("one blob", co.wrap(function *() {
            const repo = yield makeRepo();
            const id = yield hashObject(repo, "xxxxxxxh");
            const result = yield TreeUtil.writeTree(repo, null, {
                foo: new Change(id, FILEMODE.BLOB),
            });
            const entry = yield result.entryByPath("foo");
            assert.isNotNull(entry);
            assert(entry.isBlob());
            assert.equal(entry.id().tostrS(), id.tostrS());
        }));
        it("deep blob", co.wrap(function *() {
            const repo = yield makeRepo();
            const id = yield hashObject(repo, "xxxxxxxh");
            const result = yield TreeUtil.writeTree(repo, null, {
                "foo/bar": new Change(id, FILEMODE.BLOB),
            });
            const entry = yield result.getEntry("foo/bar");
            assert.isNotNull(entry);
            assert(entry.isBlob());
            assert.equal(entry.id().tostrS(), id.tostrS());
        }));
        it("deep blob on parent", co.wrap(function *() {
            const repo = yield makeRepo();
            const aId = yield hashObject(repo, "xxxxxxxh");
            const firstTree = yield TreeUtil.writeTree(repo, null, {
                a: new Change(aId, FILEMODE.BLOB),
            });
            const zId = yield hashObject(repo, "aaaa");
            const secondTree = yield TreeUtil.writeTree(repo, firstTree, {
                "x/y/z": new Change(zId, FILEMODE.BLOB),
            });
            const aEntry = yield secondTree.getEntry("a");
            assert.equal(aEntry.id().tostrS(), aId.tostrS());
            const zEntry = yield secondTree.getEntry("x/y/z");
            assert.equal(zEntry.id().tostrS(), zId.tostrS());
        }));
        it("second blob", co.wrap(function *() {
            const repo = yield makeRepo();
            const fooId= yield hashObject(repo, "xxxxxxxh");
            const firstTree = yield TreeUtil.writeTree(repo, null, {
                "foo": new Change(fooId, FILEMODE.BLOB),
            });
            const barId = yield hashObject(repo, "aaa");
            const secondTree = yield TreeUtil.writeTree(repo, firstTree, {
                "bar": new Change(barId, FILEMODE.BLOB),
            });
            const fooEntry = yield secondTree.entryByPath("foo");
            assert.equal(fooEntry.id().tostrS(), fooId.tostrS());
            const barEntry = yield secondTree.entryByPath("bar");
            assert.equal(barEntry.id().tostrS(), barId.tostrS());
        }));
        it("second deep blob", co.wrap(function *() {
            const repo = yield makeRepo();
            const barId = yield hashObject(repo, "xxxxxxxh");
            const firstTree = yield TreeUtil.writeTree(repo, null, {
                "foo/bar": new Change(barId, FILEMODE.BLOB),
            });
            const bobId = yield hashObject(repo, "ererere");
            const secondTree = yield TreeUtil.writeTree(repo, firstTree, {
                "foo/bob": new Change(bobId, FILEMODE.BLOB),
            });
            const barEntry = yield secondTree.getEntry("foo/bar");
            assert.equal(barEntry.id().tostrS(), barId.tostrS());
            const bobEntry = yield secondTree.getEntry("foo/bob");
            assert.equal(bobEntry.id().tostrS(), bobId.tostrS());
        }));
        it("remove a blob", co.wrap(function *() {
            const repo = yield makeRepo();
            const id = yield hashObject(repo, "xxxxxxxh");
            const firstTree = yield TreeUtil.writeTree(repo, null, {
                foo: new Change(id, FILEMODE.BLOB),
            });
            const secondTree = yield TreeUtil.writeTree(repo, firstTree, {
                foo: null,
            });
            assert.equal(secondTree.entryCount(), 0);
        }));
        it("remove a deep blob", co.wrap(function *() {
            const repo = yield makeRepo();
            const id = yield hashObject(repo, "xxxxxxxh");
            const firstTree = yield TreeUtil.writeTree(repo, null, {
                "foo/bar": new Change(id, FILEMODE.BLOB),
            });
            const secondTree = yield TreeUtil.writeTree(repo, firstTree, {
                "foo/bar": null,
            });
            assert.equal(secondTree.entryCount(), 0);
        }));
        it("remove one or two deep blobs", co.wrap(function *() {
            const repo = yield makeRepo();
            const id = yield hashObject(repo, "xxxxxxxh");
            const firstTree = yield TreeUtil.writeTree(repo, null, {
                "foo/bar": new Change(id, FILEMODE.BLOB),
                "foo/baz": new Change(id, FILEMODE.BLOB),
            });
            const secondTree = yield TreeUtil.writeTree(repo, firstTree, {
                "foo/bar": null,
            });
            assert.equal(secondTree.entryCount(), 1);
        }));
        it("update blob", co.wrap(function *() {
            const repo = yield makeRepo();
            const id = yield hashObject(repo, "xxxxxxxh");
            const firstTree = yield TreeUtil.writeTree(repo, null, {
                foo: new Change(id, FILEMODE.BLOB),
            });
            const newId = yield hashObject(repo, "hallo");
            const secondTree = yield TreeUtil.writeTree(repo, firstTree, {
                foo: new Change(newId, FILEMODE.BLOB),
            });
            const entry = yield secondTree.entryByPath("foo");
            assert.equal(entry.id().tostrS(), newId.tostrS());
        }));
        it("from blob to tree with blob", co.wrap(function *() {
            const repo = yield makeRepo();
            const id = yield hashObject(repo, "xxxxxxxh");
            const firstTree = yield TreeUtil.writeTree(repo, null, {
                "foo": new Change(id, FILEMODE.BLOB),
            });
            const secondTree = yield TreeUtil.writeTree(repo, firstTree, {
                "foo": null,
                "foo/bar": new Change(id, FILEMODE.BLOB),
            });
            const entry = yield secondTree.entryByPath("foo/bar");
            assert.equal(entry.id().tostrS(), id.tostrS());
        }));
        it("from blob to tree with blob, reversed", co.wrap(function *() {
            const repo = yield makeRepo();
            const id = yield hashObject(repo, "xxxxxxxh");
            const firstTree = yield TreeUtil.writeTree(repo, null, {
                "foo": new Change(id, FILEMODE.BLOB),
            });
            const secondTree = yield TreeUtil.writeTree(repo, firstTree, {
                "foo/bar": new Change(id, FILEMODE.BLOB),
                "foo": null,
            });
            const entry = yield secondTree.entryByPath("foo/bar");
            assert.equal(entry.id().tostrS(), id.tostrS());
        }));
        it("from tree with blob to blob", co.wrap(function *() {
            const repo = yield makeRepo();
            const id = yield hashObject(repo, "xxxxxxxh");
            const firstTree = yield TreeUtil.writeTree(repo, null, {
                "foo/bar": new Change(id, FILEMODE.BLOB),
            });
            const secondTree = yield TreeUtil.writeTree(repo, firstTree, {
                "foo": new Change(id, FILEMODE.BLOB),
                "foo/bar": null,
            });
            const entry = yield secondTree.entryByPath("foo");
            assert.equal(entry.id().tostrS(), id.tostrS());
        }));
        it("from tree with blob to blob, reversed", co.wrap(function *() {
            const repo = yield makeRepo();
            const id = yield hashObject(repo, "xxxxxxxh");
            const firstTree = yield TreeUtil.writeTree(repo, null, {
                "foo/bar": new Change(id, FILEMODE.BLOB),
            });
            const secondTree = yield TreeUtil.writeTree(repo, firstTree, {
                "foo/bar": null,
                "foo": new Change(id, FILEMODE.BLOB),
            });
            const entry = yield secondTree.entryByPath("foo");
            assert.equal(entry.id().tostrS(), id.tostrS());
        }));
        it("rm directory but add new content", co.wrap(function *() {
            const repo = yield makeRepo();
            const id = yield hashObject(repo, "xxxxxxxh");
            const firstTree = yield TreeUtil.writeTree(repo, null, {
                "foo/bam": new Change(id, FILEMODE.BLOB),
            });
            const secondTree = yield TreeUtil.writeTree(repo, firstTree, {
                "foo": null,
                "foo/bar/baz": new Change(id, FILEMODE.BLOB),
            });
            let failed = false;
            try {
                yield secondTree.entryByPath("foo/bam");
            } catch (e) {
                failed = true;
            }
            assert(failed, "it's there");
        }));
        it("implicitly overwrite blob with directory", co.wrap(function *() {
            const repo = yield makeRepo();
            const blobAId = yield hashObject(repo, "xxxxxxxh");
            const parent = yield TreeUtil.writeTree(repo, null, {
                foo: new Change(blobAId, FILEMODE.BLOB),
            });
            const blobBId = yield hashObject(repo, "bazzzz");
            const result = yield TreeUtil.writeTree(repo, parent, {
                "foo/bar": new Change(blobBId, FILEMODE.BLOB),
            });
            const entry = yield result.entryByPath("foo/bar");
            assert.isNotNull(entry);
            assert(entry.isBlob());
            assert.equal(entry.id().tostrS(), blobBId.tostrS());
        }));
    });
    describe("hashFile", function () {
        it("breathing", co.wrap(function *() {
            const content = "abcdefg";
            const repo = yield TestUtil.createSimpleRepository();
            const filename = "foo";
            const filepath = path.join(repo.workdir(), filename);
            yield fs.writeFile(filepath, content);
            const result = yield TreeUtil.hashFile(repo, filename);
            const db = yield repo.odb();
            const BLOB = 3;
            const expected = yield db.write(content, content.length, BLOB);
            assert.equal(result.tostrS(), expected.tostrS());
        }));
    });
    describe("listWorkdirChanges", function () {
        const Change     = TreeUtil.Change;
        const FILESTATUS = RepoStatus.FILESTATUS;
        const Submodule  = RepoStatus.Submodule;
        const RELATION   = Submodule.COMMIT_RELATION;
        const FILEMODE   = NodeGit.TreeEntry.FILEMODE;
        it("removal", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const status = new RepoStatus({
                workdir: { foo: FILESTATUS.REMOVED },
            });
            const result = yield TreeUtil.listWorkdirChanges(repo, status,
                                                                        false);
            assert.deepEqual(result, { foo: null });
        }));
        it("modified", co.wrap(function *() {
            const content = "abcdefg";
            const repo = yield TestUtil.createSimpleRepository();
            const filename = "foo";
            const filepath = path.join(repo.workdir(), filename);
            yield fs.writeFile(filepath, content);
            const status = new RepoStatus({
                workdir: { foo: FILESTATUS.MODIFIED },
            });
            const result = yield TreeUtil.listWorkdirChanges(repo, status,
                                                                        false);
            const db = yield repo.odb();
            const BLOB = 3;
            const id  = yield db.write(content, content.length, BLOB);
            assert.deepEqual(Object.keys(result), ["foo"]);
            assert.equal(result.foo.id.tostrS(), id.tostrS());
            assert.equal(result.foo.mode, FILEMODE.BLOB);
        }));
        it("unchanged submodule", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const commit = "1111111111111111111111111111111111111111";
            const status = new RepoStatus({
                submodules: {
                    "sub": new RepoStatus.Submodule({
                        commit: new Submodule.Commit(commit, "/a"),
                        index: new Submodule.Index(commit,
                                                   "/a",
                                                   RELATION.SAME),
                        workdir: new Submodule.Workdir(new RepoStatus({
                            headCommit: commit,
                        }), RELATION.SAME),
                    }),
                },
            });
            const result = yield TreeUtil.listWorkdirChanges(repo, status,
                                                                        false);
            assert.deepEqual(result, {});
        }));
        it("submodule", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const commit = "1111111111111111111111111111111111111111";
            const status = new RepoStatus({
                submodules: {
                    "sub": new RepoStatus.Submodule({
                        commit: new Submodule.Commit("1", "/a"),
                        index: new Submodule.Index("1", "/a", RELATION.SAME),
                        workdir: new Submodule.Workdir(new RepoStatus({
                            headCommit: commit,
                        }), RELATION.AHEAD),
                    }),
                },
            });
            const result = yield TreeUtil.listWorkdirChanges(repo, status,
                                                                        false);
            assert.deepEqual(result, {
                sub: new Change(NodeGit.Oid.fromString(commit),
                                FILEMODE.COMMIT),
            });
        }));
        it("submodule with index change", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const commit = "1111111111111111111111111111111111111111";
            const status = new RepoStatus({
                submodules: {
                    "sub": new RepoStatus.Submodule({
                        commit: new Submodule.Commit("1", "/a"),
                        index: new Submodule.Index(commit,
                                                   "/a",
                                                    RELATION.AHEAD),
                        workdir: null,
                    }),
                },
            });
            const result = yield TreeUtil.listWorkdirChanges(repo, status,
                                                                        true);
            assert.deepEqual(result, {
                sub: new Change(NodeGit.Oid.fromString(commit),
                                FILEMODE.COMMIT),
            });
        }));
        it("new submodule with commit", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const commit = "1111111111111111111111111111111111111111";
            const modPath = path.join(repo.workdir(),
                                      SubmoduleConfigUtil.modulesFileName);
            // It doesn't matter what's in the file, just that the function
            // includes its contents.
            yield fs.writeFile(modPath, "foo");
            const modId = yield TreeUtil.hashFile(
                                          repo,
                                          SubmoduleConfigUtil.modulesFileName);
            const status = new RepoStatus({
                submodules: {
                    "sub": new RepoStatus.Submodule({
                        commit: null,
                        index: new Submodule.Index(null, "/a", null),
                        workdir: new Submodule.Workdir(new RepoStatus({
                            headCommit: commit,
                        }), RELATION.AHEAD),
                    }),
                },
            });
            const result = yield TreeUtil.listWorkdirChanges(repo, status,
                                                                        true);
            assert.deepEqual(result, {
                sub: new Change(NodeGit.Oid.fromString(commit),
                                FILEMODE.COMMIT),
                ".gitmodules": new Change(modId, FILEMODE.BLOB),
            });
        }));
        it("deleted submodule", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const modPath = path.join(repo.workdir(),
                                      SubmoduleConfigUtil.modulesFileName);
            // It doesn't matter what's in the file, just that the function
            // includes its contents.
            yield fs.writeFile(modPath, "foo");
            const modId = yield TreeUtil.hashFile(
                                          repo,
                                          SubmoduleConfigUtil.modulesFileName);

            const status = new RepoStatus({
                submodules: {
                    "sub": new RepoStatus.Submodule({
                        commit: new Submodule.Commit("1", "/a"),
                        index: null,
                        workdir: null,
                    }),
                },
            });
            const result = yield TreeUtil.listWorkdirChanges(repo, status,
                                                                        true);
            assert.deepEqual(result, {
                sub: null,
                ".gitmodules": new Change(modId, FILEMODE.BLOB),
            });
        }));
        it("untracked and index", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const status = new RepoStatus({
                index: {
                    foo: FILESTATUS.MODIFIED,
                },
                workdir: {
                    bar: FILESTATUS.ADDED,
                },
                submodules: {
                    baz: new Submodule({
                        commit: new Submodule.Commit("1", "/a"),
                        index: new Submodule.Index("1", "/a", RELATION.SAME),
                        workdir: new Submodule.Workdir(new RepoStatus({
                            headCommit: "1",
                        }), RELATION.SAME),
                    }),
                },
            });
            const result = yield TreeUtil.listWorkdirChanges(repo, status,
                                                                        false);
            assert.deepEqual(result, {});
        }));
        it("added, with includeUnstaged", co.wrap(function *() {
            const content = "abcdefg";
            const repo = yield TestUtil.createSimpleRepository();
            const filename = "foo";
            const filepath = path.join(repo.workdir(), filename);
            yield fs.writeFile(filepath, content);
            const status = new RepoStatus({
                workdir: { foo: FILESTATUS.ADDED, },
            });
            const result = yield TreeUtil.listWorkdirChanges(repo, status,
                                                                        true);
            const db = yield repo.odb();
            const BLOB = 3;
            const id  = yield db.write(content, content.length, BLOB);
            assert.deepEqual(Object.keys(result), ["foo"]);
            assert.equal(result.foo.id.tostrS(), id.tostrS());
            assert.equal(result.foo.mode, FILEMODE.BLOB);
        }));
        it("executable", co.wrap(function *() {
            const content = "abcdefg";
            const repo = yield TestUtil.createSimpleRepository();

            const filename1 = "foo";
            const filepath1 = path.join(repo.workdir(), filename1);
            yield fs.writeFile(filepath1, content, { mode: 0o744 });

            const filename2 = "bar";
            const filepath2 = path.join(repo.workdir(), filename2);
            yield fs.writeFile(filepath2, content, { mode: 0o744 });

            const status = new RepoStatus({
                workdir: { foo: FILESTATUS.MODIFIED, bar: FILESTATUS.ADDED },
            });

            const db = yield repo.odb();
            const BLOB = 3;
            const id  = yield db.write(content, content.length, BLOB);

            // executable ignoring new files
            let result = yield TreeUtil.listWorkdirChanges(repo, status,
                                                                        false);
            assert.deepEqual(Object.keys(result), ["foo"]);
            assert.equal(result.foo.id.tostrS(), id.tostrS());
            assert.equal(result.foo.mode, FILEMODE.EXECUTABLE);

            // executable including added files
            result = yield TreeUtil.listWorkdirChanges(repo, status,
                                                                    true);
            assert.deepEqual(Object.keys(result), ["foo", "bar"]);
            assert.equal(result.bar.id.tostrS(), id.tostrS());
            assert.equal(result.bar.mode, FILEMODE.EXECUTABLE);
        }));
    });
});
