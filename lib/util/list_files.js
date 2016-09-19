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

const assert  = require("chai").assert;
const co      = require("co");
const NodeGit = require("nodegit");
const path    = require("path");

const SubmoduleConfigUtil = require("./submodule_config_util");
const SubmoduleUtil       = require("./submodule_util");

/**
 * Return the files in the index of the specified `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @return [String]
 */
const listFilesForRepo = co.wrap(function *(repo) {
    const index = yield repo.index();
    const entries = index.entries();
    return entries.map(entry => entry.path);
});

/**
 * Return a list the files in the specified `repo` and its *open* submodules,
 * relative to the root of the repository, or to the optionally specified
 * `relativePath` if provided.  Note that the order of the list is
 * not defined.  Note that if `relativePath` is provided, no files will be
 * listed that are not within that subdirectory.  The behavior is undefined
 * unless `relativePath` (if provided) is a valid relative path and has no
 * trailing slash.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             [relativePath]
 * @return [String]
 */
exports.listFiles = co.wrap(function *(repo, relativePath) {
    assert.instanceOf(repo, NodeGit.Repository);
    if (undefined !== relativePath && null !== relativePath) {
        assert.isString(relativePath);
        assert.notEqual(relativePath, "");
        assert.notEqual(relativePath[relativePath.length - 1], "/");
        assert(!path.isAbsolute(relativePath));
    }
    const subNames = new Set(yield SubmoduleUtil.getSubmoduleNames(repo));
    const openSubs = yield SubmoduleUtil.listOpenSubmodules(repo);

    const result = [];

    let withSlash;  // the relative path with a suffixed '/'
    if (relativePath) {
        withSlash = relativePath + "/";
    }

    /**
     * Return true if the specified `filePath` is contained in `relativePath`
     * and false otherwise.
     */
    function inRelativePath(filePath) {
        return filePath.startsWith(withSlash);
    }

    /**
     * Add the specified `filePath` to the `result` array if not filtered.  If
     * there is a relative path, remove the relative path from `filePath`
     * before adding to `result`.
     */
    function addPath(filePath) {
        if (relativePath) {
            if (inRelativePath(filePath)) {
                const relative = path.relative(relativePath, filePath);
                result.push(relative);
            }
        }
        else {
            result.push(filePath);
        }
    }

    // First look at all the files in the meta-repo, ignoring submodules
    // `.gitmodules` file.

    (yield listFilesForRepo(repo)).forEach(name => {
        if (!subNames.has(name) &&
            SubmoduleConfigUtil.modulesFileName !== name) {
            addPath(name);
        }
    });

    // Then list files in submodules.

    yield openSubs.map(co.wrap(function *(name) {

        // If we have a relative path, optimize by skipping submodules whose
        // contents would be omitted.  Include the contents of this submodule
        // if the relative path is one of the roots of the submodules path (its
        // name starts with relative path), or if the relative path is actually
        // inside the submodule (the submodule name is a prefix of the relative
        // path).

        if (relativePath &&
           !(inRelativePath(name) || withSlash.startsWith(name + "/"))) {
            return [];                                                // RETURN
        }

        const subRepo = yield SubmoduleUtil.getRepo(repo, name);
        const files = yield listFilesForRepo(subRepo);
        files.forEach(filePath => {
            const fullPath = path.join(name, filePath);
            addPath(fullPath);
        });
    }));
    return result;
});
