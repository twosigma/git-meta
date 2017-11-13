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

const GitUtil             = require("./git_util");
const Submodule           = require("./submodule");
const SubmoduleChange     = require("./submodule_change");
const SubmoduleFetcher    = require("./submodule_fetcher");
const SubmoduleConfigUtil = require("./submodule_config_util");

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
    const shaGetters = submoduleNames.map(co.wrap(function *(name) {
        try {
            const entry = yield tree.entryByPath(name);
            return entry.sha();
        }
        catch (e) {
            return null;
        }
    }));
    const shas = yield shaGetters;
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
 * for its repository in the specified `repo` on the branch having the
 * specified `branchName`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             branchName
 * @return {Object}
 */
exports.getSubmoduleShasForBranch = co.wrap(function *(repo, branchName) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(branchName);
    const commit = yield repo.getBranchCommit(branchName);
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
            result.push(`${colors.red("missing entry")}`);
        }
    }
    return result;
};

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
    // must verify with `isVisble`, which looks for a repositories `.git` file.

    const openInConfig = SubmoduleConfigUtil.parseOpenSubmodules(text);
    const visCheckers = openInConfig.map(sub => exports.isVisible(repo, sub));
    const visFlags = yield visCheckers;
    let result = [];
    openInConfig.forEach((name, i) => {
        if (visFlags[i]) {
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
    const openers = submoduleNames.map(co.wrap(function *(name) {
        const isVisible = openSet.has(name);
        if (!isVisible) {
            return null;
        }
        const subRepo = yield exports.getRepo(repo, name);
        return {
            name: name,
            repo: subRepo,
        };
    }));
    const repos = yield openers;
    return repos.filter(x => x !== null);
});

/**
 * Return a summary of the submodule SHA changes in the specified `diff`.
 * TODO: Test this separately from `getSubmoduleChanges`.
 *
 * @asycn
 * @param {NodeGit.Diff} diff
 * @return {Object} map from name to `SubmoduleChange`
 */
exports.getSubmoduleChangesFromDiff = function (diff) {
    assert.instanceOf(diff, NodeGit.Diff);

    const num = diff.numDeltas();
    const result = {};
    const DELTA = NodeGit.Diff.DELTA;
    const COMMIT = NodeGit.TreeEntry.FILEMODE.COMMIT;
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
                                                 newFile.id().tostrS());
                }
            } break;
            case DELTA.ADDED: {
                const newFile = delta.newFile();
                const path = newFile.path();
                if (COMMIT === newFile.mode()) {
                    result[path] = new SubmoduleChange(null,
                                                       newFile.id().tostrS());
                }
            } break;
            case DELTA.DELETED: {
                const oldFile = delta.oldFile();
                const path = oldFile.path();
                if (COMMIT === oldFile.mode()) {
                    result[path] = new SubmoduleChange(oldFile.id().tostrS(),
                                                       null);
                }
            } break;
        }
    }
    return result;
};

/**
 * Return a summary of the submodule SHAs changed by the specified `commitId`
 * in the specified `repo`, and flag denoting whether or not the `.gitmodules`
 * file was changed.
 *
 * @asycn
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 * @return {Object} map from name to `SubmoduleChange`
 */
exports.getSubmoduleChanges = co.wrap(function *(repo, commit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);

    // We calculate the changes of a commit against its first parent.  If it
    // has no parents, then the calculation is against an empty tree.

    let parentTree = null;
    const parents = yield commit.getParents();
    if (0 !== parents.length) {
        parentTree = yield parents[0].getTree();
    }

    const tree = yield commit.getTree();
    const diff = yield NodeGit.Diff.treeToTree(repo, parentTree, tree, null);
    return yield exports.getSubmoduleChangesFromDiff(diff);
});

/**
 * Return the states of the submodules in the specified `commit` in the
 * specified `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 * @return {Object} map from submodule name to `Submodule` object
 */
