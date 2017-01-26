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
 * This module provides utilities for loading and displaying `RepoStatus`
 * objects.
 *
 * TODO: this module should be split into two: one for reading status and one
 * for displaying.
 */

const assert  = require("chai").assert;
const co      = require("co");
const colors  = require("colors/safe");
const NodeGit = require("nodegit");
const path    = require("path");

const GitUtil             = require("../util/git_util");
const UserError           = require("../util/user_error");
const Rebase              = require("../util/rebase");
const RebaseFileUtil      = require("../util/rebase_file_util");
const RepoStatus          = require("../util/repo_status");
const SubmoduleUtil       = require("../util/submodule_util");
const SubmoduleConfigUtil = require("../util/submodule_config_util");

/**
 * This value-semantic class describes a line entry to be printed in a status
 * message.
 */
class StatusDescriptor {
    /**
     * @param {RepoStatus.FILESTATUS} status
     * @param {String}                path
     * @param {String}                detail
     */
    constructor(status, path, detail) {
        this.status = status;
        this.path = path;
        this.detail = detail;
    }

    /**
     * Return a description of this object using the specified `color` function
     * to apply color and displaying `this.path` relative to the specified
     * `cwd`.
     *
     * @param {Function} color
     * @return {String}
     */
    print(color, cwd) {
        let result = "";
        const FILESTATUS = RepoStatus.FILESTATUS;
        switch(this.status) {
            case FILESTATUS.ADDED:
                result += "new file:     ";
                break;
            case FILESTATUS.MODIFIED:
                result += "modified:     ";
                break;
            case FILESTATUS.REMOVED:
                result += "deleted:      ";
                break;
            case FILESTATUS.CONFLICTED:
                result += "conflicted:   ";
                break;
            case FILESTATUS.RENAMED:
                result += "renamed:      ";
                break;
            case FILESTATUS.TYPECHANGED:
                result += "type changed: ";
                break;
        }
        result += path.relative(cwd, this.path);
        result = color(result);
        if ("" !== this.detail) {
            result += ` (${this.detail})`;
        }
        return result;
    }
}

exports.StatusDescriptor = StatusDescriptor;

/**
 * Return the specified `descriptors` sorted by path.
 *
 * @param {StatusDescriptor []} descriptors
 * @return {StatusDescriptor []}
 */
exports.sortDescriptorsByPath = function (descriptors) {
    return descriptors.sort((l, r) => {
        const lPath = l.path;
        const rPath = r.path;
        return lPath === rPath ? 0 : (lPath < rPath ? -1 : 1);
    });
};

/**
 * Return a string describing the specified `statuses`, using the specified
 * `color` function to apply color, printing paths relative to the specified
 * `cwd`.
 *
 * @param {StatusDescriptor []} statuses
 * @param {Function}            color
 * @return {String}
 */
exports.printStatusDescriptors = function (statuses, color, cwd) {
    assert.isArray(statuses);
    assert.isFunction(color);
    if (0 === statuses.length) {
        return "";                                                    // RETURN
    }
    const sorted = exports.sortDescriptorsByPath(statuses);
    const lines = sorted.map(status => "\t" + status.print(color, cwd));
    return lines.join("\n") + "\n";
};

/**
 * Return a string describing the specified `untracked` files, using the
 * specified `color` function to apply color and displaying the path relative
 * to the specified `cwd`.
 *
 * @param {String []} untracked
 * @param {Function}  color
 * @param {String}    cwd
 * @return {String}
 */
exports.printUntrackedFiles = function (untracked, color, cwd) {
    assert.isArray(untracked);
    assert.isFunction(color);
    assert.isString(cwd);
    let result = "";
    untracked.sort().forEach(filename => {
        result += "\t" + color(path.relative(cwd, filename)) + "\n";
    });
    return result;
};

/**
 * Return a list of status descriptors for the submodules in the specified
 * `status` that have status changes.
 *
 * @param {RepoStatus} status
 * @return {StatusDescriptor []}
 */
