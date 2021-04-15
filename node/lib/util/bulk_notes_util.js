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

const assert         = require("chai").assert;
const ChildProcess   = require("child-process-promise");
const co             = require("co");
const NodeGit        = require("nodegit");
const path           = require("path");

const ConfigUtil          = require("./config_util");
const DoWorkQueue         = require("./do_work_queue");
const GitUtil             = require("./git_util");
const TreeUtil            = require("./tree_util");

/**
 * Return a sharded path for the specified `sha`, e.g.
 * "aabbffffffffffffffff" becomes: "aa/bb/ffffffffffffffff".  The behavior is
 * undefined unless `sha` contains at least five characters.
 *
 * @param {String} sha
 * @return {String}
 */
exports.shardSha = function (sha) {
    return path.join(sha.substr(0, 2), sha.substr(2, 2), sha.substr(4));
};

/**
 * This is a workaround for a missing libgit2 feature.  Normally, we
 * would use something like Reference.createMatching, but it doesn't support
 * asserting that a ref didn't previously exist.  See
 * https://github.com/libgit2/libgit2/pull/5842
 */
const updateRef = co.wrap(function*(repo, refName, commit, old, reflog) {
    try {
        yield ChildProcess.exec(
            `git -C ${repo.path()} update-ref -m '${reflog}' ${refName} \
${commit} ${old}`);
        return true;
    } catch (e) {
        return false;
    }
});

const tryWriteNotes = co.wrap(function *(repo, refName, contents) {
    // We're going to directly write the tree/commit for a new
    // note containing `contents`.

    let currentTree = null;
    const parents = [];
    const ref = yield GitUtil.getReference(repo, refName);
    if (null !== ref) {
        const currentCommit = yield repo.getCommit(ref.target());
        parents.push(currentCommit);
        currentTree = yield currentCommit.getTree();
    }
    const odb = yield repo.odb();
    const changes = {};
    const ODB_BLOB = 3;
    const BLOB = NodeGit.TreeEntry.FILEMODE.BLOB;
    const writeBlob = co.wrap(function *(sha) {
        const content = contents[sha];
        const blobId = yield odb.write(content, content.length, ODB_BLOB);
        const sharded = exports.shardSha(sha);
        changes[sharded] = new TreeUtil.Change(blobId, BLOB);
    });
    yield DoWorkQueue.doInParallel(Object.keys(contents), writeBlob);

    const newTree = yield TreeUtil.writeTree(repo, currentTree, changes);
    const sig = yield ConfigUtil.defaultSignature(repo);
    const commit = yield NodeGit.Commit.create(repo,
                                               null,
                                               sig,
                                               sig,
                                               null,
                                               "git-meta updating notes",
                                               newTree,
                                               parents.length,
                                               parents);

    let old;
    if (null === ref) {
        old = "0000000000000000000000000000000000000000";
    } else {
        old = ref.target().tostrS();
    }
    return yield updateRef(repo, refName, commit.tostrS(), old, "updated");
});

/**
 * Write the specified `contents` to the note having the specified `refName` in
 * the specified `repo`.
 *
 * Writing notes oneo-at-a-time is slow.  This method let's you write them in
 * bulk, far more efficiently.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             refName
 * @param {Object}             contents    SHA to data
 */
exports.writeNotes = co.wrap(function *(repo, refName, contents) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(refName);
    assert.isObject(contents);

    if (0 === Object.keys(contents).length) {
        // Nothing to do if no contents; no point in making an empty commit or
        // in making clients check themselves.
        return;                                                       // RETURN
    }

    const retryCount = 3;
    let success;
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    for (let i = 0; i < retryCount; i++) {
        success = yield tryWriteNotes(repo, refName, contents);
        if (success) {
            return;
        } else {
            let suffix;
            if (i === retryCount - 1) {
                suffix = "giving up";
            } else {
                suffix = "retrying";
                yield sleep(500);
            }
            console.warn(`Failed to update notes ref ${refName}, ${suffix}`);
        }
    }
    if (!success) {
        throw new Error("Failed to update notes ref ${refName} after retries");
    }
});


/**
 * Load, into the specified `result`, note entries found in the specified
 * `tree`, prefixing their key with the specified `basePath`.  If subtrees are
 * found, recurse.  Use the specified `repo` to read trees from their IDs.
 *
 * @param {Object}       result
 * @param {NodeGit.Tree} tree
 * @param {String}       basePath
 */
const processTree = co.wrap(function *(result, repo, tree, basePath) {
    const entries = tree.entries();
    const processEntry = co.wrap(function *(e) {
        const fullPath = basePath + e.name();
        if (e.isBlob()) {
            const blob = yield e.getBlob();
            result[fullPath] = blob.toString();
        } else if (e.isTree()) {
            // Recurse if we find a tree,

            const id = e.id();
            const nextTree = yield repo.getTree(id);
            yield processTree(result, repo, nextTree, fullPath);
        }
        // Ignore anything that's neither blob nor tree.
    });
    yield DoWorkQueue.doInParallel(entries, processEntry);
});

/**
 * Return the contents of the note having the specified `refName` in the
 * specified `repo` or an empty object if no such note exists.
 *
 * Reading notes one-at-a-time is slow.  This method lets you read them all at
 * once for a given ref.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             refName
 * @return {Object} sha to content
 */
exports.readNotes = co.wrap(function *(repo, refName) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(refName);

    const ref = yield GitUtil.getReference(repo, refName);
    if (null === ref) {
        return {};
    }
    const result = {};
    const commit = yield repo.getCommit(ref.target());
    const tree = yield commit.getTree();
    yield processTree(result, repo, tree, "");
    return result;
});

/**
 * Return the result of transforming the specified `map` so that each of the
 * (string) values are replaced by the result of JSON parsing them.
 *
 * @param {Object} map     string to string
 * @return {Object} map    string to object
 */
exports.parseNotes = function (map) {
    const result = {};
    for (let key in map) {
        result[key] = JSON.parse(map[key]);
    }
    return result;
};
