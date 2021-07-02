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
 * This module contains utility methods for working with submodules.
 */

const assert  = require("chai").assert;
const co      = require("co");
const colors  = require("colors");
const NodeGit = require("nodegit");
const fs      = require("fs-promise");
const path    = require("path");

const DoWorkQueue         = require("../util/do_work_queue");
const GitUtil             = require("./git_util");
const Submodule           = require("./submodule");
const SubmoduleChange     = require("./submodule_change");
const SubmoduleFetcher    = require("./submodule_fetcher");
const SubmoduleConfigUtil = require("./submodule_config_util");
const UserError           = require("./user_error");
const Walk                = require("./walk");

/**
 * Return the names of the submodules (visible or otherwise) for the index
 * in the specified `repo`.
 *
 * TODO: I wrote this function because the equivalent
 * `NodeGit.Repository.getSubmoduleNames` method is about 100X slower; we
 * should submit a patch to `libgit2` or `nodegit`.
 *
 * @param {NodeGit.Repository} repo
 * @return {String []}
 */
exports.getSubmoduleNames = co.wrap(function *(repo) {
    const index = yield repo.index();
    const subs = yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, index);
    return Object.keys(subs);
});

/**
 * Return the names of the submodules on the specified `commit`, in the
 * specified `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit} commit
 * @return {String []}
 */
exports.getSubmoduleNamesForCommit = co.wrap(function *(repo, commit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    const map = yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo,
                                                                  commit);
    return Object.keys(map);
});

/**
 * Return the names of the submodules on the head of the branch having the
 * specified `branchName` specified `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             branchName
 * @return {String []}
 */
exports.getSubmoduleNamesForBranch = co.wrap(function *(repo, branchName) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(branchName);

    // If the requested branch is the current branch, we can just ask the repo.
    // Otherwise, we have to do something much more complicated and expensive.

    const commit = yield repo.getBranchCommit(branchName);
    return yield exports.getSubmoduleNamesForCommit(repo, commit);
});

/**
 * Return a map from submodule name to string representing the expected sha1
 * for its repository in the specified `repo` on the specified `commit` for the
 * submodules whose names are in the specified `submoduleNames` array.  Note
 * that if a submodule in `submoduleNames` does not exist in `commit`, no entry
 * is populated for it in the returned object.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String[]}           submoduleNames
 * @param {NodeGit.Commit}     commit
 * @return {Object}
 */
exports.getSubmoduleShasForCommit =
    co.wrap(function *(repo, submoduleNames, commit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isArray(submoduleNames);
    submoduleNames.forEach(name => assert.isString(name));
    assert.instanceOf(commit, NodeGit.Commit);
    // It's not straight-forward to do submodule operations on arbitrary
    // commits, as all the submodule routines in libgit2 deal with the repo in
    // its checked-out state.

    // We're going to have to grab the object for each submodule and ask
    // for its sha; this value happens to correspond to what the meta-repo
    // believes is the proper commit for that submodule.

    const tree = yield commit.getTree();
    const shaGetter = co.wrap(function *(name) {
        try {
            const entry = yield tree.entryByPath(name);
            return entry.sha();
        }
        catch (e) {
            return null;
        }
    });
    const shas = yield DoWorkQueue.doInParallel(submoduleNames, shaGetter);
    let result = {};
    for (let i = 0; i < submoduleNames.length; ++i) {
        const sha = shas[i];
        if (null !== sha) {
            result[submoduleNames[i]] = sha;
        }
    }
    return result;
});


/**
 * Return a map from submodule name to string representing the expected sha1
 * for its repository in the specified `repo` on the specified `commitish`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             branchName
 * @return {Object}
 */
exports.getSubmoduleShasForCommitish = co.wrap(function *(repo, commitish) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(commitish);
    const annotated = yield NodeGit.AnnotatedCommit.fromRevspec(repo,
                                                                commitish);
    const commit = yield NodeGit.Commit.lookup(repo, annotated.id());
    const submoduleNames =
                    yield exports.getSubmoduleNamesForCommit(repo, commit);

    return yield exports.getSubmoduleShasForCommit(repo,
                                                   submoduleNames,
                                                   commit);
});

