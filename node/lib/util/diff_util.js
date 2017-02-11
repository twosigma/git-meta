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
const SubmoduleConfigUtil = require("./submodule_config_util");

/**
 * Return the `RepoStatus.FILESTATUS` value that corresponds to the specified
 * flag.  The behavior is undefined unless `flag` represents one of the types
 * convertible to `FILESTATUS`.
 *
 * @param {NodeGit.Diff.DELTA} flag
 * @return {RepoStatus.FILESTATUS}
 */
exports.convertDeltaFlag = function (flag) {
    const DELTA = NodeGit.Diff.DELTA;
    const FILESTATUS = RepoStatus.FILESTATUS;
    switch (flag) {
        case DELTA.MODIFIED: return FILESTATUS.MODIFIED;
        case DELTA.ADDED: return FILESTATUS.ADDED;
        case DELTA.DELETED: return FILESTATUS.REMOVED;
        case DELTA.CONFLICTED: return FILESTATUS.CONFLICTED;
        case DELTA.RENAMED: return FILESTATUS.RENAMED;
        case DELTA.TYPECHANGE: return FILESTATUS.TYPECHANGED;

        // Status changes in `RepoStatus` objects are separated into `staged`
        // and `workdir` maps.  Files that are "added" in the workdir are
        // implicitly untracked.

        case DELTA.UNTRACKED: return FILESTATUS.ADDED;
    }
    assert(`Unrecognized DELTA type: ${flag}.`);
};

function readDiff(diff) {
    const result = {};
    const FILESTATUS = RepoStatus.FILESTATUS;
    const numDeltas = diff.numDeltas();
    for (let i = 0;  i < numDeltas; ++i) {
        const delta = diff.getDelta(i);
        const diffStatus = delta.status();
        const fileStatus = exports.convertDeltaFlag(diffStatus);
        const file = FILESTATUS.REMOVED === fileStatus ?
                     delta.oldFile() :
                     delta.newFile();
        const path = file.path();

        // Skip the .gitmodules file and all submodule changes; they're handled
        // separately.

        if (SubmoduleConfigUtil.modulesFileName !== path &&
            NodeGit.TreeEntry.FILEMODE.COMMIT !== file.mode()) {
            result[path] = fileStatus;
        }
    }
    return result;
}

/**
 * Return differences for the specified `paths` in the specified `repo` between
 * the current index and working directory, and the specified `tree`, if
 * not null.  If the specified `allUntracked` is true, include all untracked
 * files rather than accumulating them by directory.  If `paths` is empty,
 * check the entire `repo`.  If the specified `workdirToTree` is true,
 * calculate workdir differences from the `tree`; otherwise, calculate
 * them between the workdir and the index of `repo`.  When calculating a diff
 * to compute changes to stage with a `-a` option (stage modified files), for
 * example, you need to `workdirToTree` to be true.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Tree|null} tree
 * @param {String []} paths
 * @param {Boolean} workdirToTree
 * @param {Boolean} allUntracked
 * @return {Object}
 * @return {Object} return.staged path to FILESTATUS of staged changes
 * @return {Object} return.workdir path to FILESTATUS of workdir changes
 */
exports.getRepoStatus = co.wrap(function *(repo,
                                           tree,
                                           paths,
                                           workdirToTree,
                                           allUntracked) {
    assert.instanceOf(repo, NodeGit.Repository);
    if (null !== tree) {
        assert.instanceOf(tree, NodeGit.Tree);
    }
    assert.isArray(paths);
    assert.isBoolean(workdirToTree);
    assert.isBoolean(allUntracked);

    const options = {
        ignoreSubmodules: 1,
        flags: NodeGit.Diff.OPTION.INCLUDE_UNTRACKED |
               NodeGit.Diff.OPTION.EXCLUDE_SUBMODULES,
    };
    if (0 !== paths.length) {
        options.pathspec = paths;
    }
    if (allUntracked) {
        options.flags = options.flags |
                        NodeGit.Diff.OPTION.RECURSE_UNTRACKED_DIRS;
    }
    const index = yield repo.index();
    const workdirToIndexDiff =
                       yield NodeGit.Diff.indexToWorkdir(repo, index, options);
    const workdirToIndexStatus = readDiff(workdirToIndexDiff);
    if (!workdirToTree) {
        const indexToTreeDiff =
            yield NodeGit.Diff.treeToIndex(repo, tree, null, options);
        const indexToTreeStatus = readDiff(indexToTreeDiff);
        return {
            staged: indexToTreeStatus,
            workdir: workdirToIndexStatus,
        };
    }
    const workdirToTreeDiff =
                   yield NodeGit.Diff.treeToWorkdir(repo, tree, options);
    const workdirToTreeStatus = readDiff(workdirToTreeDiff);
    const staged = {};
    const workdir = {};

    // `workdirToTreeStatus` contains all differences between the working
    // directory and `tree`: staged and unstaged.  We characterize files having
    // no change between the workdir and the index as being staged, and all
    // else as workdir.

    Object.keys(workdirToTreeStatus).forEach(path => {
        const change = workdirToTreeStatus[path];
        if (!(path in workdirToIndexStatus)) {
            staged[path] = change;
        }
        else {
            workdir[path] = change;
        }
    });

    return {
        staged: staged,
        workdir: workdir,
    };
});
