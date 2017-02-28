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
const NodeGit = require("nodegit");

const TestUtil = require("../../lib/util/test_util");
const TreeUtil = require("../../lib/util/tree_util");

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
    });
});