exports.listSubmoduleDescriptors = function (status) {
    assert.instanceOf(status, RepoStatus);
    const result = [];
    const subs = status.submodules;
    const RELATION = RepoStatus.Submodule.COMMIT_RELATION;
    Object.keys(subs).forEach(subName => {
        let detail = "";
        const sub = subs[subName];

        // If workdir or index are on different commit, add a description to
        // detail.

        const commitRelation = (null === sub.repoStatus) ?
                               sub.indexShaRelation :
                               sub.workdirShaRelation;
        switch (commitRelation) {
        case RELATION.AHEAD:
            detail += ", new commits";
            break;
        case RELATION.BEHIND:
            detail += ", on old commit";
            break;
        case RELATION.UNRELATED:
            detail += ", on unrelated commit";
            break;
        case RELATION.UNKNOWN:
            detail += ", on unknown commit";
            break;
        }

        // Check if sha has changed.  If it's null, then this submodule is
        // deleted in the index and will show that way.

        if (null !== sub.indexUrl && sub.commitUrl !== sub.indexUrl) {
            detail += ", new url";
        }

        // If there is detail or a non-null indexStatus, we have something to
        // report, add it to the list.

        if (null !== sub.indexStatus || "" !== detail) {
            result.push(new StatusDescriptor(
                sub.indexStatus === null ?
                    RepoStatus.FILESTATUS.MODIFIED :
                    sub.indexStatus,
                subName,
                "submodule" + detail));
        }
    });
    return result;
};

/**
 * Return the status descriptors and untracked files for the meta repo and
 * acculuated from submodules in the specified `status`.
 *
 * @param {RepoStatus} status
 * @return {Object}
 * @return {StatusDescriptor []} return.staged
 * @return {StatusDescriptor []} return.workdir
 * @return {String []}           return.untracked
 */
exports.accumulateStatus = function (status) {
    const staged = exports.listSubmoduleDescriptors(status);
    const workdir = [];
    const untracked = [];

    function accumulateStaged(prefixPath, stagedFiles) {
        Object.keys(stagedFiles).forEach(filename => {
            staged.push(new StatusDescriptor(stagedFiles[filename],
                                             path.join(prefixPath, filename),
                                             ""));
        });
    }

    function accumulateWorkdir(prefixPath, workdirFiles) {
        Object.keys(workdirFiles).forEach(filename => {
            const status = workdirFiles[filename];
            const fullPath = path.join(prefixPath, filename);
            if (RepoStatus.FILESTATUS.ADDED === status) {
                untracked.push(fullPath);
            }
            else {
                workdir.push(new StatusDescriptor(status, fullPath, ""));
            }
        });
    }

    accumulateStaged("", status.staged);
    accumulateWorkdir("", status.workdir);

    // Accumulate data for the submodules.

    const subs = status.submodules;
    Object.keys(subs).forEach(subName => {
        const sub = subs[subName];
        if(null !== sub.repoStatus) {
            const subRepo = sub.repoStatus;
            accumulateStaged(subName, subRepo.staged);
            accumulateWorkdir(subName, subRepo.workdir);
        }
    });

    return {
        staged: staged,
        workdir: workdir,
        untracked: untracked,
    };
};

/**
 * Return a message describing the specified `rebase`.
 *
 * @param {Rebase}
 * @return {String}
 */
exports.printRebase = function (rebase) {
    assert.instanceOf(rebase, Rebase);
    const shortSha = GitUtil.shortSha(rebase.onto);
    return `${colors.red("rebase in progress; onto ", shortSha)}
You are currently rebasing branch '${rebase.headName}' on '${shortSha}'.
  (fix conflicts and then run "git meta rebase --continue")
  (use "git meta rebase --skip" to skip this patch)
  (use "git meta rebase --abort" to check out the original branch)
`;
};

/**
 * Return a message describing the state of the current branch in the specified
 * `status`.
 *
 * @param {RepoStatus} status
 * @return {String>
 */
exports.printCurrentBranch = function (status) {
    if (null !== status.currentBranchName) {
        return `On branch ${colors.green(status.currentBranchName)}.\n`;
    }
    return `\
On detached head ${colors.red(GitUtil.shortSha(status.headCommit))}.\n`;
};

/**
 * Return a description of the specified `status`, displaying paths relative to
 * the specified `cwd`.  Note that a value of "" for `cwd` indicates the root
 * of the repository.
 *
 * @param {RepoStatus} status
 * @param {String}     cwd
 */
