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

const assert    = require("chai").assert;
const co        = require("co");
const colors    = require("colors");
const fs        = require("fs-promise");
const NodeGit   = require("nodegit");
const path      = require("path");

const Status        = require("./status");
const SubmoduleUtil = require("./submodule_util");
const UserError     = require("./user_error");

/**
 * Stage modified content at the specified `paths` in the specified `repo`.  If
 * a path in `paths` refers to a file, stage it; if it refers to  a directory,
 * stage all modified content rooted at that path, including that in open
 * submodules.  Note that a path of "" is taken to indicate the entire
 * repository.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String []}          paths
 */
exports.stagePaths = co.wrap(function *(repo, paths) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isArray(paths);

    // `stagePaths` has to handle two specific special cases:
    // 1. If a path points into a submodule, we need to split it up and work
    //    off the relative part in the submodule.
    // 2. If a path contains a submodule, we need to stage everything in the
    //    submodule.

    const workdir = repo.workdir();

    const subsToAdd = {};  // map from sub name to array of files to stage

    let processPath;  // forward declaration, used in mutual-recursion with
                      // `processSubmodulePath`

    function processSubmodulePath(subName, subs, pathInSub) {
        let toAddToSub = subsToAdd[subName];
        if (undefined === toAddToSub) {
            toAddToSub = [];
            subsToAdd[subName] = toAddToSub;
        }
        return processPath(toAddToSub,
                           subName,
                           subs[subName].repoStatus.workdir,
                           {},
                           pathInSub);
    }

    processPath = co.wrap(function *(destToAdd,
                                     subName,
                                     workdirChanges,
                                     subs,
                                     relPath) {
        // Skip the '.git' directory.

        if (".git" === relPath) {
            return;                                                   // RETURN
        }

        // If this path refers directly to a file that has working directory
        // changes, add it to the list of files to stage and return.

        if ("" !== relPath && relPath in workdirChanges) {
            destToAdd.push(relPath);
            return;                                                   // RETURN
        }

        // If  this path is a submodule, recurse into it (or do nothing if the
        // sub isn't open.

        if (relPath in subs) {
            const sub = subs[relPath];
            if (sub.repoStatus) {
                yield processSubmodulePath(relPath, subs, "");
            }
            return;                                                   // RETURN
        }

        // Otherwise, compute the absolute value of the path and see if it's a
        // directory.

        const absPath = path.join(workdir, subName, relPath);
        let stat;
        try {
            stat = yield fs.stat(absPath);
        }
        catch (e) {
            // Display the relative path with the submodule name (empty if not
            // in a submodule).
            throw new UserError(`
Invalid path: ${colors.red(path.join(subName, relPath))}.`);
        }

        // If this path is a directory, recurse with each file in it.

        if (stat.isDirectory()) {
            const subPaths = yield fs.readdir(absPath);
            yield subPaths.map(subFilename => {
                return processPath(destToAdd,
                                   subName,
                                   workdirChanges,
                                   subs,
                                   path.join(relPath, subFilename));
            });
        }

        // If we've reached this point, `relPath` referred to an unchanged
        // file.
    });

    const toAdd = [];  // Will contain a list of files to stage

    const status = yield Status.getRepoStatus(repo, {
        showAllUntracked: true,
    });
    const subs = status.submodules;
    const openSubNames = Object.keys(subs).filter(subName => {
        return null !== subs[subName].repoStatus;
    });

    // Process all the provided `paths`.  After this yield, `toAdd` will
    // contain all paths to add in the meta-repo, and `subsToAdd` will contain
    // all the subs to add for each submodule.

    yield paths.map(filename => {
        // If `filename` references a file inside a submodule, we need to
        // handle it specially.  Checking each file against the name of each
        // open submodule has potentially N^2 behavior, but it will be unlikely
        // to be an issue unless there are a large number of paths passed to
        // `add` and a large number of open submodules, in which case I imagine
        // that the cost of this check will not be the bottleneck anyway.

        for (let i = 0; i < openSubNames.length; ++i) {
            const subName = openSubNames[i];
            if (filename.startsWith(subName)) {
                // Slice off the part of `filename` that is after the submodule
                // name prefix and the `/` that comes after it.  This is the
                // path relative to the root of the submodule.

                const pathInSub = filename.slice(subName.length + 1,
                                                 filename.length);
                return processSubmodulePath(subName, subs, pathInSub);
            }
        }

        return processPath(toAdd, "", status.workdir, subs, filename);
    });

    const addPaths = co.wrap(function *(repoToAddTo, pathsToAdd) {
        const index = yield repoToAddTo.index();
        yield pathsToAdd.map(filename => index.addByPath(filename));
        yield index.write();
    });

    // Do the actual adds for the meta-repo.

    yield addPaths(repo, toAdd);


    // And all the adds for each subrepo.

    yield Object.keys(subsToAdd).map(co.wrap(function *(subName) {
        const subRepo = yield SubmoduleUtil.getRepo(repo, subName);
        yield addPaths(subRepo, subsToAdd[subName]);
    }));

});
