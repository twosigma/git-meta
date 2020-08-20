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
const path    = require("path");

const RepoASTTestUtil     = require("../../lib/util/repo_ast_test_util");
const BulkNotesUtil       = require("../../lib/util/bulk_notes_util");

describe("BulkNotesUtil", function () {
describe("shardSha", function () {
    it("breathing", function () {
        assert.equal(BulkNotesUtil.shardSha("aabbffffffffffffffff"),
                     path.join("aa", "bb", "ffffffffffffffff"));
    });
});
describe("writeNotes", function () {
    it("with a parent", co.wrap(function *() {
        const ref = "refs/notes/foo/bar";
        const written = yield RepoASTTestUtil.createRepo(`
S:C2-1;H=2;N ${ref} 1=hello`);
        const repo = written.repo;
        const foo = yield repo.getHeadCommit();
        const fooSha = foo.id().tostrS();
        const first = (yield foo.getParents())[0];
        const firstSha = first.id().tostrS();
        const newNotes = {};
        newNotes[fooSha] = "foobar";
        yield BulkNotesUtil.writeNotes(repo, ref, newNotes);
        const result = {};
        const shas = [];
        yield NodeGit.Note.foreach(repo, ref, (_, sha) => {
            shas.push(sha);
        });
        yield shas.map(co.wrap(function *(sha) {
            const note = yield NodeGit.Note.read(repo, ref, sha);
            result[sha] = note.message();
        }));
        const expected = newNotes;
        newNotes[firstSha] = "hello";
        assert.deepEqual(result, expected);
    }));
    it("no parents", co.wrap(function *() {
        const ref = "refs/notes/foo/bar";
        const written = yield RepoASTTestUtil.createRepo("S:C2-1;H=2");
        const repo = written.repo;
        const foo = yield repo.getHeadCommit();
        const fooSha = foo.id().tostrS();
        const first = (yield foo.getParents())[0];
        const firstSha = first.id().tostrS();
        const newNotes = {};
        newNotes[firstSha] = "hello";
        newNotes[fooSha] = "foobar";
        yield BulkNotesUtil.writeNotes(repo, ref, newNotes);
        const result = {};
        const shas = [];
        yield NodeGit.Note.foreach(repo, ref, (_, sha) => {
            shas.push(sha);
        });
        yield shas.map(co.wrap(function *(sha) {
            const note = yield NodeGit.Note.read(repo, ref, sha);
            result[sha] = note.message();
        }));
        const expected = newNotes;
        assert.deepEqual(result, expected);
    }));
});
describe("readNotes", function () {
    it("empty", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S:C2-1;Bfoo=2");
        const repo = written.repo;
        const refName = "refs/notes/foo/bar";
        const result = yield BulkNotesUtil.readNotes(repo, refName);
        assert.deepEqual(result, {});
    }));
    it("breathing", co.wrap(function *() {
        const written = yield RepoASTTestUtil.createRepo("S:C2-1;Bfoo=2");
        const repo = written.repo;
        const head = yield repo.getHeadCommit();
        const headSha = head.id().tostrS();
        const foo = yield repo.getBranchCommit("foo");
        const fooSha = foo.id().tostrS();
        const refName = "refs/notes/foo/bar";
        const sig = yield repo.defaultSignature();
        yield NodeGit.Note.create(repo, refName, sig, sig, fooSha, "foo", 1);
        yield NodeGit.Note.create(repo, refName, sig, sig, headSha, "bar", 1);
        const result = yield BulkNotesUtil.readNotes(repo, refName);
        const expected = {};
        expected[fooSha] = "foo";
        expected[headSha] = "bar";
        assert.deepEqual(result, expected);
    }));
    it("sharded, from `writeNotes`", co.wrap(function *() {
        const ref = "refs/notes/foo/bar";
        const written = yield RepoASTTestUtil.createRepo("S:C2-1;H=2");
        const repo = written.repo;
        const foo = yield repo.getHeadCommit();
        const fooSha = foo.id().tostrS();
        const first = (yield foo.getParents())[0];
        const firstSha = first.id().tostrS();
        const newNotes = {};
        newNotes[firstSha] = "hello";
        newNotes[fooSha] = "foobar";
        yield BulkNotesUtil.writeNotes(repo, ref, newNotes);
        const result = yield BulkNotesUtil.readNotes(repo, ref);
        assert.deepEqual(result, newNotes);
    }));
});
describe("parseNotes", function () {
    it("breathing", function () {
        const obj = { foo: "bar" };
        const str = JSON.stringify(obj, null, 4);
        const input = { yay: str };
        const result = BulkNotesUtil.parseNotes(input);
        assert.deepEqual(result, { yay: obj });
    });
});
});
