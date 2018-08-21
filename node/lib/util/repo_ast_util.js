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
 * This module provides utilities for manipulating `RepoAST` objects.
 *
 */

const assert   = require("chai").assert;
const colors   = require("colors");
const deeper   = require("deeper");

const RepoAST  = require("../util/repo_ast");
const TextUtil  = require("../util/text_util");

const Sequencer = RepoAST.SequencerState;
const CommitAndRef = Sequencer.CommitAndRef;

                         // Begin module-local methods

/**
 * Check for differences in the specified `first` and `second` objects.  Call
 * the specified `missingFirst` function for each key present in `second` but
 * not in first, the specified `missingSecond` function for each key present in
 * `first` but not in `second`, and `compare` for each key present in both.
 *
 * @private
 * @param {Object} first
 * @param {Object} second
 * @param {Function} missingFirst
 * @param {Function} missingSecond
 * @param {Function} compare
 */
function diffObjects(first,
                     second,
                     missingFirst,
                     missingSecond,
                     compare) {
    assert.isObject(first);
    assert.isObject(second);
    assert.isFunction(missingFirst);
    assert.isFunction(missingSecond);
    assert.isFunction(compare);
    for (let k in second) {
        if (!(k in first)) {
            missingFirst(k);
        }
    }
    for (let k in first) {
        if (!(k in second)) {
            missingSecond(k);
        }
    }
    for (let k in first) {
        if (k in second) {
            compare(k);
        }
    }
}

/**
 * Return formatted (colored) version of the specified `text` appropriate for
 * expected values.
 *
 * @private
 * @param {String} text
 * @return {String}
 */
function colorExp(text) {
    return colors.green(text);
}

/**
 * Return formatted (colored) version of the specified `text` appropriate for
 * actual values.
 *
 * @private
 * @param {String} text
 * @return {String}
 */
function colorAct(text) {
    return colors.yellow(text);
}

/**
 * Return formatted (colored) version of the specified `text` appropriate for
 * name of an unexpected item.
 *
 * @private
 * @param {String} text
 * @return {String}
 */
function colorBad(text) {
    return colors.magenta(text);
}

function diffChanges(actual, expected) {
    let result = [];
    function missingActual(path) {
        result.push(`missing change to ${colorBad(path)}: ${expected[path]}`);
    }
    function missingExpected(path) {
        result.push(
          `unexpected change to ${colorBad(path)}: ${colorBad(actual[path])}`);
    }
    function compare(path) {
        const actualChange = actual[path];
        const expectedChange = expected[path];
        let different;
        if (actualChange instanceof RepoAST.File &&
            expectedChange instanceof RepoAST.File) {
            if (expectedChange.contents.startsWith("^")) {
                const exp = expectedChange.contents.substr(1);
                const matcher = new RegExp(exp);
                const match = matcher.exec(actualChange.contents);
                different = null === match ||
                    actualChange.isExecutable !== expectedChange.isExecutable;
            } else {
                different = !actualChange.equal(expectedChange);
            }
        } else if (actualChange instanceof RepoAST.Submodule &&
                   expectedChange instanceof RepoAST.Submodule) {
            different = !actualChange.equal(expectedChange);
        } else if (actualChange instanceof RepoAST.Conflict &&
                   expectedChange instanceof RepoAST.Conflict) {
            different = !actualChange.equal(expectedChange);
        } else {
            different = actualChange !== null || expectedChange !== null;
        }
        if (different) {
            result.push(`\
for path ${colorBad(path)} expected ${colorExp(expectedChange)} but \
got ${colorAct(actualChange)}`
                       );
        }
    }
    diffObjects(actual, expected, missingActual, missingExpected, compare);
    return result;
}

/**
 * Return an array of description of the difference between the specified
 * `actual` and `expected` `Commit` objects; if there are no differences, the
 * array will be empty.
 *
 * @private
 * @param {RepoAST.Commit} actual
 * @param {RepoAST.Commit} expected
 * @return {String[]}
 */
