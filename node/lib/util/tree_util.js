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
const fs      = require("fs-promise");
const NodeGit = require("nodegit");
const path    = require("path");

const RepoStatus          = require("./repo_status");
const SubmoduleConfigUtil = require("./submodule_config_util");

/**
 * Return a nested tree mapping the flat structure in the specified `flatTree`,
 * which consists of a map of paths to values, into a hierarchical structure
 * beginning at the root.  For example, if the input is:
 *     { "a/b/c": 2, "a/b/d": 3}
 * the output will be:
 *     { a : { b: { c: 2, d: 3} } }
 *
 * @param {Object} flatTree
 * @return {Object}
 */
exports.buildDirectoryTree = function (flatTree) {
    let result = {};

    for (let subpath in flatTree) {
        const paths = subpath.split("/");
        let tree = result;

        // Navigate/build the tree until there is only one path left in paths,
        // then write the entry.

        for (let i = 0; i + 1 < paths.length; ++i) {
            const nextPath = paths[i];
            let nextTree = tree[nextPath];

            // If we have a null entry for something that we need to be a tree,
            // that means we've changed something that was an object into a
            // parent directory.  Otherwise, we need to build a new object for
            // this directory.

            if (undefined !== nextTree && null !== nextTree) {
                tree = tree[nextPath];
            }
            else {
                nextTree = {};
                tree[nextPath] = nextTree;
                tree = nextTree;
            }
        }
        const leafPath = paths[paths.length - 1];
        const leafData = tree[leafPath];
        const data = flatTree[subpath];

        // Similar to above, if we see something changed to null where we
        // alreaduy have data, we can ignore it.  This just means that
        // something we are removing is turning into a tree.

        if (undefined === leafData || null !== data) {
            tree[leafPath] = data;
        }
    }

   return result;
};

/**
 * `Change` is a value-semantic class representing a change to be registered
 * for path in a repository.
 */
class Change {

    /**
     * Create a new `Change` object having the specified object `id` and file
     * `mode`.
     *
     * @param {NodeGit.Oid}                id
     * @param {NodeGit.TreeEntry.FILEMODE} mode
     */
    constructor(id, mode) {
        this.d_id = id;
        this.d_mode = mode;
    }

    /**
     * @property {NodeGit.Oid}
     */
    get id() {
        return this.d_id;
    }

    /**
     * @property {NodeGit.TreeEntry.FILEMODE}
     */
    get mode() {
        return this.d_mode;
    }
}

exports.Change = Change;

/**
 * Return the tree created by applying the specified `changes` to the specified
 * `baseTree` (if provided) in the specified `repo`.  `changes` maps from path
 * to a change to write in the tree for that path, with a null entry indicating
 * that the path is to be removed.  The behavior is undefined if `null ===
 * baseTree` and any removals are specified in `changes`, if there are changes
 * specified that are not BLOB or COMMIT, or if there are conflicts between the
 * specified changes themselves or the base tree, such as:
 *
 * - removal for a path that doesn't exist
 * - a path change for an entry that logically must contain a tree
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Tree|null}  baseTree
 * @param {Object}             changes map from path to `Change`
 * @return {NodeGit.Tree}
 */
