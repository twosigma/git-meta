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

const assert = require("chai").assert;
const co     = require("co");
const fs     = require("fs-promise");
const path   = require("path");
const rimraf = require("rimraf");

const SequencerState = require("./sequencer_state");

const CommitAndRef = SequencerState.CommitAndRef;

/**
 * This module contains methods for accessing, reading, and rendering
 * `SequencerState` objects on disk.  The disk structure is (note, all files
 * are eol-terminated):
 * 
 * .git/meta_sequencer/TYPE            -- Single line containing the type, e.g.
 *                                        "REBASE".
 *                    /ORIGINAL_HEAD   -- SHA and optional ref name of what was
 *                                     -- on head.  The first line is the SHA.
 *                                        If there is one line, there is no
 *                                        ref name.  If there are two lines,
 *                                        the second is the ref name. 
 *                    /TARGET          -- SHA and optional ref name of the
 *                                     -- commit to rebase onto, merge, etc.
 *                                        The format is same as ORIGINAL_HEAD.
 *                    /COMMITS         -- List of commits to rebase,
 *                                        cherry-pick, etc., one per line.
 *                    /CURRENT_COMMIT  -- Single line containing the index of
 *                                        current commit in COMMITS to operate
 *                                        on. 
 *                   /MESSAGE          -- commit message file, if any
 */

const SEQUENCER_DIR = "meta_sequencer";
const TYPE_FILE = "TYPE";
const ORIGINAL_HEAD_FILE = "ORIGINAL_HEAD";
const TARGET_FILE = "TARGET";
const COMMITS_FILE = "COMMITS";
const CURRENT_COMMIT_FILE = "CURRENT_COMMIT";
const MESSAGE_FILE = "MESSAGE";

/**
 * Return the contents of the file in the sequencer directory from the
 * specified `gitDir` having the specified `name`, or null if the file cannot
 * be read.
 *
 * @param {String} gitDir
 * @param {String} name
 * @return {String|null}
 */
exports.readFile = co.wrap(function *(gitDir, name) {
    assert.isString(gitDir);
    assert.isString(name);
    const filePath = path.join(gitDir, SEQUENCER_DIR, name);
    try {
        return yield fs.readFile(filePath, "utf8");
    }
    catch (e) {
        return null;
    }
});

/**
 * Read the `CommitAndRef` object from the specified `fileName` in the
 * sequencer director in the specified `gitDir` if it exists, or null if it
 * does not.  The format 
 *
 * @param {String} gitDir
 * @param {String} fileName
 * @return {CommitAndRef|null}
 */
exports.readCommitAndRef = co.wrap(function *(gitDir, fileName) {
    assert.isString(gitDir);
    assert.isString(fileName);
    const content = yield exports.readFile(gitDir, fileName);
    if (null !== content) {
        const lines = content.split("\n");
        lines.pop();
        const numLines = lines.length; 
        if (1 === numLines || 2 === numLines) {
            const ref = 2 === numLines ? lines[1] : null;
            return new CommitAndRef(lines[0], ref);
        }
    }
    return null;
});

/**
 * Return the array of commit stored in the specified `gitDir`, or null if
 * the file is missing or malformed.
 *
 * @param {String} gitDir
 * @return {[String]|null}
 */
exports.readCommits = co.wrap(function *(gitDir) {
    assert.isString(gitDir);
    const content = yield exports.readFile(gitDir, COMMITS_FILE);
    if (null !== content) {
        const lines = content.split("\n");
        const nonEmpty = lines.filter(line => line.length > 0);
        if (0 !== nonEmpty.length) {
            return nonEmpty;
        }
    }
    return null;
});

/**
 * Return the index of the current commit stored in the specified `gitDir`, or
 * null if the file is missing, malformed, or the index is out-of-range.  It is
 * out-of-range if it is >= the specified `numCommits`, which is the size of
 * the array of commit operations stored in the sequencer in `gitDir`, e.g., if
 * there is 1 commit operation, the only valid index is 0.
 *
 * @param {String} gitDir
 * @param {Number} numCommits
 * @return {Number}
 */
exports.readCurrentCommit = co.wrap(function *(gitDir, numCommits) {
    assert.isString(gitDir);
    assert.isNumber(numCommits);
    const content = yield exports.readFile(gitDir, CURRENT_COMMIT_FILE);
    if (null !== content) {
        const lines = content.split("\n");
        if (0 !== lines.length) {
            const index = Number.parseInt(lines[0]);
            if (!Number.isNaN(index) && index < numCommits) {
                return index;
            }
        }
    }
    return null;
});