function diffCommits(actual, expected) {
    let result = [];
    if (!deeper(actual.parents, expected.parents)) {
        result.push(`\
expected parents to be ${colorExp(expected.parents)} but got \
${colorAct(actual.parents)}`
                   );
    }
    result = result.concat(diffChanges(actual.changes, expected.changes));
    if (actual.message !== expected.message && "*" !== expected.message) {
        result.push(`
Expected message to be ${colorExp(expected.message)} but it is \
${colorAct(actual.message)}.`
                   );
    }
    return result;
}

/**
 * Return an array of descriptions of the difference between the specified
 * `actual` and `expected` `Remote` objects; if there are no differences, the
 * array will be empty.
 *
 * @private
 * @param {RepoAST.Remote} actual
 * @param {RepoAST.Remote} expected
 * @return {String[]}
 */
function diffRemotes(actual, expected) {
    let result = [];
    if (actual.url !== expected.url) {
        result.push(`
expected url to be ${colorExp(expected.url)} but got ${colorAct(actual.url)}`
                   );
    }
    function missingActual(branch) {
        result.push(`missing remote branch ${colorBad(branch)}`);
    }
    function missingExpected(branch) {
        result.push(`unexpected remote branch ${colorBad(branch)}`);
    }
    function compare(branch) {
        if (actual.branches[branch] !== expected.branches[branch]) {
            result.push(`\
for remote branch ${colorBad(branch)} expected \
${colorExp(expected.branches[branch])} but got \
${colorAct(actual.branches[branch])}`
                       );
        }
    }
    diffObjects(actual.branches,
                expected.branches,
                missingActual,
                missingExpected,
                compare);
    return result;
}

/**
 * Return a description of the difference between the specified `first` and
 * `second` `RepoAST` objects, or null if they have the same value.
 *
 * @param {RepoAST} first
 * @param {RepoAST} second
 * @return {String[]}
 */
