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

const assert    = require("chai").assert;
const spawn     = require("child-process-promise").spawn;
const co        = require("co");
const path      = require("path");
const process   = require("process");
const fs        = require("fs");

/**
 * Check if git-meta hook with given hook name exists
 * Return true if hook exists.
 * @param {String} name
 * @return {Boolean}
 */
exports.hasHook = function (repo, name) {
    assert.isString(name);

    const rootDirectory = repo.path();
    const hookPath = path.join(rootDirectory, "hooks");
    const absPath = path.resolve(hookPath, name);

    return fs.existsSync(absPath);
};

/**
 * Run git-meta hook with given hook name.
 * Return true on success or hook does not exist, false otherwise.
 * @async
 * @param {String} name
 * @param {String[]} args
 * @return {Boolean}
 */
exports.execHook = co.wrap(function*(repo, name, args=[], env={}) {
    assert.isString(name);

    const rootDirectory = repo.path();
    const hookPath = path.join(rootDirectory, "hooks");
    const absPath = path.resolve(hookPath, name);

    if (!fs.existsSync(absPath)) {
        return true;
    }

    try {
        process.chdir(repo.workdir());
        const subEnv = {};
        Object.assign(subEnv, process.env);
        Object.assign(subEnv, env);
        yield spawn(absPath, args, { stdio: "inherit", env: subEnv });
        return true;
    } catch (e) {
        if (e.code === "EACCES") {
            console.log("EACCES: Cannot execute: " + absPath);
        } else if (e.stdout) {
            console.log(e.stdout);
        }
        return false;
    }
});
