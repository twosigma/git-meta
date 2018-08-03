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

const assert         = require("chai").assert;
const co             = require("co");
const Hook           = require("../../lib/util/hook");
const path           = require("path");
const fs             = require("fs-promise");
const TestUtil       = require("../../lib/util/test_util");

describe("Hook", function () {
    describe("execHook", function () {
        // 1. Hook does not exist, no error throws.
        it("hook_does_not_exist", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const hookName = "fake_hook";
            assert.doesNotThrow(
                function () {
                    //Nothing happened, no error throws.
                },
                yield Hook.execHook(repo, hookName)
            );
        }));

        // 2. Hook exists.
        it("hook_exists", co.wrap(function *() {
            const hookName = "real_hook";
            const repo = yield TestUtil.createSimpleRepository();
            const workDir = repo.workdir();
            process.chdir(workDir);
            const hooksDir = path.join(workDir, ".git/hooks");
            const hookFile = path.join(hooksDir, hookName);
            const hookOutputFile = path.join(hooksDir, "hook_test");
            yield fs.writeFile(hookFile,
                  "#!/bin/bash \necho 'it is a test hook' >" + hookOutputFile);
            yield fs.chmod(hookFile, "755");
            yield Hook.execHook(repo, hookName);
            assert.ok(fs.existsSync(hookOutputFile), "File does not exists");
            assert.equal(fs.readFileSync(hookOutputFile, "utf8"),
                "it is a test hook\n");
        }));
    });
});