/**
 * Return an array of the expected shas for the submodules having the specified
 * `submoduleNames` in the specified `index`.
 *
 * @param {NodeGit.Index} index
 * @param {String []}      submoduleNames
 * @return {String []}
 */
exports.getCurrentSubmoduleShas = function (index, submoduleNames) {
    assert.instanceOf(index, NodeGit.Index);
    assert.isArray(submoduleNames);
    submoduleNames.forEach(name => assert.isString(name));

    let result = [];
    let entry;
    for (let i = 0; i < submoduleNames.length; ++i) {
        entry = index.getByPath(submoduleNames[i]);
        if (entry) {
            result.push(entry.id.tostrS());
        } else {
            // Probably a merge conflict
            result.push(null);
        }
    }
    return result;
};

const gitReservedNames = new Set(["HEAD", "FETCH_HEAD", "ORIG_HEAD",
                                  "COMMIT_EDITMSG", "index", "config",
                                  "logs", "rr-cache", "hooks", "info",
                                  "objects", "refs"]);
/**
 * Return a list of submodules from .git/modules -- that is,
 * approximately, those which we have ever opened.
 */
exports.listAbsorbedSubmodules = co.wrap(function*(repo) {
    const modules_dir = path.join(repo.path(), "modules");
    const out = [];

    if (!fs.existsSync(modules_dir)) {
        return out;
    }
    yield Walk.walk(modules_dir, function*(root, files, dirs) {
        if (files.indexOf("HEAD") !== -1) {
            // We've hit an actual git module -- don't recurse
            // further.  It's possible that our module contains other
            // modules (e.g. if foo/bar/baz gets moved to
            // foo/bar/baz/fleem).  If so, really weird things could
            // happen -- e.g. .git/modules/foo/bar/baz/objects could
            // secretly contain another entire git repo.  There are
            // cases here that regular git can't handle (for instance,
            // if you move a submodule to a subdirectory of itself
            // named "config").  But the vast majority of the time,
            // nested repos won't have name conflicts with git
            // reserved dir names, so we'll just eliminate those
            // reserved name, and recurse the rest if any.

            const filtered = [];
            for (const name of dirs) {
                if (!gitReservedNames.has(name)) {
                    filtered.push(name);
                }
            }
            dirs.splice(0, dirs.length, ...filtered);
            out.push(root.substring(modules_dir.length + 1));
        }
    });


    return out;

});


/**
 * Return true if the submodule having the specified `submoduleName` in the
 * specified `repo` is visible and false otherwise.
 *
 * TODO: `NodeGit.Submodule.status` is way too slow; takes about 40s for 4k
 * repos.  Should submit a patch to fix.

 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             submoduleName
 */
exports.isVisible = function (repo, submoduleName) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(submoduleName);

    const submoduleGitPath = path.join(repo.workdir(), submoduleName, ".git");
    return fs.access(submoduleGitPath, fs.R_OK)
    .then(() => true)
    .catch(() => false);
};

/**
 * Return the `Repository` for the submodule having the specified `name` in the
 * specified `metaRepo`.
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {String}             name
 * @return {NodeGit.Repository}
 */
exports.getRepo = function (metaRepo, name) {
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.isString(name);

    const submodulePath = path.join(metaRepo.workdir(), name);
    return NodeGit.Repository.open(submodulePath);
};

/**
 * Return the `Repository` for the absorbed bare repo for th submodule
 * having the specified `name` in the specified `metaRepo`.  That's
 * the one in meta/.git/modules/...
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {String}             name
 * @return {NodeGit.Repository}
 */
exports.getBareRepo = function (metaRepo, name) {
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.isString(name);

    // metaRepo.path() returns the path to the gitdir.
    const submodulePath = path.join(metaRepo.path(), "modules", name);
    return NodeGit.Repository.openBare(submodulePath);
};

/**
 * Return an array containing a list of the currently open submodules of the
 * specified `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @return {String[]}
 */
