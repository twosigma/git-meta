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
const assert  = require("chai").assert;
const co      = require("co");
const colors  = require("colors/safe");
const NodeGit = require("nodegit");

const GitUtil             = require("../util/git_util");
const UserError           = require("../util/user_error");
const RepoStatus          = require("../util/repo_status");
const SubmoduleUtil       = require("../util/submodule_util");
const SubmoduleConfigUtil = require("../util/submodule_config_util");

/**
 * Return a string describing the file changes in the specified `repoStatus` or
 * an empty string if there are no changes.
 *
 * @param {RepoStatus} repoStatus
 * @return {String}
 */
exports.printFileStatuses = function (repoStatus) {
    assert.instanceOf(repoStatus, RepoStatus);
    let result = "";
    const FILESTATUS = RepoStatus.FILESTATUS;
    function statusDescription(status) {
        switch(status) {
            case FILESTATUS.ADDED:
                return "new file:     ";
            case FILESTATUS.MODIFIED:
                return "modified:     ";
            case FILESTATUS.REMOVED:
                return "deleted:      ";
            case FILESTATUS.CONFLICTED:
                return "conflicted:   ";
            case FILESTATUS.RENAMED:
                return "renamed:      ";
            case FILESTATUS.TYPECHANGED:
                return "type changed: ";
        }
    }
    const innerIndent = "        ";

    // Print status of staged files first.

    if (0 !== Object.keys(repoStatus.staged).length) {
        if ("" !== result) {
            result += "\n";
        }
        result += "Changes staged to be commited:\n\n";
        Object.keys(repoStatus.staged).sort().forEach(fileName => {
            result += innerIndent;
            const status = repoStatus.staged[fileName];
            result += colors.green(statusDescription(status));
            result += colors.green(fileName);
            result += "\n";
        });
    }

    // Split up unstaged changes by modified and untracked; we'll print them
    // separately.

    let changed = [];
    let untracked = [];
    Object.keys(repoStatus.workdir).sort().forEach(fileName => {
        const status = repoStatus.workdir[fileName];
        if (FILESTATUS.ADDED === status) {
            untracked.push(fileName);
        }
        else {
            changed.push(fileName);
        }
    });

    // Then, print status of files that have been modified but not staged.

    if (0 !== changed.length) {
        if ("" !== result) {
            result += "\n";
        }
        result += "Changes not staged for commit:\n\n";
        changed.forEach(fileName => {
            const status = repoStatus.workdir[fileName];
            if (FILESTATUS.ADDED !== status) {
                result += innerIndent;
                result += colors.red(statusDescription(status));
                result += colors.red(fileName);
                result += "\n";
            }
        });
    }

    // Finally, print the names of newly added files.

    if (0 !== untracked.length) {
        if ("" !== result) {
            result += "\n";
        }
        result += "Untracked files:\n\n";
        untracked.forEach(fileName => {
            result += innerIndent;
            result += colors.red(fileName);
            result += "\n";
        });
    }
    return result;
};

/**
 * Return a string describing the specified submodule `status`, displaying a
 * message if `status` does not have the specified `expectedBranchName` and it
 * is non-null, if there are staged changes to the submodule`s sha or url, or
 * if the submodule is open and has modifications to its index or working
 * directory -- other than untracked files.  Return an empty string otherwise.
 *
 * @param {String}               [expectedBranchName]
 * @param {RepoStatus.Submodule} status
 * @return {String}
 */
