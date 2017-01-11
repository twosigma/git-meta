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

const Rebase = require("./rebase");

/**
 * This modules defines the type `RepoStatus`, used to describe modifications
 * to a repo.
 */

/**
 * @enum {RepoStatus.STAGE}
 * indicates the meaning of an entry in the index
 */
// From libgit2 index.h.  This information is not documented in
// the nodegit or libgit2 documentation.
const STAGE = {
    NORMAL: 0,  // normally staged file
    OURS  : 2,  // our side of a stage
    THEIRS: 3,  // their side of a stage
};

/**
 * @enum {RepoStatus.FILESTATUS}
 * @static
 * indicates how a file was changed
 */
const FILESTATUS = {
    MODIFIED: 0,
    ADDED: 1,
    REMOVED: 2,
    CONFLICTED: 3,
    RENAMED: 4,
    TYPECHANGED: 5
};

/**
 * @enum {RepoStatus.Submodule.COMMIT_RELATION}
 * @static
 * indicates how two commits are related to one another
 */
const COMMIT_RELATION = {
    SAME: 0,
    AHEAD: 1,
    BEHIND: 2,
    UNRELATED: 3,
    UNKNOWN: 4,
};

/**
 * @class {RepoStatus.Submodule} a value-semantic type representing changes to
 * the state of a submodule
 */
class Submodule {

    /**
     * @constructor
     * Create a new `Submodule` object configured by the specified `status.
     * A non-null `indexStatus` indicates staged changes to this submodule.  A
     * non-null `repoStatus` indicates that the repository for this submodule
     * is visible.  The behavior is undefined if:
     *   - the submodule has been removed and contains `repoStatus` (open
     *     working directory), `indexSha`, `indexShaRelation`,  or `indexUrl`
     *   - the status does not indicate removal and `indexSha`, or `indexUrl`
     *     are null
     *   - the status indicates that the submodule was not just added but lacks
     *     commit information, having null `commitSha` or `commitUrl`.
     *   - the `indexSha` and `commitSha` are non-null but `indexShaRelation`
     *     is null
     *   - the status indicates that the submodule was just added, but contains
     *     `commitSha` or `commitUrl`.
     *   - index modification is indicated, but the indicated shas and urls are
     *     the same in the index and commit
     *   - modification is not indicated, but the indicated shas or urls differ
     *     between index and commit
     *   - `indexSha` and `commitSha` are the same, but `indexShaRelation` is
     *     not `COMMIT_RELATION.SAME`, or `indexShaRelation` is
     *     `COMMIT_RELATION.SAME but `indexSha` and `commitSha` differ
     *   - `indexSha` and `repoStatus.headCommit` are the same, but
     *     `workdirShaRelation` is not `COMMIT_RELATION.SAME`, or
     *     `workdirShaRelation` is `COMMIT_RELATION.SAME but `indexSha` and
     *     `repoStatus.headCommit` differ
     *
     * @param {Object} status
     * @param {RepoStatus.FILESTATUS} [status.indexStatus]
     * @param {String}                [status.indexSha]
     * @param {COMMIT_RELATION}       [status.indexShaRelation]
     * @param {String}                [status.indexUrl]
     * @param {String}                [status.commitSha]
     * @param {String}                [status.commitUrl]
     * @param {COMMIT_RELATION}       [status.workdirShaRelation]
     * @param {RepoStatus}            [repoStatus]
     */
    constructor(status) {
        assert.isObject(status);
        this.d_indexStatus        = null;
        this.d_indexSha           = null;
        this.d_indexShaRelation   = null;
        this.d_indexUrl           = null;
        this.d_commitSha          = null;
        this.d_commitUrl          = null;
        this.d_workdirShaRelation = null;
        this.d_repoStatus         = null;

        if ("indexStatus" in status) {
            this.d_indexStatus = status.indexStatus;
        }
        if ("indexSha" in status) {
            this.d_indexSha = status.indexSha;
        }
        if ("indexShaRelation" in status) {
            this.d_indexShaRelation = status.indexShaRelation;
        }
        if ("indexUrl" in status) {
            this.d_indexUrl = status.indexUrl;
        }
        if ("commitSha" in status) {
            this.d_commitSha = status.commitSha;
        }
        if ("commitUrl" in status) {
            this.d_commitUrl = status.commitUrl;
        }
        if ("workdirShaRelation" in status) {
            this.d_workdirShaRelation = status.workdirShaRelation;
        }
        if ("repoStatus" in status) {
            this.d_repoStatus = status.repoStatus;
        }
        Object.freeze(this);
    }