exports.listOpenSubmodules = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);
    let text = null;
    const configPath = SubmoduleConfigUtil.getConfigPath(repo);
    try {
        // Sync to avoid race conditions
        text = fs.readFileSync(configPath, "utf8");
    }
    catch (e) {
        return [];                                                    // RETURN
    }

    // In at least one situation -- rebase -- Git will add a submodule to
    // the `.git/config` file without actually opening it, meaning that the
    // `.git/config` file cannot be used as the single source of truth and we
    // must verify with `isVisible`, which looks for a repositories `.git` file.
    // Also, we need to make sure that the submodule is included in the
    // `.gitmodules` file.  If a user abandons a submodule while adding it, it
    // may have a lingering reference in `.git/config` even though it's been
    // removed from `.gitmodules`.

    const configuredSubmodules =
                            SubmoduleConfigUtil.getSubmodulesFromWorkdir(repo);
    const openInConfig = SubmoduleConfigUtil.parseOpenSubmodules(text);
    const visCheckers = openInConfig.map(sub => exports.isVisible(repo, sub));
    const visFlags = yield visCheckers;
    let result = [];
    openInConfig.forEach((name, i) => {
        if ((name in configuredSubmodules) && visFlags[i]) {
            result.push(name);
        }
    });
    return result;
});

/**
 * Return an array containing the submodule names  and repositories of the
 * visible submodules in the specified `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @return {Object []}
 * @return {String}             return.name
 * @return {NodeGit.Repository} return.repo
 */
exports.getSubmoduleRepos = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const openArray = yield exports.listOpenSubmodules(repo);
    const openSet = new Set(openArray);

    const submoduleNames = yield exports.getSubmoduleNames(repo);
    const opener = co.wrap(function *(name) {
        const isVisible = openSet.has(name);
        if (!isVisible) {
            return null;
        }
        const subRepo = yield exports.getRepo(repo, name);
        return {
            name: name,
            repo: subRepo,
        };
    });
    const repos = yield DoWorkQueue.doInParallel(submoduleNames, opener);
    return repos.filter(x => x !== null);
});

/**
 * Return a summary of the submodule SHA changes in the specified `diff`.  Fail
 * if the specified 'allowMetaChanges' is not true and `diff` contains
 * non-submodule changes to the meta-repo.
 *
 * @asycn
 * @param {NodeGit.Diff} diff
 * @param {Bool} allowMetaChanges
 * @return {Object} map from name to `SubmoduleChange`
 */
exports.getSubmoduleChangesFromDiff = function (diff, allowMetaChanges) {
    assert.instanceOf(diff, NodeGit.Diff);
    assert.isBoolean(allowMetaChanges);

    const num = diff.numDeltas();
    const result = {};
    const DELTA = NodeGit.Diff.DELTA;
    const COMMIT = NodeGit.TreeEntry.FILEMODE.COMMIT;
    const modulesFileName = SubmoduleConfigUtil.modulesFileName;
    for (let i = 0; i < num; ++i) {
        const delta = diff.getDelta(i);
        switch (delta.status()) {
            case DELTA.COPIED:
            case DELTA.RENAMED: {
                if (COMMIT === delta.newFile.mode() ||
                    COMMIT === delta.oldFile.mode()) {
                    throw new Error(
                           "Not sure if these are possible.  TODO: find out.");
                }
            } break;
            case DELTA.MODIFIED:
            case DELTA.CONFLICTED: {
                const newFile = delta.newFile();
                const path = newFile.path();
                if (COMMIT === newFile.mode()) {
                    result[path] = new SubmoduleChange(
                                                 delta.oldFile().id().tostrS(),
                                                 newFile.id().tostrS(), 
                                                 null);
                } else if (!allowMetaChanges && path !== modulesFileName) {
                    throw new UserError(`\
Modification to meta-repo file ${colors.red(path)} is not supported.`);
                }
            } break;
            case DELTA.ADDED: {
                const newFile = delta.newFile();
                const path = newFile.path();
                if (COMMIT === newFile.mode()) {
                    result[path] = new SubmoduleChange(null,
                                                       newFile.id().tostrS(),
                                                       null);
                } else if (!allowMetaChanges && path !== modulesFileName) {
                    throw new UserError(`\
Addition to meta-repo of file ${colors.red(path)} is not supported.`);
                }
            } break;
            case DELTA.DELETED: {
                const oldFile = delta.oldFile();
                const path = oldFile.path();
                if (COMMIT === oldFile.mode()) {
                    result[path] = new SubmoduleChange(oldFile.id().tostrS(),
                                                       null,
                                                       null);
                } else if (!allowMetaChanges && path !== modulesFileName) {
                    throw new UserError(`\
Deletion of meta-repo file ${colors.red(path)} is not supported.`);
                }
            } break;
        }
    }
    return result;
};