exports.printSubmoduleStatus = function (expectedBranchName, status) {
    if (null !== expectedBranchName) {
        assert.isString(expectedBranchName);
    }
    assert.instanceOf(status, RepoStatus.Submodule);

    let result = "";

    const RELATION = RepoStatus.Submodule.COMMIT_RELATION;
    const FILESTATUS = RepoStatus.FILESTATUS;

    // We'll work back from the index in the main repo to the workdir of the
    // subrepo.

    // First, check to see if there are staged changes to this submodule in the
    // index of the main repo.

    if (status.indexStatus !== null) {
        switch (status.indexStatus) {
            case FILESTATUS.ADDED:
                result += `\
Added referencing url ${colors.green(status.indexUrl)} at commit \
${colors.green(status.indexSha)}.
`;
                break;
            case FILESTATUS.REMOVED:
                result += colors.red("Removed\n");
                break;
            case FILESTATUS.MODIFIED:
                if (status.indexUrl !== status.commitUrl) {
                    result += `
Staged change to URL from ${colors.green(status.commitUrl)} to \
${colors.green(status.indexUrl)}.
`;
                }
                switch (status.indexShaRelation) {
                    case RELATION.SAME:
                        break;
                    case RELATION.AHEAD:
                        result += `
New commit staged from ${colors.green(GitUtil.shortSha(status.commitSha))} to \
${colors.green(GitUtil.shortSha(status.indexSha))}.
`;
                        break;
                    case RELATION.BEHIND:
                        result += `
Reset to old commit ${colors.yellow(GitUtil.shortSha(status.indexSha))} from \
${colors.yellow(GitUtil.shortSha(status.commitSha))}.
`;
                        break;
                    case RELATION.UNRELATED:
                        result += `
Changed to unrelated commit  ${colors.red(GitUtil.shortSha(status.indexSha))} \
from ${colors.red(GitUtil.shortSha(status.commitSha))}.
`;
                        break;
                    case RELATION.UNKNOWN:
                        result += `
Change staged to commit ${colors.yellow(GitUtil.shortSha(status.indexSha))} \
but cannot verify relation to \
${colors.yellow(GitUtil.shortSha(status.commitSha))} as the repo is closed.
`;
                }
                break;

            default:
                assert(false, `TODO: status: ${status.indexStatus}`);
                break;
        }
    }

    // At this point, return if the repo is not open, i.e., there is no
    // repoStatus.

    if (null === status.repoStatus) {
        return result;                                                // RETURN
    }

    // Now, check branch status

    if (null !== expectedBranchName &&
        status.repoStatus.currentBranchName !== expectedBranchName) {
        if (null === status.repoStatus.currentBranchName) {
            result += `\
Expected to have ${colors.yellow(expectedBranchName)} but is not on a branch.
`;
        }
        else {
            result += `\
On wrong branch ${colors.yellow(status.repoStatus.currentBranchName)}.
`;
        }
    }

    // Then, the head commit of the submodule's repo.

    switch (status.workdirShaRelation) {
        case RELATION.SAME:
            break;
        case RELATION.AHEAD:
            result += `
New commit ${colors.green(GitUtil.shortSha(status.repoStatus.headCommit))} in \
open repo.
`;
            break;
        case RELATION.BEHIND:
            result += `
Open repo has old commit \
${colors.red(GitUtil.shortSha(status.repoStatus.headCommit))} on head.
`;
            break;
        case RELATION.UNRELATED:
            result += `
Open repo has unrelated commit \
${colors.red(GitUtil.shortSha(status.repoStatus.headCommit))} on head.
`;
            break;
    }

    // Finally, check the state of the index and workdir of the open repo.

    result += exports.printFileStatuses(status.repoStatus);
    return result;
};

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
    assert.isString(name);
    assert.instanceOf(metaRepo, NodeGit.Repository);
    if (null !== indexUrl) {
        assert.isString(indexUrl);
    }
    if (null !== commitUrl) {
        assert.isString(commitUrl);
    }
    assert.instanceOf(index, NodeGit.Index);
    assert.instanceOf(commitTree, NodeGit.Tree);
    assert.isBoolean(isVisible);
    assert.isFunction(readRepoStatus);

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
        assert.isNotNull(indexUrl);
        args.indexStatus = FILESTATUS.ADDED;
    }
    else {
        args.commitSha = (yield commitTree.entryByPath(name)).sha();
    }

    // A null indexUrl indicates that the submodule was removed.  Otherwise,
    // load up the sha in the index.

    if (null === indexUrl) {
        assert.isNotNull(commitUrl);
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

        const toDescendant = yield NodeGit.Graph.descendantOf(subRepo,
                                                              toId,
                                                              fromId);
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
 * Return a description of the status of changes to the specified `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @return {RepoStatus}
 */
exports.getRepoStatus = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    // TODO: show renamed from and to instead of just to.

    const headCommit = yield repo.getHeadCommit();

    if (null === headCommit) {
        throw new UserError("No head commit.");
    }

    let args = {
        headCommit: headCommit.id().tostrS(),
        currentBranchName: yield GitUtil.getCurrentBranchName(repo),
        staged: {},
        workdir: {},
        submodules: {},
    };

    // Loop through each of the `NodeGit.FileStatus` objects in the repo and
    // categorize them into `args`.

    const statuses = yield repo.getStatusExt({
        flags: NodeGit.Status.OPT.EXCLUDE_SUBMODULES |
            NodeGit.Status.OPT.INCLUDE_UNTRACKED
    });
    const FILESTATUS = RepoStatus.FILESTATUS;
    const STATUS = NodeGit.Status.STATUS;
    for (let i = 0; i < statuses.length; ++i) {
        const status = statuses[i];
        const path = status.path();

        // Skip the `.gitmodules` file.

        if (SubmoduleConfigUtil.modulesFileName === path) {
            continue;                                               // CONTINUE
        }

        const bit = status.statusBit();

        // Index status.

        if (bit & STATUS.INDEX_NEW) {
            args.staged[path] = FILESTATUS.ADDED;
        }
        else if (bit & STATUS.INDEX_DELETED) {
            args.staged[path] = FILESTATUS.REMOVED;
        }
        else if (bit & STATUS.INDEX_MODIFIED) {
            args.staged[path] = FILESTATUS.MODIFIED;
        }

        // Workdir status

        if (bit & STATUS.WT_NEW) {
            args.workdir[path] = FILESTATUS.ADDED;
        }
        else if (bit & STATUS.WT_DELETED) {
            args.workdir[path] = FILESTATUS.REMOVED;
        }
        else if (bit & STATUS.WT_MODIFIED) {
            args.workdir[path] = FILESTATUS.MODIFIED;
        }
    }

    // Now do the submodules.  First, list the submodules visible in the head
    // commit and index.

    const headSubs =
           yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, headCommit);
    const index = yield repo.index();
    const indexSubs =
                 yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, index);
    const openArray = yield SubmoduleUtil.listOpenSubmodules(repo);
    const openSet = new Set(openArray);

    const commitTree = yield headCommit.getTree();

    // Make a list of all subs that exist in either the head commit or the
    // index.

    const allSubNames = Array.from(new Set(
                        Object.keys(headSubs).concat(Object.keys(indexSubs))));

    // Make a list of promises to read the status for each submodule, then
    // evaluate them in parallel.

    const subStatMakers = allSubNames.map(name => {
        return exports.getSubmoduleStatus(name,
                                          repo,
                                          indexSubs[name] || null,
                                          headSubs[name] || null,
                                          index,
                                          commitTree,
                                          openSet.has(name),
                                          exports.getRepoStatus);
    });
    const subStats = yield subStatMakers;

    // And copy them into the arguments.

    allSubNames.forEach((name, i) => {
        args.submodules[name] = subStats[i];
    });

    return new RepoStatus(args);
});

/**
 * Return a string describing the status of the submodules in the specified
 * `submoduleNames` in the specified `metaRepo`.
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {String[]}           requestedNames
 * @return {String}
 */
exports.printSubmodulesStatus = co.wrap(function *(metaRepo, requestedNames) {
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.isArray(requestedNames);
    requestedNames.forEach(name => assert.isString(name));

    // TODO: if it starts to look slow, we could optimize to load only the
    // status for the submodules in `submoduleNames`.

    const repoStat = yield exports.getRepoStatus(metaRepo);

    let result = "";

    const subs = repoStat.submodules;

    requestedNames.forEach((name, i) => {
        if (0 !== i) {
            result += "\n";
        }
        result += `${colors.cyan(name)}\n`;
        const stat = subs[name];
        if (!stat) {
            result += "not the name of a submodule\n";
            return;                                                   // RETURN
        }
        const statResult =
               exports.printSubmoduleStatus(repoStat.currentBranchName, stat);
        result += statResult;
        if ("" === statResult) {
            if (null === stat.repoStatus) {
                result += "not visible, and no changes in index\n";
            }
            else {
                result += "no changes\n";
            }
        }
    });
    return result;
});

/**
 * Return a description of the specified `metaStatus`.
 *
 * @param {RepoStatus} metaStatus
 */
exports.printRepoStatus = function (metaStatus) {
    let result = "";

    if (null !== metaStatus.currentBranchName) {
        result += `On branch ${colors.green(metaStatus.currentBranchName)}.\n`;
    }
    else {
        result += `\
On detached head ${colors.red(GitUtil.shortSha(metaStatus.headCommit))}.`;
    }
    const metaStatusDesc = exports.printFileStatuses(metaStatus);
    result += metaStatusDesc;
    if ("" === metaStatusDesc) {
        result += "nothing to commit, working directory clean\n";
    }

    let submodulesText = "";
    const subs = metaStatus.submodules;
    Object.keys(subs).forEach(name => {
        const status = subs[name];
        const subResult = exports.printSubmoduleStatus(
                                                  metaStatus.currentBranchName,
                                                  status);
        if ("" !== subResult) {
            submodulesText += colors.cyan(name) + "\n";
            submodulesText += subResult;
        }
    });

    if ("" !== submodulesText) {
        result += "Submodules:\n";
        result += submodulesText;
    }
    return result;
};

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
 * a `UserError` object otherwise.  The `metaRepo` is in a consistent state if:
 *
 * - the meta-repository has a (named) active branch
 * - all submodules that are visible have an active branch with the same name
 *   as the active branch in the meta-repository
 * - the HEAD of each submodule points to a descendant of the commit indicated
 *   in the HEAD of the meta-repo commit (or that commit).
 *
 * @param {RepoStatus} metaStatus
 */
exports.ensureConsistent = function (metaStatus) {
    assert.instanceOf(metaStatus, RepoStatus);

    const metaBranch = metaStatus.currentBranchName;

    let error = "";

    if (null === metaBranch) {
        error += "The meta-repository is not on a branch.\n";
    }

    const subs = metaStatus.submodules;
    const SAME = RepoStatus.Submodule.COMMIT_RELATION.SAME;
    Object.keys(subs).forEach(subName => {
        const sub = subs[subName];
        if (null !== metaBranch &&
            null !== sub.repoStatus) {
            if (null === sub.repoStatus.currentBranchName) {
                error += `\
Submodule ${colors.cyan(subName)} has no current branch.\n`;
            }
            else if (metaBranch !== sub.repoStatus.currentBranchName) {
                error += `\
Submodule ${colors.cyan(subName)} is on branch \
${colors.red(sub.repoStatus.currentBranchName)} but expected \
${colors.green(metaBranch)}.\n`;
            }
        }
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
 * Throw a `UserError` object unless the specified `metaRepo` is clean
 * according to the method `ensureClean` and consistent according to the method
 * `ensureConsistend`.
 *
 * @param {NodeGit.Repository} metaRepo
 */
exports.ensureCleanAndConsistent = co.wrap(function *(metaRepo) {
    assert.instanceOf(metaRepo, NodeGit.Repository);

    const status = yield exports.getRepoStatus(metaRepo);
    exports.ensureConsistent(status);
    exports.ensureClean(status);
});
