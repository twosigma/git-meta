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

/**
 * This module contains methods for accessing files that pertain to in-progress
 * rebases.  We are separate them from `util/rebase.js` because they are used
 * by `read_repo_ast_util`, which is at a lower level than `rebase.js`.  I can
 * find no methods exposed by `NodeGit` or plain Git for "finding" the current
 * rebase directory -- which can have many different names such as
 * "rebase-merge" or "rebase-apply".  There are
 */

const co      = require("co");
const assert  = require("chai").assert;
const path    = require("path");
const fs      = require("fs-promise");

const Rebase    = require("./rebase");
const UserError = require("./user_error");

/**
 * Return the name of any directory in the specified `gitDir` that could
 * contain rebasing information, or null if no such directory is found.  The
 * behavior is undefined unless `gitDir` is a directory.
 *
 * @param {String} gitDir
 * @return {String|null}
 */
exports.findRebasingDir = co.wrap(function *(gitDir) {
    assert.isString(gitDir);
    const files = yield fs.readdir(gitDir);
    const rebaseCheck = /^rebase-(apply|merge)$/;
    for (let i = 0; i < files.length; ++i) {
        const name = files[i];
        if (null !== rebaseCheck.exec(name)) {
            const stat = yield fs.stat(path.join(gitDir, name));
            if (stat.isDirectory()) {
                return name;
            }
        }
    }
    return null;
});

/**
 * the name of the file where the name of the head used to start the rebase is
 * stored
 * @property {String} headFileName
 */
exports.headFileName = "head-name";

/**
 * Return the state of the in-progress rebase of the repo at the specified
 * `gitDir` path, or `null` if there is no rebase information to find in
 * `gitDir`.  The behavior is undefined unless `gitDir` is a directory.
 *
 * @param {NodeGit.Repository} repo
 * @return {Rebase}
 */
exports.readRebase = co.wrap(function *(gitDir) {
    assert.isString(gitDir);
    const rebasingDirName = yield exports.findRebasingDir(gitDir);

    // No rebasing directory means not rebasing; return null.

    if (null === rebasingDirName) {
        return null;                                                  // RETURN
    }

    const rebasingDir = path.join(gitDir, rebasingDirName);

    let headName;
    let originalHead;
    let onto;

    // Try to read old head 
    try {
        headName = yield fs.readFile(path.join(rebasingDir,
                                               exports.headFileName),
                                     "utf-8");
        originalHead = yield fs.readFile(path.join(rebasingDir, "orig-head"),
                                          "utf-8");
        onto = yield fs.readFile(path.join(rebasingDir, "onto"),
                                  "utf-8");
    }
    catch (e) {
        throw new UserError(`Malformed rebasing directory \
                            ${path.join(gitDir, rebasingDir)}: ${e.message}.`);
    }
    function rmNewline(data) {
        return data.split("\n")[0];
    }
    return new Rebase(rmNewline(headName),
                      rmNewline(originalHead),
                      rmNewline(onto));
});
