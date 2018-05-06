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

// TODO:
// - commit signatures

const assert   = require("chai").assert;
const deeper   = require("deeper");
const deepCopy = require("deepcopy");

const Rebase         = require("./rebase");
const SequencerState = require("./sequencer_state");

/**
 * @class {File}
 *
 * This class represents a file in a repository.
 */
class File {
    /**
     * Create a `File` object having the specified `contents` and
     * `isExecutable` bit.
     *
     * @constructor
     * @param {String} contents
     * @param {Bool}   isExecutable
     */
    constructor(contents, isExecutable) {
        assert.isString(contents);
        assert.isBoolean(isExecutable);
        this.d_contents = contents;
        this.d_isExecutable = isExecutable;
        Object.freeze(this);
    }

    /**
     * @property {String} contents     the contents of the file
     */
    get contents() {
        return this.d_contents;
    }

    /**
     * @property {Bool}  isExecutable   true if the file is executable
     */
    get isExecutable() {
        return this.d_isExecutable;
    }

    /**
     * Return true if this object represents the same value as the specified
     * `rhs` and false otherwise.  Two `File` objects represent the same
     * value if they have the same `contents` and `isExecutable` properties.
     *
     * @param {File} rhs
     * @return {Bool}
     */
    equal(rhs) {
        return this.d_contents === rhs.d_contents &&
            this.d_isExecutable === rhs.d_isExecutable;
    }
}

File.prototype.toString = function () {
    return `File(content=${this.d_contents}, \
isExecutable=${this.d_isExecutable})`;
};

/**
 * @class {Branch}
 *
 * This class represents a branch in a repository.
 */
class Branch {
    /**
     * Create a `Branch` having the specified `sha` and optionally specified
     * `tracking` branch.
     *
     * @constructor
     * @param {String}      sha
     * @param {String|null} tracking
     */
    constructor(sha, tracking) {
        assert.isString(sha);
        if (null !== tracking) {
            assert.isString(tracking);
        }
        this.d_sha = sha;
        this.d_tracking = tracking;
        Object.freeze(this);
    }

    /**
     * @property {String} sha the commit pointed to by this branch
     */
    get sha() {
        return this.d_sha;
    }

    /**
     * @property {String|null} tracking the branch tracked by this one, if any
     */
    get tracking() {
        return this.d_tracking;
    }
}

/**
 * @class {Submodule}
 *
 * This class represents the definition of a submodule in a repository.
 */
class Submodule {

    /**
     * Create a `Submodule` having the specified `url` and `sha`.  A null sha
     * indicates that the repo does not have an object entry for this
     * submodule; it's probably new.
     *
     * @constructor
     * @param {String} url
     * @param {String} [sha]
     */
    constructor(url, sha) {
        assert.isString(url);
        if (null !== sha) {
            assert.isString(sha);
        }
        this.d_url = url;
        this.d_sha = sha;
        Object.freeze(this);
    }

    /**
     * @property {String} url upstream location of submodule
     */
    get url() {
        return this.d_url;
    }

    get sha() {
        return this.d_sha;
    }

    /**
     * Return true if the specified `rhs` represents the same value as this
     * `Submodule` object and false otherwise.  Two `Submodule` objects
     * represent the same value if they have the same `url` and `sha`.
     *
     * @param {Submodule} rhs
     * @return {Bool}
     */
    equal(rhs) {
        assert.instanceOf(rhs, Submodule);
        return this.d_url === rhs.d_url && this.d_sha === rhs.d_sha;
    }
}

Submodule.prototype.toString = function () {
    return `Submodule(url=${this.d_url}, sha=${this.d_sha || ""})`;
};

/**
 * @class Conflict
 *
 * This class is used to represent a file that is conflicted in the index.
 */
class Conflict {

    /**
     * Create a new `Conflict` having the specified `ancestor`, `our`, and
     * `their` file content.  Null content indicates a deletion.
     *
     * @constructor
     * @param {String|Submodule|null} ancestor
     * @param {String|Submodule|null} our
     * @param {String||Submodule|null} their
     */
    constructor(ancestor, our, their) {
        assert(null === ancestor ||
               ancestor instanceof File ||
               ancestor instanceof Submodule, ancestor);
        assert(null === our ||
               our instanceof File ||
               our instanceof Submodule, our);
        assert(null === their ||
               their instanceof File ||
               their instanceof Submodule, their);
        this.d_ancestor = ancestor;
        this.d_our = our;
        this.d_their = their;
    }