/**
 * Return a summary of the submodule SHAs changed by the specified `commit`
 * in the specified `repo`, and flag denoting whether or not the `.gitmodules`
 * file was changed.  If 'commit' contains changes to the meta-repo and the
 * specified 'allowMetaChanges' is not true, throw a 'UserError'.  If the
 * specified `baseCommit` is provided, calculate changes between it and
 * `commit`; otherwise, calculate changes between `commit` and its first
 * parent.
 *
 * @asycn
 * @param {NodeGit.Repository}  repo
 * @param {NodeGit.Commit}      commit
 * @param {NodeGit.Commit|null} baseCommit
 * @param {Bool} allowMetaChanges
 * @return {Object} map from name to `SubmoduleChange`
 */
exports.getSubmoduleChanges = co.wrap(function *(repo,
                                                 commit,
                                                 baseCommit,
                                                 allowMetaChanges) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    if (null !== baseCommit) {
        assert.instanceOf(baseCommit, NodeGit.Commit);
    }
    assert.isBoolean(allowMetaChanges);

    // We calculate the changes of a commit against its first parent.  If it
    // has no parents, then the calculation is against an empty tree.

    let baseTree = null;
    if (null !== baseCommit) {
        baseTree = yield baseCommit.getTree();
    } else {
        const parents = yield commit.getParents();
        if (0 !== parents.length) {
            baseTree = yield parents[0].getTree();
        }
    }

    const tree = yield commit.getTree();
    const diff = yield NodeGit.Diff.treeToTree(repo, baseTree, tree, null);
    return yield exports.getSubmoduleChangesFromDiff(diff, allowMetaChanges);
});

/**
 * Return the states of the submodules in the specified `commit` in the
 * specified `repo`.  If the specified 'names' is not null, return only
 * submodules in 'names'; otherwise, return all submodules.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 * @param {String[]|null}      names
 * @return {Object} map from submodule name to `Submodule` object
 */
exports.getSubmodulesForCommit = co.wrap(function *(repo, commit, names) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    if (null !== names) {
        assert.isArray(names);
    }
    const urls =
               yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, commit);
    if (null === names) {
        names = Object.keys(urls);
    }
    else {
        names = names.filter(n => n in urls);
    }
    const shas = yield exports.getSubmoduleShasForCommit(repo, names, commit);
    let result = {};
    names.forEach(name => {
        result[name] = new Submodule(urls[name], shas[name]);
    });
    return result;
});

/**
 * Return the list of submodules, listed in the specified `indexSubNames`, that
 * are a descendant of the specified `dir`, including (potentially) `dir`
 * itself (unless `dir` is suffixed with '/').
 *
 * if includeParents is true, submodules that would be parent
 * directories of `dir` are are also included
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             dir
 * @param {String []}          indexSubNames
 * @param {Boolean}            includeParents
 * @return {String[]}
 */
exports.getSubmodulesInPath = function (dir, indexSubNames, includeParents) {
    assert.isString(dir);
    assert.isArray(indexSubNames);
    if (includeParents === undefined) {
        includeParents = false;
    }
    if ("" !== dir) {
        assert.notEqual("/", dir[0]);
        assert.notEqual(".", dir);
        assert.notEqual("..", dir);
    }
    if ("" === dir) {
        return indexSubNames;
    }

    // test if the short path is a parent dir of the long path
    const isParentDir = (shortPath, longPath) => {
        return longPath.startsWith(shortPath) && (
            shortPath[shortPath.length-1] === "/" ||
            longPath[shortPath.length] === "/"
        );
    };
    const result = [];
    for (const subPath of indexSubNames) {
        if (subPath === dir) {
            return [dir];                                             // RETURN
        } else if (isParentDir(dir, subPath)) {
            result.push(subPath);
        } else if (includeParents && isParentDir(subPath, dir)) {
            result.push(subPath);
        }
    }
    return result;
};

