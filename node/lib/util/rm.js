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

const assert       = require("chai").assert;
const binarySearch = require("binary-search");
const co           = require("co");
const fs           = require("fs-promise");
const groupBy      = require("group-by");
const path         = require("path");
const NodeGit      = require("nodegit");

const CloseUtil           = require("./close_util");
const SparseCheckoutUtil  = require("./sparse_checkout_util");
const SubmoduleUtil       = require("./submodule_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const TextUtil            = require("./text_util");
const UserError           = require("./user_error");

const FILEMODE = NodeGit.TreeEntry.FILEMODE;
const STATUS = NodeGit.Status.STATUS;

function needToRequestRecursive(path) {
    throw new UserError(
        `not removing '${path}' recursively without -r`);
}

function pluralizeHas(n) {
    return n === 1 ? "has" : "have";
}

const errorsByCause = {
    unstaged: {
        problem: "local modifications",
        solution: "use --cached to keep the file, or -f to force removal"
    },
    staged: {
        problem: "changes staged in the index",
        solution: "use -f to force removal"
    },
    stagedAndUnstaged: {
        problem: "staged content different from both the file and the HEAD",
        solution: "use -f to force removal"
    }
};

function problemMessage(badFiles, cause, entityType) {
    const error = errorsByCause[cause];
    assert.isDefined(error);
    return `the following ${TextUtil.pluralize(entityType, badFiles.length)} \
${pluralizeHas(badFiles.length)} ${error.problem}:
${TextUtil.listToIndentedString(badFiles)}
(${error.solution})`;
}

/**
 * @class Problem
 * describes a problem which prevents removal of an object
 */
class Problem {
    constructor(path, cause, entityType) {
        if (undefined === entityType) {
            entityType = "file";
        }

        this.d_path = path;
        this.d_cause = cause;
        this.d_entityType = entityType;
        Object.freeze(this);
    }
    get path() {
        return this.d_path;
    }
    get cause() {
        return this.d_cause;
    }
    get entityType() {
        return this.d_entityType;
    }
}

const checkIndexIsHead = co.wrap(function*(headTree, indexId, entryPath) {
    if (headTree === null) {
        return false;
    }
    else {
        let inRepo;
        try {
            inRepo = yield headTree.entryByPath(entryPath);
        } catch (e) {
            return false;
        }
        if (!indexId.equal(inRepo.id())) {
            return false;
        }
    }
    return true;
});

/**
 * Return null if check index == HEAD || index == workdir.  Else,
 * return a Problem
 */
const checkIndexIsHeadOrWorkdir = co.wrap(function*(repo, headTree, entry,
                                                    entryPath, displayPath) {
    const inIndex = entry.id;

    const indexIsHead = yield checkIndexIsHead(headTree, inIndex, entryPath);
    if (indexIsHead) {
        return null;
    }
    const filePath = path.join(repo.workdir(), entryPath);
    try {
        yield fs.access(filePath);
    } catch (e) {
        assert.equal("ENOENT", e.code);
        //a file that doesn't exist is considered OK for rm --cached, too
        return null;
    }

    if (entry.mode === FILEMODE.COMMIT) {
        // this is a submodule so we don't check the working tree
        return new Problem(displayPath, "staged", "submodule");
    }

    const index = yield repo.index();
    const diff = yield NodeGit.Diff.indexToWorkdir(repo, index,
                                                   {"pathspec" : [entryPath]});
    if (diff.numDeltas() === 0) {
        return null;
    }
    else {
        return new Problem(displayPath, "unstaged", "file");
    }
});

function setDefault(options, arg, def) {
    if (undefined === options[arg]) {
        options[arg] = def;
    }
    else {
        assert.isBoolean(options[arg]);
    }
}

/**
 * Check that a file is clean enough to delete, according to Git's
 * rules.  An already-deleted file is always clean.  If --cached
 * is supplied, index may match either HEAD or the worktree; otherwise,
 * only the worktree is permitted.  For unclean files, return a Problem
 * describing how the file is unclean.
 */
const checkCleanliness = co.wrap(function *(repo, headTree, index, pathname,
                                            options) {
    if (options.force) {
        return null;
    }

    let displayPath = pathname;
    if (options.prefix !== undefined) {
        displayPath = path.join(options.prefix, pathname);
    }
    const entry = index.getByPath(pathname);

    if (options.cached) {
        return yield checkIndexIsHeadOrWorkdir(repo, headTree, entry,
                                               pathname, displayPath);
    }
    let status;
    try {
        // Status.file throws errors after 0.22.0
        status = yield NodeGit.Status.file(repo, pathname); 
    } catch (err) {
        return null;
    }

    if (status === 0 || status & STATUS.WT_DELETED !== 0) {
        //git considers these OK regardless
        return null;
    }
    if ((status & STATUS.WT_MODIFIED) !== 0) {
        if ((status & STATUS.INDEX_MODIFIED) !== 0) {
            return new Problem(displayPath, "stagedAndUnstaged");
        }
        else {
            return new Problem(displayPath, "unstaged");
        }
    }
    else {
        if ((status & STATUS.INDEX_MODIFIED) !== 0) {
            return new Problem(displayPath, "staged");
        }
    }
    return null;
});

const deleteEmptyParents = co.wrap(function*(fullpath) {
    const parent = path.dirname(fullpath);
    try {
        yield fs.rmdir(parent);
    } catch (e) {
        //We only want to remove empty parent dirs, but it's
        //cheaper just to try to remove them and ignore errors
        return;
    }
    yield deleteEmptyParents(parent);
});

function checkAllPathsResolved(paths, resolved) {
    const allResolvedPaths = [];
    for (const rootLevel of Object.keys(resolved)) {
        const subPaths = resolved[rootLevel];
        if (subPaths.length === 0) {
            allResolvedPaths.push(rootLevel);
        } else {
            for (const sub of subPaths) {
                allResolvedPaths.push(path.join(rootLevel, sub));
            }
        }
    }
    allResolvedPaths.sort();
    for (const spec of paths) {
        let stripped = spec;
        if (spec.endsWith("/")) {
            stripped = spec.substring(0, spec.length - 1);
        }
        const idx = binarySearch(allResolvedPaths, stripped, TextUtil.strcmp);
        if (idx < 0) {
            //spec is a/b, next item is a/b/c, OK
            const insertionPoint = -idx - 1;
            const nextResolved = allResolvedPaths[insertionPoint];
            if (insertionPoint >= allResolvedPaths.length ||
                !nextResolved.startsWith(stripped + "/")) {
                throw new UserError(`\
pathspec '${spec}' did not match any files`);
            }
        }
    }
}

/**
 * Remove the specified `paths` in the specified `repo`.  If a path in
 * `paths` refers to a file, remove it.  If it refers to a directory,
 * and recursive is true, remove it recursively.  If it's false, throw
 * a UserError.  If a path to be removed does not exist in the index,
 * throw a UserError.  If a path to be removed is not clean, and force
 * is false, throw a UserError.
 *
 * If --cached is supplied, the paths will be removed from the index
 * but not from disk.
 *
 * If there are any dirty paths, the meta or submodule indexes may be
 * dirty upon return from this function.  Unfortunately due to a
 * nodegit bug, we can't reload the index:
 * https://github.com/nodegit/nodegit/issues/1478
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String []}          paths
 * @param {Object}             [options]
 * @param {Boolean}            [options.recursive]
 * @param {Boolean}            [options.cached] (remove from index not disk)
 * @param {Boolean}            [options.force]
 * @param {String}             [options.prefix] Path prefix for file lookup
 */
exports.rmPaths = co.wrap(function *(repo, paths, options) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isArray(paths);
    if (undefined === options) {
        options = {};
    }
    else {
        assert.isObject(options);
    }
    setDefault(options, "recursive", false);
    setDefault(options, "cached", false);
    setDefault(options, "force", false);
    if (undefined === options.prefix) {
        options.prefix = "";
    }
    else {
        assert.isString(options.prefix);
    }

    for (const p of paths) {
        if (p === "") {
            throw new UserError("warning: empty strings as pathspecs are " +
                                "invalid.  Please use . instead if you " +
                                "meant to match all paths.");
        }
    }

    const index = yield repo.index();
    const headCommit = yield repo.getHeadCommit();

    const indexUrls =
          yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, index);
    const headUrls =
          yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, headCommit);

    // In theory, it would be be possible for a sub to be in the
    // workdir (that is, in an unstaged change to .gitmodules) as
    // well, but since git rm generally doesn't deal with workdir
    // changes, we ignore that possibility.

    // We might, at least for easy testing, want to handle changes to
    // root-level files, so we add those files to the root level items

    const rootLevelItemSet = new Set();
    for (const submodules of [indexUrls, headUrls]) {
        for (const sub of Object.keys(submodules)) {
            rootLevelItemSet.add(sub);
        }
    }

    for (const entry of index.entries()) {
        rootLevelItemSet.add(entry.path);
    }

    const rootLevelItems = [];
    rootLevelItems.push(...rootLevelItemSet);
    const openArray = yield SubmoduleUtil.listOpenSubmodules(repo);
    const openSubmoduleSet = new Set(openArray);

    // TODO: consider changing resolvePaths to support root-level items
    // items, which would enable removal of checkAllPathsResolved
    const resolved = yield SubmoduleUtil.resolvePaths(paths,
                                                      rootLevelItems,
                                                      openArray);

    checkAllPathsResolved(paths, resolved);

    let headTree = null;
    if (headCommit !== null) {
        const treeId = headCommit.treeId();
        headTree = yield repo.getTree(treeId);
    }

    // Check that everything is clean enough to remove
    const pathSet = new Set(paths);
    const toRemove = [];
    const problems = [];
    const removedSubmodules = [];
    const toRecurse = [];
    for (const rootLevel of Object.keys(resolved)) {
        const items = resolved[rootLevel];
        if (items.length === 0) {
            if (!(options.recursive || pathSet.has(rootLevel))) {
                return needToRequestRecursive([rootLevel]);
            }
            toRemove.push(rootLevel);
            const problem = yield checkCleanliness(repo, headTree, index,
                                                   rootLevel, options);
            if (problem !== null) {
                problems.push(problem);
            }
            const entry = index.getByPath(rootLevel);
            if (entry === undefined || entry.mode === FILEMODE.COMMIT) {
                removedSubmodules.push(rootLevel);
            }
        }
        else {
            // recurse into submodule
            const subRepo = yield SubmoduleUtil.getRepo(repo, rootLevel);
            const subOptions = {};
            Object.assign(subOptions, options);
            subOptions.prefix = rootLevel;
            // We set dryRun = true here because we're just checking
            // for clean.  If there are no problems, we'll later
            // go through toRecurse and do a full run.
            subOptions.dryRun = true;
            toRecurse.push({repo : subRepo, items : items,
                            options : subOptions});
            yield exports.rmPaths(subRepo, items, subOptions);
        }
    }

    //report any problems
    if (problems.length !== 0) {
        let msg = "";
        const byType = groupBy(problems, "entityType");

        for (const type in byType) {
            const byCause = groupBy(byType[type], "cause");
            for (const cause in byCause) {
                msg += problemMessage(byCause[cause].map(x => x.path),
                                      cause, type);
            }
        }
        throw new UserError(msg);
    }

    if (options.dryRun) {
        return;
    }

    // Now do the full run on submodules
    for (const r of toRecurse) {
        r.options.dryRun = false;
        yield exports.rmPaths(r.repo, r.items, r.options);
    }

    // This "if" is necessary due to
    // https://github.com/nodegit/nodegit/issues/1487
    if (toRemove.length !== 0) {
        yield index.removeAll(toRemove);
        yield SparseCheckoutUtil.writeMetaIndex(repo, index);
    }

    // close to-be-deleted submodules
    const submodulesToClose = [];
    for (const submodule of removedSubmodules) {
        if (openSubmoduleSet.has(submodule)) {
            submodulesToClose.push(submodule);
        }
    }

    yield CloseUtil.close(repo, repo.workdir(), submodulesToClose,
                          options.force);


    // Clean up the workdir
    const root = repo.workdir();
    if (!options.cached) {
        for (const file of toRemove) {
            const fullpath = path.join(root, file);
            let stat = null;
            try {
                stat = yield fs.stat(fullpath);
            } catch (e) {
                //it is possible that e doesn't exist on disk
                assert.equal("ENOENT", e.code);
            }
            if (stat !== null) {
                if (stat.isDirectory()) {
                    yield fs.rmdir(fullpath);
                } else {
                    yield fs.unlink(fullpath);
                }
            }
            yield deleteEmptyParents(fullpath);
        }
    }

    // And write any gitmodules files changes
    const modules = yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo,
                                                                     index);
    for (const file of removedSubmodules) {
        delete modules[file];
    }

    yield SubmoduleConfigUtil.writeUrls(repo, index, modules, options.cached);
    yield index.write();
});