    /**
     * @property {String|Submodule|null} ancestor
     * the content of the file in the common ancestor commit
     */
    get ancestor() {
        return this.d_ancestor;
    }

    /**
     * @property {String|Submodule|null} our
     * the content of the file in the "current" commit being integrated into
     */
    get our() {
        return this.d_our;
    }

    /**
     * @property {String|Submodule|null} their
     * the content of the file in the commit being integrated
     */
    get their() {
        return this.d_their;
    }

    /**
     * Return true if the specified `rhs` represents the same value as this
     * `Conflict` and false otherwise.  Two `Conflict` objects represent the
     * same value if the have the same `ancestor`, `our`, and `their`.
     *
     * @param {Conflict} rhs
     * @return {Bool}
     */
    equal(rhs) {
        assert.instanceOf(rhs, Conflict);
        return deeper(this, rhs);
   }
}

Conflict.prototype.toString = function () {
    return `Conflict(ancestor=${this.d_ancestor}, our=${this.d_our} \
their=${this.d_their})`;
};

/**
 * This module provides the RepoAST class and associated classes.  Supported
 * configurations will be added (and documented here) as they are added.

/**
 * @class Commit
 *
 * This class represents a commit in a repository.
 */
class Commit {

    /**
     * Create a new `Commit` object.
     *
     * @param {Object}   args
     * @param {String[]} [args.parents] list of ids of parent commits
     * @param {Object}   [args.changes] map from path to content
     * @param {String}   [args.message] defaults to ""
     * @constructor
     */
    constructor(args) {
        if (undefined === args) {
            args = {};
        }
        assert.isObject(args);
        this.d_parents = [];
        if ("parents" in args) {
            assert.isArray(args.parents);
            args.parents.forEach(parent => {
                assert.isString(parent);
                this.d_parents.push(parent);
            });

        }
        this.d_changes = {};
        if ("changes" in args) {
            assert.isObject(args.changes);
            for (let path in args.changes) {
                const file = args.changes[path];
                assert(file === null ||
                       file instanceof File ||
                       file instanceof Submodule,
                       `commit change at ${path} has invalid content ${file}`);
                this.d_changes[path] = file;
            }
        }
        this.d_message = "";
        if ("message" in args) {
            assert.isString(args.message);
            this.d_message = args.message;
        }
        Object.freeze(this);
    }

    /**
     * @property {String []} parents array of parent commit IDs
     */
    get parents() {
        return deepCopy(this.d_parents);
    }

    /**
     * @property {Object} changes map from path to new (string) value
     *
     * changes may be:
     * 1. string -- raw data for the path
     * 2. null   -- indicates deletion of file at path
     * 3. Submodule -- indicates addition/change of submodule at path
     */
    get changes() {
        let result = {};
        for (let key in this.d_changes) {
            result[key] = this.d_changes[key];
        }
        return result;
    }

    /**
     * @property {String} message the commit message
     */
    get message() {
        return this.d_message;
    }
}

/**
 * @class Remote
 * This class represents a remote in a repository.
 */
class Remote {
    /**
     * Create a new `Commit` object.
     *
     * @param {String} url
     * @param {Object} [args]
     * @param {Object} [args.branches] map from name to commit id
     * @constructor
     */
    constructor(url, args) {
        assert.isString(url);
        if (undefined === args) {
            args = {};
        }
        assert.isObject(args);
        this.d_url = url;
        this.d_branches = {};
        if ("branches" in args) {
            assert.isObject(args.branches);
            for (let name in args.branches) {
                const id = args.branches[name];
                assert.isString(id);
                this.d_branches[name] = id;
            }
        }
        for (let key in args) {
            assert.equal(key, "branches");
        }
        Object.freeze(this);
    }

    /**
     * @property {String} url location of the remote
     */
    get url() {
        return deepCopy(this.d_url);
    }

    /**
     * @property {Object} branches  map from branch name to commit id
     */
    get branches() {
        return deepCopy(this.d_branches);
    }
}

