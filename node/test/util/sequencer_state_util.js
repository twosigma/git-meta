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

const assert = require("chai").assert;
const co     = require("co");
const fs     = require("fs-promise");
const mkdirp = require("mkdirp");
const path   = require("path");

const SequencerState      = require("../../lib//util/sequencer_state");
const SequencerStateUtil  = require("../../lib//util/sequencer_state_util");
const TestUtil            = require("../../lib/util/test_util");

const CommitAndRef = SequencerState.CommitAndRef;

describe("SequencerStateUtil", function () {
describe("readFile", function () {
    it("exists", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "foo"), "1234\n");
        const result = yield SequencerStateUtil.readFile(gitDir, "foo");
        assert.equal(result, "1234\n");
    }));
    it("missing", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const result = yield SequencerStateUtil.readFile(gitDir, "foo");
        assert.isNull(result);
    }));
});
describe("readCommitAndRef", function () {
    it("nothing", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const result = yield SequencerStateUtil.readCommitAndRef(gitDir,
                                                                 "foo");
        assert.isNull(result);
    }));
    it("just a sha", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "foo"), "1234\n");
        const result = yield SequencerStateUtil.readCommitAndRef(gitDir,
                                                                 "foo");
        assert.instanceOf(result, CommitAndRef);
        assert.equal(result.sha, "1234");
        assert.isNull(result.ref);
    }));
    it("sha and a ref", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "foo"), "12\n34\n");
        const result = yield SequencerStateUtil.readCommitAndRef(gitDir,
                                                                 "foo");
        assert.instanceOf(result, CommitAndRef);
        assert.equal(result.sha, "12");
        assert.equal(result.ref, "34");
    }));
    it("too few", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "foo"), "12");
        const result = yield SequencerStateUtil.readCommitAndRef(gitDir,
                                                                 "foo");
        assert.isNull(result);
    }));
    it("too many", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "foo"), "1\n2\n3\n");
        const result = yield SequencerStateUtil.readCommitAndRef(gitDir,
                                                                 "foo");
        assert.isNull(result);
    }));
});
describe("readCommits", function () {
    it("got commits", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "COMMITS"), "1\n2\n3\n");
        const result = yield SequencerStateUtil.readCommits(gitDir);
        assert.deepEqual(result, ["1", "2", "3"]);
    }));
    it("missing commits file", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const result = yield SequencerStateUtil.readCommits(gitDir);
        assert.isNull(result);
    }));
    it("no commits in file", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "COMMITS"), "");
        const result = yield SequencerStateUtil.readCommits(gitDir);
        assert.isNull(result);
    }));
});
describe("readCurrentCommit", function () {
    it("good", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "CURRENT_COMMIT"), "1\n");
        const result = yield SequencerStateUtil.readCurrentCommit(gitDir, 2);
        assert.equal(result, 1);
    }));
    it("missing", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const result = yield SequencerStateUtil.readCurrentCommit(gitDir, 2);
        assert.isNull(result);
    }));
    it("no lines", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "CURRENT_COMMIT"), "");
        const result = yield SequencerStateUtil.readCurrentCommit(gitDir, 2);
        assert.isNull(result);
    }));
    it("non", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "CURRENT_COMMIT"), "x\n");
        const result = yield SequencerStateUtil.readCurrentCommit(gitDir, 2);
        assert.isNull(result);
    }));
    it("bad index", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "CURRENT_COMMIT"), "2\n");
        const result = yield SequencerStateUtil.readCurrentCommit(gitDir, 2);
        assert.isNull(result);
    }));
});
describe("readSequencerState", function () {
    it("good state", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "TYPE"),
                           SequencerState.TYPE.MERGE + "\n");
        yield fs.writeFile(path.join(fileDir, "ORIGINAL_HEAD"), "24\n");
        yield fs.writeFile(path.join(fileDir, "TARGET"), "12\n34\n");
        yield fs.writeFile(path.join(fileDir, "COMMITS"), "1\n2\n3\n");
        yield fs.writeFile(path.join(fileDir, "CURRENT_COMMIT"), "1\n");
        const result = yield SequencerStateUtil.readSequencerState(gitDir);
        assert.instanceOf(result, SequencerState);
        assert.equal(result.type, SequencerState.TYPE.MERGE);
        assert.equal(result.originalHead.sha, "24");
        assert.isNull(result.originalHead.ref);
        assert.equal(result.target.sha, "12");
        assert.equal(result.target.ref, "34");
        assert.deepEqual(result.commits, ["1", "2", "3"]);
        assert.equal(result.currentCommit, 1);
        assert.isNull(result.message);
    }));
    it("good state with message", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "TYPE"),
                           SequencerState.TYPE.MERGE + "\n");
        yield fs.writeFile(path.join(fileDir, "ORIGINAL_HEAD"), "24\n");
        yield fs.writeFile(path.join(fileDir, "TARGET"), "12\n34\n");
        yield fs.writeFile(path.join(fileDir, "COMMITS"), "1\n2\n3\n");
        yield fs.writeFile(path.join(fileDir, "CURRENT_COMMIT"), "1\n");
        yield fs.writeFile(path.join(fileDir, "MESSAGE"), "foo\n");
        const result = yield SequencerStateUtil.readSequencerState(gitDir);
        assert.instanceOf(result, SequencerState);
        assert.equal(result.type, SequencerState.TYPE.MERGE);
        assert.equal(result.originalHead.sha, "24");
        assert.isNull(result.originalHead.ref);
        assert.equal(result.target.sha, "12");
        assert.equal(result.target.ref, "34");
        assert.deepEqual(result.commits, ["1", "2", "3"]);
        assert.equal(result.currentCommit, 1);
        assert.equal(result.message, "foo\n");
    }));
    it("bad type", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "ORIGINAL_HEAD"), "24\n");
        yield fs.writeFile(path.join(fileDir, "TARGET"), "12\n34\n");
        yield fs.writeFile(path.join(fileDir, "COMMITS"), "1\n2\n3\n");
        yield fs.writeFile(path.join(fileDir, "CURRENT_COMMIT"), "1\n");
        const result = yield SequencerStateUtil.readSequencerState(gitDir);
        assert.isNull(result);
    }));
    it("wrong type", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "TYPE"), "foo\n");
        yield fs.writeFile(path.join(fileDir, "ORIGINAL_HEAD"), "24\n");
        yield fs.writeFile(path.join(fileDir, "TARGET"), "12\n34\n");
        yield fs.writeFile(path.join(fileDir, "COMMITS"), "1\n2\n3\n");
        yield fs.writeFile(path.join(fileDir, "CURRENT_COMMIT"), "1\n");
        const result = yield SequencerStateUtil.readSequencerState(gitDir);
        assert.isNull(result);
    }));
    it("bad head", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "TYPE"),
                           SequencerState.TYPE.MERGE + "\n");
        yield fs.writeFile(path.join(fileDir, "TARGET"), "12\n34\n");
        yield fs.writeFile(path.join(fileDir, "COMMITS"), "1\n2\n3\n");
        yield fs.writeFile(path.join(fileDir, "CURRENT_COMMIT"), "1\n");
        const result = yield SequencerStateUtil.readSequencerState(gitDir);
        assert.isNull(result);
    }));
    it("bad target", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "TYPE"),
                           SequencerState.TYPE.MERGE + "\n");
        yield fs.writeFile(path.join(fileDir, "ORIGINAL_HEAD"), "24\n");
        yield fs.writeFile(path.join(fileDir, "COMMITS"), "1\n2\n3\n");
        yield fs.writeFile(path.join(fileDir, "CURRENT_COMMIT"), "1\n");
        const result = yield SequencerStateUtil.readSequencerState(gitDir);
        assert.isNull(result);
    }));
    it("bad commits", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "TYPE"),
                           SequencerState.TYPE.MERGE + "\n");
        yield fs.writeFile(path.join(fileDir, "ORIGINAL_HEAD"), "24\n");
        yield fs.writeFile(path.join(fileDir, "TARGET"), "12\n34\n");
        yield fs.writeFile(path.join(fileDir, "CURRENT_COMMIT"), "1\n");
        const result = yield SequencerStateUtil.readSequencerState(gitDir);
        assert.isNull(result);
    }));
    it("bad commits length", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "TYPE"),
                           SequencerState.TYPE.MERGE + "\n");
        yield fs.writeFile(path.join(fileDir, "ORIGINAL_HEAD"), "24\n");
        yield fs.writeFile(path.join(fileDir, "TARGET"), "12\n34\n");
        yield fs.writeFile(path.join(fileDir, "COMMITS"), "1\n2\n3\n");
        yield fs.writeFile(path.join(fileDir, "CURRENT_COMMIT"), "4\n");
        const result = yield SequencerStateUtil.readSequencerState(gitDir);
        assert.isNull(result);
    }));
    it("bad current commit", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        yield fs.writeFile(path.join(fileDir, "TYPE"),
                           SequencerState.TYPE.MERGE + "\n");
        yield fs.writeFile(path.join(fileDir, "ORIGINAL_HEAD"), "24\n");
        yield fs.writeFile(path.join(fileDir, "TARGET"), "12\n34\n");
        yield fs.writeFile(path.join(fileDir, "COMMITS"), "1\n2\n3\n");
        const result = yield SequencerStateUtil.readSequencerState(gitDir);
        assert.isNull(result);
    }));
});
describe("cleanSequencerState", function () {
    it("breathe", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const fileDir = path.join(gitDir, "meta_sequencer");
        mkdirp.sync(fileDir);
        const filePath = path.join(fileDir, "TYPE");
        yield fs.writeFile(filePath, SequencerState.TYPE.MERGE);
        yield fs.readFile(filePath, "utf8");
        yield SequencerStateUtil.cleanSequencerState(gitDir);
        let gone = false;
        try {
            yield fs.readFile(filePath, "utf8");
        } catch (e) {
            gone = true;
        }
        assert(gone);
    }));
});
describe("writeSequencerState", function () {
    it("breathe", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const original = new CommitAndRef("a", null);
        const target = new CommitAndRef("b", "c");
        const initial = new SequencerState({
            type: SequencerState.TYPE.REBASE,
            originalHead: original,
            target: target,
            commits: ["1", "2"],
            currentCommit: 0
        });
        yield SequencerStateUtil.writeSequencerState(gitDir, initial);
        const read = yield SequencerStateUtil.readSequencerState(gitDir);
        assert.deepEqual(read, initial);
    }));
    it("with message", co.wrap(function *() {
        const gitDir = yield TestUtil.makeTempDir();
        const original = new CommitAndRef("a", null);
        const target = new CommitAndRef("b", "c");
        const initial = new SequencerState({
            type: SequencerState.TYPE.REBASE,
            originalHead: original,
            target: target,
            commits: ["1", "2"],
            currentCommit: 0,
            message: "mahaha",
        });
        yield SequencerStateUtil.writeSequencerState(gitDir, initial);
        const read = yield SequencerStateUtil.readSequencerState(gitDir);
        assert.deepEqual(read, initial);
    }));
});
describe("mapCommits", function () {
    const cases = {
        "just one to map": {
            sequencer: new SequencerState({
                type: SequencerState.TYPE.REBASE,
                originalHead: new CommitAndRef("1", null),
                target: new CommitAndRef("1", "foo"),
                currentCommit: 0,
                commits: ["1"],
                message: "foo",
            }),
            commitMap: {
                "1": "2",
            },
            expected: new SequencerState({
                type: SequencerState.TYPE.REBASE,
                originalHead: new CommitAndRef("2", null),
                target: new CommitAndRef("2", "foo"),
                currentCommit: 0,
                commits: ["2"],
                message: "foo",
            }),
        },
        "multiple": {
            sequencer: new SequencerState({
                type: SequencerState.TYPE.REBASE,
                originalHead: new CommitAndRef("1", null),
                target: new CommitAndRef("2", "foo"),
                currentCommit: 0,
                commits: ["1", "3"],
            }),
            commitMap: {
                "1": "2",
                "2": "4",
                "3": "8",
            },
            expected: new SequencerState({
                type: SequencerState.TYPE.REBASE,
                originalHead: new CommitAndRef("2", null),
                target: new CommitAndRef("4", "foo"),
                currentCommit: 0,
                commits: ["2", "8"],
            }),
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, function () {
            const result = SequencerStateUtil.mapCommits(c.sequencer,
                                                         c.commitMap);
            assert.instanceOf(result, SequencerState);
            assert.deepEqual(result, c.expected);
        });
    });
});
});
