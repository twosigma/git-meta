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

/**
 * This module contains utilities for configuring submodules.  Eventually all
 * this should go away and we should submit patches to libgit2/nodegit.  The
 * reasons we need these methods are:
 *
 * - speed: the Submodule methods are slow
 * - locking: the Submodule methods make unnecessary locks and don't work
 *   in parallel
 * - correctness: once we start doing some of the manipulation ourselves, the
 *   data is not recorded in libgit's caches and so we must do all Submodule
 *   work ourselves.
 *
 * @module {SubmoduleConfigUtil}
 */

const assert  = require("chai").assert;
const co      = require("co");
const fs      = require("fs-promise");
const NodeGit = require("nodegit");
const path    = require("path");
const url     = require("url");

const UserError = require("./user_error");

const CONFIG_FILE_NAME = "config";

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
 * Return the relative path from the working directory of a submodule having
 * the specified `subName` to its .git directory.
 * @param {String} subName
 */
exports.computeRelativeGitDir = function (subName) {
    const depth = subName.split("/").length;
    let moveUp = "";
    for (let i = 0; i < depth; ++i) {
        moveUp = path.join(moveUp, "..");
    }
    return path.join(moveUp, ".git", "modules", subName);
};

/**
 * Return the relative path from the .git directory of a submodule to its
 * working directory.
 * @param {String} subName
 */
exports.computeRelativeWorkDir = function (subName) {
    const depth = subName.split("/").length;
    let moveUp = path.join("..", "..");
    for (let i = 0; i < depth; ++i) {
        moveUp = path.join(moveUp, "..");
    }
    return path.join(moveUp, subName);
};

/**
 * Return the result of resolving the specified `relativeUrl` onto the
 * specified `baseUrl`.
 *
 * @param {String} baseUrl
 * @param {String} relativeUrl
 * @return {String}
 */
exports.resolveUrl = function (baseUrl, relativeUrl) {
    assert.isString(baseUrl);
    assert.isString(relativeUrl);

    // Make sure ends with trailing "/" so resolution will work with "."
    // correctly.

    if (!baseUrl.endsWith("/")) {
        baseUrl += "/";
    }
    const res = url.resolve(baseUrl, relativeUrl);

    // Trim trailing "/" which will stick around in some situations (e.g., "."
    // for relativeUrl) but not others, to give uniform results.

    if (res.endsWith("/")) {
        return res.substr(0, res.length - 1);
    }
    return res;
};

/**
 * If the specified `submoduleUrl` is a relative path, return the result of
 * resolving it onto the specified `baseUrl`; otherwise, return `submoduleURL`.
 * Throw a `UserError` if `null === baseUrl` and `submoduleUrl` is relative.
 *
 * @param {String|null} baseUrl
 * @param {String} submoduleUrl
 * @return {String}
 */
exports.resolveSubmoduleUrl = function (baseUrl, submoduleUrl) {
    if (null !== baseUrl) {
        assert.isString(baseUrl);
    }
    assert.isString(submoduleUrl);
    if (submoduleUrl.startsWith(".")) {
        if (null === baseUrl) {
            throw new UserError(
      `Attempt to use relative url: ${submoduleUrl}, but no 'origin' remote.`);
        }
        return exports.resolveUrl(baseUrl, submoduleUrl);
    }
    return submoduleUrl;
};

/**
 * Return a map from submodule name to url from the specified `text`.
 * @param {String} text
 */
exports.parseSubmoduleConfig = function (text) {
    assert.isString(text);

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
            if (lastName.endsWith("/")) {
                lastName = lastName.slice(0, lastName.length - 1);
            }
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
    assert.isString(text);

    const regex = /\[submodule *"(.*)"]/;
    const lines = text.split("\n");
    const result = new Set();
    for (let i = 0; i < lines.length; ++i) {
        const line = lines[i];
        const parseResult = regex.exec(line);
        if (null !== parseResult) {
            result.add(parseResult[1]);
        }
    }
    return Array.from(result);
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
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);

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
    return exports.parseSubmoduleConfig(data);
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
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(index, NodeGit.Index);

    const entry = index.getByPath(exports.modulesFileName);
    if (undefined === entry) {
        return {};                                                    // RETURN
    }
    const oid = entry.id;
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
 * @return {Object} map from name to url
 */
exports.getSubmodulesFromWorkdir = function (repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const modulesPath = path.join(repo.workdir(), exports.modulesFileName);
    let data;
    try {
        data = fs.readFileSync(modulesPath, "utf8");
    }
    catch (e) {
        // File doesn't exist, no submodules configured.
    }
    if (undefined === data) {
        return {};
    }
    return exports.parseSubmoduleConfig(data);
};

