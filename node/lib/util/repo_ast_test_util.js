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
 * @module {RepoASTTestUtil}
 *
 * This module provides utility functions for test drivers using `RepoAST`
 * objects.
 */

const assert  = require("chai").assert;
const co      = require("co");
const NodeGit = require("nodegit");

const ReadRepoASTUtil     = require("../../lib/util/read_repo_ast_util");
const RepoAST             = require("../../lib/util/repo_ast");
const RepoASTUtil         = require("../../lib/util/repo_ast_util");
const ShorthandParserUtil = require("../../lib/util/shorthand_parser_util");
const TestUtil            = require("../../lib/util/test_util");
const UserError           = require("../../lib/util/user_error");
const WriteRepoASTUtil    = require("../../lib/util/write_repo_ast_util");

                         // Begin module-local methods

/**
 * Translate the specified `input` into a map from repo name to `RepoAST`.
 * `input` may be either a string to be parsed by
 * `ShorthandParserUtil.parseMultiRepoShorthand` or a map from repo name to
 * either a `RepoAST` object or a string to be parsed by
 * `ShorthandParserUtil.parseRepoShorthand`.  Pass the specified
 * `expectedRepos` to `parseMultiRepoShorthand`, if provided.
 *
 * @private
 * @param {String|Object} input
 * @param {Object}        [expectedRepos]
 * @return {Object} map from name to `RepoAST`
 */
function createMultiRepoASTMap(input, expectedRepos) {
    if ("string" === typeof input) {
        return ShorthandParserUtil.parseMultiRepoShorthand(input,
                                                           expectedRepos);
    }
    assert.isObject(input);
    let result = {};
    for (let repoName in input) {
        let repoDef = input[repoName];
        if ("string" === typeof repoDef) {
            repoDef = ShorthandParserUtil.parseRepoShorthand(repoDef);
        }
        else {
            assert.instanceOf(repoDef, RepoAST);
        }
        result[repoName] = repoDef;
    }
    return result;
}

                          // End module-local methods

/**
 * Return the repository an object maps as returned by
 * `WriteRepoASTUtil.writeRAST` as described by the specified `input`.  The
 * value of `input` may be a string parseable by
 * `ShorthandParserUtil.parseRepoShorthand`, or a `RepoAST` object.
 */
exports.createRepo = co.wrap(function *(input) {
    let ast;
    if ("string" === typeof input) {
        ast = ShorthandParserUtil.parseRepoShorthand(input);
    }
    else {
        assert.instanceOf(input, RepoAST);
        ast = input;
    }
    const path = yield TestUtil.makeTempDir();
    return yield WriteRepoASTUtil.writeRAST(ast, path);
});

/**
 * Create a repository described by the specified `input`, apply the specified
 * `manipulator` to it, then verify that it has the state described by the
 * specified `expected`.  The `manipulator` must return a map from IDs
 * in the repository to those described in `expectedShorthand`, or
 * `undefined` if no such mapping is required.  Both `input` and `expected` may
 * be either a string in the syntax accepted by `parseRepoShorthand` or a
 * `RepoAST` object.
 *
 * @param {String|RepoAST}  input
 * @param {String|RepoAST}  expectedShorthand
 * @param {(NodeGit.Repository, commitMap, oldMap) => Promise} manipulator
 */
exports.testRepoManipulator = co.wrap(function *(input,
                                                 expected,
                                                 manipulator) {
    if (!(expected instanceof RepoAST)) {
        assert.isString(expected);
        expected = ShorthandParserUtil.parseRepoShorthand(expected);
    }
    const written = yield exports.createRepo(input);
    const repo = written.repo;
    const userMap = yield manipulator(repo,
                                      written.commitMap,
                                      written.oldCommitMap);
    if (undefined !== userMap) {
        Object.assign(written.commitMap, userMap);
    }
    const ast = yield ReadRepoASTUtil.readRAST(repo);
    const actual = RepoASTUtil.mapCommitsAndUrls(ast, written.commitMap, {});
    RepoASTUtil.assertEqualASTs(actual, expected);
});

/**
 * Return the repository an objects and mappings returned by
 * `WriteRepoASTUtil.writeMultiRAST` as described by the specified `input` map.
 * The values of `input` may be strings parseable by
 * `ShorthandParserUtil.parseRepoShorthand`, or `RepoAST` objects, or any mix
 * of the two.
 */
exports.createMultiRepos = co.wrap(function *(input) {
    const inputASTs = createMultiRepoASTMap(input);
    const root = yield TestUtil.makeTempDir();
    return yield WriteRepoASTUtil.writeMultiRAST(inputASTs, root);
});