exports.writeTree = co.wrap(function *(repo, baseTree, changes) {
    assert.instanceOf(repo, NodeGit.Repository);
    if (null !== baseTree) {
        assert.instanceOf(baseTree, NodeGit.Tree);
    }
    assert.isObject(changes);

    // First, aggregate the flat mapping from path to change into a
    // hierarchical map.

    const directory = exports.buildDirectoryTree(changes);

    // TODO: This is a workaround for a bug in nodegit.  The contract for
    // libgit2's `treebuilder` is to not free the `tree_entry` objects that its
    // methods return until your done with the `treebuilder` object that
    // returned them -- then you must free them else leak.  Nodegit, however,
    // appears to be freeing them as each `tree_entry` is GC'd; this seems to
    // be the normal way the bindings work and I imagine it's a mechanical
    // thing.  The workaround is to stick all the `tree_entry` objects we see
    // into an array whose lifetime is scoped to that of this method.
    //
    // Nodegit issue on github: https://github.com/nodegit/nodegit/issues/1333

    const treeEntries = [];

    // This method does the real work, but assumes an already aggregated
    // directory structure.

    const writeSubtree = co.wrap(function *(parentTree, subDir, basePath) {
        const builder = yield NodeGit.Treebuilder.create(repo, parentTree);
        for (let filename in subDir) {
            const entry = subDir[filename];
            const fullPath = path.join(basePath, filename);

            if (null === entry) {
                // Null means the entry was deleted.

                builder.remove(filename);
            }
            else if (entry instanceof Change) {
                const inserted =
                      builder.insert(filename, entry.id, entry.mode);
                treeEntries.push(inserted);
            }
            else {
                let subtree;
                let treeEntry = null;

                // If we have a directory that was removed in `changes`, we do
                // not want to base it on the original parent tree.

                if (null !== changes[fullPath] && null !== parentTree) {
                    try {
                        treeEntry = yield parentTree.entryByPath(filename);
                    }
                    catch (e) {
                        // 'filename' didn't exist in 'parentTree'
                    }
                }
                if (null !== treeEntry && treeEntry.isTree()) {
                    treeEntries.push(treeEntry);
                    const treeId = treeEntry.id();
                    const curTree = yield repo.getTree(treeId);
                    subtree = yield writeSubtree(curTree, entry, fullPath);
                }
                else {
                    subtree = yield writeSubtree(null, entry, fullPath);
                }
                if (0 === subtree.entryCount()) {
                    builder.remove(filename);
                }
                else {
                    const inserted = builder.insert(
                                        filename,
                                        subtree.id(),
                                        NodeGit.TreeEntry.FILEMODE.TREE);
                    treeEntries.push(inserted);
                }
            }
        }
        const id = yield builder.write();
        return yield repo.getTree(id);
    });
    return yield writeSubtree(baseTree, directory, "");
});

/**
 * Return an blob ID for the specified `filename` in the specified `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             filename
 * @return {NodeGit.Oid}
 */
exports.hashFile = co.wrap(function* (repo, filename) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(filename);

    const filepath = path.join(repo.workdir(), filename);
    return yield NodeGit.Blob.createFromDisk(repo, filepath);
});

/**
 * Return a map from path to `Change` for the working directory of the
 * specified `repo` having the specified `status`.  If the specified
 * `includeUnstaged` is true, include unstaged changes.
 *
 * @param {NodeGit.Repository} repo
 * @param {RepoStatus}         status
 * @param {Boolean}            includeUnstaged
 * @return {Object}
 */
exports.listWorkdirChanges = co.wrap(function *(repo, status, includeUnstaged) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(status, RepoStatus);
    assert.isBoolean(includeUnstaged);

    let touchedModules = false;
    const FILESTATUS = RepoStatus.FILESTATUS;
    const FILEMODE = NodeGit.TreeEntry.FILEMODE;

    const result = {};

    // first, plain files.

    const workdir = status.workdir;
    for (let subpath in workdir) {
        let filemode = FILEMODE.EXECUTABLE;
        const fullpath = path.join(repo.workdir(), subpath);
        try {
            yield fs.access(fullpath, fs.constants.X_OK);
        } catch (e) {
            // if unable to execute, use BLOB.
            filemode = FILEMODE.BLOB;
        }
        switch (workdir[subpath]) {
            case FILESTATUS.ADDED:
                if (includeUnstaged) {
                    const sha = yield exports.hashFile(repo, subpath);
                    result[subpath] = new Change(sha, filemode);
                }
                break;
            case FILESTATUS.MODIFIED:
                const sha = yield exports.hashFile(repo, subpath);
                result[subpath] = new Change(sha,filemode);
                break;
            case FILESTATUS.REMOVED:
                result[subpath] = null;
                break;
        }
    }

    // then submodules; we're adding open submodules with different HEAD
    // commits.

    const submodules = status.submodules;
    const SAME = RepoStatus.Submodule.COMMIT_RELATION.SAME;
    for (let name in submodules) {
        const sub = submodules[name];
        const wd = sub.workdir;
        let sha = null;
        touchedModules = touchedModules ||
            null === sub.commit ||
            null === sub.index ||
            sub.index.url !== sub.commit.url;
        if (null !== wd && SAME !== wd.relation) {
            sha = wd.status.headCommit;
        }
        else if (null === sub.commit && null !== sub.index) {
            sha = sub.index.sha;
        }
        else if (null === wd && null === sub.index) {
            result[name] = null;
        }
        else if (null === wd && SAME !== sub.index.relation) {
            sha = sub.index.sha;
        }
        if (null !== sha) {
            result[name] = new Change(NodeGit.Oid.fromString(sha),
                                      FILEMODE.COMMIT);

        }
    }

    if (touchedModules) {
        const modulesName = SubmoduleConfigUtil.modulesFileName;
        const id = yield exports.hashFile(repo, modulesName);
        result[modulesName] = new Change(id, FILEMODE.BLOB);
    }

    return result;
});