exports.printRepoStatus = function (status, cwd) {
    assert.instanceOf(status, RepoStatus);
    assert.isString(cwd);

    let result = "";

    if (null !== status.rebase) {
        result += exports.printRebase(status.rebase);
    }

    result += exports.printCurrentBranch(status);

    let changes = "";
    const fileStatuses = exports.accumulateStatus(status);
    const staged = fileStatuses.staged;
    if (0 !== staged.length) {
        changes += `\
Changes to be committed:
  (use "git meta reset HEAD <file>..." to unstage)

`;
        changes += exports.printStatusDescriptors(staged, colors.green, cwd);
        changes += "\n";
    }
    const workdir = fileStatuses.workdir;
    if (0 !== workdir.length) {
        changes += `\
Changes not staged for commit:
  (use "git meta add <file>..." to update what will be committed)
  (use "git meta checkout -- <file>..." to discard changes in working \
directory)
  (commit or discard the untracked or modified content in submodules)

`;
        changes += exports.printStatusDescriptors(workdir, colors.red, cwd);
        changes += "\n";
    }
    const untracked = fileStatuses.untracked;
    if (0 !== untracked.length) {
        changes += `\
Untracked files:
  (use "git meta add <file>..." to include in what will be committed)

`;
        changes += exports.printUntrackedFiles(untracked, colors.red, cwd);
        changes += "\n";
    }

    if ("" === changes) {
        result += "nothing to commit, working tree clean\n";
    }
    else {
        result += changes;
    }

    return result;
};

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
            throw new UserError(`\
Misconfigured repo; no commit specified in index for submodule \
${colors.red(name)}.`);
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
 * in submobules.  If the optionally specified
 * `options.includeClosedSubmodules` is provided (default true), include the
 * index status of closed submodules.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {Object}             [options]
 * @param {Boolean}            [options.showAllUntracked]
 * @param {String []}          [options.paths]
 * @param {Boolean}            [options.showMetaChanges]
 * @param {Boolean}            [options.includeClosedSubmodules]
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
    if (undefined === options.includeClosedSubmodules) {
        options.includeClosedSubmodules = true;
    }
    else {
        assert.isBoolean(options.includeClosedSubmodules);
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
            // If we're not including closed submodules, filter them out.
            if (!options.includeClosedSubmodules) {
                subsToList = subsToList.filter(name => openSet.has(name));
            }
        }
        else {

            // If we're not including closed subs, then the open submodules are
            // the only ones to inspect.

            if (!options.includeClosedSubmodules) {
                subsToList = openArray;
            }
            else {
                // Otherwise, compute the list by joining the list of
                // submodules listed in the index and on head.
                subsToList = Array.from(new Set(
                        Object.keys(headUrls).concat(indexNames)));
            }
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

/**
 * Do nothing if the specified `metaStatus` indicates a clean meta-repository
 * having clean submodules, having no staged or unstaged changes.  Otherwise,
 * throw a `UserError` object with diagnostic information.
 *
 * @param {RepoStatus} metaStatus
 */
exports.ensureClean = function (metaStatus) {
    assert.instanceOf(metaStatus, RepoStatus);
    let error = "";

    if (!metaStatus.isClean()) {
        error += "The meta-repository is not clean.\n";
    }

    const subs = metaStatus.submodules;
    Object.keys(subs).forEach(subName => {
        const sub = subs[subName];
        if (!sub.isClean()) {
            error += `Submodule ${colors.cyan(subName)} is not clean.\n`;
        }
    });
    if ("" !== error) {
        throw new UserError(error);
    }
};

/**
 * Do nothing if the specified `metastatus` indicates a consistent state; Throw
 * a `UserError` object otherwise.  The `metaRepo` is in a consistent state if
 * the HEAD of each submodule points to a descendant of the commit indicated in
 * the HEAD of the meta-repo commit (or that commit).
 *
 * @param {RepoStatus} metaStatus
 */
exports.ensureConsistent = function (metaStatus) {
    assert.instanceOf(metaStatus, RepoStatus);

    let error = "";

    const subs = metaStatus.submodules;
    const SAME = RepoStatus.Submodule.COMMIT_RELATION.SAME;
    Object.keys(subs).forEach(subName => {
        const sub = subs[subName];
        if (null !== sub.indexStatus) {
            error += `\
Submodule ${colors.cyan(subName)} is changed in index.\n`;
        }
        else if (null !== sub.workdirShaRelation &&
                 SAME !== sub.workdirShaRelation) {
            error += `\
Submodule ${colors.cyan(subName)} has new commit\n`;
        }
    });

    if ("" !== error) {
        throw new UserError(error);
    }
};

/**
 * Throw a `UserError` object unless the specified `status` is clean
 * according to the method `ensureClean` and consistent according to the method
 * `ensureConsistend`.
 *
 * @param {RepoStatus} status
 */
exports.ensureCleanAndConsistent = function (status) {
    assert.instanceOf(status, RepoStatus);
    exports.ensureConsistent(status);
    exports.ensureClean(status);
};