/**
 * @class AST
 *
 * This class represents the state of a Git repository.
 */
class AST {

    /**
     * Create a new `AST` object.  The behavior is undefined unless
     * 
     * - each commit id referenced in each object in the specified `commits`,
     *   each reference in the specified `branches`, `refs`, and `head`, if
     *   specified, exists in the `commits` map.
     * - no names in `refs` indicate branches: local (starting with 'heads/' or
     *   remote, (starting with 'remotes/')
     * - `currentBranchName`, if specified, exists in `branches`
     * - each commit in `commits` is *reachable* from at least one of a:
     *   - branch
     *   - reference
     *   - remote branch
     *   - HEAD
     *   - another reachable commit
     * - every deletion described by a commit references a path that would have
     *   existed.
     * - each change introduced in a commit would actually alter the working
     *   tree as defined by its left-most parent
     * - `currentBranchName` and `head` indicate the same commit, or one of
     *   them is not specified
     * - `head` is specified whenever `index` or `workdir` are provided
     * - `workdir` contains no submodule changes
     * - all specified `openSubmodules` exist on HEAD or in the `index`.
     * - If provided, the `onto` and `originalHead` commits in `rebase` exist
     *   in `commits`.
     * - if 'bare', `index` and `workdir` are empty, and `rebase` is null
     * - any conflicted path in the index has a value specified in the workdir
     *
     * @param {Object}         args
     * @param {Object}         [args.commits]
     * @param {Object}         [args.branches]
     * @param {Object}         [args.refs]
     * @param {String|null}    [args.head]
     * @param {Boolean}        [args.bare]
     * @param {String|null}    [args.currentBranchName]
     * @param {Object}         [args.remotes]
     * @param {Object}         [args.index]
     * @param {Object}         [args.workdir]
     * @param {Object}         [args.notes]
     * @param {Object}         [args.openSubmodules]
     * @param {Rebase}         [args.rebase]
     * @param {SequencerState} [args.sequencerState]
     * @param {Boolean}        [args.sparse]
     */
    constructor(args) {
        if (undefined === args) {
            args = {};
        }
        assert.isObject(args);

        // Validate and copy commits.

        this.d_commits = {};
        const commits = ("commits" in args) ? args.commits : {};
        assert.isObject(commits);
        function checkCommit(commit, message) {
            assert.isObject(commits);
            assert.property(commits, commit, message);
        }

        let renderCache = {};  // Used to cache rendered worktrees.

        Object.keys(commits).forEach(id => {
            const commit = commits[id];
            assert.instanceOf(commit, Commit);

            // Validate parents exist.

            const parents = commit.parents;
            commit.parents.forEach(checkCommit, `parent of ${id}`);

            // Validate changes:
            // 1. that they aren't "duplicates"
            // 2. that deletions affect files that actually exist

            let worktree = {};
            if (0 !== parents.length) {
                const firstParent = parents[0];
                worktree = AST.renderCommit(renderCache,
                                            commits,
                                            firstParent);
            }
            const changes = commit.changes;
            Object.keys(changes).forEach(path => {
                const change = changes[path];
                assert(!deeper(change, worktree[path]),
                   `Duplicate change in commit ${id} for ${path}: ${change}.`);
                if (null === change) {
                    assert.property(worktree,
                                    path,
                                    `Deletion of non-existient path ${path} \
in commit ${id}.`);
                }
            });

            // Don't need to deep copy `Commit` objects as they are
            // frozen.
            this.d_commits[id] = commit;
        });

        // Keep track of seen commits.

        let seen = new Set();

        function traverse(commitId) {
            if (!seen.has(commitId)) {
                seen.add(commitId);
                commits[commitId].parents.forEach(traverse);
            }
        }

        function checkAndTraverse(commitId, message) {
            checkCommit(commitId, message);
            traverse(commitId);
        }

        // Validate and copy branches.

        this.d_branches = {};
        const branches = ("branches" in args) ? args.branches : {};
        for (let name in branches) {
            const branch = branches[name];
            assert.instanceOf(branch, Branch);
            checkAndTraverse(branch.sha, `branch ${branch}`);
            this.d_branches[name] = branch;
        }

        // Validate and copy refs.

        this.d_refs = {};
        const refs = ("refs" in args) ? args.refs : {};
        for (let name in refs) {
            const ref = refs[name];
            assert.isString(ref, name);
            assert(!name.startsWith("heads/"),
                   `ref ${name} indicates a branch`);
            assert(!name.startsWith("remotes/"),
                   `ref ${name} indicates a remote branch`);
            checkAndTraverse(ref, `ref ${name}`);
            this.d_refs[name] = ref;
        }

        // Validate and copy head.

        this.d_head = null;
        const head = ("head" in args) ? args.head : null;
        if (null !== head) {
            assert.isString(head);
            checkAndTraverse(head, "head");
            this.d_head = head;
        }

        this.d_bare = false;
        if ("bare" in args) {
            this.d_bare = args.bare;
            assert.isBoolean(this.d_bare);
        }

        // Validate and copy current branch

        this.d_currentBranchName = null;
        const currentBranchName = ("currentBranchName" in args) ?
                                                 args.currentBranchName : null;
        if (null !== currentBranchName) {
            assert.isString(currentBranchName);
            assert.property(this.d_branches, currentBranchName);
            if (null !== this.d_head) {
                assert.equal(this.d_head,
                             this.d_branches[currentBranchName].sha,
                             "current head and branch differ");
            }
            this.d_currentBranchName = currentBranchName;
        }

        // Validate and copy remotes

        this.d_remotes = {};
        if ("remotes" in args) {
            for (let name in args.remotes) {
                let remote = args.remotes[name];
                assert.instanceOf(remote, Remote);
                const remoteBranches = remote.branches;
                let branches = {};
                for (let branchName in remoteBranches) {
                    const commit = remoteBranches[branchName];
                    checkAndTraverse(commit, `remote ${name}`);
                    branches[branchName] = commit;
                }
                this.d_remotes[name] = new Remote(remote.url, {
                    branches: branches,
                });
            }
        }

        this.d_rebase = null;
        if ("rebase" in args) {
            const rebase = args.rebase;
            if (null !== rebase) {
                assert.instanceOf(rebase, Rebase);
                assert.isFalse(this.d_bare);
                checkAndTraverse(rebase.originalHead,
                                 "original head of rebase");
                checkAndTraverse(rebase.onto,
                                 "onto of rebase");
                this.d_rebase = rebase;
            }
        }

        this.d_sequencerState = null;
        if ("sequencerState" in args) {
            const sequencerState = args.sequencerState;
            if (null !== sequencerState) {
                assert.instanceOf(sequencerState, SequencerState);
                assert.isFalse(this.d_bare);
                checkAndTraverse(sequencerState.originalHead.sha,
                                 "original head of sequencer");
                checkAndTraverse(sequencerState.target.sha,
                                 "target commit of sequencer");
                sequencerState.commits.forEach(
                    sha => checkAndTraverse(sha, "sequencer commit"));
                this.d_sequencerState = sequencerState;
            }
        }

        // Validate that all commits have been reached.

        for (let key in commits) {
            assert(seen.has(key), `Commit '${key}' is not reachable.`);
        }

        // Copy and validate notes changes.

        this.d_notes = {};
        if ("notes" in args) {
            const notes = deepCopy(args.notes);
            assert.isObject(notes);
            for (let refName in notes) {
                const notesForRef = notes[refName];
                this.d_notes[refName] = {};
                assert.isObject(notesForRef);
                for (let commit in notesForRef) {
                    const message = notesForRef[commit];
                    assert.isString(message);
                    this.d_notes[refName][commit] = message;
                }
            }
        }

        // Copy and validate workdir changes.

        this.d_workdir = {};
        if ("workdir" in args) {
            const workdir = args.workdir;
            assert.isObject(workdir);
            for (let path in workdir) {
                assert.isFalse(this.d_bare);
                const change = workdir[path];
                if (null !== change) {
                    assert.instanceOf(change,
                                      File,
                                      `workdir change at ${path}`);
                }
                this.d_workdir[path] = change;
            }
        }

        // Copy and validate index changes.

        this.d_index = {};
        if ("index" in args) {
            const index = args.index;
            assert.isObject(index);
            for (let path in index) {
                assert.isFalse(this.d_bare);
                const change = index[path];
                assert(null === change ||
                       change instanceof File ||
                       change instanceof Submodule ||
                       change instanceof Conflict,
                       `Invalid value in index for ${path} -- ${change}`);
                this.d_index[path] = change;
            }
        }


        // Copy and validate open submodules.  Each open submodule must be an
        // instance of `AST` and there must be a `Submodule` defined in the
        // current index for that path.

        this.d_openSubmodules = {};
        if ("openSubmodules" in args) {
            const openSubmodules = args.openSubmodules;
            assert.isObject(openSubmodules);
            if (0 !== Object.keys(openSubmodules).length) {
                assert.isNotNull(this.d_head);
                const index = AST.renderIndex(this.d_commits,
                                              this.d_head,
                                              this.d_index);
                for (let path in openSubmodules) {
                    assert.property(index, path);
                    assert.instanceOf(index[path], Submodule);
                    const open = openSubmodules[path];
                    assert.instanceOf(open, AST);
                    this.d_openSubmodules[path] = open;
                }
            }
        }

        this.d_sparse = false;
        if ("sparse" in args) {
            this.d_sparse = args.sparse;
            assert.isBoolean(this.d_sparse);
        }

        Object.freeze(this);
    }