/**
 * Create the repositories described by the specified `input`, apply the
 * specified `manipulator` to them, then verify that the repositories are in
 * the specified `expected` state.  If the specified `shouldFail` is true, then
 * the behavior is undefined unless `manipulator` fails with a `UserError`
 * exception.  Note that `expected` will still be checked on failure. A few
 * notes about some of the arguments:
 *
 * - `input` -- may be either a string that will be parsed by
 *   `ShorthandParserUtil.parseMultiRepoShorthand` or a map from repo name to
 *   either a string to be parsed by `ShorthandParserUtil.parseRepoShorthand`.
 * - `expected` -- has the same structural options as `input`.  Additionally,
 *   `expected` may describe new repositories that did not exist in the
 *   original input.  If a repo is omitted from `expected`, it is assumed to be
 *   required to be in its original state.  If `undefined === expected` it is
 *   as if the user passed `{}`.
 * - If multi-repo syntax is used in the shorthand, repositories may use the
 *   `E` base type to reference their `input` states.
 * - `manipulator` -- Is passed a map from repo name to repo, and a second
 *   argument containing a commit map and a url map.  It may return an
 *   object containing:
 *      - `commitMap`  -- specifying actual to logical mappings for new commits
 *      - `reverseCommitMap` -- reverse of `commitMap` -- logical to actual
 *      - `urlMap`     -- specifying repo name to path for new repos.  Note
 *                        that this is the opposite format returned by
 *                        `writeRAST` and expected by `mapCommitsAndUrls`.
 *      - `reverseUrlMap` -- reverse of `urlMap` -- logical to actual
 *   If it returns `undefined` then it is assumed no mapping is necessary.  The
 *   behvior is undefined if either map contains entries for commits or urls
 *   that already existed in the original map.
 * - If `options.expectedTransformer` is provided, the map of expected ASTs,
 *   along with an object containing mapping information will be passed to it
 *   with the expectation that it will return a (potentially changed) expected
 *   map.  This facility is provided to allow for cases where some aspect of a
 *   repository state may be dependent on mapping information, such as if a
 *   commit ID is embedded in a ref name.
 * - If `options.actualTransformer` is provided, the map of expected ASTs,
 *   along with an object containing mapping information will be passed to it
 *   with the expectation that it will return a (potentially changed) actual
 *   map.  This facility is provided to allow for cases where some aspect of a
 *   repository state may be dependent on mapping information, such as if a
 *   commit ID is embedded in a ref name.  For example, if a reference name
 *   will contain a sha, this option allows one to transform that reference
 *   name into one where the physical sha is replaced by the logical sha, e.g.:
 *   'refs/commits/aaaaafffffffff' can be changed to: 'refs/commits/1'.
 *
 * TODO: We should change this so that manipulators are given object/url maps
 * to manipulate in-place so that mappings may be recorded even if errors are
 * throwsn.
 *
 * @async
 * @param {String|Object}        input
 * @param {String|Object}        [expected]
 * @param {(repoMap, { commitMap, urlMap}) => Promise} manipulator
 * @param {Boolean|undefined}    shouldFail
 * @param {Object}               [options]
 * @param {Function}             [options.expectedTransformer]
 * @param {Object}               options.expectedTransformer.expected
 * @param {Object}               options.expectedTransformer.mapping
 * @param {Object}               options.expectedTransformer.mapping.commitMap
 * @param {Object}               options.expectedTransformer.mapping.urlMap
 * @param {Object}         options.expectedTransformer.mapping.reverseCommitMap
 * @param {Object}         options.expectedTransformer.mapping.reverseUrlMap
 * @param {Object}               options.expectedTransformer.return
 * @param {Boolean}              options.ignoreRefsCommits
 */
