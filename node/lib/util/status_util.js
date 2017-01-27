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
 * This module provides utilities for reading `RepoStatus` objects --
 * describing state changes -- from a repository.
 *
 */

const assert  = require("chai").assert;
const co      = require("co");
const NodeGit = require("nodegit");

const GitUtil             = require("../util/git_util");
const Rebase              = require("../util/rebase");
const RebaseFileUtil      = require("../util/rebase_file_util");
const RepoStatus          = require("../util/repo_status");
const SubmoduleUtil       = require("../util/submodule_util");
const SubmoduleConfigUtil = require("../util/submodule_config_util");

/**
 * Return status changes for the specified `paths` in the specified `repo`.  If
 * the specified `allUntracked` is true, include all untracked files rather
 * than accumulating them by directory.  If `paths` is empty, check the entire
 * `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @param {String []} paths
 * @param {Boolean} allUntracked
 * @return {Object}
 * @return {Object} return.staged path to FILESTATUS of staged changes
 * @return {Object} return.workdir path to FILESTATUS of workdir changes
 */
exports.getChanges = co.wrap(function *(repo, paths, allUntracked) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isArray(paths);
    assert.isBoolean(allUntracked);

    const result = {
        staged: {},
        workdir: {},
    };

    // Loop through each of the `NodeGit.FileStatus` objects in the repo and
    // categorize them into `result`.

    const options = {
        flags: NodeGit.Status.OPT.EXCLUDE_SUBMODULES |
               NodeGit.Status.OPT.INCLUDE_UNTRACKED,
        pathspec: paths,
    };
    if (allUntracked) {
        options.flags = options.flags |
                        NodeGit.Status.OPT.RECURSE_UNTRACKED_DIRS;
    }
    const statuses = yield repo.getStatusExt(options);
    const FILESTATUS = RepoStatus.FILESTATUS;
    const STATUS = NodeGit.Status.STATUS;
    for (let i = 0; i < statuses.length; ++i) {
        const status = statuses[i];
        const path = status.path();

        // Skip the `.gitmodules` file.

        if (SubmoduleConfigUtil.modulesFileName === path) {
            continue;                                           // CONTINUE
        }

        const bit = status.statusBit();

        // Index status.

        if (bit & STATUS.INDEX_NEW) {
            result.staged[path] = FILESTATUS.ADDED;
        }
        else if (bit & STATUS.INDEX_DELETED) {
            result.staged[path] = FILESTATUS.REMOVED;
        }
        else if (bit & STATUS.INDEX_MODIFIED) {
            result.staged[path] = FILESTATUS.MODIFIED;
        }

        // Workdir status

        if (bit & STATUS.WT_NEW) {
            result.workdir[path] = FILESTATUS.ADDED;
        }
        else if (bit & STATUS.WT_DELETED) {
            result.workdir[path] = FILESTATUS.REMOVED;
        }
        else if (bit & STATUS.WT_MODIFIED) {
            result.workdir[path] = FILESTATUS.MODIFIED;
        }
    }
    return result;
});


/**
 * Return the `RepoStatus.Submodule` for the submodule having the specified
 * `name` in the specified `metaRepo`.  The specified `indexUrl` contains the
 * configured url for this submodule, unless it has been removed in the index.
 * The specified `commitUrl` contains the configured url for this submodule,
 * unless it has just been added to the index. The specified `isVisible` is
 * true if the submodule has an open repository.  Use the specified
 * `readRepoStatus` to read the status of a repository.  The specified `index`
 * and `commitTree` are used to read the shas for the meta repository index and
 * current commit, respectively.
 *
 * Note that this method is mostly exposed to make it easier to test, and the
 * `readRepoStatus` parameter is provided to break a cycle between this method
 * and `getRepoStatus`.
 *
 * @async
 * @private
 * @param {String}                          name
 * @param {NodeGit.Repository}              metaRepo
 * @param {String}                          [indexUrl]
 * @param {String}                          [commitUrl]
 * @param {NodeGit.Index}                   index
 * @param {NodeGit.Tree}                    commitTree
 * @param {Boolean}                         isVisible
 * @param {(repo) => Promise -> RepoStatus} readRepoStatus
 * @return {RepoStatus.Submodule}
 */
