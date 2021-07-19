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

const assert  = require("chai").assert;
const co      = require("co");
const NodeGit = require("nodegit");

const RepoStatus          = require("./repo_status");

const DELTA = NodeGit.Diff.DELTA;

exports.UNTRACKED_FILES_OPTIONS = {
    ALL: "all",
    NORMAL: "normal",
    NO: "no",
};

/**
 * Return the `RepoStatus.FILESTATUS` value that corresponds to the specified
 * flag.  The behavior is undefined unless `flag` represents one of the types
 * convertible to `FILESTATUS`.
 *
 * @param {NodeGit.Diff.DELTA} flag
 * @return {RepoStatus.FILESTATUS}
 */
exports.convertDeltaFlag = function (flag) {
    const FILESTATUS = RepoStatus.FILESTATUS;
    switch (flag) {
        case DELTA.MODIFIED: return FILESTATUS.MODIFIED;
        case DELTA.ADDED: return FILESTATUS.ADDED;
        case DELTA.DELETED: return FILESTATUS.REMOVED;
        case DELTA.RENAMED: return FILESTATUS.RENAMED;
        case DELTA.TYPECHANGE: return FILESTATUS.TYPECHANGED;

        // Status changes in `RepoStatus` objects are separated into `staged`
        // and `workdir` maps.  Files that are "added" in the workdir are
        // implicitly untracked.

        case DELTA.UNTRACKED: return FILESTATUS.ADDED;
    }
    assert(false, `Unrecognized DELTA type: ${flag}.`);
};

function readDiff(diff) {
    const result = {};
    const FILESTATUS = RepoStatus.FILESTATUS;
    const numDeltas = diff.numDeltas();
    for (let i = 0;  i < numDeltas; ++i) {
        const delta = diff.getDelta(i);
        const diffStatus = delta.status();
        if (DELTA.CONFLICTED === diffStatus) {
            continue;                                               // CONTINUE
        }
        const fileStatus = exports.convertDeltaFlag(diffStatus);
        const file = FILESTATUS.REMOVED === fileStatus ?
                     delta.oldFile() :
                     delta.newFile();
        const path = file.path();

        if (FILESTATUS.MODIFIED === fileStatus &&
            delta.newFile().id().equal(delta.oldFile().id())) {
            // This file isn't actually changed -- it's just being reported
            // as changed because it differs from the index (even though
            // the index isn't really for contents).
            continue;
        }

        // Skip the all submodule changes; they're handled separately.
        if (NodeGit.TreeEntry.FILEMODE.COMMIT !== file.mode()) {
            result[path] = fileStatus;
        }
    }
    return result;
}

/**
 * Do not use this on the meta repo because it uses libgit2 operations
 * with bad performance and without the ability to handle sparse checkouts.
 *
 * Return differences for the specified `paths` in the specified `repo` between
 * the current index and working directory, and the specified `tree`, if
 * not null.  If the specified `untrackedFilesOption` is ALL, include all
 * untracked files. If it is NORMAL, accumulate them by directory. If it is NO,
 * don't show untracked files. If `paths` is empty, check the entire `repo`.
 * If the specified `ignoreIndex` is true, return, in the `workdir` field, the
 * status difference between the workdir and `tree`, ignoring the state of the
 * index.  Otherwise, return, in the `workdir` field, the difference between
 * the workir and the index; and in the `staged` field, the difference between
 * the index and `tree`.  Note that when `ignoreIndex` is true, the returned
 * `staged` field will always be `{}`. Note also that conflicts are ignored; we
 * don't have enough information here to handle them properly.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Tree|null} tree
 * @param {String []} paths
 * @param {Boolean} ignoreIndex
 * @param {String} untrackedFilesOption
 * @return {Object}
 * @return {Object} return.staged path to FILESTATUS of staged changes
 * @return {Object} return.workdir path to FILESTATUS of workdir changes
 */
exports.getRepoStatus = co.wrap(function *(repo,
                                           tree,
                                           paths,
                                           ignoreIndex,
                                           untrackedFilesOption) {
    assert.instanceOf(repo, NodeGit.Repository);
    if (null !== tree) {
        assert.instanceOf(tree, NodeGit.Tree);
    }
    assert.isArray(paths);
    assert.isBoolean(ignoreIndex);
    if (!untrackedFilesOption) {
        untrackedFilesOption = exports.UNTRACKED_FILES_OPTIONS.NORMAL;
    }

    const options = {
        ignoreSubmodules: 1,
        flags: NodeGit.Diff.OPTION.IGNORE_SUBMODULES,
    };
    if (0 !== paths.length) {
        options.pathspec = paths;
    }

    switch (untrackedFilesOption) {
        case exports.UNTRACKED_FILES_OPTIONS.ALL:
            options.flags = options.flags |
                            NodeGit.Diff.OPTION.INCLUDE_UNTRACKED |
                            NodeGit.Diff.OPTION.RECURSE_UNTRACKED_DIRS;
            break;
        case exports.UNTRACKED_FILES_OPTIONS.NORMAL:
            options.flags = options.flags |
                            NodeGit.Diff.OPTION.INCLUDE_UNTRACKED;
            break;
        case exports.UNTRACKED_FILES_OPTIONS.NO:
            break;
    }

    if (ignoreIndex) {
        const workdirToTreeDiff =
              yield NodeGit.Diff.treeToWorkdirWithIndex(repo,
                                                        tree,
                                                        options);
        const workdirToTreeStatus = readDiff(workdirToTreeDiff);
        return {
            staged: {},
            workdir: workdirToTreeStatus,
        };
    }
    const index = yield repo.index();
    const workdirToIndexDiff =
                       yield NodeGit.Diff.indexToWorkdir(repo, index, options);
    const workdirToIndexStatus = readDiff(workdirToIndexDiff);
    const indexToTreeDiff =
            yield NodeGit.Diff.treeToIndex(repo, tree, null, options);
    const indexToTreeStatus = readDiff(indexToTreeDiff);
    return {
        staged: indexToTreeStatus,
        workdir: workdirToIndexStatus,
    };
});