    /**
     * @property {RepoStatus.FILESTATUS} [indexStatus] state of this submodule
     * in the index.  Wil be null if no staged changes.
     */
    get indexStatus() {
        return this.d_indexStatus;
    }

    /**
     * @property {String} [indexSha] value for the submodule's sha in the
     * index.  Will be null if `FILESTATUS.REMOVED === indexStatus`.
     */
    get indexSha() {
        return this.d_indexSha;
    }

    /**
     * @property {COMMIT_RELATION} indexShaRelation indicates the relationship
     * between the sha indicated in the repository's index for this
     * submodule and the sha indicated in the head commit.
     */
    get indexShaRelation() {
        return this.d_indexShaRelation;
    }

    /**
     * @property {String} [indexUrl] value for the submodule's url in the
     * index.  Will be null if `FILESTATUS.REMOVED === indexStatus`.
     */
    get indexUrl() {
        return this.d_indexUrl;
    }

    /**
     * @property {String} [commitSha] value for this repo's sha in the HEAD
     * commit.  Will be null if `FILESTATUS.ADDED === indexStatus`.
     */
    get commitSha() {
        return this.d_commitSha;
    }

    /**
     * @property {String} [commitUrl] value for this repo's url in the HEAD
     * commit.  Will be null if `FILESTATUS.ADDED === indexStatus`.
     */
    get commitUrl() {
        return this.d_commitUrl;
    }

    /**
     * @property {COMMIT_RELATION} [workdirShaRelation] indicates relationship
     * to head commit in an open submodule's repo and the sha indicated for
     * that submodule in the index
     */
    get workdirShaRelation() {
        return this.d_workdirShaRelation;
    }

    /**
     * @property {RepoStatus} [repoStatus] value for the open repository of
     * this submodule.  Non-null value indicates that the submodule is open.
     */
    get repoStatus() {
        return this.d_repoStatus;
    }

    /**
     * Return true if this submodule is clean and false otherwise.  A submodule
     * is clean if it has no staged or working directory changes to its commit
     * sha, url, or open repository.
     */
    isClean() {
        return this.isIndexClean() && this.isWorkdirClean();
    }

    /**
     * Return true if the index for this submodules is clean and HEAD is on the
     * commit indicated by the HEAD of the meta-repo.  We consider commits to
     * a submodule that are not reflected on HEAD of the meta-repo to be staged
     * changes.
     *
     * @return {Boolean}
     */
    isIndexClean() {
        if (this.d_repoStatus) {
            if (!this.d_repoStatus.isIndexClean() ||
                (null !== this.d_workdirShaRelation && 
                 COMMIT_RELATION.SAME !== this.d_workdirShaRelation)) {
                return false;                                         // RETURN
            }
        }

        // Check to see if there is a different sha for this submodule in the
        // index then what is on HEAD.

        if (COMMIT_RELATION.SAME !== this.d_indexShaRelation) {
            return false;
        }

        // Otherwise, check its index status.

        return null === this.d_indexStatus;
    }

    /**
     * Return true if this repo is closed or has a clean workdir, and false
     * otherwise.
     *
     * @return {Boolean}
     */
    isWorkdirClean() {
        return null === this.d_repoStatus ||
            this.d_repoStatus.isWorkdirClean();
    }
}

/**
 * @class {RepoStatus} value-semantic type representing changes to a
 * repository's index and working directory.
 */
class RepoStatus {

    /**
     * Return the `STAGE` for the specified `flags`.
     *
     * @static
     * @param {Number} flags
     * @return {STAGE}
     */
    static getStage(flags) {
        const GIT_IDXENTRY_STAGESHIFT = 12;
        return flags >> GIT_IDXENTRY_STAGESHIFT;
    }