exports.getSubmodulesForCommit = co.wrap(function *(repo, commit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    const urls =
               yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, commit);
    const names = Object.keys(urls);
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
 * itself (unless `dir` is suffixed with '/'), in the specified `repo`.  The
 * behavior is undefined unless `dir` is empty or refers to a valid path within
 * `repo`.  Note that if `"" === dir`, the result will be all submodules.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             dir
 * @param {String []}          indexSubNames
 * @return {String[]}
 */
exports.getSubmodulesInPath = co.wrap(function *(workdir, dir, indexSubNames) {
    assert.isString(workdir);
    assert.isString(dir);
    assert.isArray(indexSubNames);
    if ("" !== dir) {
        assert.notEqual("/", dir[0]);
        assert.notEqual(".", dir);
        assert.notEqual("..", dir);
    }
    if ("" === dir) {
        return indexSubNames;
    }
    const subs = new Set(indexSubNames);
    const result = [];
    const listForFilename = co.wrap(function *(filepath) {
        if (subs.has(filepath)) {
            result.push(filepath);
        }
        else {
            const absPath = path.join(workdir, filepath);
            const stat = yield fs.stat(absPath);
            if (stat.isDirectory()) {
                const subdirs = yield fs.readdir(absPath);
                yield subdirs.map(filename => {
                    return listForFilename(path.join(filepath, filename));
                });

            }
        }
    });
    yield listForFilename(dir);
    return result;
});

/**
 * Return the list of submodules found in the specified `paths` in the
 * specified meta-repo `workdir`, containing the submodules having the
 * specified `submoduleNames`.  Treat paths as being relative to the specified
 * `cwd`.  Throw a `UserError` if an invalid path is encountered, and log
 * warnings for valid paths containing no submodules.
 *
 * @async
 * @param {String} workdir
 * @param {String} cwd
 * @param {String[]} submoduleNames
 * @param {String[]} paths
 * @return {String[]}
 */
exports.resolveSubmoduleNames = co.wrap(function *(workdir,
                                                   cwd,
                                                   submoduleNames,
                                                   paths) {
    assert.isString(workdir);
    assert.isString(cwd);
    assert.isArray(submoduleNames);
    assert.isArray(paths);

    const subLists = yield paths.map(co.wrap(function *(filename) {
        // Compute the relative path for `filename` from the root of the repo,
        // and check for invalid values.
        const relPath = yield GitUtil.resolveRelativePath(workdir,
                                                          cwd,
                                                          filename);
        const result = yield exports.getSubmodulesInPath(workdir,
                                                         relPath,
                                                         submoduleNames);
        if (0 === result.length) {
            console.warn(`\
No submodules found from ${colors.yellow(filename)}.`);
        }
        return result;
    }));
    return subLists.reduce((a, b) => a.concat(b), []);
});

/**
 * Return a map from submodule name to an array of paths (relative to the root
 * of each submodule) identified by the specified `paths` relative to the root
 * of the specified `workdir`, indicating one of the submodule names in the
 * specified `indexSubNames`.  Check each path to see if it points into one of
 * the specified `openSubmodules`, and add the relative offset to the paths for
 * that submodule if it does.  If any path in `paths` contains a submodule
 * entirely (as opposed to a sub-path within it), it will be mappped to an
 * empty array (regardless of whether or not any sub-path in that submodule is
 * identified).
 *
 * @param {String}    workdir
 * @param {String []} paths
 * @param {String []} indexSubNames
 * @param {String []} openSubmodules
 * @return {Object} map from submodule name to array of paths
 */
exports.resolvePaths = co.wrap(function *(workdir,
                                          paths,
                                          indexSubNames,
                                          openSubmodules) {
    assert.isString(workdir);
    assert.isArray(paths);
    assert.isArray(indexSubNames);
    assert.isArray(openSubmodules);

    const result = {};

    // First, populate 'result' with all the subs that are completely
    // contained.

    yield paths.map(co.wrap(function *(path) {
        const subs = yield exports.getSubmodulesInPath(workdir,
                                                       path,
                                                       indexSubNames);
        subs.forEach(subName => result[subName] = []);
    }));

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
        for (let j = 0;  j < subsToCheck.length; ++j) {
            const subName = subsToCheck[j];
            if (filename.startsWith(subName + "/")) {
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
    }

    return result;
});

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
exports.addRefs = co.wrap(function *(repo, refs, submodules) {
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
                                               "addRefs");
            }
        }));
    }));
});

/**
 * Cache the submodules before invoking the specified `operation` and uncache
 * them after the operation is completed, or before allowing an exception to
 * propagte.  Return the result of `operation`.
 *
 * @param {NodeGit.Repository} repo
 * @param {(repo ) => Promise} operation
 */
exports.cacheSubmodules = co.wrap(function *(repo, operation) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isFunction(operation);
    repo.submoduleCacheAll();
    let result;
    try {
        result = yield operation(repo);
    }
    catch (e) {
        repo.submoduleCacheClear();
        throw e;
    }
    repo.submoduleCacheClear();
    return result;
});

/**
 * Attempt to handle a conflicted `.gitmodules` file in the specified `repo`
 * with changes from the specified `fromCommit` and `ontoCommit` commits.  If
 * successful, write the result to the .gitmodules file and return true;
 * otherwise, return false.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     fromCommit
 * @param {NodeGit.Commit}     ontoCommit
 * @return {Boolean}
 */
exports.mergeModulesFile = co.wrap(function *(repo,
                                              fromCommit,
                                              ontoCommit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(fromCommit, NodeGit.Commit);
    assert.instanceOf(ontoCommit, NodeGit.Commit);
    // If there is a conflict in the '.gitmodules' file, attempt to resolve it
    // by comparing the current change against the original onto commit and the
    // merge base between the base and onto commits.

    const Conf = SubmoduleConfigUtil;
    const getSubs = Conf.getSubmodulesFromCommit;
    const fromNext = yield getSubs(repo, fromCommit);

    const baseId = yield NodeGit.Merge.base(repo,
                                            fromCommit.id(),
                                            ontoCommit.id());
    const mergeBase = yield repo.getCommit(baseId);
    const baseSubs =
            yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, mergeBase);

    const ontoSubs = yield SubmoduleConfigUtil.getSubmodulesFromCommit(
                                                                   repo,
                                                                   ontoCommit);

    const merged = Conf.mergeSubmoduleConfigs(fromNext, ontoSubs, baseSubs);
                        // If it was resolved, write out and stage the new
                        // modules state.

    if (null !== merged) {
        const newConf = Conf.writeConfigText(merged);
        yield fs.writeFile(path.join(repo.workdir(), Conf.modulesFileName),
                           newConf);
        return true;
    }
    return false;
});

