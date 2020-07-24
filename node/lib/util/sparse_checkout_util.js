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

const assert  = require("chai").assert;
const co      = require("co");
const fs      = require("fs-promise");
const NodeGit = require("nodegit");
const path    = require("path");

const ConfigUtil = require("./config_util");

/**
 * This module contains methods for interacting with Git's sparse checkout
 * facility, that is not supported by libgit2.
 */

/**
 * Return the path to the sparse checkout file for the specified `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @return {String}
 */
exports.getSparseCheckoutPath = function (repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    return path.join(repo.path(), "info", "sparse-checkout");
};

/**
 * Return true if the specified `repo` is in sparse mode and false otherwise.
 * A repo is in sparse mode iff: `core.sparsecheckout` is true.
 *
 * @param {NodeGit.Repository} repo
 * @return {Bool}
 */
exports.inSparseMode = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    return (yield ConfigUtil.configIsTrue(repo, "core.sparsecheckout")) ||
        false;
});

/**
 * Configure the specified `repo` to be in sparse-checkout mode --
 * specifically, our sparse checkout mode where everything but `.gitmodules` is
 * excluded.  Note that this method is just for testing; to make it work in a
 * real environment you'd also need to udpate the index entries and the
 * sparse-checkout file for open submodules.
 *
 * @param {NodeGit.Repository} repo
 */
exports.setSparseMode = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const config = yield repo.config();
    yield config.setString("core.sparsecheckout", "true");
    yield fs.writeFile(exports.getSparseCheckoutPath(repo), ".gitmodules\n");
});

/**
 * This bit is set in the `flagsExtended` field of a `NodeGit.Index.Entry` for
 * paths that should be skipped due to sparse checkout.
 */
const SKIP_WORKTREE = 1 << 14;

/**
 * Return the contents of the `.git/info/sparse-checkout` file for the
 * specified `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @return {String}
 */
exports.readSparseCheckout = function (repo) {
    assert.instanceOf(repo, NodeGit.Repository);
    const filePath = exports.getSparseCheckoutPath(repo);
    try {
        return fs.readFileSync(filePath, "utf8");
    } catch (e) {
        if ("ENOENT" !== e.code) {
            throw e;
        }
        return "";
    }
};

/**
 * Add the specified `filename` to the set of files visible in the sparse
 * checkout in the specified `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             filename
 */
exports.addToSparseCheckoutFile = co.wrap(function *(repo, filename) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(filename);

    const sparsePath = exports.getSparseCheckoutPath(repo);
    yield fs.appendFile(sparsePath, filename + "\n");
});

/**
 * Remove the specified `filenames` from the set of files visible in the sparse
 * checkout in the specified `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @param {String[]}           filenames
 */
exports.removeFromSparseCheckoutFile = function (repo, filenames) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isArray(filenames);
    const sparseFile = exports.readSparseCheckout(repo);
    const toRemoveSet = new Set(filenames);
    const newContent = sparseFile.split("\n").filter(
                                               name => !toRemoveSet.has(name));
    fs.writeFileSync(exports.getSparseCheckoutPath(repo),
                     newContent.join("\n"));
};

/**
 * Write out the specified `index` for the specified meta-repo, `repo`, set the
 * index flags to the correct values based on the contents of
 * `.git/info/sparse-checkout`, which libgit2 does not do.
 *
 * TODO: independent test
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Index} index
 * @param {String|undefined} path if set, where to write the index
 */
exports.setSparseBitsAndWriteIndex = co.wrap(function *(repo, index,
                                                        path = undefined) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(index, NodeGit.Index);

    // If we're in sparse mode, manually set bits to skip the worktree since
    // libgit2 will not.

    if (yield exports.inSparseMode(repo)) {
        const sparseCheckout = exports.readSparseCheckout(repo);
        const sparseSet = new Set(sparseCheckout.split("\n"));
        const NORMAL = 0;
        for (const e of index.entries()) {
            if (NORMAL === NodeGit.Index.entryStage(e)) {
                if (sparseSet.has(e.path)) {
                    e.flagsExtended &= ~SKIP_WORKTREE;
                } else {
                    e.flagsExtended |= SKIP_WORKTREE;
                }
                yield index.add(e);
            }
        }
    }
    // This is a horrible hack that we need because nodegit doesn't
    // have a way to write the index to anywhere other than the
    // location from whence it was opened.
    if (path !== undefined) {
        const indexPath = repo.path() + "index";
        yield fs.copy(indexPath, path);
        const newIndex = yield NodeGit.Index.open(path);
        yield newIndex.removeAll();
        for (const e of index.entries()) {
            yield newIndex.add(e);
        }
        index = newIndex;
    }
    yield index.write();
});
