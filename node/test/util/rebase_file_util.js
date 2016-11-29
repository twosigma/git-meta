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

const assert = require("chai").assert;
const co     = require("co");
const fs     = require("fs-promise");
const path   = require("path");

const RebaseFileUtil = require("../../lib//util/rebase_file_util");
const Rebase         = require("../../lib//util/rebase");
const TestUtil       = require("../../lib/util/test_util");
const UserError      = require("../../lib/util/user_error");

describe("findRebasingDir", function () {

    // We're going to create a test directory consisting of a set of files and
    // sub-directories as input to `findRebasingDir`.  Because we make no
    // guarantee of which directory we'll choose, the expected result is an
    // array of acceptable results.

    const cases = {
        "empty": {
            inputDirs: [],
            inputFiles: [],
            expected: [],
        },
        "wrong dirs and files": {
            inputDirs: ["foo", "bar"],
            inputFiles: ["baz", "boom"],
            expected: [],
        },
        "matching apply": {
            inputDirs: ["rebase-apply"],
            inputFiles: ["foo"],
            expected: ["rebase-apply"],
        },
        "matching merge": {
            inputDirs: ["rebase-merge"],
            inputFiles: ["foo"],
            expected: ["rebase-merge"],
        },
        "matching dirs": {
            inputDirs: ["rebase-merge", "rebase-apply"],
            inputFiles: ["foo"],
            expected: ["rebase-merge", "rebase-apply"],
        },
        "matching dir and some not": {
            inputDirs: ["rebase-apply", "rbase-bar"],
            inputFiles: ["foo"],
            expected: ["rebase-apply"],
        },
        "matching file but not dir": {
            inputDirs: [],
            inputFiles: ["rebase-baz"],
            expected: [],
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const tempDir = yield TestUtil.makeTempDir();
            yield c.inputDirs.map(co.wrap(function *(name) {
                yield fs.mkdir(path.join(tempDir, name));
            }));
            yield c.inputFiles.map(co.wrap(function *(name) {
                yield fs.writeFile(path.join(tempDir, name), "");
            }));
            const result = yield RebaseFileUtil.findRebasingDir(tempDir);
            if (0 === c.expected.length) {
                assert.equal(result, null);
            }
            else {
                assert.oneOf(result, c.expected);
            }
        }));
    });
});

describe("readRebase", function () {
    // Here, we will synthesize rebasing dirs and see if `readRebase`: (a)
    // properly calls into `findRebasingDir` and returns `null` when no such
    // directory is found; (b) reads and parses the right files; and (c) throw
    // as UserError when files are missing.

    const cases = {
        "bad dir": {
            rebaseDir: "foo",
            files: {},
            expected: null,
        },
        "good files": {
            rebaseDir: "rebase-apply",
            files: {
                "head-name": "my-head",
                "orig-head": "1111",
                "onto": "2222"
            },
            expected: new Rebase("my-head", "1111", "2222"),
        },
        "good files with newlines": {
            rebaseDir: "rebase-apply",
            files: {
                "head-name": "my-head\n",
                "orig-head": "1111\n",
                "onto": "2222\n"
            },
            expected: new Rebase("my-head", "1111", "2222"),
        },
        "missing head name": {
            rebaseDir: "rebase-apply",
            files: {
                "orig-head": "1111",
                "onto": "2222"
            },
            expected: new Rebase("my-head", "1111", "2222"),
            fails: true,
        },
        "missing original head": {
            rebaseDir: "rebase-apply",
            files: {
                "head-name": "my-head",
                "onto": "2222"
            },
            expected: new Rebase("my-head", "1111", "2222"),
            fails: true,
        },
        "missing onto": {
            rebaseDir: "rebase-apply",
            files: {
                "head-name": "my-head",
                "orig-head": "1111",
            },
            expected: new Rebase("my-head", "1111", "2222"),
            fails: true,
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const tempDir = yield TestUtil.makeTempDir();
            const rebaseDir = path.join(tempDir, c.rebaseDir);
            yield fs.mkdir(rebaseDir);
            yield Object.keys(c.files).map(co.wrap(function *(name) {
                yield fs.writeFile(path.join(rebaseDir, name), c.files[name]);
            }));
            let result;
            try {
                result = yield RebaseFileUtil.readRebase(tempDir);
            }
            catch (e) {
                if (!c.fails) {
                    throw e;
                }
                if (!(e instanceof UserError)) {
                    throw e;
                }
                return;                                               // RETURN
            }
            assert(!c.fails, "expected failure");
            assert.deepEqual(result, c.expected);
        }));
    });
});