    /**
     * @property {Object} commits from (string) commit id to `Commit` object
     */
    get commits() {
        return Object.assign({}, this.d_commits);
    }

    /**
     * @property {Object} branches map from branch name to expected commit id
     */
    get branches() {
        return Object.assign({}, this.d_branches);
    }

    /**
     * @property {Object} refs  map from ref name to expected commit id
     */
    get refs() {
        return deepCopy(this.d_refs);
    }

    /**
     * @property {String|null} head the current HEAD commit.
     */
    get head() {
        return this.d_head;
    }

    /**
     * @property {String|null} currentBranchName name of current branch.  A
     * repo has a detached head iff `null === currentBranchName`.
     */
    get currentBranchName() {
        return this.d_currentBranchName;
    }

    /**
     * @property {Object} remotes map from remote name to `Remote` object
     */
    get remotes() {
        return Object.assign({}, this.d_remotes);
    }

    /**
     * @property {Object} index the current index.  Describes changes from the
     * current HEAD
     */
    get index() {
        return Object.assign({}, this.d_index);
    }

    /**
     * @property {Boolean} true if repo is bare and false otherwise
     */
    get bare() {
        return this.d_bare;
    }

    /**
     * @property {Object} notes the set of notes. Grouped by ref.
     */
    get notes() {
        return Object.assign({}, this.d_notes);
    }

