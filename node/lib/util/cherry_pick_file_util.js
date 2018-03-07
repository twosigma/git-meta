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

const assert = require("chai").assert;
const co     = require("co");
const fs     = require("fs-promise");
const path   = require("path");
const rimraf = require("rimraf");

const CherryPick = require("./cherry_pick");

/**
 * This module contains methods for accessing files that pertain to in-progress
 * cherry-picks.
 */

const metaCherryPickDir = "META_CHERRY_PICK";
const originalHeadFile = "ORIG_HEAD";
const pickFile = "PICK";

/**
 * Return the `CherryPick` object in the specified `gitDir`, if one exists, or
 * null if there is no cherry-pick in progress.
 *
 * @param {String} gitDir
 * @return {String|null}
 */
exports.readCherryPick = co.wrap(function *(gitDir) {
    assert.isString(gitDir);
    let originalHead;
    let pick;
    const root = path.join(gitDir, metaCherryPickDir);
    try {
        originalHead = yield fs.readFile(path.join(root, originalHeadFile),
                                         "utf8");
        pick = yield fs.readFile(path.join(root, pickFile), "utf8");
    }
    catch (e) {
        // TODO: Emit diagnostic if directory exists but is malformed.
        return null;
    }
    return new CherryPick(originalHead.split("\n")[0], pick.split("\n")[0]);
});

/**
 * Write the specified `cherryPick` to the specified `gitDir`.  The behavior is
 * undefined if there is already a cherry-pick recorded in `gitDir`.
 *
 * @param {String}     gitDir
 * @param {CherryPick} cherryPick
 */
exports.writeCherryPick = co.wrap(function *(gitDir, cherryPick) {
    assert.isString(gitDir);
    assert.instanceOf(cherryPick, CherryPick);

    const root = path.join(gitDir, metaCherryPickDir);
    yield fs.mkdir(root);
    yield fs.writeFile(path.join(root, originalHeadFile),
                       cherryPick.originalHead + "\n");
    yield fs.writeFile(path.join(root, pickFile),
                       cherryPick.picked + "\n");
});

/**
 * Remove files related to a meta cherry-pick.
 *
 * @param {String} gitDir
 */
exports.cleanCherryPick = co.wrap(function *(gitDir) {
    assert.isString(gitDir);
    const root = path.join(gitDir, metaCherryPickDir);
    const promise = new Promise(callback => {
        return rimraf(root, {}, callback);
    });
    yield promise;
});
