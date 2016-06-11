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

const co = require("co");

/**
 * @module {SubmoduleConfigUtil}
 *
 * This module contains utilties for processing submodule configuration data.
 */

/**
 * name of the modules configuration file
 *
 * @static
 * @property {String}
 */
exports.modulesFileName = ".gitmodules";

/**
 * Return a map from submodule name to url from the specified `text`.
 * @param {String} text
 */
exports.parseSubmoduleConfig = function (text) {
    const nameRe = /\[submodule *"(.*)"]/;
    const urlRe  = /^[ \t]*url = (.*)$/;
    let result = {};
    const lines = text.split("\n");
    let lastName = null;
    for (let i = 0; i < lines.length; ++i) {
        const line = lines[i];
        const nameParseResult = nameRe.exec(line);
        if (null !== nameParseResult) {
            lastName = nameParseResult[1];
        }
        else if (null !== lastName) {
            const urlParseResult = urlRe.exec(line);
            if (null !== urlParseResult) {
                result[lastName] = urlParseResult[1];
            }
        }
    }
    return result;
};

/**
 * Return an array containing the names of the submodules listed in the
 * specified text, formatted as from a `.git/config` file.
 *
 * @param {String} text
 * @return {String[]}
 */
exports.parseOpenSubmodules = function (text) {
    const regex = /\[submodule *"(.*)"]/;
    const lines = text.split("\n");
    const result = [];
    for (let i = 0; i < lines.length; ++i) {
        const line = lines[i];
        const parseResult = regex.exec(line);
        if (null !== parseResult) {
            result.push(parseResult[1]);
        }
    }
    return result;
};

/**
 * Return a map from submodule name to url at the specified `commit` in the
 * specified `repo`.
 *
 * @private
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 * @return {Object} map from name to url
 */
exports.getSubmodulesFromCommit = co.wrap(function *(repo, commit) {
    const tree = yield commit.getTree();
    let entry;
    try {
        entry = yield tree.entryByPath(exports.modulesFileName);
    }
    catch (e) {
        // No modules file.
        return {};
    }
    const oid = entry.oid();
    const blob = yield repo.getBlob(oid);
    const data = blob.toString();
    return  exports.parseSubmoduleConfig(data);
});

/**
 * Return a map from submodule name to url in the specified `repo`.
 *
 * @private
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Index}      index
 * @return {Object} map from name to url
 */
exports.getSubmodulesFromIndex = co.wrap(function *(repo, index) {
    const entry = index.getByPath(exports.modulesFileName);
    if (undefined === entry) {
        return {};                                                    // RETURN
    }
    const oid = entry.id;
    const blob = yield repo.getBlob(oid);
    const data = blob.toString();
    return  exports.parseSubmoduleConfig(data);
});