/**
 * Return the path to the config file for the specified `repo`.
 *
 * @param {NodeGit.Repository}
 * @return {String}
 */
exports.getConfigPath = function (repo) {
    assert.instanceOf(repo, NodeGit.Repository);
    return path.join(repo.path(), CONFIG_FILE_NAME);
};

/**
 * Return the text for the lines to configure the submodule having the
 * specified `name` to point to the specified `url`.
 *
 * @param {String} name
 * @param {String} url
 * @return {String}
 */
exports.getConfigLines = function (name, url) {
    assert.isString(name);
    assert.isString(url);
    return `\
[submodule "${name}"]
\turl = ${url}
`;
};

/**
 * Write the entry to set up the the submodule having the specified `name` to
 * and `url` to the `.git/config` file for the repo at the specified
 * `repoPath`.  The behavior is undefined if there is already an entry for
 * `name` in the config file.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             name
 * @param {String}             url
 *
 * @async
 * @param {String} repoPath
 * @param {String} name
 * @param {String} url
 */
exports.initSubmodule = co.wrap(function *(repoPath, name, url) {
    assert.isString(repoPath);
    assert.isString(name);
    assert.isString(url);
    const configPath = path.join(repoPath, ".git", CONFIG_FILE_NAME);
    const lines = exports.getConfigLines(name, url);

    // Do this sync to avoid race conditions for now.

    fs.appendFileSync(configPath, lines);
    yield (Promise.resolve());  // empty yield to avoid warning.
});

/**
 * Return the configured template path, from which to copy files into
 * newly-opened submodules, for the specified `repo`, or null if no such path
 * is configured.
 *
 * @async
 * @param {NodeGit.Repository} templatePath
 * @return {String | null}
 */
exports.getTemplatePath = co.wrap(function *(repo) {
    const config = yield repo.config();
    try {
        return yield config.getString("meta.submoduleTemplatePath");
    }
    catch (e) {
        return null;
    }
});

/**
 * Open the submodule having the specified `name` and `url` for the `metaRepo`.
 * Configure the repository for this submodule to have `url` as its remote,
 * unless `url` is relative, in which case resolve `url` against the specified
 * `repoUrl`.  Throw a `UserError` if `null === repoUrl` and `url` is relative.
 * Return the newly opened repository.  Note that this command does not fetch
 * any refs from the remote for this submodule, and while its repo can be
 * opened it will be empty.  If the specified `templatePath` is provided,
 * use it as a template from which to copy files in to the `.git` directory of
 * the newly-opened repo.
 *
 * This method is largely needed to workaround deficiences in
 * `NodeGit.Submodule`, for example, it cannot be used to initialize a repo
 * that has an existing .git dir in `.git/modules`.
 *
 * @async
 * @param {String|null}        repoUrl
 * @param {NodeGit.Repository} metaRepo
 * @param {String}             name
 * @param {String}             url
 * @param {String|null}        templatePath
 * @return {NodeGit.Repository}
 */
exports.initSubmoduleAndRepo = co.wrap(function *(repoUrl,
                                                  metaRepo,
                                                  name,
                                                  url,
                                                  templatePath) {
    if (null !== repoUrl) {
        assert.isString(repoUrl);
    }
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.isString(name);
    assert.isString(url);
    if (null !== templatePath) {
        assert.isString(templatePath);
    }

    // Update the `.git/config` file.

    const repoPath = metaRepo.workdir();
    yield exports.initSubmodule(repoPath, name, url);

    // Then, initialize the repository.  We pass `initExt` the right set of
    // flags so that it will set it up as a git link.

    const subRepoDir = path.join(repoPath, ".git", "modules", name);

    const FLAGS = NodeGit.Repository.INIT_FLAG;

    // See if modules repo exists.

    try {
        yield NodeGit.Repository.open(subRepoDir);
    }
    catch (e) {
        // Or, make it if not.

        yield NodeGit.Repository.initExt(subRepoDir, {
            workdirPath: exports.computeRelativeWorkDir(name),
            flags: FLAGS.NO_DOTGIT_DIR | FLAGS.MKPATH |
                FLAGS.RELATIVE_GITLINK |
                (null === templatePath ? 0 : FLAGS.EXTERNAL_TEMPLATE),
            templatePath: templatePath
        });
    }


    // Write out the .git file.  Note that `initExt` configured to write a
    // relative .git directory will not write this file successfully if the
    // `.git/modules/${name}` directory exists.

    const relativeGitDir = exports.computeRelativeGitDir(name);
    yield fs.writeFile(path.join(repoPath, name, ".git"),
                       `gitdir: ${relativeGitDir}\n`);

    const result = yield NodeGit.Repository.open(path.join(repoPath, name));

    // Configure the origin.  If there is already an origin, make sure it has
    // the correct URL; otherwise, add it.

    const realUrl = exports.resolveSubmoduleUrl(repoUrl, url);
    let origin = null;
    try {
        origin = yield result.getRemote("origin");
    }
    catch (e) {
    }
    if (null !== origin) {
        if (realUrl !== origin.url()) {
            NodeGit.Remote.setUrl(result, "origin", realUrl);
        }
    }
    else {
        yield NodeGit.Remote.create(result, "origin", realUrl);
    }

    return result;
});

