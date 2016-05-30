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
        result.push(`missing change to ${colorBad(path)}`);
    }
    function missingExpected(path) {
        result.push(
          `unexpected change to ${colorBad(path)}: ${colorBad(actual[path])}`);
    }
    function compare(path) {
        const actualChange = actual[path];
        const expectedChange = expected[path];
        let different = actualChange !== expectedChange;
        if (different &&
            actualChange instanceof RepoAST.Submodule &&
            expectedChange instanceof RepoAST.Submodule) {
            different = actualChange.url !== expectedChange.url ||
                actualChange.sha !== expectedChange.sha;
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
 * Return an array of  description of the difference between the specified
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
    return result;
}

/**
 * Return an array of  description of the difference between the specified
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
        result.push(`missing branch ${colorBad(branch)}`);
    }
    function missingExpected(branch) {
        result.push(`unexpected branch ${colorBad(branch)}`);
    }
    function compare(branch) {
        if (actual.branches[branch] !== expected.branches[branch]) {
            result.push(`\
for branch ${colorBad(branch)} expected \
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
    const indent = "".repeat(4);

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
            diffs.forEach(diff => {
                result.push(indent + diff);
            });
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
            diffs.forEach(diff => {
                result.push(indent + diff);
            });
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
        if (actualBranch !== expectedBranch) {
            result.push(`\
branch ${colorBad(branch)} is ${colorAct(actualBranch)} but expected \
${colorExp(expectedBranch)}`
                       );
        }
    }
    diffObjects(actual.branches,
                expected.branches,
                missingActualBranch,
                missingExpectedBranch,
                compareBranches);

    // Then the HEAD

    if (actual.head !== expected.head) {
        result.push(`\
HEAD is ${colorAct(actual.head)} but expected ${colorExp(expected.head)}`
                   );
    }

    // Next, the current branch name

    if (actual.currentBranchName !== expected.currentBranchName) {
        result.push(`
current branch is ${colorAct(actual.currentBranchName)} but expected \
${colorExp(expected.currentBranchName)}`
                   );
    }

    // Then, check the index.

    const indexChanges =
                      result.concat(diffChanges(actual.index, expected.index));
    if (0 !== indexChanges.length) {
        result.push(`In ${colorBad("index")}`);
        indexChanges.forEach(diff => {
            result.push(indent + diff);
        });
    }

    // Finaly, check the workding directory.

    const workdirChanges =
                  result.concat(diffChanges(actual.workdir, expected.workdir));
    if (0 !== workdirChanges.length) {
        result.push(`In ${colorBad("workdir")}`);
        workdirChanges.forEach(diff => {
            result.push(indent + diff);
        });
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
    const indent = "".repeat(4);

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
            diffs.forEach(diff => {
                result.push(indent + diff);
            });
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
 * from the maps are kept as-is.
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
        if (commitId in commitMap) {
            return commitMap[commitId];
        }
        return commitId;
    }

    function mapSubmodule(submodule) {
        let url = submodule.url;
        if (url in urlMap) {
            url = urlMap[url];
        }
        let sha = submodule.sha;
        if (sha in commitMap) {
            sha = commitMap[sha];
        }
        return new RepoAST.Submodule(url, sha);
    }

    function mapChanges(input) {
        let changes = {};
        for (let path in input) {
            let change = input[path];
            if (change instanceof RepoAST.Submodule) {
                change = mapSubmodule(change);
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
        });
    }

    // Copy and transform commit map.  Have to transform the key (commit id)
    // and the commits themselves which also contain commit ids.

    let commits = {};
    for (let commitId in ast.commits) {
        commits[mapCommitId(commitId)] = mapCommit(ast.commits[commitId]);
    }

    // Then branches -- they're strings that map to commit ids.

    let branches = {};
    for (let branchName in ast.branches) {
        branches[branchName] = mapCommitId(ast.branches[branchName]);
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

    // Then the head

    let head = null;
    if (ast.head) {
        head = mapCommitId(ast.head);
    }

    return ast.copy({
        commits: commits,
        branches: branches,
        head: head,
        currentBranchName: ast.currentBranchName,
        remotes: remotes,
        index: mapChanges(ast.index),
        workdir: mapChanges(ast.workdir),
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
        const commitId = originalBranches[name];
        addCommit(commitId);
        remoteBranches[name] = commitId;
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
        const defaultBranchCommit = originalBranches[originalBranch];
        branches[originalBranch] = defaultBranchCommit;
        if (null === head) {
            head = defaultBranchCommit;
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
        currentBranchName: original.currentBranchName,
    });
};