function diffASTs(actual, expected) {
    let result = [];

    // First, check the commits

    function missingActualCommit(id) {
        result.push(`missing commit ${colorBad(id)}`);
    }
    function missingExpectedCommit(id) {
        result.push(`unexpected commit ${colorBad(id)}`);
    }
    function compareCommits(id) {
        const diffs = diffCommits(actual.commits[id], expected.commits[id]);
        if (0 !== diffs.length) {
            result.push(`for commit ${colorBad(id)}`);
            result.push(...diffs.map((d) => TextUtil.indent(d)));
        }
    }
    diffObjects(actual.commits,
                expected.commits,
                missingActualCommit,
                missingExpectedCommit,
                compareCommits);

    // Then remotes

    function missingActualRemote(remote) {
        result.push(`missing remote ${colorBad(remote)}`);
    }
    function missingExpectedRemote(remote) {
        result.push(`unexpected remote ${colorBad(remote)}`);
    }
    function compareRemotes(remote) {
        const diffs = diffRemotes(actual.remotes[remote],
                                  expected.remotes[remote]);
        if (0 !== diffs.length) {
            result.push(`for remote ${colorBad(remote)}`);
            result.push(...diffs.map((d) => TextUtil.indent(d)));
        }
    }
    diffObjects(actual.remotes,
                expected.remotes,
                missingActualRemote,
                missingExpectedRemote,
                compareRemotes);

    // Then check branches

    function missingActualBranch(branch) {
        result.push(`missing branch ${colorBad(branch)}`);
    }
    function missingExpectedBranch(branch) {
        result.push(`unexpected branch ${colorBad(branch)}`);
    }
    function compareBranches(branch) {
        const actualBranch = actual.branches[branch];
        const expectedBranch = expected.branches[branch];
        if (!deeper(actualBranch, expectedBranch)) {
            result.push(`\
branch ${colorBad(branch)} is ${colorAct(JSON.stringify(actualBranch))} but \
expected ${colorExp(JSON.stringify(expectedBranch))}`
                       );
        }
    }
    diffObjects(actual.branches,
                expected.branches,
                missingActualBranch,
                missingExpectedBranch,
                compareBranches);

    // Then check refs

    function missingActualRef(ref) {
        result.push(`missing ref ${colorBad(ref)}`);
    }
    function missingExpectedRef(ref) {
        result.push(`unexpected ref ${colorBad(ref)}`);
    }
    function compareRefs(ref) {
        const actualRef = actual.refs[ref];
        const expectedRef = expected.refs[ref];
        if (actualRef !== expectedRef) {
            result.push(`\
ref ${colorBad(ref)} is ${colorAct(actualRef)} but expected \
${colorExp(expectedRef)}`
                       );
        }
    }
    diffObjects(actual.refs,
                expected.refs,
                missingActualRef,
                missingExpectedRef,
                compareRefs);

    // Then the notes

    function missingActualNote(ref) {
            result.push(`missing notes ref ${colorBad(ref)}`);
    }
    function missingExpectedNote(ref) {
            result.push(`unexpected notes ref ${colorBad(ref)}`);
    }
    function compareNotes(ref) {
        const actualNotes = actual.notes[ref];
        const expectedNotes = expected.notes[ref];
        for (let commit in expectedNotes) {
            const actualMessage = actualNotes[commit];
            const expectedMessage = expectedNotes[commit];
            if (!actualMessage && expectedMessage) {
                result.push(`\
missing note for commit ${colorBad(commit)} in ref ${colorBad(ref)}: \
${expectedMessage}`
                           );
            }
        }
        for (let commit in actualNotes) {
            const actualMessage = actualNotes[commit];
            const expectedMessage = expectedNotes[commit];
            if (!actualMessage && expectedMessage) {
                result.push(`\
missing note for commit ${colorBad(commit)} in ref ${colorBad(ref)}: \
${expectedMessage}`
                           );
            }
            else if (actualMessage && !expectedMessage) {
                result.push(`\
unexpected note for commit ${colorBad(commit)} in ref ${colorBad(ref)}: \
${colorExp(actualMessage)}`
                           );
            }
            else if (actualMessage !== expectedMessage) {
                result.push(`\
wrong note for commit ${colorBad(commit)} in ref ${colorBad(ref)}: \
expected ${colorExp(expectedMessage)}, got ${colorBad(actualMessage)}`
                           );
            }
        }
    }

    diffObjects(actual.notes,
                expected.notes,
                missingActualNote,
                missingExpectedNote,
                compareNotes);

    // Then the HEAD

    if (actual.head !== expected.head) {
        result.push(`\
HEAD is ${colorAct(actual.head)} but expected ${colorExp(expected.head)}`
                   );
    }

    // Check bare

    if (actual.bare !== expected.bare) {
        if (expected.bare) {
            result.push(`Expected repository to be bare.`);
        }
        else {
            result.push(`Expected repository not to be bare.`);
        }
    }

    // Next, the current branch name

    if (actual.currentBranchName !== expected.currentBranchName) {
        result.push(`
current branch is ${colorAct(actual.currentBranchName)} but expected \
${colorExp(expected.currentBranchName)}`
                   );
    }

    // Then, check the index.

    const indexChanges = diffChanges(actual.index, expected.index);
    if (0 !== indexChanges.length) {
        result.push(`In ${colorBad("index")}`);
        result.push(...indexChanges.map((d) => TextUtil.indent(d)));
    }

    // Then, check the working directory.

    const workdirChanges = diffChanges(actual.workdir, expected.workdir);
    if (0 !== workdirChanges.length) {
        result.push(`In ${colorBad("workdir")}`);
        result.push(...workdirChanges.map((d) => TextUtil.indent(d)));
    }

    // Check open submodules

    function missingActualOpenSubmodule(name) {
        result.push(`missing open submodule ${colorBad(name)}`);
    }
    function missingExpectedOpenSubmodule(name) {
        result.push(`unexpected open submodule ${colorBad(name)}`);
    }
    function compareOpenSubmodules(name) {
        const diffs = diffASTs(actual.openSubmodules[name],
                               expected.openSubmodules[name]);
        if (0 !== diffs.length) {
            result.push(`for open submodule ${colorBad(name)}`);
            result.push(...diffs.map((d) => TextUtil.indent(d)));
        }
    }
    diffObjects(actual.openSubmodules,
                expected.openSubmodules,
                missingActualOpenSubmodule,
                missingExpectedOpenSubmodule,
                compareOpenSubmodules);

    // Check rebases

    if (null === actual.rebase && null !== expected.rebase) {
        result.push("Missing rebase.");
    }
    else if (null !== actual.rebase && null === expected.rebase) {
        result.push("Unexpected rebase.");
    }
    else if (null !== actual.rebase) {
        if (actual.rebase.headName !== expected.rebase.headName) {
            result.push(`Expected ${colorBad("rebase head name")} to be \
${colorExp(expected.rebase.headName)} but got \
${colorAct(actual.rebase.headName)}.`);
        }
        if (actual.rebase.originalHead !== expected.rebase.originalHead) {
            result.push(`Expected ${colorBad("rebase original head")} to be \
${colorExp(expected.rebase.originalHead)} but got \
${colorAct(actual.rebase.originalHead)}.`);
        }
        if (actual.rebase.onto !== expected.rebase.onto) {
            result.push(`Expected ${colorBad("rebase onto")} to be \
${colorExp(expected.rebase.onto)} but got ${colorAct(actual.rebase.onto)}.`);
        }
    }

    // Check sequencer

    if (null === actual.sequencerState && null !== expected.sequencerState) {
        result.push("Missing sequencer.");
    }
    else if (null !== actual.sequencerState &&
                                            null === expected.sequencerState) {
        result.push("Unexpected sequencer.");
    }
    else if (null !== actual.sequencerState &&
                       !actual.sequencerState.equal(expected.sequencerState)) {
       result.push(`\
Expected sequencer to be ${actual.sequencerState} but got \
${expected.sequencerState}`);
    }

    // Check sparse

    if (actual.sparse !== expected.sparse) {
        if (expected.sparse) {
            result.push(`Expected repository to be sparse.`);
        }
        else {
            result.push(`Expected repository not to be sparse.`);
        }
    }

    return result;
}

                          // End modue-local methods