/**
 * Return a dictionary mapping from submodule name to URL for the describes the
 * submodule state resulting from merging the specified `lhs` and `rhs`
 * dictionaries, who have the specified `mergeBase` dictionary as their merge
 * base; or, `null` if there is a conflict between the two that cannot be
 * resolved.
 * TODO: indicate which submodules are in conflict
 *
 * @param {Object} lhs
 * @param {Object} rhs
 * @param {Object} mergeBase
 * @return {Object|null}
 */
exports.mergeSubmoduleConfigs = function (lhs, rhs, mergeBase) {
    assert.isObject(lhs);
    assert.isObject(rhs);
    assert.isObject(mergeBase);

    let result = {};
    let lhsValue;
    let rhsValue;
    let mergeBaseValue;

    // First, loop through `lhs`.  For each value, if we do not find a
    // conflict, and the value hasn't been removed in `rhs`, copy it into
    // `result`.

    for (let key in lhs) {
        lhsValue = lhs[key];
        rhsValue = rhs[key];
        mergeBaseValue = mergeBase[key];

        // If the value has changed between left and right, neither is the same
        // as what was in the mergeBase, we have a conflict.

        if (lhsValue !== rhsValue &&
            rhsValue !== mergeBaseValue &&
            lhsValue !== mergeBaseValue) {
            return null;
        }

        // If the value exists in `rhs` (it wasn't deleted), or it wasn't in
        // `mergeBase` (meaning it wasn't in `rhs` because `lhs` added it),
        // then copy it to `result`.

        if (undefined !== rhsValue || undefined === mergeBaseValue) {
            result[key] = lhsValue;
        }

    }
    for (let key in rhs) {
        lhsValue = result[key];  // use 'result' as it may be smaller
        rhsValue = rhs[key];
        mergeBaseValue = mergeBase[key];

        // We will have a conflict only when the value doesn't exist in 'lhs'
        // -- otherwise, it would have been detected already.  So, a conflict
        // exists when it's gone from the `lhs` (deleted), but present in the
        // `rhs`, and there is a value in `mergeBase` that's different from
        // `rhs`.

        if (undefined === lhsValue &&
            undefined !== mergeBaseValue &&
            rhsValue !== mergeBaseValue) {
            return null;
        }

        // Otherwise, we want to copy the value over if it's a change.

        else if (rhsValue !== mergeBaseValue) {
            result[key] = rhsValue;
        }
    }
    return result;
};

/**
 * Return the text for a `.gitmodules` file containing the specified
 * `submodules` definitions.
 *
 * @param {Object} urls  map from submodule name to url
 * @return {String}
 */
exports.writeConfigText = function (urls) {
    assert.isObject(urls);
    let result = "";
    const keys = Object.keys(urls).sort();
    let name;
    let url;
    for (let i = 0; i < keys.length; ++i) {
        name = keys[i];
        url = urls[name];
        result += `\
[submodule "${name}"]
\tpath = ${name}
\turl = ${url}
`;
    }
    return result;
};

/**
 * Write, to the `.gitmodules` file, the specified `urls` in the specified
 * `index`, in the specified `repo` and stage the change to the index.
 * 
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Index}      index
 * @param {Object}             urls   submodule name to url
 */
exports.writeUrls = co.wrap(function *(repo, index, urls) {
    const modulesPath = path.join(repo.workdir(),
                                  exports.modulesFileName);
    const newConf = exports.writeConfigText(urls);
    yield fs.writeFile(modulesPath, newConf);
    yield index.addByPath(exports.modulesFileName);
});
