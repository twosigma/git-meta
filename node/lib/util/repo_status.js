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
const SequencerState = require("./sequencer_state");

/**
 * This modules defines the type `RepoStatus`, used to describe modifications
 * to a repo.
 */

/**
 * @class Conflict
 * describes a conflict in a file or submodule
 */
class Conflict {
    /**
     * Create a new `Conflict` object having the specified `ancestorMode`,
     * `ourMode`, and `theirMode` modes.
     *
     * @param {Number|null} ancestorMode
     * @param {Number|null} ourMode
     * @param {Number|null} theirMode
     */
    constructor(ancestorMode, ourMode, theirMode) {
        if (null !== ancestorMode) {
            assert.isNumber(ancestorMode);
        }
        if (null !== ourMode) {
            assert.isNumber(ourMode);
        }
        if (null !== theirMode) {
            assert.isNumber(theirMode);
        }

        this.d_ancestorMode = ancestorMode;
        this.d_ourMode = ourMode;
        this.d_theirMode = theirMode;
        Object.freeze(this);
    }

    /**
     * @property {Number} ancestorMode   file mode of the ancestor part
     */
    get ancestorMode() {
        return this.d_ancestorMode;
    }

    /**
     * @property {Number} ourMode  file mode of our part of conflict
     */
    get ourMode() {
        return this.d_ourMode;
    }

    get theirMode() {
        return this.d_theirMode;
    }
}

/**
 * @enum {RepoStatus.STAGE}
 * indicates the meaning of an entry in the index
 */