exports.testMultiRepoManipulator =
        co.wrap(function *(input, expected, manipulator, shouldFail, options) {
    if (undefined !== shouldFail) {
        assert.isBoolean(shouldFail);
    }
    else {
        shouldFail = false;
    }
    if (undefined === expected) {
        expected = {};
    }
    if (undefined === options) {
        options = {};
    }
    else {
        assert.isObject(options);
    }
    if (!("expectedTransformer" in options)) {
        options.expectedTransformer = (expected) => expected;
    }
    else {
        assert.isFunction(options.expectedTransformer);
    }
    if (!("actualTransformer" in options)) {
        options.actualTransformer = (actual) => actual;
    }
    else {
        assert.isFunction(options.actualTransformer);
    }
    const includeRefsCommits = options.includeRefsCommits || false;
    const inputASTs = createMultiRepoASTMap(input);

    // Write the repos in their initial states.

    const root = yield TestUtil.makeTempDir();
    const written = yield WriteRepoASTUtil.writeMultiRAST(inputASTs, root);
    const inputRepos = written.repos;
    const commitMap = written.commitMap;
    const urlMap    = written.urlMap;
    const mappings = {
        commitMap: commitMap,
        reverseCommitMap: written.reverseCommitMap,
        urlMap: urlMap,
        reverseUrlMap: written.reverseUrlMap,
    };

    // Pass the repos off to the manipulator.

    let manipulated;
    let failed = false;
    try {
        manipulated = yield manipulator(inputRepos, mappings);
    }
    catch (e) {
        if (!shouldFail) {
            throw e;
        }
        if (!(e instanceof UserError)) {
            throw e;
        }
        failed = true;
    }

    assert.equal(shouldFail, failed);

    // Copy over and verify (that they are not duplicates) remapped commits and
    // urls output by the manipulator.
    let manipulatorRemap = {};

    if (undefined !== manipulated) {
        if ("commitMap" in manipulated) {
            manipulatorRemap = manipulated.commitMap;
            assert.isObject(manipulated.commitMap,
                            "manipulator must return object");
            for (let commit in manipulated.commitMap) {
                assert.notProperty(
                              commitMap,
                              commit,
                             `commit already mapped to ${commitMap[commit]}.`);
                const newVal = manipulatorRemap[commit];
                commitMap[commit] = newVal;
                mappings.reverseCommitMap[newVal] = commit;
            }
        }
        if ("urlMap" in manipulated) {
            assert.isObject(manipulated.urlMap);
            for (let name in manipulated.urlMap) {
                const url = manipulated.urlMap[name];
                assert.notProperty(urlMap, url);
                urlMap[url] = name;
            }
        }
    }

    // Set up the expected ASTs.

    let expectedASTs = createMultiRepoASTMap(expected, inputASTs);

    // Add initial value of AST for those not specified in `expected`.

    for (let repoName in inputASTs) {
        if (!(repoName in expectedASTs)) {
            expectedASTs[repoName] = inputASTs[repoName];
        }
    }

    // Allow a transformer a chance to apply mappings to the expected ASTs.

    expectedASTs = options.expectedTransformer(expectedASTs, mappings);

    // Read in the states of the repos.

    const seen = new Set();
    function rememberCommit(sha) { seen.add(sha); }

    let actualASTs = {};
    for (let repoName in expectedASTs) {
        let repo;

        // Load the repo if not loaded earlier.

        if (repoName in inputRepos) {
            repo = inputRepos[repoName];
        }
        else {
            assert.property(manipulated.urlMap, repoName);
            const path = manipulated.urlMap[repoName];
            repo = yield NodeGit.Repository.open(path);
        }
        const newAST = yield ReadRepoASTUtil.readRAST(repo, includeRefsCommits);
        const commits = RepoASTUtil.listCommits(newAST);
        Object.keys(commits).forEach(rememberCommit);
        actualASTs[repoName] = RepoASTUtil.mapCommitsAndUrls(newAST,
                                                             commitMap,
                                                             urlMap);
    }

    // Make sure we didn't get garbage in the remap set.

    for (let sha in manipulatorRemap) {
        assert(seen.has(sha),
               `Remap for unseen commit ${sha} to ${manipulatorRemap[sha]}`);
    }

    // Allow mapping of actual ASTs.

    actualASTs = options.actualTransformer(actualASTs, mappings);

    RepoASTUtil.assertEqualRepoMaps(actualASTs, expectedASTs);
});

function addNewCommit(result, commitMap, newCommit, oldCommit, suffix) {
    assert.property(commitMap, oldCommit);
    const oldLogicalCommit = commitMap[oldCommit];
    result[newCommit] = oldLogicalCommit + suffix;
}

/**
 * Populate the specified `result` with translation of the specified `commits`
 * using the specified `commitMap` such that each sha becomes ${logical
 * sha}${suffix}.
 *
 * @param {Object} result    output, new physical to new logical sha
 * @param {Object} commits   from new physical to old physical sha
 * @param {Object} commitMap from old physical to old logical sha
 * @param {String} suffix
 */
exports.mapCommits = function (result, commits, commitMap, suffix) {
    assert.isObject(result);
    assert.isObject(commits);
    assert.isObject(commitMap);
    assert.isString(suffix);

    Object.keys(commits).forEach(newCommit => {
        addNewCommit(result, commitMap, newCommit, commits[newCommit], suffix);
    });
};

/**
 * Populate the specified `result` with translations of the specified
 * `subCommits` based on the specified `commitMap` such that each submodule
 * commit becomes ${logical id}${sub name}.
 *
 * @param {Object} result      output, new physical to new logical sha
 * @param {Object} subCommits  from sub name to map from new to old sha
 * @param {Object} commitMap   from  old physical to old logical sha
 */
exports.mapSubCommits = function (result, subCommits, commitMap) {
    assert.isObject(result);
    assert.isObject(subCommits);
    assert.isObject(commitMap);

    Object.keys(subCommits).forEach(subName => {
        const commits = subCommits[subName];
        exports.mapCommits(result, commits, commitMap, subName);
    });
};
