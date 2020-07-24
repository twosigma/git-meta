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
const rimraf  = require("rimraf");
const url     = require("url");

const DoWorkQueue        = require("./do_work_queue");
const GitUtil            = require("./git_util");
const SparseCheckoutUtil = require("./sparse_checkout_util");
const UserError          = require("./user_error");

function doRimRaf(fileName) {
    return new Promise(callback => {
        return rimraf(fileName, {}, callback);
    });
}

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
 * Remove the first found configuration entry for the submodule having the
 * specified `submoduleName` in the config file in the specified `repoPath`; do
 * nothing if no entry is found.
 *
 * @param {String} repoPath
 * @param {String} submoduleName
 */
exports.clearSubmoduleConfigEntry =
                                  co.wrap(function *(repoPath, submoduleName) {
    assert.isString(repoPath);
    assert.isString(submoduleName);

    // Using a very stupid algorithm here to find and remove the submodule
    // entry.  This logic could be smarter (maybe use regexes) and more
    // efficition (stream in and out). Note that we use only synchronous
    // when mutating the config file to avoid race conditions.

    const configPath = path.join(repoPath, "config");
    const configText = fs.readFileSync(configPath, "utf8");
    const configLines = configText.split("\n");
    const newConfigLines = [];
    const searchString = "[submodule \"" + submoduleName + "\"]";

    let found = false;
    let inSubmoduleConfig = false;

    // Loop through the file and push, onto 'newConfigLines' any lines that
    // aren't part of the bad submodule section.

    for (const line of configLines) {
        if (!found && !inSubmoduleConfig && line === searchString) {
            inSubmoduleConfig = true;
            found = true;
        }
        else if (inSubmoduleConfig) {
            // If we see a line starting with "[" while we're in the submodule
            // section, we can get out of it.

            if (0 !== line.length && line[0] === "[") {
                inSubmoduleConfig = false;
            }
        }
        if (!inSubmoduleConfig) {
            newConfigLines.push(line);
        }
    }

    // If we didn't find the submodule, don't write the data back out.

    if (found) {
        newConfigLines.push("");  // one more new line
        fs.writeFileSync(configPath, newConfigLines.join("\n"));
    }

    // Silence warning about no yield statement.
    yield (Promise.resolve());
});

/**
 * De-initialize the repositories having the specified `submoduleNames` in the
 * specified `repo`.
 *
 * Note that after calling this method,
 * `SparseCheckoutUtil.setSparseBitsAndWriteIndex` must be called to update
 * the SKIP_WORKTREE flags for closed submodules.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String[]}           submoduleNames
 */
exports.deinit = co.wrap(function *(repo, submoduleNames) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isArray(submoduleNames);

    const sparse = yield SparseCheckoutUtil.inSparseMode(repo);

    const deinitOne = co.wrap(function *(submoduleName) {

        // This operation is a major pain, first because libgit2 does not
        // provide any direct methods to do the equivalent of 'git deinit', and
        // second because nodegit does not expose the method that libgit2 does

        // De-initting a submodule requires the following things:
        // 1. Confirms there are no unpushed (to any remote) commits
        //    or uncommited changes (including new files).
        // 2. Remove all files under the path of the submodule, but not the
        //    directory itself, which would look to Git as if we were trying
        //    to remove the submodule.
        // 3. Remove the entry for the submodule from the '.git/config' file.
        // 4. Remove the directory .git/modules/<submodule>

        // We will clear out the path for the submodule.

        const rootDir = repo.workdir();
        const submodulePath = path.join(rootDir, submoduleName);

        if (sparse) {
            // Clear out submodule's contents.

            yield doRimRaf(submodulePath);

            // Clear parent directories until they're all gone or we find one
            // that's non-empty.

            let next = path.dirname(submoduleName);
            try {
                while ("." !== next) {
                    yield fs.rmdir(path.join(rootDir, next));
                    next = path.dirname(next);
                }
            } catch (e) {
                // It's possible that we're closing d/x and d/y, and
                // that in doing so, we end up trying to delete d
                // twice, which would give ENOENT.
                if ("ENOTEMPTY" !== e.code && "ENOENT" !== e.code) {
                    throw e;
                }
            }
        } else {
            const files = yield fs.readdir(submodulePath);
            yield files.map(co.wrap(function *(filename) {
                yield doRimRaf(path.join(submodulePath, filename));
            }));
        }
        yield exports.clearSubmoduleConfigEntry(repo.path(), submoduleName);
    });
    yield DoWorkQueue.doInParallel(submoduleNames, deinitOne);
    if (yield SparseCheckoutUtil.inSparseMode(repo)) {
        SparseCheckoutUtil.removeFromSparseCheckoutFile(repo, submoduleNames);
    }
});

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

    // Handle prefixed urls like cache::https://...
    const prefixStart = baseUrl.lastIndexOf("::");
    let prefix = "";
    if (prefixStart !== -1) {
        prefix = baseUrl.substring(0, prefixStart + 2);
        baseUrl = baseUrl.substring(prefixStart + 2);
    }

    const res = prefix + url.resolve(baseUrl, relativeUrl);

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
 * Return a map from submodule name to url in the specified `repo` by parsing
 * the blob content of `.gitmodules`
 *
 * @private
 * @async
 * @param {NodeGit.Repository} repo repo where blob can be read
 * @param {NodeGit.IndexEntry} entry index entry for `.gitmodules`
 * @return {Object} map from name to url
 */