/**
 * Trigger an assertion unless the specified `actual` and `expected` objects
 * have the same value.  The specified `message`, if provided, will be included
 * in the message of any throw exceptions.
 *
 * @param {RepoAST.Commit} actual
 * @param {RepoAST.Commit} expected
 * @param {String}         [message]
 */
exports.assertEqualCommits = function (actual, expected, message) {
    assert.instanceOf(actual, RepoAST.Commit);
    assert.instanceOf(expected, RepoAST.Commit);
    if (undefined !== message) {
        assert.isString(message);
    }
    const diffs = diffCommits(actual, expected);
    if (0 !== diffs.length) {
        let text = (undefined !== message) ? (message + "\n") : "";
        text += diffs.join("\n");
        throw new Error(text);
    }
};

/**
 * Trigger an assertion unless the specified `first` and `second` `RepoAST`
 * objects have the same value.  If specified, `message` is included in the
 * message of any thrown exception.
 *
 * @param {RepoAST} first
 * @param {RepoAST} second
 * @param {String}  [message]
 */
exports.assertEqualASTs = function (first, second, message) {
    assert.instanceOf(first, RepoAST);
    assert.instanceOf(second, RepoAST);
    if (undefined !== message) {
        assert.isString(message);
    }
    const diffs = diffASTs(first, second);
    if (0 !== diffs.length) {
        let text = (undefined !== message) ? (message + "\n") : "";
        text += diffs.join("\n");
        throw new Error(text);
    }
};

/**
 * Trigger an assertion unless the specified `actual` and `expected` contain
 * the same repository maps.
 *
 * @param {Object} actual    from repo name to `RepoAST` object
 * @param {Object} expected  from repo name to `RepoAST` object
 */
exports.assertEqualRepoMaps = function (actual, expected, message) {
    assert.isObject(actual);
    assert.isObject(expected);
    if (undefined !== message) {
        assert.isString(message);
    }
    let result = [];

    // First, check the commits

    function missingActualRepo(name) {
        result.push(`missing repo ${colorBad(name)}`);
    }
    function missingExpectedRepo(name) {
        result.push(`unexpected repo ${colorBad(name)}`);
    }
    function compareRepos(name) {
        const actualRepo = actual[name];
        const expectedRepo = expected[name];
        const diffs = diffASTs(actualRepo, expectedRepo);
        if (0 !== diffs.length) {
            result.push(`for repo ${colorBad(name)}`);
            result.push(...diffs.map((d) => TextUtil.indent(d)));
        }
    }
    diffObjects(actual,
                expected,
                missingActualRepo,
                missingExpectedRepo,
                compareRepos);
    if (0 !== result.length) {
        let text = (undefined !== message) ? (message + "\n") : "";
        text += result.join("\n");
        throw new Error(text);
    }
};

