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

/**
 * This module contains common git utility methods that do not require NodeGit
 * to accomplish. This is an optimization since loading NodeGit results in
 * unsatisfactory performance in the CLI.
 */

const fs           = require("fs-promise");
const path         = require("path");
// DO NOT REQUIRE NODEGIT

/**
 * If the directory identified by the specified `dir` contains a ".git"
 * directory, return it.  Otherwise, return the first parent directory of `dir`
 * containing a `.git` directory.  If no such directory exists, return `None`.
 *
 * @private
 * @param {String} dir
 * @return {String}
 */
function getContainingGitDir(dir) {
    const gitPath = path.join(dir, ".git");
    if (fs.existsSync(gitPath)) {
        if (fs.statSync(gitPath).isDirectory()) {
            return dir;                                               // RETURN
        }

        // If `.git` is a file, it is a git link. If the link is to a submodule
        // it will be relative.  If it's not relative, and therefore not a
        // submodule, we stop with this directory.

        const content = fs.readFileSync(gitPath, "utf8");
        const parts = content.split(" ");
        if (1 < parts.length && parts[1].startsWith("/")) {
            return dir;
        }
    }

    const base = path.dirname(dir);

    if ("" === base || "/" === base) {
        return null;                                                  // RETURN
    }

    return getContainingGitDir(base);
}

/**
 * Return the root of the repository in which the current working directory
 * resides, or null if the working directory contains no git repository.
 *
 * @return {String|null}
 */
exports.getRootGitDirectory = function () {
    return getContainingGitDir(process.cwd());
};