exports.getSubmodulesFromIndexEntry = co.wrap(function *(repo, entry) {
    assert.instanceOf(repo, NodeGit.Repository);
    if (!entry) {
        return {};                                                    // RETURN
    }
    assert.instanceOf(entry, NodeGit.IndexEntry);
    const blob = yield repo.getBlob(entry.id);
    return  exports.parseSubmoduleConfig(blob.toString());
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
    return yield exports.getSubmodulesFromIndexEntry(repo, entry);
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
 * and `url` to the `config` file for the repo at the specified
 * `repoPath`.  The behavior is undefined if there is already an entry for
 * `name` in the config file.
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
    yield exports.clearSubmoduleConfigEntry(repoPath, name);
    const configPath = path.join(repoPath, CONFIG_FILE_NAME);
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
 * @param {Boolean}            bare
 * @return {NodeGit.Repository}
 */
exports.initSubmoduleAndRepo = co.wrap(function *(repoUrl,
                                                  metaRepo,
                                                  name,
                                                  url,
                                                  templatePath, 
                                                  bare) {
    if (null !== repoUrl) {
        assert.isString(repoUrl);
    }
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.isString(name);
    assert.isString(url);
    assert.isBoolean(bare);
    if (null !== templatePath) {
        assert.isString(templatePath);
    }

    // Update the `.git/config` file.

    const repoPath = metaRepo.isBare ?
        path.dirname(metaRepo.path()) :
        metaRepo.workdir();
    yield exports.initSubmodule(metaRepo.path(), name, url);

    // Then, initialize the repository.  We pass `initExt` the right set of
    // flags so that it will set it up as a git link.

    const subRepoDir = path.join(repoPath, ".git", "modules", name);

    const FLAGS = NodeGit.Repository.INIT_FLAG;

    const initRepo = co.wrap(function *() {
        return bare ?
            yield NodeGit.Repository.init(subRepoDir, 1) :
            yield NodeGit.Repository.initExt(subRepoDir, {
                workdirPath: exports.computeRelativeWorkDir(name),
                flags: FLAGS.NO_DOTGIT_DIR | FLAGS.MKPATH |
                    FLAGS.RELATIVE_GITLINK |
                    (null === templatePath ? 0 : FLAGS.EXTERNAL_TEMPLATE),
                templatePath: templatePath
            });
    });
    // See if modules repo exists.
    let subRepo = null;
    try {
        subRepo = bare ?
            yield NodeGit.Repository.openBare(subRepoDir) :
            yield NodeGit.Repository.open(subRepoDir);
        // re-init if previously opened as bare
        if (!bare && subRepo.isBare()) {
            subRepo = yield initRepo();
        }
    }
    catch (e) {
        // Or, make it if not.
        subRepo = yield initRepo();
    }

    if (bare)  {
        return subRepo;
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
        result += `\n\
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
 * @param {Boolean}            cached do not write to the working tree
 */
exports.writeUrls = co.wrap(function *(repo, index, urls, cached) {
    if (undefined === cached) {
        cached = false;
    }
    else {
        assert.isBoolean(cached);
    }

    const repoPath = repo.isBare ?
        path.dirname(repo.path()) :
        repo.workdir();
    const modulesPath = path.join(repoPath,
                                  exports.modulesFileName);
    const newConf = exports.writeConfigText(urls);
    if (newConf.length === 0) {
        if (!cached) {
            try {
                yield fs.unlink(modulesPath);
            } catch (e) {
                //maybe it didn't exist prior to this
            }
        }
        try {
            yield index.removeByPath(exports.modulesFileName);
        } catch (e) {
            // ditto
        }
    }
    else {
        if (!cached) {
            yield fs.writeFile(modulesPath, newConf);
            yield index.addByPath(exports.modulesFileName);
        } else {
            // If we use this method of staging the change along with the
            // `fs.writeFile` above in the `!cached` case, it will randomly
            // confuse Git into thinking the `.gitmodules` file is modified
            // even though a `git diff` shows no changes.  I suspect we're
            // writing some garbage flags somwewhere.  You can replicate (after
            // reverting the change that introduces this comment:
            //```bash
            //$ while :;
            //> do
            //> write-repos -o 'a=B|x=U:C3-2 t=Sa:1;Bmaster=3;Bfoo=2'
            //> git -C x meta cherry-pick foo
            //> git -C x status
            //> sleep 0.01
            //> done
            //
            // and wait, about 1/4 times the `status` command will show a dirty
            // `.gitmodules` file.
            //
            // TODO: track down why this confuses libgit2, *or* get rid of the
            // caching logic; I don't think it buys us anything.

            const oid = yield GitUtil.hashObject(repo, newConf);
            const sha = oid.toString();
            const entry = new NodeGit.IndexEntry();
            entry.path = exports.modulesFileName;
            entry.mode = NodeGit.TreeEntry.FILEMODE.BLOB;
            entry.id = NodeGit.Oid.fromString(sha);
            entry.flags = entry.flagsExtended = 0;
            yield index.add(entry);
        }
    }
});