exports.getSubmoduleStatus = co.wrap(function *(name,
                                                metaRepo,
                                                indexUrl,
                                                commitUrl,
                                                index,
                                                commitTree,
                                                isVisible,
                                                readRepoStatus) {
    const args = {
        indexUrl: indexUrl,
        commitUrl: commitUrl,
    };

    const FILESTATUS = RepoStatus.FILESTATUS;
    const COMMIT_RELATION = RepoStatus.Submodule.COMMIT_RELATION;

    // If we have a null commitUrl, it means that the submodule exists in the
    // commit but not on the index; set index status to added.  Otherwise, load
    // up the commit sha.

    if (null === commitUrl) {
        args.indexStatus = FILESTATUS.ADDED;
    }
    else {
        args.commitSha = (yield commitTree.entryByPath(name)).sha();
    }

    // A null indexUrl indicates that the submodule was removed.  Otherwise,
    // load up the sha in the index.

    if (null === indexUrl) {
        args.indexStatus = FILESTATUS.REMOVED;
    }
    else {
        const entry = index.getByPath(name);
        if (entry) {
            args.indexSha = entry.id.tostrS();
        }
        else {
            args.indexSha = null;
        }
    }

    // If we have both an index and commit url, then we should have shas for
    // both; if that is the case, set the status to MODIFIED if they are
    // different.

    if (null !== indexUrl && null !== commitUrl) {
        if (indexUrl !== commitUrl) {
            args.indexStatus = FILESTATUS.MODIFIED;
        }
        if (args.indexSha !== args.commitSha) {
            args.indexStatus = FILESTATUS.MODIFIED;

            // Set relation to unknown for now; if we have a repository then
            // we'll check later.

            args.indexShaRelation = COMMIT_RELATION.UNKNOWN;
        }
        else {
            args.indexShaRelation = COMMIT_RELATION.SAME;
        }
    }

    // We've done all we can for non-visible sub-repos.

    if (!isVisible) {
        return new RepoStatus.Submodule(args);                        // RETURN
    }

    const subRepo = yield SubmoduleUtil.getRepo(metaRepo, name);
    const subStatus = yield readRepoStatus(subRepo);

    /**
     * Return COMMIT_RELATION.AHEAD if the commit having the specified `to` sha
     * in `subRepo` is a descendant of the specified `from`, BEHIND if `from`
     * is a descendant of `to`, and UNRELATED if neither is descended from the
     * other.  If null is provided for either value, return null.
     *
     * @param {String} [from]
     * @param {String} [to]
     * @return {RepoStatus.Submodule.COMMIT_RELATION|null}
     */
    const getRelation = co.wrap(function *(from, to) {
        if (!from || !to) {
            return null;
        }
        assert.isString(from);
        assert.isString(to);
        if (from === to) {
            return COMMIT_RELATION.SAME;
        }

        const fromId = NodeGit.Oid.fromString(from);
        const toId = NodeGit.Oid.fromString(to);

        // If one of the commits is not present, `descendantOf` will throw.

        let toDescendant;
        try {
            toDescendant = yield NodeGit.Graph.descendantOf(subRepo,
                                                            toId,
                                                            fromId);
        }
        catch (e) {
            return COMMIT_RELATION.UNKNOWN;
        }

        if (toDescendant) {
            return COMMIT_RELATION.AHEAD;
        }

        const fromDescendant = yield NodeGit.Graph.descendantOf(subRepo,
                                                                fromId,
                                                                toId);
        if (fromDescendant) {
            return COMMIT_RELATION.BEHIND;
        }
        return COMMIT_RELATION.UNRELATED;
    });

    // Compute the relations between the commits specifed in the workdir,
    // index, and commit.

    args.indexShaRelation = yield getRelation(args.commitSha, args.indexSha);
    args.workdirShaRelation = yield getRelation(args.indexSha,
                                                subStatus.headCommit);
    args.repoStatus = subStatus;
    return new RepoStatus.Submodule(args);
});

