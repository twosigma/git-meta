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

    for (let path in flatTree) {
        const paths = path.split("/");
        let tree = result;

        // Navigate/build the tree until there is only one path left in paths,
        // then write the entry.

        for (let i = 0; i + 1 < paths.length; ++i) {
            const nextPath = paths[i];
            if (nextPath in tree) {
                tree = tree[nextPath];
                assert.isObject(tree, `for path ${path}`);
            }
            else {
                const nextTree = {};
                tree[nextPath] = nextTree;
                tree = nextTree;
            }
        }
        const leafPath = paths[paths.length - 1];
        assert.notProperty(tree, leafPath, `duplicate entry for ${path}`);
        const data = flatTree[path];
        tree[leafPath] = data;
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

    // This method does the real work, but assumes an already aggregated
    // directory structure.

    const writeSubtree = co.wrap(function *(parentTree, subDir) {
        const builder = yield NodeGit.Treebuilder.create(repo, parentTree);
        for (let filename in subDir) {
            const entry = subDir[filename];

            if (null === entry) {
                // Null means the entry was deleted.

                builder.remove(filename);
            }
            else if (entry instanceof Change) {
                yield builder.insert(filename, entry.id, entry.mode);
            }
            else {
                let subtree;
                let treeEntry = null;
                if (null !== parentTree) {
                    try {
                        treeEntry = yield parentTree.entryByPath(filename);
                    }
                    catch (e) {
                        // 'filename' didn't exist in 'parentTree'
                    }
                }
                if (null !== treeEntry) {
                    assert(treeEntry.isTree(), `${filename} should be a tree`);
                    const treeId = treeEntry.id();
                    const curTree = yield repo.getTree(treeId);
                    subtree = yield writeSubtree(curTree, entry);
                }
                else {
                    subtree = yield writeSubtree(null, entry);
                }
                if (0 === subtree.entryCount()) {
                    builder.remove(filename);
                }
                else {
                    yield builder.insert(filename,
                                         subtree.id(),
                                         NodeGit.TreeEntry.FILEMODE.TREE);
                }
            }
        }
        const id = builder.write();
        return yield repo.getTree(id);
    });
    return yield writeSubtree(baseTree, directory);
});