/**
 * Return the list of submodules found in the specified `paths` in the
 * specified meta-repo `workdir`, containing the submodules having the
 * specified `submoduleNames`.  Treat paths as being relative to the specified
 * `cwd`.  Throw a `UserError` if an path outside of the workdir is
 * encountered.  If a path inside the workdir contains no submodules,
 * either log a warning, or, if throwOnMissing is set, throw a `UserError`.
 *
 * @param {String} workdir
 * @param {String} cwd
 * @param {String[]} submoduleNames
 * @param {String[]} paths
 * @param {Boolean} throwOnMissing
 * @return {String[]}
 */
exports.resolveSubmoduleNames = function (workdir,
                                          cwd,
                                          submoduleNames,
                                          paths,
                                          throwOnMissing) {
    assert.isString(workdir);
    assert.isString(cwd);
    assert.isArray(submoduleNames);
    assert.isArray(paths);

    const subLists = paths.map(filename => {
        // Compute the relative path for `filename` from the root of the repo,
        // and check for invalid values.
        const relPath = GitUtil.resolveRelativePath(workdir,
                                                    cwd,
                                                    filename);
        const result = exports.getSubmodulesInPath(relPath,
                                                   submoduleNames,
                                                   false);
        if (0 === result.length) {
            const msg = `\
No submodules found from ${colors.yellow(filename)}.`;
            if (throwOnMissing) {
                throw new UserError(msg);
            } else {
                console.warn(msg);
            }
        }
        return result;
    });
    return subLists.reduce((a, b) => a.concat(b), []);
};

/**
 * Return a map from `paths` to the list of of submodules found under those
 * paths in the specified meta-repo `workdir`, containing the submodules
 * having the specified `submoduleNames`.  Treat paths as being relative to
 * the specified `cwd`.  Throw a `UserError` if an path outside of the workdir
 * is encountered.  If a path inside the workdir contains no submodules,
 * either log a warning, or, if throwOnMissing is set, throw a `UserError`.
 *
 * @param {String} workdir
 * @param {String} cwd
 * @param {String[]} submoduleNames
 * @param {String[]} paths
 * @param {Boolean} throwOnMissing
 * @return {String[]}
 */
exports.resolveSubmodules = function (workdir,
                                      cwd,
                                      submoduleNames,
                                      paths,
                                      throwOnMissing) {
    assert.isString(workdir);
    assert.isString(cwd);
    assert.isArray(submoduleNames);
    assert.isArray(paths);

    const byFilename = {};
    paths.forEach(filename => {
        // Compute the relative path for `filename` from the root of the repo,
        // and check for invalid values.
        const relPath = GitUtil.resolveRelativePath(workdir,
                                                    cwd,
                                                    filename);
        const result = exports.getSubmodulesInPath(relPath,
                                                   submoduleNames,
                                                   true);
        if (0 === result.length) {
            const msg = `\
No submodules found from ${colors.yellow(filename)}.`;
            if (throwOnMissing) {
                throw new UserError(msg);
            } else {
                console.warn(msg);
            }
        }
        byFilename[filename] = result;
    });

    const out = {};
    for (let [filename, paths] of Object.entries(byFilename)) {
        for (const path of paths) {
            if (out[path]) {
                if (!out[path].includes(filename)) {
                    out[path].push(filename);
                }
            } else {
                out[path] = [filename];
            }
        }
    }
    return out;
};


/**
 * Return a map from submodule name to an array of paths (relative to the root
 * of each submodule) identified by the specified `paths`, indicating one of
 * the submodule names in the specified `indexSubNames`.  Check each path to
 * see if it points into one of the specified `openSubmodules`, and add the
 * relative offset to the paths for that submodule if it does.  If any path in
 * `paths` contains a submodule entirely (as opposed to a sub-path within it),
 * it will be mappped to an empty array (regardless of whether or not any
 * sub-path in that submodule is identified).
 *
 * @param {String []} paths
 * @param {String []} indexSubNames
 * @param {String []} openSubmodules
 * @param {Boolean} failOnUnprefixed
 * @return {Object} map from submodule name to array of paths
 */