    /**
     * @property {Object} workdir the current working directory.  Describes
     * changes from the current index.
     */
    get workdir() {
        return Object.assign({}, this.d_workdir);
    }

    /**
     * @property {Object} openSubmodules map from path top state of repository
     * for all currently open submodules
     */
    get openSubmodules() {
        return Object.assign({}, this.d_openSubmodules);
    }

    /**
     * @property {Rebase} rebase if rebase in progress, the state of the rebase
     */
    get rebase() {
        return this.d_rebase;
    }

    /**
     * @property {SequencerState} null unless a sequence operation is ongoing
     */
    get sequencerState() {
        return this.d_sequencerState;
    }

    /**
     * @property {Boolean} true if repo is sparse and false otherwise
     */
    get sparse() {
        return this.d_sparse;
    }

    /**
     * Accumulate the specified `changes` into the specified `dest` map.  A
     * non-null value in `changes` overrides any existing value in `dest`; a
     * `null value causes the path mapped to `null` to be removed.  The
     * behavior is undefined if `changes` indicates a deletion to a value that
     * does not exist in `dest`.
     *
     * @static
     * @param {Object} dest path to value
     * @param {Object} changes path to change
     */
    static accumulateDirChanges(dest, changes) {
        assert.isObject(dest);
        assert.isObject(changes);
        for (let path in changes) {
            const change = changes[path];

            if (null === change) {
                assert.property(dest, path);
                delete dest[path];
            }
            else {
                dest[path] = change;
            }
        }
    }

