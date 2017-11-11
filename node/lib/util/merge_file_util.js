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

const assert = require("chai").assert;
const co     = require("co");
const fs     = require("fs-promise");
const path   = require("path");
const rimraf = require("rimraf");

const Merge = require("./merge");

/**
 * This module contains methods for accessing files that pertain to in-progress
 * merges.
 */

const metaMergeDir = "META_MERGE";
const messageFile = "MSG";
const originalHeadFile = "ORIG_HEAD";
const mergeHeadFile = "MERGE_HEAD";

/**
 * Return the `Merge` object in the specified `gitDir`, if one exists, or null
 * if there is no merge in progress.
 *
 * @param {String} gitDir
 * @return {String|null}
 */
exports.readMerge = co.wrap(function *(gitDir) {
    assert.isString(gitDir);
    let message;
    let originalHead;
    let mergeHead;
    const root = path.join(gitDir, metaMergeDir);
    try {
        message = yield fs.readFile(path.join(root, messageFile),
                                    "utf8");
        originalHead = yield fs.readFile(path.join(root, originalHeadFile),
                                         "utf8");
        mergeHead = yield fs.readFile(path.join(root, mergeHeadFile), "utf8");
    }
    catch (e) {
        return null;
    }
    return new Merge(message,
                     originalHead.split("\n")[0],
                     mergeHead.split("\n")[0]);
});

/**
 * Write the specified `merge` to the specified `gitDir`.  The behavior is
 * undefined if there is already a merge recorded in `gitDir`.
 *
 * @param {String} gitDir
 * @param {Merge}  merge
 */
exports.writeMerge = co.wrap(function *(gitDir, merge) {
    assert.isString(gitDir);
    assert.instanceOf(merge, Merge);

    const root = path.join(gitDir, metaMergeDir);
    yield fs.mkdir(root);
    yield fs.writeFile(path.join(root, "MSG"), merge.message);
    yield fs.writeFile(path.join(root, "ORIG_HEAD"),
                       merge.originalHead + "\n");
    yield fs.writeFile(path.join(root, "MERGE_HEAD"),
                       merge.mergeHead + "\n");
});

/**
 * Remove files related to a meta merge.
 *
 * @param {String} gitDir
 */
exports.cleanMerge = co.wrap(function *(gitDir) {
    assert.isString(gitDir);
    const root = path.join(gitDir, metaMergeDir);
    const promise = new Promise(callback => {
        return rimraf(root, {}, callback);
    });
    yield promise;
});
