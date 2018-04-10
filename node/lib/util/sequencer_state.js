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

const assert  = require("chai").assert;
const deeper   = require("deeper");

const TYPE = {
    CHERRY_PICK: "CHERRY_PICK",
    MERGE: "MERGE",
    REBASE: "REBASE",
};

/**
 * This module defines the `SequencerState` value-semantic type.
 */

/**
 * @class CommitAndRef
 *
 * This class describes a commit and optionally the ref it came from.
 */
class CommitAndRef {
    /**
     * Create a new `CommitAndRef` object.
     *
     * @param {String}      sha
     * @param {String|null} ref
     */
    constructor(sha, ref) {
        assert.isString(sha);
        if (null !== ref) {
            assert.isString(ref);
        }
        this.d_sha = sha;
        this.d_ref = ref;

        Object.freeze(this);
    }

    /**
     * @property {String} sha  the unique identifier for this commit
     */
    get sha() {
        return this.d_sha;
    }

    /**
     * @property {String|null} ref
     *
     * If the commit was referenced by a ref, this is its name.
     */
    get ref() {
        return this.d_ref;
    }

    /**
     * Return true if the specified `rhs` represents the same value as this
     * object.  Two `CommitAndRef` objects represet the same value if they have
     * the same `sha` and `ref` properties.
     *
     * @param {CommitAndRef} rhs
     * @return {Bool}
     */
    equal(rhs) {
        assert.instanceOf(rhs, CommitAndRef);
        return this.d_sha === rhs.d_sha && this.d_ref === rhs.d_ref;
    }
}

CommitAndRef.prototype.toString = function () {
    let result = `CommitAndRef(sha=${this.d_sha}`;
    if (null !== this.d_ref) {
        result += `, ref=${this.d_ref}`;
    }
    return result + ")";
};

/**
 * @class SequencerState
 *
 * This class represents the state of an in-progress sequence operation such as
 * a merge, cherry-pick, or rebase.
 */
class SequencerState {
    /**
     * Create a new `SequencerState` object.  The behavior is undefined unless
     * `0 <= currentCommit` and `commits.length >= currentCommit`.  If
     * `commits.length === currentCommit`, there are no more commits left on
     * which to operate.
     *
     * @param {Object} properties
     * @param {TYPE}         properties.type
     * @param {CommitAndRef} properties.originalHead
     * @param {CommitAndRef} properties.target
     * @param {[String]}     properties.commits
     * @param {Number}       properties.currentCommit
     * @param {String|null}  [properties.message]
     */
    constructor(properties) {
        assert.isString(properties.type);
        assert.property(TYPE, properties.type);
        assert.instanceOf(properties.originalHead, CommitAndRef);
        assert.instanceOf(properties.target, CommitAndRef);
        assert.isArray(properties.commits);
        assert.isNumber(properties.currentCommit);
        assert(0 <= properties.currentCommit);
        assert(properties.commits.length >= properties.currentCommit);

        this.d_message = null;
        if ("message" in properties) {
            if (null !== properties.message) {
                assert.isString(properties.message);
                this.d_message = properties.message;
            }
        }

        this.d_type = properties.type;
        this.d_originalHead = properties.originalHead;
        this.d_target = properties.target;
        this.d_commits = properties.commits;
        this.d_currentCommit = properties.currentCommit;

        Object.freeze(this);
    }

    /**
     * @property {TYPE}  the type of operation in progress
     */
    get type() {
        return this.d_type;
    }

    /**
     * @property {CommitAndRef} originalHead
     * what HEAD pointed to when the operation started
     */
    get originalHead() {
        return this.d_originalHead;
    }

    /**
     * @property {CommitAndRef} target
     * the commit that was the target of the operation
     */
    get target() {
        return this.d_target;
    }

    /**
     * @property {[String]} commits  the sequence of commits to operate on
     */
    get commits() {
        return this.d_commits;
    }

    /**
     * @property {Number} currentCommit  index of the current commit
     */
    get currentCommit() {
        return this.d_currentCommit;
    }

    /**
     * @property {String|null} message   commit message to be used
     */
    get message() {
        return this.d_message;
    }

    /**
     * Return true if the specified `rhs` represents the same value as this
     * `SequencerState` object and false otherwise.  Two `SequencerState`
     * objects represent the same value if they have the same `type`,
     * `originalHead`, `target`, `commits`, and `currentCommit` properties.
     *
     * @param {SequencerState} rhs
     * @return {Bool}
     */
    equal(rhs) {
        assert.instanceOf(rhs, SequencerState);
        return this.d_type === rhs.d_type &&
            this.d_originalHead.equal(rhs.d_originalHead) &&
            this.d_target.equal(rhs.d_target) &&
            deeper(this.d_commits, rhs.d_commits) &&
            this.d_currentCommit === rhs.d_currentCommit &&
            this.d_message === rhs.d_message;
    }

    /**
     * Return a new `SequencerState` object having the same value as this
     * object except where overriden by the fields in the optionally specified
     * `properties`.
     *
     * @param {Object}       [properties]
     * @param {String}       [type]
     * @param {CommitAndRef} [originalHead]
     * @param {CommitAndRef} [target]
     * @param {Number}       [currentCommit]
     * @param {[String]}     [commits]
     * @param {String|null}  [message]
     * @return {SequencerState}
     */
    copy(properties) {
        if (undefined === properties) {
            properties = {};
        } else {
            assert.isObject(properties);
        }
        return new SequencerState({
            type: ("type" in properties) ? properties.type : this.d_type,
            originalHead: ("originalHead" in properties) ?
                               properties.originalHead : this.d_originalHead,
            target: ("target" in properties) ?
                                  properties.target : this.d_target,
            currentCommit: ("currentCommit" in properties) ?
                               properties.currentCommit : this.d_currentCommit,
            commits: ("commits" in properties) ?
                                  properties.commits : this.d_commits,
            message: ("message" in properties) ?
                                  properties.message : this.d_message,
        });
    }

}

SequencerState.prototype.toString = function () {
    return `\
SequencerState(type=${this.d_type}, originalHead=${this.d_originalHead}, \
target=${this.d_target}, commits=${JSON.stringify(this.d_commits)}, \
currentCommit=${this.d_currentCommit}, msg=${this.d_message})`;
};

SequencerState.TYPE = TYPE;
SequencerState.CommitAndRef = CommitAndRef;

module.exports = SequencerState;