/**
 * Return the sequencer state if it exists in the specified `gitDir`, or null
 * if it is missing or malformed.
 * TODO: emit diagnostic when malformed?
 *
 * @param {String} gitDir
 * @return {SequencerState|null}
 */
exports.readSequencerState = co.wrap(function *(gitDir) {
    assert.isString(gitDir);

    const typeContent = yield exports.readFile(gitDir, TYPE_FILE);
    if (null === typeContent) {
        return null;                                                  // RETURN
    }
    const typeLines = typeContent.split("\n");
    if (2 !== typeLines.length) {
        return null;                                                  // RETURN
    }
    const type = typeLines[0];
    if (!(type in SequencerState.TYPE)) {
        return null;                                                  // RETURN
    }
    const original = yield exports.readCommitAndRef(gitDir,
                                                    ORIGINAL_HEAD_FILE);
    if (null === original) {
        return null;                                                  // RETURN
    }
    const target = yield exports.readCommitAndRef(gitDir, TARGET_FILE);
    if (null === target) {
        return null;                                                  // RETURN
    }
    const commits = yield exports.readCommits(gitDir);
    if (null === commits) {
        return null;                                                  // RETURN
    }
    const currentCommit = yield exports.readCurrentCommit(gitDir,
                                                          commits.length);
    if (null === currentCommit) {
        return null;                                                  // RETURN
    }
    const message = yield exports.readFile(gitDir, MESSAGE_FILE);
    return new SequencerState({
        type: type,
        originalHead: original,
        target: target,
        commits: commits,
        currentCommit: currentCommit,
        message: message,
    });
});

/**
 * Remote the sequencer directory and all its content in the specified
 * `gitDir`, or do nothing if this directory doesn't exist.
 *
 * @param {String} gitDir
 */
exports.cleanSequencerState = co.wrap(function *(gitDir) {
    assert.isString(gitDir);
    const root = path.join(gitDir, SEQUENCER_DIR);
    const promise = new Promise(callback => {
        return rimraf(root, {}, callback);
    });
    yield promise;
});

const writeCommitAndRef = co.wrap(function *(dir, name, commitAndRef) {
    const filePath = path.join(dir, name);
    let content = commitAndRef.sha + "\n";
    if (null !== commitAndRef.ref) {
        content += commitAndRef.ref + "\n";
    }
    yield fs.writeFile(filePath, content);
});

/**
 * Clear out any existing sequencer and write the specified `state` to the
 * specified `gitDir`.
 *
 * @param {String}         gitDir
 * @param {SequencerState} state
 */
exports.writeSequencerState = co.wrap(function *(gitDir, state) {
    assert.isString(gitDir);
    assert.instanceOf(state, SequencerState);

    yield exports.cleanSequencerState(gitDir);
    const root = path.join(gitDir, SEQUENCER_DIR);
    yield fs.mkdir(root);
    yield fs.writeFile(path.join(root, TYPE_FILE), state.type + "\n");
    yield writeCommitAndRef(root, ORIGINAL_HEAD_FILE, state.originalHead);
    yield writeCommitAndRef(root, TARGET_FILE, state.target);
    const commitsContent = state.commits.join("\n");
    yield fs.writeFile(path.join(root, COMMITS_FILE), commitsContent);
    yield fs.writeFile(path.join(root, CURRENT_COMMIT_FILE),
                       "" + state.currentCommit);
    if (null !== state.message) {
        yield fs.writeFile(path.join(root, MESSAGE_FILE), state.message);
    }
});

/**
 * Return a new `SequencerState` object having the same value as the specified
 * `sequencer`, but with each commit sha it contains replaced with the value it
 * mapts to in the specified `commitMap`.  The behavior is undefined unless
 * every commit sha is mapped.
 *
 * @param {SequencerState} sequencer
 * @param {Object}         commitMap     sha to sha
 * @return {Sequencer}
 */
exports.mapCommits = function (sequencer, commitMap) {
    assert.instanceOf(sequencer, SequencerState);
    assert.isObject(commitMap);

    function map(sha) {
        assert.property(commitMap, sha);
        return commitMap[sha];
    }

    function mapCommitAndRef(old) {
        return new CommitAndRef(map(old.sha), old.ref);
    }

    const newOriginal = mapCommitAndRef(sequencer.originalHead);
    const newTarget = mapCommitAndRef(sequencer.target);
    const newCommits = sequencer.commits.map(map);
    return new SequencerState({
        type: sequencer.type,
        originalHead: newOriginal,
        target: newTarget,
        currentCommit: sequencer.currentCommit,
        commits: newCommits,
        message: sequencer.message,
    });
};