// From libgit2 index.h.  This information is not documented in
// the nodegit or libgit2 documentation.
const STAGE = {
    NORMAL: 0,  // normally staged file
    ANCESTOR: 1,
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
 * The `Submodule.Commit` class represents the state of a `Submodule` object in
 * a commit.
 */
class Commit {
    /**
     * Create a new `Commit` object having the specified `sha` and `url`.
     *
     * @param {String} sha
     * @param {String} url
     */
    constructor(sha, url) {
        this.d_sha = sha;
        this.d_url = url;
    }

    /**
     * the sha registered in the commit for a submodule
     *
     * @property {String}
     */
    get sha() {
        return this.d_sha;
    }

    /**
     * the url registered in the commit for a submodule
     *
     * @property {String}
     */
    get url() {
        return this.d_url;
    }
}

/**
 * An `Submodule.Index` object represents the status of a submodule in the
 * index.
 */
class Index {

    /**
     * Return a new `Index` object having the specified `sha`, `url`, and
     * `relation`.
     *
     * @param {String|null}                    sha
     * @param {String}                         url
     * @param {Submodule.COMMIT_RELATION|null} relation
     */
    constructor(sha, url, relation) {
        this.d_sha = sha;
        this.d_url = url;
        this.d_relation = relation;
        Object.freeze(this);
    }

    /**
     * the sha registered in the index for a submodule
     *
     * @property {String}
     */
    get sha() {
        return this.d_sha;
    }

    /**
     * the url registered in the index for a submodule
     *
     * @property {String}
     */
    get url() {
        return this.d_url;
    }

    /**
     * relationship between the sha registered in the index the commit
     *
     * @property {String}
     */
    get relation() {
        return this.d_relation;
    }
}

/**
 * A `Submodule.Workdir` object represents the state of an open submodule.
 */
class Workdir {
    /**
     * Create a new `Workdir` object having the specified repo `status` and
     * `relation` between its head commit and that registered in the index.
     * The behavior is undefined if
     * `null === status.headCommit && null !== relation`.
     *
     * @param {RepoStatus}           status
     * @param {COMMIT_RELATION|null} relation
     */
    constructor(status, relation) {
        assert.instanceOf(status, module.exports);
        if (null !== relation) {
            assert.isNumber(relation);
        }
        if (null === status.headCommit) {
            assert.isNull(relation);
        }
        this.d_status = status;
        this.d_relation = relation;
    }

    /**
     * the status of the open repository for a submodule
     *
     * @property {RepoStatus} status
     */
    get status() {
        return this.d_status;
    }

    /**
     * the relationship between the HEAD commit of the open repository and the
     * commit registered in the index for a submodule
     */
    get relation() {
        return this.d_relation;
    }
}


/**
 * @class {RepoStatus.Submodule} a value-semantic type representing changes to
 * the state of a submodule
 */
class Submodule {
    /**
     * @constructor
     * Create a new `Submodule` object configured by the specified `status`.
     * A null `commit` field indicates thab the submodule was added.  A null
     * `index` field indicates that the submodule was removed.  A non-null
     * `workdir` field indicates an open submodule.
     * The behavior is undefined if:
     *   - `index` is null but `workdir` is non-null
     *   - `commit` is null and `index.relation` is non-null
     *   - `commit` is not null and `index.relation` is null
     *   - `index.sha` and `commit.sha` are the same, but `index.Relation` is
     *     not `COMMIT_RELATION.SAME`
     *   - `index.relation` is `COMMIT_RELATION.SAME but `index.sha` and
     *      `commit.sha` differ
     *   - `index.sha` and `workdir.status.headCommit` are not null and
     *   `workdir.relation` is null
     *   - `index.sha` and `workdir.status.headCommit` are the same, but
     *     `workdir.relation` is not `COMMIT_RELATION.SAME`
     *   - `workdir.relation` is `COMMIT_RELATION.SAME but `index.sha` and
     *     `workdir.status.headCommit` differ
     *
     * @param {Object}       status
     * @param {Commit|null}  status.commit
     * @param {Index|null}   status.index
     * @param {Workdir|null} status.workdir
     */
    constructor(status) {
        if (undefined === status) {
            status = {};
        }
        this.d_commit  = status.commit || null;
        this.d_index   = status.index || null;
        this.d_workdir = status.workdir || null;
    }

    /**
     * status of the submodule in the current commit, or null if it's been
     * added and not yet committed
     *
     * @property {Commit}
     */
    get commit() {
        return this.d_commit;
    }

    /**
     * status of the submodule in the index, or null if its been deleted
     *
     * @property {Index}
     */
    get index() {
        return this.d_index;
    }

    /**
     * workdir status of the submodule if open, null if it's not open
     *
     * @property {Workdir}
     */
    get workdir() {
        return this.d_workdir;
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
        if (null !== this.d_workdir) {
            if (!this.d_workdir.status.isIndexClean() ||
                 COMMIT_RELATION.SAME !== this.d_workdir.relation) {
                return false;                                         // RETURN
            }
        }

        // If it's been deleted it's not clean.

        if (null === this.d_index) {
            return false;
        }

        // If it's been added it's not clean.
        if (null === this.d_commit) {
            return false;
        }

        // Otherwise, it's unclean if its URL or commit has changed.

        return this.d_commit.url === this.d_index.url &&
            this.d_commit.sha === this.d_index.sha;
    }

    /**
     * Return true if this submodule has been added.
     * @return {Boolean}
     */
    isNew() {
        return null === this.d_commit;
    }

    /**
     * Return true if this submodule can be committed, because it is both not
     * new and has some staged changes or commits.
     *
     * @return {Boolean}
     */
    isCommittable () {
        return !(this.isNew() &&
                 (null === this.d_index ||
                  null === this.d_index.sha) &&
                 (null === this.d_workdir ||
                  null === this.d_workdir.status.headCommit &&
                  this.d_workdir.status.isIndexClean()));
    }

    /**
     * Return true if this repo is closed or has a clean workdir, and false
     * otherwise.  If the specified `all` is true, consider untracked files to
     * be dirty.
     *
     * @param {Boolean} all
     * @return {Boolean}
     */
    isWorkdirClean(all) {
        return null === this.d_workdir ||
            this.d_workdir.status.isWorkdirClean(all);
    }

    /**
     * Return a new `Submodule` object having the same value as this one, but
     * with replacing properties defined in the specified `args`.
     *
     * @param {Object} args
     * @return {Submodule}
     */
    copy(args) {
        if (undefined === args) {
            args = {};
        }
        return new Submodule({
            commit: ("commit" in args) ? args.commit : this.d_commit,
            index: ("index" in args) ? args.index : this.d_index,
            workdir: ("workdir" in args) ? args.workdir : this.d_workdir,
        });
    }

    /**
     * Return a new `Submodule` object having the same value as this one with a
     * newly opened repository.  The behavior is undefined unless
     * `null !== this.index && null === this.workdir`.
     *
     * @return {Submodule}
     */
    open() {
        assert.isNotNull(this.d_index);
        assert.isNull(this.d_workdir);
        const RepoStatus = module.exports;
        return this.copy({
            workdir: new Workdir(new RepoStatus({
                headCommit: this.d_index.sha,
            }), COMMIT_RELATION.SAME),
        });
    }
}

/**
 * @class {RepoStatus} value-semantic type representing changes to a
 * repository's index and working directory.
 */
class RepoStatus {

    /**
     * Create a new status object having the specified properties.
     * @constructor
     *
     * @param {Object}     [args]
     * @param {String}     [args.currentBranchName]
     * @param {String}     [args.headCommit]
     * @param {Object}     [args.staged] map from name to `FILESTATUS`
     * @param {Object}     [args.submodules] map from name to `Submodule`
     * @param {Object}     [args.workdir] map from name to `FILESTATUS`
     * @param {Rebase}     [args.rebase] rebase, if one is in progress
     * @param {SequencerState}
     *                     [args.sequencerState] state of sequencer
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
        this.d_sequencerState = null;

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
                if ("number" !== typeof(value)) {
                    assert.instanceOf(value, Conflict);
                }
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
            this.d_submodules = Object.assign({}, args.submodules);
        }

        if ("rebase" in args) {
            const rebase = args.rebase;
            if (null !== rebase) {
                assert.instanceOf(rebase, Rebase);
            }
            this.d_rebase = rebase;
        }

        if ("sequencerState" in args) {
            const sequencerState = args.sequencerState;
            if (null !== sequencerState) {
                assert.instanceOf(sequencerState, SequencerState);
            }
            this.d_sequencerState = sequencerState;
        }
        Object.freeze(this);
    }

    // ACCESSORS

    /**
     * Return true if there are no staged or modified files in this repository.
     * Note that untracked files and changes to submodules do not count as
     * modifications unless the specified `all` is true.
     *
     * @return {Boolean}
     */
    isClean(all) {
        return this.isIndexClean() && this.isWorkdirClean(all);
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
     * and false otherwise.  If the specified `all` is true consider untracked
     * files to be dirty.
     *
     * @param {Boolean} all
     * @return {Boolean}
     */
    isWorkdirClean(all) {
        for (let path in this.d_workdir) {
            if (all || FILESTATUS.ADDED !== this.d_workdir[path]) {
                return false;
            }
        }
        return true;
    }

    /**
     * Return true if `this.isClean()` is true for this repository and all of
     * its submodules, and false otherwise.  If the specified `all` is true,
     * consider untracked submodules to be dirty.
     *
     * @param {Boolean} all to include untracked files
     * @return {Boolean}
     */
    isDeepClean(all) {
        return this.isIndexDeepClean() && this.isWorkdirDeepClean(all);
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
     * all of its submodules, and false otherwise.  If the specified `all` is
     * true, consider untracked files to be dirty.
     *
     * @param {Boolean} all
     * @return {Boolean}
     */
    isWorkdirDeepClean(all) {
        if (!this.isWorkdirClean(all)) {
            return false;
        }
        for (let sub in this.d_submodules) {
            if (!this.d_submodules[sub].isWorkdirClean(all)) {
                return false;
            }
        }
        return true;
    }

    /*
     * Return true if there are new submodules that are uncommittable.
     */
    areUncommittableSubmodules() {
        return -1 !== Object.keys(this.d_submodules).findIndex(subName => {
            const sub = this.d_submodules[subName];
            return !sub.isCommittable();
        });
    }

    /**
     * Return true if there are any conflicts in the repository represented by
     * this object and false otherwise.
     *
     * @return {Bool}
     */
    isConflicted() {
        for (let name in this.d_staged) {
            if (this.staged[name] instanceof Conflict) {
                return true;                                          // RETURN
            }
        }
        for (let name in this.d_submodules) {
            const sub = this.d_submodules[name];
            if (null !== sub.workdir && sub.workdir.status.isConflicted()) {
                return true;                                          // RETURN
            }
        }
        return false;
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
     * @property {rebase} rebase if non-null, state of in-progress rebase
     */
    get rebase() {
        return this.d_rebase;
    }

    /**
     * @property {SequencerState} sequencerState if ~null, state of sequencer
     */
    get sequencerState() {
        return this.d_sequencerState;
    }
    /**
     * Return a new `RepoStatus` object having the same value as this one, but
     * with replacing properties defined in the specified `args`.
     *
     * @param {Object} args
     * @return {RepoStatus}
     */
    copy(args) {
        if (undefined === args) {
            args = {};
        }
        else {
            assert.isObject(args);
        }
        return new RepoStatus({
            currentBranchName: ("currentBranchName" in args) ?
                args.currentBranchName : this.d_currentBranchName,
            headCommit: ("headCommit" in args) ?
                args.headCommit: this.d_headCommit,
            staged: ("staged" in args) ? args.staged : this.d_staged,
            submodules: ("submodules" in args) ?
                args.submodules: this.d_submodules,
            workdir: ("workdir" in args) ? args.workdir : this.d_workdir,
            rebase: ("rebase" in args) ? args.rebase : this.d_rebase,
            sequencerState: ("sequencerState" in args) ?
                              args.sequencerState : this.d_sequencerState,
        });
    }
}

module.exports = RepoStatus;
RepoStatus.Conflict = Conflict;
RepoStatus.STAGE = STAGE;
RepoStatus.FILESTATUS = FILESTATUS;
RepoStatus.Submodule = Submodule;
Submodule.COMMIT_RELATION = COMMIT_RELATION;
Submodule.Commit = Commit;
Submodule.Index = Index;
Submodule.Workdir = Workdir;
