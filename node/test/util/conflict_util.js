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
const fs      = require("fs-promise");
const NodeGit = require("nodegit");
const path    = require("path");

const ConflictUtil        = require("../../lib/util/conflict_util");
const GitUtil             = require("../../lib/util/git_util");
const TestUtil            = require("../../lib/util/test_util");

describe("ConflictUtil", function () {
const ConflictEntry = ConflictUtil.ConflictEntry;
const Conflict = ConflictUtil.Conflict;
describe("ConflictEntry", function () {
    it("breathe", function () {
        const entry = new ConflictUtil.ConflictEntry(2, "1");
        assert.equal(entry.mode, 2);
        assert.equal(entry.id, "1");
    });
});
describe("Conflict", function () {
    it("breathe", function () {
        const ancestor = new ConflictEntry(2, "1");
        const our = new ConflictEntry(3, "1");
        const their = new ConflictEntry(4, "1");
        const conflict = new Conflict(ancestor, our, their);
        assert.equal(conflict.ancestor, ancestor);
        assert.equal(conflict.our, our);
        assert.equal(conflict.their, their);

        const nullC = new Conflict(null, null, null);
        assert.isNull(nullC.ancestor);
        assert.isNull(nullC.our);
        assert.isNull(nullC.their);
    });
});
describe("addConflict", function () {
    const FILEMODE = NodeGit.TreeEntry.FILEMODE;
    it("existing", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        const makeEntry = co.wrap(function *(data) {
            const id = yield GitUtil.hashObject(repo, data);
            return new ConflictEntry(FILEMODE.BLOB, id.tostrS());
        });
        const ancestor = yield makeEntry("xxx");
        const our = yield makeEntry("yyy");
        const their = yield makeEntry("zzz");
        const index = yield repo.index();
        const conflict = new Conflict(ancestor, our, their);
        const filename = "README.md";
        yield ConflictUtil.addConflict(index, filename, conflict);
        yield index.write();
        yield fs.writeFile(path.join(repo.workdir(), filename), "foo");
        const ancestorEntry = index.getByPath(filename, 1);
        assert.equal(ancestorEntry.id, ancestor.id);
        const ourEntry = index.getByPath(filename, 2);
        assert.equal(ourEntry.id, our.id);
        const theirEntry = index.getByPath(filename, 3);
        assert.equal(theirEntry.id, their.id);
    }));
    it("multiple values", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        const makeEntry = co.wrap(function *(data) {
            const id = yield GitUtil.hashObject(repo, data);
            return new ConflictEntry(FILEMODE.BLOB, id.tostrS());
        });
        const ancestor = yield makeEntry("xxx");
        const our = yield makeEntry("yyy");
        const their = yield makeEntry("zzz");
        const conflict = new Conflict(ancestor, our, their);
        const index = yield repo.index();
        const path = "foo/bar.md";
        yield ConflictUtil.addConflict(index, path, conflict);
        const ancestorEntry = index.getByPath(path, 1);
        assert.equal(ancestorEntry.id, ancestor.id);
        const ourEntry = index.getByPath(path, 2);
        assert.equal(ourEntry.id, our.id);
        const theirEntry = index.getByPath(path, 3);
        assert.equal(theirEntry.id, their.id);
    }));
    it("with null", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        const makeEntry = co.wrap(function *(data) {
            const id = yield GitUtil.hashObject(repo, data);
            return new ConflictEntry(FILEMODE.BLOB, id.tostrS());
        });
        const ancestor = yield makeEntry("xxx");
        const their = yield makeEntry("zzz");
        const conflict = new Conflict(ancestor, null, their);
        const index = yield repo.index();
        const path = "foo/bar.md";
        yield ConflictUtil.addConflict(index, path, conflict);
        const ancestorEntry = index.getByPath(path, 1);
        assert.equal(ancestorEntry.id, ancestor.id);
        const ourEntry = index.getByPath(path, 2);
        assert.equal(ourEntry, null);
        const theirEntry = index.getByPath(path, 3);
        assert.equal(theirEntry.id, their.id);
    }));
});
});