    /**
     * Return a copy of this object replacing the properties in the specified
     * `args`.
     *
     * @param {Object}      args
     * @param {Object}      [args.commits]
     * @param {Object}      [args.branches]
     * @param {Object}      [args.refs]
     * @param {Object}      [args.notes]
     * @param {String|null} [args.head]
     * @param {String|null} [args.currentBranchName]
     * @return {AST}
     */
    copy(args) {
        if (undefined === args) {
            args = {};
        }
        return new AST({
            commits: ("commits" in args) ? args.commits : this.d_commits,
            branches: ("branches" in args) ? args.branches : this.d_branches,
            refs: ("refs" in args) ? args.refs : this.d_refs,
            head: ("head" in args) ? args.head: this.d_head,
            currentBranchName: ("currentBranchName" in args) ?
                args.currentBranchName :
                this.d_currentBranchName,
            remotes: ("remotes" in args) ? args.remotes : this.d_remotes,
            index: ("index" in args) ? args.index : this.d_index,
            notes: ("notes" in args) ? args.notes : this.d_notes,
            workdir: ("workdir" in args) ? args.workdir : this.d_workdir,
            openSubmodules: ("openSubmodules" in args) ?
                args.openSubmodules : this.d_openSubmodules,
            rebase: ("rebase" in args) ? args.rebase : this.d_rebase,
            sequencerState: ("sequencerState" in args) ?
                       args.sequencerState: this.d_sequencerState,
            bare: ("bare" in args) ? args.bare : this.d_bare,
            sparse: ("sparse" in args) ? args.sparse : this.d_sparse,
        });
    }

    /**
     * Return a map from path to change reflecting the state of the repository
     * that would be expected were the commit with the specified `commitId`
     * checked out -- basically, accumulating changes from root to `commit`,
     * referencing commits in the specified `commitMap`.  The behavior is
     * undefined unless `commitId` refers to a `Commit` object in `commitMap`
     * and the commits are consistent as described in the constructor of `AST`.
     * Use the specified `cache` to store intermediate (and final) results; if
     * `commitId` already exists in `cache` return the value stored in `cache`.
     *
     * Note that this method is needed on `AST` because it will be used to
     * validate preconditions in the constructor.
     *
     * @static
     * @param {Object} cache
     * @param {Object} commitMap
     * @param {String} commitId
     * @return {Object} maps from path to change
     */
    static renderCommit(cache, commitMap, commitId) {
        assert.isObject(cache);
        assert.isObject(commitMap);
        assert.isString(commitId);

        if (commitId in cache) {
            return cache[commitId];
        }

        assert.property(commitMap, commitId);

        const commit = commitMap[commitId];
        let result = {};

        if (0 !== commit.parents.length) {
            // We need traverse only the left-most parent.  Changes are against
            // the left parent.

            Object.assign(
                        result,
                        AST.renderCommit(cache, commitMap, commit.parents[0]));
        }

        AST.accumulateDirChanges(result, commit.changes);
        cache[commitId] = result;
        return result;
    }

    /**
     * Return a map from path to content for an index having the specified
     * `indexChanges` staged on the commit having the specified `commitId` in
     * the specified `commitMap`.
     *
     * @param {Object} commitMap    from commit id to `Commit`
     * @param {String} commitId     id of HEAD commit
     * @param {Object} indexChanges map from path to content
     * @return {Object} map from path to content (data or `Submodule`)
     */
    static renderIndex(commitMap, commitId, indexChanges) {
        assert.isObject(commitMap);
        assert.isString(commitId);
        assert.isObject(indexChanges);
        const cache = {};
        const fromCommit = AST.renderCommit(cache, commitMap, commitId);
        const filteredIndex = {};
        for (let key in indexChanges) {
            const value = indexChanges[key];
            if (!(value instanceof Conflict)) {
                filteredIndex[key] = value;
            }
        }
        AST.accumulateDirChanges(fromCommit, filteredIndex);
        return fromCommit;
    }
}

AST.Branch = Branch;
AST.Commit = Commit;
AST.Conflict = Conflict;
AST.File = File;
AST.Rebase = Rebase;
AST.Remote = Remote;
AST.SequencerState = SequencerState;
AST.Submodule = Submodule;
module.exports = AST;