/**
 * Return a new `RepoAST` object that has the same value as the specified `ast`
 * except that each commit ID is replaced with the value that it maps to in the
 * specified `commitMap`.  And each remote url that exists in the specified
 * `urlMap` is replaced by the value in that map.  URLs and commits missing
 * from the maps are kept as-is.  The behavior is undefined if any commits are
 * unmapped.
 *
 * @param {RepoAST} ast
 * @param {Object}  commitMap string to string
 * @param {Object}  urlMap    string to string
 * @return {RepoAST}
 */
exports.mapCommitsAndUrls = function (ast, commitMap, urlMap) {
    assert.instanceOf(ast, RepoAST);
    assert.isObject(commitMap);
    assert.isObject(urlMap);

    function mapCommitId(commitId) {
        assert.property(commitMap, commitId);
        return commitMap[commitId];
    }

    function mapSubmodule(submodule) {
        let url = submodule.url;
        if (url in urlMap) {
            url = urlMap[url];
        }
        let sha = submodule.sha;
        if (null !== sha) {
            sha = mapCommitId(sha);
        }
        return new RepoAST.Submodule(url, sha);
    }

    function mapData(data) {
        if (data instanceof RepoAST.Submodule) {
            return mapSubmodule(data);
        }
        return data;
    }

    function mapChanges(input) {
        let changes = {};
        for (let path in input) {
            let change = input[path];
            if (change instanceof RepoAST.Conflict) {
                change = new RepoAST.Conflict(mapData(change.ancestor),
                                              mapData(change.our),
                                              mapData(change.their));
            } else {
                change = mapData(change);
            }
            changes[path] = change;
        }
        return changes;
    }

    function mapCommit(commit) {
        assert.instanceOf(commit, RepoAST.Commit);
        const parents = commit.parents.map(mapCommitId);
        return new RepoAST.Commit({
            parents: parents,
            changes: mapChanges(commit.changes),
            message: commit.message,
        });
    }

    function mapCommitAndRef(car) {
        return new CommitAndRef(mapCommitId(car.sha), car.ref);
    }

    // Copy and transform commit map.  Have to transform the key (commit id)
    // and the commits themselves which also contain commit ids.

    let commits = {};
    for (let commitId in ast.commits) {
        commits[mapCommitId(commitId)] = mapCommit(ast.commits[commitId]);
    }

    let notes = {};
    for (let ref in ast.notes) {
        notes[ref] = {};
        for (let commitId in ast.notes[ref]) {
            notes[ref][mapCommitId(commitId)] = ast.notes[ref][commitId];
        }
    }

    // Then branches

    let branches = {};
    for (let branchName in ast.branches) {
        const oldBranch = ast.branches[branchName];
        const newId = mapCommitId(oldBranch.sha);
        branches[branchName] = new RepoAST.Branch(newId, oldBranch.tracking);
    }

    // Then refs -- they're strings that map to commit ids, like branches

    let refs = {};
    for (let refName in ast.refs) {
        refs[refName] = mapCommitId(ast.refs[refName]);
    }

    // Then remote branches.
    let remotes = {};
    for (let remoteName in ast.remotes) {
        const remote = ast.remotes[remoteName];
        let remoteBranches = {};
        for (let branchName in remote.branches) {
            remoteBranches[branchName] =
                                      mapCommitId(remote.branches[branchName]);
        }
        const url = urlMap[remote.url] || remote.url;
        remotes[remoteName] = new RepoAST.Remote(url, {
            branches: remoteBranches
        });
    }

    let openSubmodules = {};
    for (let name in ast.openSubmodules) {
        const smAST = ast.openSubmodules[name];
        openSubmodules[name] = exports.mapCommitsAndUrls(smAST,
                                                         commitMap,
                                                         urlMap);
    }

    // Then the head

    let head = null;
    if (ast.head) {
        head = mapCommitId(ast.head);
    }

    let rebase = ast.rebase;
    if (null !== rebase) {
        rebase = new RepoAST.Rebase(rebase.headName,
                                    mapCommitId(rebase.originalHead),
                                    mapCommitId(rebase.onto));
    }

    let sequencer = ast.sequencerState;
    if (null !== sequencer) {
        const original = mapCommitAndRef(sequencer.originalHead);
        const target = mapCommitAndRef(sequencer.target);
        const commits = sequencer.commits.map(mapCommitId);
        sequencer = new Sequencer({
            type: sequencer.type,
            originalHead: original,
            target: target,
            commits: commits,
            currentCommit: sequencer.currentCommit,
            message: sequencer.message,
        });
    }

    return ast.copy({
        commits: commits,
        branches: branches,
        refs: refs,
        head: head,
        currentBranchName: ast.currentBranchName,
        remotes: remotes,
        index: mapChanges(ast.index),
        notes: notes,
        workdir: mapChanges(ast.workdir),
        openSubmodules: openSubmodules,
        rebase: rebase,
        sequencerState: sequencer,
    });
};