exports.resolvePaths = function (paths, indexSubNames, openSubmodules,
                                 failOnUnprefixed) {
    assert.isArray(paths);
    assert.isArray(indexSubNames);
    assert.isArray(openSubmodules);
    if (failOnUnprefixed === undefined) {
        failOnUnprefixed = false;
    } else {
        assert.isBoolean(failOnUnprefixed);
    }

    const result = {};

    // First, populate 'result' with all the subs that are completely
    // contained, and clean the relevant specs out of paths

    const remainingPaths = [];
    const add = subName => result[subName] = [];
    for (const path of paths) {
        const subs = exports.getSubmodulesInPath(path, indexSubNames);
        if (subs.length > 0) {
            subs.forEach(add);
        } else {
            remainingPaths.push(path);
        }
    }
    paths = remainingPaths;

    // Now check to see which paths refer to a path inside a submodule.
    // Checking each file against the name of each open submodule has
    // potentially N^2 behavior, but it will be unlikely to be an issue unless
    // there are both a large number of paths specifically identified, and a
    // large number of open submodules, in which case I imagine that the cost
    // of this check will not be the bottleneck anyway.

    // First, filter out subs that are already completely contained.

    const subsToCheck = openSubmodules.filter(subName => {
        return !(subName in result);
    });

    for (let i = 0; i < paths.length; ++i) {
        const filename = paths[i];
        let found = false;
        for (let j = 0; j < subsToCheck.length; ++j) {
            const subName = subsToCheck[j];
            if (filename === subName) {
                found = true;
                result[subName] = [];
            } else if (filename.startsWith(subName + "/")) {
                found = true;
                const pathInSub = filename.slice(subName.length + 1,
                                                 filename.length);
                const subPaths = result[subName];
                if (undefined === subPaths) {
                    result[subName] = [pathInSub];
                }
                else {
                    subPaths.push(pathInSub);
                }
            }
        }
        if (!found && failOnUnprefixed) {
            throw new UserError(`\
pathspec '${filename}' did not match any files`);
        }
    }

    return result;
};

/**
 * Create references having the specified `refs` names in each of the specified
 * `submodules`, in the specified `repo` with each created reference being
 * assigned to the commit indicated for that respective submodule by the ref
 * with that name in the meta-repo.  Do not create a reference in a submodule
 * when for references indicating commits in which that submodule does not
 * exist.  Note that if a reference is the *current* branch of a sub-repo, it
 * is not adjusted. The behavior is undefined unless each `ref` is a valid
 * reference name in `repo`, and each submodule in `submodules` is open.
 *
 * @param {NodeGit.Repository} repo
 * @param {String[]}           refs
 * @param {String[]}           submodules
 */
exports.syncRefs = co.wrap(function *(repo, refs, submodules) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isArray(refs);
    assert.isArray(submodules);

    const subRepos = {};
    yield submodules.map(co.wrap(function *(name) {
        subRepos[name] = yield exports.getRepo(repo, name);
    }));

    yield refs.map(co.wrap(function *(name) {
        const ref = yield NodeGit.Reference.lookup(repo, name);
        const commit = yield repo.getCommit(ref.target());
        const tree = yield commit.getTree();
        const fetcher = new SubmoduleFetcher(repo, commit);
        yield submodules.map(co.wrap(function *(subName) {
            const subRepo = subRepos[subName];
            const head = yield subRepo.head();

            // Skip if this sub is on the branch 'name'.

            if (!head.isBranch() || head.name() !== name) {
                let entry = null;
                try {
                    entry = yield tree.entryByPath(subName);
                }
                catch (e) {
                    // If we fail, the sub doesn't exist on this commit.
                    // Catching this exception is the only way to know.

                    return;                                           // RETURN
                }
                const sha = entry.sha();

                // Make sure we have this commit.

                yield fetcher.fetchSha(subRepo, subName, sha);

                yield NodeGit.Reference.create(subRepo,
                                               name,
                                               NodeGit.Oid.fromString(sha),
                                               1,
                                               "syncRefs");
            }
        }));
    }));
});
