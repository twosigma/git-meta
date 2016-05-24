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
 * This module contains methods for closing local sub repositories.
 */

const co      = require("co");
const rimraf  = require("rimraf");
const path    = require("path");
const fs      = require("fs-promise");

/**
 * Backup the modules directory for the submodule having the specified 'name'
 * in the repo located at the specified 'root'. It will be backed up to
 * .git/metabackups/name<date>
 * @param {String} root
 * @param {String} name
 */
exports.cleanModulesDirectory = co.wrap(function *(root, name) {

    const backupDir = path.join(root, ".git", "metabackups");
    const rmModDir = new Promise(callback => {
        return rimraf(backupDir, {}, callback);
    });
    yield rmModDir;

    yield fs.mkdir(backupDir);

    const submoduleModuleDir = path.join(root, ".git", "modules", name);

    const date = new Date();
    const backupModuleDir = path.join(backupDir, name + "-" + date.getTime())

    yield fs.rename(submoduleModuleDir, backupModuleDir);
    console.log("Created a backup at " + backupModuleDir);
});

/**
 * Close the repository having the specified `submoduleName` in the specified
 * `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             submoduleName
 */
exports.close = co.wrap(function *(repo, submoduleName) {

    // This operation is a major pain, first because libgit2 does not provide
    // any direct methods to do the equivalent of 'git deinit', and second
    // because nodegit does not expose the method that libgit2 does provide to
    // delete an entry from the config file.

    // De-initting a submodule requires two things:
    // 1. Remove all files under the path of the submodule, but not the
    //    directory itself, which would look to Git as if we were trying
    //    to remove the submodule.
    // 2. Remove the entry for the submodule from the '.git/config' file.
    // 3. Remove the directory .git/modules/<submodule>

    // First, we will clear out the path for the submodule.

    const rootDir = repo.workdir();
    const submodulePath = path.join(rootDir, submoduleName);
    const files = yield fs.readdir(submodulePath);

    // Use 'rimraf' on each top level entry in the submodule'.

    const removeFiles = files.map(filename => {
        return new Promise(callback => {
            return rimraf(path.join(submodulePath, filename), {}, callback);
        });
    });

    yield removeFiles;

    // Using a very stupid algorithm here to find and remove the submodule
    // entry.  This logic could be smarter (maybe use regexes) and more
    // efficition (stream in and out).

    const configPath = path.join(rootDir, ".git", "config");
    const configText = yield fs.readFile(configPath, "utf8");
    const configLines = configText.split("\n");
    const newConfigLines = [];
    const searchString = "[submodule \"" + submoduleName + "\"]";

    let found = false;
    let inSubmoduleConfig = false;

    // Loop through the file and push, onto 'newConfigLines' any lines that
    // aren't part of the bad submodule section.

    for (let i = 0; i < configLines.length; ++i) {
        let line = configLines[i];
        if (!found && !inSubmoduleConfig && line === searchString) {
            inSubmoduleConfig = true;
            found = true;
        }
        else if (inSubmoduleConfig) {
            // If we see a line starting with "[" while we're in the submodule
            // section, we can get out of it.

            if (0 !== line.length && line[0] === "[") {
                inSubmoduleConfig = false;
            }
        }
        if (!inSubmoduleConfig) {
            newConfigLines.push(line);
        }
    }

    // If we didn't find the submodule, don't write the data back out.

    if (found) {
        newConfigLines.push("");  // one more new line
        yield fs.writeFile(configPath, newConfigLines.join("\n"));
    }

    // Finally, remove the .git/modules/<submodule> directory
    yield exports.cleanModulesDirectory(rootDir, submoduleName);
});