    /**
     * Create a new status object having the specified properties.
     * @constructor
     *
     * @param {Object}   [args]
     * @param {String}   [args.currentBranchName]
     * @param {String}   [args.headCommit]
     * @param {Object}   [args.staged] map from name to `FILESTATUS`
     * @param {Object}   [args.submodules] map from name to `Submodule`
     * @param {Object}   [args.workdir] map from name to `FILESTATUS`
     * @param {Rebase}   [args.rebase] rebase, if one is in progress
     */
    constructor(args) {
        if (undefined === args) {
            args = {};
        }
        else {
            assert.isObject(args);
        }
        this.d_currentBranchName = null;
        this.d_headCommit = null;
        this.d_staged = {};
        this.d_workdir = {};
        this.d_submodules = {};
        this.d_rebase = null;

        if ("currentBranchName" in args) {
            if (null !== args.currentBranchName) {
                assert.isString(args.currentBranchName);
                this.d_currentBranchName = args.currentBranchName;
            }
        }
        if ("headCommit" in args) {
            if (null !== args.headCommit) {
                assert.isString(args.headCommit);
                this.d_headCommit = args.headCommit;
            }
        }
        if ("staged" in args) {
            const staged = args.staged;
            assert.isObject(staged);
            for (let name in staged) {
                const value = staged[name];
                assert.isNumber(value);
                this.d_staged[name] = value;
            }
        }
        if ("workdir" in args) {
            const workdir = args.workdir;
            assert.isObject(workdir);
            for (let name in workdir) {
                const value = workdir[name];
                assert.isNumber(value);
                this.d_workdir[name] = value;
            }
        }
        if ("submodules" in args) {
            const submodules = args.submodules;
            for (let name in submodules) {
                const submodule = submodules[name];
                assert.instanceOf(submodule, Submodule);
                this.d_submodules[name] = submodule;
            }
        }

        if ("rebase" in args) {
            const rebase = args.rebase;
            if (null !== rebase) {
                assert.instanceOf(rebase, Rebase);
            }
            this.d_rebase = rebase;
        }
        Object.freeze(this);
    }

    // ACCESSORS

    /**
     * Return true if there are no staged or modified files in this repository.
     * Note that untracked files and changes to submodules do not count as
     * modifications.
     *
     * @return {Boolean}
     */
    isClean() {
        return this.isIndexClean() && this.isWorkdirClean();
    }

    /**
     * Return true there are no changes to the index of this repo and false
     * otherwise.
     *
     * @return {Boolean}
     */
    isIndexClean() {
        return 0 === Object.keys(this.d_staged).length;
    }

    /**
     * Return true there are no changes to the working directory of this repo
     * and false otherwise.
     *
     * @return {Boolean}
     */
    isWorkdirClean() {
        for (let path in this.d_workdir) {
            if (FILESTATUS.ADDED !== this.d_workdir[path]) {
                return false;
            }
        }
        return true;
    }

    /**
     * Return true if `this.isClean()` is true for this repository and all of
     * its submodules, and false otherwise.
     *
     * @return {Boolean}
     */
    isDeepClean() {
        return this.isIndexDeepClean() && this.isWorkdirDeepClean();
    }

    /**
     * Return true if `this.isClean()` is true for this repository and all of
     * its submodules, and false otherwise.
     *
     * @return {Boolean}
     */
    isIndexDeepClean() {
        if (!this.isIndexClean()) {
            return false;
        }
        for (let sub in this.d_submodules) {
            if (!this.d_submodules[sub].isIndexClean()) {
                return false;
            }
        }
        return true;
    }

    /*
     * Return true if `this.isWorkdirClean()` is true for this repository and
     * all of its submodules, and false otherwise.
     *
     * @return {Boolean}
     */
    isWorkdirDeepClean() {
        if (!this.isWorkdirClean()) {
            return false;
        }
        for (let sub in this.d_submodules) {
            if (!this.d_submodules[sub].isWorkdirClean()) {
                return false;
            }
        }
        return true;
    }

    // PROPERTIES

    /**
     * @property {String} [currentBranchName] name of current branch or null
     *                                        if no current branch
     */
    get currentBranchName() {
        return this.d_currentBranchName;
    }

    /**
     * @property {String} [headCommit] sha of head commit or null if no
     * commit
     */
    get headCommit() {
        return this.d_headCommit;
    }

    /**
     * @property {Object} staged map from name to FILESTATUS
     */
    get staged() {
        return Object.assign({}, this.d_staged);
    }

    /**
     * @property {Object} submodules map from name to `Submodule`
     */
    get submodules() {
        return Object.assign({}, this.d_submodules);
    }

    /**
     * @property {Object} workdir files modified in working directory
     *                            a map from name to FILESTATUS
     */
    get workdir() {
        return Object.assign({}, this.d_workdir);
    }

    /**
     * @property {Rebase} rebase if non-null, state of in-progress rebase
     */
    get rebase() {
        return this.d_rebase;
    }
}

module.exports = RepoStatus;
RepoStatus.STAGE = STAGE;
RepoStatus.FILESTATUS = FILESTATUS;
RepoStatus.Submodule = Submodule;
Submodule.COMMIT_RELATION = COMMIT_RELATION;

