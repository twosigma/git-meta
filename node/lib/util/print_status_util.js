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
 * This module provides utilities for displaying status information contained
 * in `RepoStatus` objects.
 *
 */

const assert  = require("chai").assert;
const colors  = require("colors/safe");
const path    = require("path");

const GitUtil             = require("./git_util");
const SequencerState      = require("./sequencer_state");
const RepoStatus          = require("./repo_status");
const TextUtil            = require("./text_util");

/**
 * This value-semantic class describes a line entry to be printed in a status
 * message.
 */
class StatusDescriptor {
    /**
     * @param {RepoStatus.FILESTATUS|RepoStatus.Conflict} status
     * @param {String}                                    path
     * @param {String}                                    detail
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
        if (this.status instanceof RepoStatus.Conflict) {
            // TODO: more detail, e.g., "we added"
            result += "conflicted:   ";
        }
        else {
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
                case FILESTATUS.RENAMED:
                    result += "renamed:      ";
                    break;
                case FILESTATUS.TYPECHANGED:
                    result += "type changed: ";
                    break;
            }
        }
        let filename = path.relative(cwd, this.path);
        if ("" === filename) {
            filename = ".";
        }
        result += filename;
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
    return descriptors.sort((l, r) => TextUtil.strcmp(l.path, r.path));
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
 * Return a description for the specified commit `relation` to be used in
 * status description.
 *
 * @param {RepoStatus.Submodule.COMMIT_RELATION} relation
 * @return {String}
 */
exports.getRelationDescription = function (relation) {
    assert.isNumber(relation);
    const RELATION = RepoStatus.Submodule.COMMIT_RELATION;
    switch (relation) {
    case RELATION.AHEAD:
        return "new commits";
    case RELATION.BEHIND:
        return "on old commit";
    case RELATION.UNRELATED:
        return "on unrelated commit";
    case RELATION.UNKNOWN:
        return "on unknown commit";
    }
    assert(false, `invalid relation: ${relation}`);
};

/**
 * Return a list of status descriptors for the submodules in the specified
 * `status` that have status changes.
 *
 * @param {RepoStatus} status
 * @return {Object}
 * @return {StatusDescriptor []} return.staged
 * @return {StatusDescriptor []} return.workdir
 * @return {String []}           return.untracked
 */
exports.listSubmoduleDescriptors = function (status) {
    assert.instanceOf(status, RepoStatus);
    const staged = [];
    const workdir = [];
    const untracked = [];
    const subs = status.submodules;
    const FILESTATUS = RepoStatus.FILESTATUS;
    Object.keys(subs).forEach(subName => {
        const sub = subs[subName];

        // Check for new submodule with no commit.

        if (!sub.isCommittable()) {
            workdir.push(new StatusDescriptor(
                                 FILESTATUS.ADDED,
                                 subName,
                                 "submodule, create commit or stage changes"));
            return;                                                   // RETURN
        }

        const commit = sub.commit;
        const index = sub.index;

        // If it's been removed, there's nothing more to add.

        if (null === index) {
            staged.push(new StatusDescriptor(FILESTATUS.REMOVED,
                                             subName,
                                             "submodule"));
            return;                                                   // RETURN
        }

        // Configuration changes and staged changes go in `stagedDetail`.

        let stagedDetail = "";
        let stagedStatus = FILESTATUS.MODIFIED;  // other choice is `ADDED`

        if (sub.isNew()) {
            stagedDetail += ", newly created";
            stagedStatus = FILESTATUS.ADDED;
        }

        // If it's not new, see if the URL has changed.

        else if (commit.url !== index.url) {
            stagedDetail += ", new url";
        }

        const SAME = RepoStatus.Submodule.COMMIT_RELATION.SAME;

        if (null !== index.relation && SAME !== index.relation) {
            stagedDetail += ", " +
                exports.getRelationDescription(index.relation);
        }

        // Now, if there is staged detail, add to staged section.

        if ("" !== stagedDetail) {
            staged.push(new StatusDescriptor(stagedStatus,
                                             subName,
                                             "submodule" + stagedDetail));
        }

        // Register unstaged commits on an open submodule.

        if (!sub.isNew() &&
            null !== sub.workdir &&
            null === sub.workdir.relation) {
            const desc = "submodule is headless -- try closing and reopening";
            workdir.push(new StatusDescriptor(FILESTATUS.MODIFIED,
                                              subName,
                                              desc));
        }
        else if (null !== sub.workdir &&
            null !== sub.workdir.relation &&
            SAME !== sub.workdir.relation) {
            const desc = "submodule, " +
                exports.getRelationDescription(sub.workdir.relation);
            workdir.push(new StatusDescriptor(FILESTATUS.MODIFIED,
                                              subName,
                                              desc));
        }
    });
    return {
        staged: staged,
        workdir: workdir,
        untracked: untracked,
    };
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
    const result = exports.listSubmoduleDescriptors(status);
    const staged = result.staged;
    const workdir = result.workdir;
    const untracked = result.untracked;

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
        if(null !== sub.workdir) {
            const subRepo = sub.workdir.status;
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
 * Return the command to which the specified sequencer `type` corresponds.
 *
 * @param {SequencerState.TYPE} type
 * @return {String}
 */
exports.getSequencerCommand = function (type) {
    const TYPE = SequencerState.TYPE;
    switch (type) {
    case TYPE.CHERRY_PICK: return "cherry-pick";
    case TYPE.MERGE: return "merge";
    case TYPE.REBASE: return "rebase";
    default: assert(false, `unhandled sequencer type: ${type}`);
    }
};

/**
 * Return a message describing the specified `sequencer`.
 *
 * @param {SequencerState} sequencer
 * @return {String}
 */
exports.printSequencer = function (sequencer) {
    assert.instanceOf(sequencer, SequencerState);
    const command = exports.getSequencerCommand(sequencer.type);
    return `\
A ${command} is in progress.
  (after resolving conflicts mark the corrected paths
   with 'git meta add', then run "git meta ${command} --continue")
  (use "git meta ${command} --abort" to check out the original branch)
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
    if (status.headCommit === null) {
        return `No commits yet\n`;
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

    result += exports.printCurrentBranch(status);

    if (null !== status.sequencerState) {
        result += exports.printSequencer(status.sequencerState);
    }

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
 * Return a short description of the specified `status`, displaying
 * paths relative to the specified `cwd`.  Note that a value of "" for
 * `cwd` indicates the root of the repository.
 *
 * @param {RepoStatus} status
 * @param {String}     cwd
 */
exports.printRepoStatusShort = function (status, cwd) {
    assert.instanceOf(status, RepoStatus);
    assert.isString(cwd);

    let result = "";

    const indexChangesByPath = {};
    const workdirChangesByPath = {};
    const allFiles = new Set();

    const fileStatuses = exports.accumulateStatus(status);

    const statusFlagByMode = "MAD";

    for (const p of fileStatuses.staged) {
        indexChangesByPath[p.path] = colors.green(statusFlagByMode[p.status]);
        allFiles.add(p.path);
    }

    for (const p of fileStatuses.workdir) {
        workdirChangesByPath[p.path] = colors.red(statusFlagByMode[p.status]);
        allFiles.add(p.path);
    }

    for (const u of fileStatuses.untracked) {
        indexChangesByPath[u] = colors.red("?");
        workdirChangesByPath[u] = colors.red("?");
        allFiles.add(u);
    }

    const allFilesArray = [];
    allFilesArray.push(...allFiles);
    exports.sortDescriptorsByPath(allFilesArray);
    for (const f of allFilesArray) {
        let index = " ";
        if (f in indexChangesByPath) {
            index = indexChangesByPath[f];
        }
        let workdir = " ";
        if (f in workdirChangesByPath) {
            workdir = workdirChangesByPath[f];
        }
        result += index + workdir + " " + f + "\n";
    }

    if (result.length === 0) {
        result = "\n";
    }

    return result;
};


/**
 * Print a string describing the status of the specified `subsToPrint`.  Use
 * the specified `openSubs` set to determine which submodules are open.  Unless
 * the specified `true === showClosed`, do not print closed sub modules.  Use
 * the specified `relCwd` to display relative paths.
 *
 * @param {String}      relCwd
 * @param {Object}      subsToPrint   map from name to sha or null if deleted
 * @param {Set(String)} openSubs      set of names of open submodules
 * @param {Boolean}     showClosed
 * @return {String}
 */
exports.printSubmoduleStatus = function (relCwd,
                                         subsToPrint,
                                         openSubs,
                                         showClosed) {
    assert.isString(relCwd);
    assert.isObject(subsToPrint);
    assert.isBoolean(showClosed);

    let result = "";
    if (showClosed) {
        result = `${colors.grey("All submodules:")}\n`;
    }
    else {
        result = `${colors.grey("Open submodules:")}\n`;
    }
    const names = Object.keys(subsToPrint).sort();
    names.forEach(name => {
        const relName = path.relative(relCwd, name);
        const isVis = openSubs.has(name);
        const visStr = isVis ? " " : "-";
        let sha = subsToPrint[name];
        if (null === sha) {
            sha = "<deleted>";
        }
        if (isVis || showClosed) {
            result += `${visStr} ${sha}  ${colors.cyan(relName)}\n`;
        }
    });
    return result;
};