/**
 * Return a new `RepoAST` object having the same value as a repository that is
 * a (non-bare) clone (i.e., via `git clone`) of a repository having the value
 * of the specified `original`.  Specifically, it has the following
 * characteristics:
 * - it has only one remote, named `origin`, set to the specified `url`
 * - that remote has as branches all the branches in `original` pointing to the
 *   same commits
 * - if `original` has a current branch, the clone has that branch as current
 *   as well
 * - if original has no current branch but does have a `head`, then the clone
 *   will have its head set to the same value and checkout out (detached)
 * - the clone has a clean index
 * - the clone has a clean working directory
 * - the clone has no open submodules
 * - non-branch refs are not copied
 *
 * @param {RepoAST} original
 * @param {String}  url
 * @return {RepoAST}
 */
exports.cloneRepo = function (original, url) {
    assert.instanceOf(original, RepoAST);
    assert.isString(url);

    const originalCommits = original.commits;

    let commits = {};
    let branches = {};
    let remoteBranches = {};

    function addCommit(id) {
        const commit = originalCommits[id];
        commits[id] = commit;
        commit.parents.forEach(addCommit);
    }

    // Copy branches to remotes, and add them to the set of (reachable)
    // commits.

    const originalBranches = original.branches;
    for (let name in originalBranches) {
        const branch = originalBranches[name];
        addCommit(branch.sha);
        remoteBranches[name] = branch.sha;
    }

    // Be sure to traverse the `head` if it's not null.

    if (null !== original.head) {
        addCommit(original.head);
    }

    // If there is a current branch, copy it into the `branches` map for the
    // clone.

    const originalBranch = original.currentBranchName;
    let head = original.head;
    if (null !== originalBranch) {
        const defaultBranch = originalBranches[originalBranch];
        branches[originalBranch] = new RepoAST.Branch(
                                                   defaultBranch.sha,
                                                   `origin/${originalBranch}`);
        if (null === head) {
            head = defaultBranch.sha;
        }
    }

    // May be a bare repo with a default branch.

    return new RepoAST({
        commits: commits,
        branches: branches,
        remoteBranches: remoteBranches,
        remotes: {
            origin: new RepoAST.Remote(url, {
                branches: remoteBranches
            })
        },
        head: head,
        notes: original.notes,
        currentBranchName: original.currentBranchName,
    });
};

/**
 * Return all commits in the specified  `repo`.
 * TODO: independent test
 *
 * @param {RepoAST} repo
 * @return {Object} sha to `RepoAST.Commit`
 */
exports.listCommits = function (repo) {
    assert.instanceOf(repo, RepoAST);
    const commits = repo.commits;

    // Also, commits from open submodules.

    for (let subName in repo.openSubmodules) {
        Object.assign(commits, repo.openSubmodules[subName].commits);
    }
    return commits;
};