/**
 * Return a description of the status of changes to the specified `repo`.  If
 * the optionally specified `options.showAllUntracked` is true (default false),
 * return each untracked file individually rather than rolling up to the
 * directory.  If the optionally specified `options.paths` is non-empty
 * (default []), list the status only of the files contained in `paths`.  If
 * the optionally specified `options.showMetaChanges` is provided (default
 * true), return the status of changes in `repo`; otherwise, show only changes
 * in submobules.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {Object}             [options]
 * @param {Boolean}            [options.showAllUntracked]
 * @param {String []}          [options.paths]
 * @param {Boolean}            [options.showMetaChanges]
 * @return {RepoStatus}
 */
exports.getRepoStatus = co.wrap(function *(repo, options) {
    assert.instanceOf(repo, NodeGit.Repository);

    // validate and fill in optional parameters

    if (undefined === options) {
        options = {};
    }
    else {
        assert.isObject(options);
    }
    if (undefined === options.showAllUntracked) {
        options.showAllUntracked = false;
    }
    else {
        assert.isBoolean(options.showAllUntracked);
    }
    if (undefined === options.paths) {
        options.paths = [];
    }
    else {
        assert.isArray(options.paths);
    }
    if (undefined === options.showMetaChanges) {
        options.showMetaChanges = true;
    }
    else {
        assert.isBoolean(options.showMetaChanges);
    }

    const headCommit = yield repo.getHeadCommit();

    let args = {
        headCommit: null === headCommit ? null : headCommit.id().tostrS(),
        currentBranchName: yield GitUtil.getCurrentBranchName(repo),
        staged: {},
        workdir: {},
        submodules: {},
    };

    // Rebase, need to get shorthand for branch if available.

    let rebase = yield RebaseFileUtil.readRebase(repo.path());
    if (null !== rebase) {
        const rebaseBranch = yield GitUtil.findBranch(repo, rebase.headName);
        if (null !== rebaseBranch) {
            rebase = new Rebase(rebaseBranch.shorthand(),
                                rebase.originalHead,
                                rebase.onto);
        }
        args.rebase = rebase;
    }

    if (options.showMetaChanges && !repo.isBare()) {
        const status = yield exports.getChanges(repo,
                                                options.paths,
                                                options.showAllUntracked);
        args.staged = status.staged;
        args.workdir = status.workdir;
    }

    // Now do the submodules.  First, list the submodules visible in the head
    // commit and index.
    //
    // TODO: For now, we're just not going to return the status of submodules
    // in a headless repository (which is better than our previous behavior of
    // crashing); we should fix it so that we can accurately reflect staged
    // submodules in the index.

    if (null !== headCommit) {
        // Now we need to figure out which subs to list, and what paths to
        // inspect in them.

        const openArray = yield SubmoduleUtil.listOpenSubmodules(repo);
        const openSet = new Set(openArray);
        const index = yield repo.index();
        const indexUrls =
                 yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, index);
        const indexNames = Object.keys(indexUrls);
        const headUrls =
           yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, headCommit);


        // No paths specified, so we'll do all submodules, restricing to open
        // ones based on options.

        let filterPaths; // map from sub name to paths to use
        let subsToList;  // array of subs that will be in result
        const filtering = 0 !== options.paths.length;
        if (filtering) {
            filterPaths = yield SubmoduleUtil.resolvePaths(repo.workdir(),
                                                           options.paths,
                                                           indexNames,
                                                           openArray);
            subsToList = Object.keys(filterPaths);
        }
        else {
            // Compute the list by joining the list of submodules listed in the
            // index and on head.
            subsToList = Array.from(new Set(
                                    Object.keys(headUrls).concat(indexNames)));
        }
        const commitTree = yield headCommit.getTree();


        // Make a list of promises to read the status for each submodule, then
        // evaluate them in parallel.

        const getSubRepo = function (subName, subRepo) {
            const paths = filtering ? filterPaths[subName] : [];
            return exports.getRepoStatus(subRepo, {
                paths: paths,
                showAllUntracked: options.showAllUntracked,
            });
        };

        const subStatMakers = subsToList.map(name => {
            return exports.getSubmoduleStatus(name,
                                              repo,
                                              indexUrls[name] || null,
                                              headUrls[name] || null,
                                              index,
                                              commitTree,
                                              openSet.has(name),
                                              repo => getSubRepo(name, repo));
        });
        const subStats = yield subStatMakers;

        // And copy them into the arguments.

        subsToList.forEach((name, i) => {
            args.submodules[name] = subStats[i];
        });
    }

    return new RepoStatus(args);
});
