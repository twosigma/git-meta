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

const assert = require("chai").assert;
const co     = require("co");
const fs     = require("fs-promise");
const path   = require("path");

const MergeFileUtil  = require("../../lib//util/merge_file_util");
const Merge          = require("../../lib//util/merge");
const TestUtil       = require("../../lib/util/test_util");

describe("MergeFileUtil", function () {
    describe("readMerge", function () {
        it("found", co.wrap(function *() {
            const tempDir = yield TestUtil.makeTempDir();
            const gitDir = path.join(tempDir, "META_MERGE");
            yield fs.mkdir(gitDir);
            yield fs.writeFile(path.join(gitDir, "MSG"), "hello world\n");
            yield fs.writeFile(path.join(gitDir, "ORIG_HEAD"), "123\n");
            yield fs.writeFile(path.join(gitDir, "MERGE_HEAD"), "456\n");
            const result = yield MergeFileUtil.readMerge(tempDir);
            assert.deepEqual(result, new Merge("hello world\n", "123", "456"));
        }));
        it("not found", co.wrap(function *() {
            const tempDir = yield TestUtil.makeTempDir();
            const gitDir = path.join(tempDir, "META_MERGE");
            yield fs.mkdir(gitDir);
            yield fs.writeFile(path.join(gitDir, "MSG"), "hello world\n");
            yield fs.writeFile(path.join(gitDir, "ORIG_HEAD"), "123\n");
            const result = yield MergeFileUtil.readMerge(tempDir);
            assert.isNull(result);
        }));
    });
    it("writeMerge", co.wrap(function *() {
        const tempDir = yield TestUtil.makeTempDir();
        const merge = new Merge("foo\n", "bar", "baz");
        yield MergeFileUtil.writeMerge(tempDir, merge);
        const root = path.join(tempDir, "META_MERGE");
        const message = yield fs.readFile(path.join(root, "MSG"), "utf8");
        assert.equal(message, "foo\n");
        const originalHead = yield fs.readFile(path.join(root, "ORIG_HEAD"),
                                         "utf8");
        assert.equal(originalHead, "bar\n");
        const mergeHead = yield fs.readFile(path.join(root, "MERGE_HEAD"),
                                            "utf8");
        assert.equal(mergeHead, "baz\n");
    }));
    it("cleanMerge", co.wrap(function *() {
        const tempDir = yield TestUtil.makeTempDir();
        yield MergeFileUtil.writeMerge(tempDir,
                                       new Merge("hey", "there", "all"));
        yield MergeFileUtil.cleanMerge(tempDir);
        const result = yield MergeFileUtil.readMerge(tempDir);
        assert.isNull(result);
    }));
});
