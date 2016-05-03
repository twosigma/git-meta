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

const assert      = require("chai").assert;
const RepoAST     = require("../util/repoast");
const RepoASTUtil  = require("../util/repoastutil");

/**
 * @module {ShorthandParserUtil}
 *
 * ## Overview
 *
 * This module provides utilities for parsing repository and multi-repository
 * shorthand.  The single-repo syntax is parsed by:
 *
 * `parseRepoShorthandRaw`  -- returns an informal Object with no validation
 * `parseRepoShorthand`     -- returns a `RepoAST` object.
 *
 * The multi-repo syntax is parsed by:
 *
 * `parseMultiRepoShorthand` -- return a map from repo name to `RepoAST`
 *
 * ## Single Repo Shorthand Syntax
 *
 * The shorthand syntax for describing a repository:
 *
 * shorthand      = <base repo type> ['>'<override>(';'<override>)*]
 * base repo type = 'S' | 'B' | ('C'<url>)
 * override       = <head> | <branch> | <current branch> | <new commit> |
 *                  <remote>
 * head           = 'H='<commit>|<nothing>             nothing means detached
 * nothing        =
 * commit         = <number>+
 * branch         = 'B'<name>'='<commit>|<nothing>     nothing deletes branch
 * current branch = '*='<commit>
 * new commit     = 'C'<commit>'-'<commit>[' '<change>(','<change>*)]
 * change         = path '=' data
 * path           = (<alpha numeric>|'/')+
 * data           = ('0-9'|'a-z'|'A-Z'|' ')*    basically non-delimiter ascii
 * remote         = R<name>=[<url>]
 *                  [' '<name>=[<commit>](','<name>=[<commit>])*]
 *
 * Some base repository types are defined by the `RepoType` property:
 *
 * - S -- "Simple" repository
 * - B -- like 'S' but bare
 *
 * Specifying a non-null current branch implies that the HEAD is set to the
 * same commit; specifying HEAD implies detached state and no current branch;
 * '*' and 'H' cannot be used together.
 *
 * Updating the commit of the current branch implies updating the HEAD.
 *
 * The first commit id specified in a commit is the id of the new commit; the
 * second is its parent.  A new commit introduces a change with a file having
 * the same name as its id and content that is also its id, unless changes are
 * specified.
 *
 * A remote specifies a name, an optional url, and an optional list of
 * branches.  If no url is specified for a remote, the intention is top provide
 * overrides for the existing remote of the specified name.  Branches with no
 * commit specifies removal of the branch from the remote in the base repo.
 *
 * Examples:
 *
 * S                          -- same as RepoType.S
 * S:H=                       -- removes head, bare repo
 * S:Bmaster=;*=              -- deletes master branch and detaches head
 * S:C2-1;Bmaster=2           -- creates a new commit, '2' derived from '1'
 *                               introducing a file '2' containing the string
 *                               '2'.  Sets master to point to this new commit.
 * S:C2-1 foo=bar;Bmaster=2  -- same as above but changes the file "foo"
 *                                   to "bar"
 * S:Rorigin=/foo.git           -- 'S' repo with an origin of /foo.git
 * S:Rorigin=/foo.git master=1  -- same as above but with remote branch
 *                              -- named 'master' pointing to commit 1
 * C/foo/bar>Bfoo=1  -- a clone of /foo/bar overriding branch foo to 1
 *
 * Note that the "clone' type may not be used with single-repo ASTs, and the
 * url must map to the name of another repo.  A cloned repository has the
 * following properties:
 * - the base repo is set to origin
 * - all branches in base repo are set up as remote branches
 * - the default branch, if any, is checked out
 * Note also that a cloned repository must appear after the repo it clones.
 *
 * ## Multi-repo Shorthand Syntax
 *
 * There is also a shorthand for describing multiple repositories in one
 * string:
 *
 * repos      = <assignment>('|'<assignment>)*
 * assignment = <repo name>'='<repo>
 *
 * Where the syntax for `repo` is that described above for
 * `parseRepoShorthand`.  Some things to note:
 *
 * - There is a single commit universe shared across these repositories.  A
 *   repository description may reference commits described in other
 *   repositories.  This feature is especially useful when dealing with clones.
 * - The same commit ID may be created twice, but the definitions must be
 *   identical.
 * - remote URLs that reference repository names are assumed to mean the
 *   repository with that name
 *
 * Examples:
 * a=S                        -- single "Simple" repo, 'a'
 * a=S|b=S                    -- two simple repos, 'a' and 'b'
 * a=S|b=Ca                   -- 'a' is a simple repo, 'b' is a clone of 'a'
 * a=S|b=S:Rupstream=a        -- 'a' is simple, and 'b' has an upstream named
 *                               'upstream' that points to 'a'
 * a=S:C2-1;Bmaster=2|b=S:Bfoo=2
 *                            -- 'a' is a simple repo with a new commit '2';
 *                               its 'master' branch points to '2'.  'b' is a
 *                               simple repo with a branch 'foo' pointing to
 *                               the same commit '2' introduced in 'a'.
 */

                         // Begin module-local methods

/**
 * Return the index of the specified `c` within the specified range
 * [begin, end) in the specified `str`, or null if the character cannot be
 * found.
 *
 * @param {String} str
 * @param {String} c
 * @param {Number} begin
 * @param {Number} end
 * @return {Number|null}
 */
function findChar(str, c, begin, end) {
    if (begin === end) {
        return null;                                                  // RETURN
    }
    const index = str.indexOf(c, begin);
    return (-1 === index || end <= index) ? null : index;
}

/**
 * Return the result of merging the data in the specified `baseAST` with data
 * returned from `parseRepoShorthandRaw` into an object suitable for passing to
 * the constructor of `RepoAST`.
 *
 * @param {RepoAST} baseAST
 * @param {Object}  rawRepo
 * @return {Object}
 */
function prepareASTArguments(baseAST, rawRepo) {
    assert.instanceOf(baseAST, RepoAST);
    assert.isObject(rawRepo);

    let resultArgs = {
        currentBranchName: baseAST.currentBranchName,
        branches: baseAST.branches,
        commits: baseAST.commits,
        remotes: baseAST.remotes,
        head: baseAST.head,
    };

    // Process HEAD.

    if ("head" in rawRepo) {
        resultArgs.head = rawRepo.head;
        resultArgs.currentBranchName = null;
    }

    // And then the current branch.

    if ("currentBranchName" in rawRepo) {
        resultArgs.currentBranchName = rawRepo.currentBranchName;
    }

    // Copy in branch overrides, deleting where `null` was specified.

    Object.keys(rawRepo.branches).forEach(name => {
        const override = rawRepo.branches[name];
        if (null !== override) {
            resultArgs.branches[name] = override;
        }
        else {
            delete resultArgs.branches[name];
        }
    });

    // If we have a current branch, make sure it's valid and update HEAD where
    // necessary.

    if (null !== resultArgs.currentBranchName) {
        assert.property(resultArgs.branches, resultArgs.currentBranchName);

        // If the head is 'null', the repo is bare and we don't need to reset
        // it.  If it is not 'null', then we should make it point to the same
        // commit as the current branch.

        if (null !== resultArgs.head) {
            resultArgs.head =
                             resultArgs.branches[resultArgs.currentBranchName];
        }
    }

    // Copy in new commits.

    Object.assign(resultArgs.commits, rawRepo.commits);

    // Copy and/or update remotes.

    Object.keys(rawRepo.remotes).forEach(remoteName => {
        const baseRemote = resultArgs.remotes[remoteName];
        let rawRemote = rawRepo.remotes[remoteName];
        let remote;


        if (null === rawRemote.url) {
            // If the 'url' is null, we want to update not override.

            assert.property(resultArgs.remotes, remoteName);
            let branches = baseRemote.branches;
            Object.keys(rawRemote.branches).forEach(branchName => {
                // Remove the branch if assigned to null.

                const branch = rawRemote.branches[branchName];
                if (null === branch) {
                    assert.property(branches, branchName);
                    delete branches[branchName];
                }
                else {
                    branches[branchName] = branch;
                }
            });
            remote = new RepoAST.Remote(baseRemote.url, {
                branches: branches
            });
        }
        else {
            remote = new RepoAST.Remote(rawRemote.url, {
                branches: rawRemote.branches,
            });
        }
        resultArgs.remotes[remoteName] = remote;
    });

    return resultArgs;
}

/**
 * Copy the commit having the specified `id` and its parents from the specified
 * `commits` map to the specified `destCommits` map.  The behavior is undefined
 * unless `id` and its ancestors exist in `commits`.
 *
 * @private
 * @param {Object} destCommits from id to `Commit`
 * @param {Object} commits      from id to `Commit`
 * @param {String} id
 */
function copyCommitAndParents(destCommits, commits, id) {
    assert.property(commits, id);
    const commit = commits[id];
    destCommits[id] = commit;
    commit.parents.forEach(
        parent => copyCommitAndParents(destCommits, commits, parent));
}
                          // End modue-local methods

/**
 * Return the raw data encoded in the specified `shorthand` according to the
 * syntax described in the documentation for this module.  This method does
 * minimal semantic validation.
 *
 * @param {String} shorthand
 * @return {Object}
 * @return {String} return.type
 * @return {Object} return.commits     map from id to commit
 * @return {Object} return.branches    map from name to commit id
 * @return {String|null} [return.head]
 * @return {String|null} [return.currentBranchName]
 */
exports.parseRepoShorthandRaw = function (shorthand) {
    assert.isString(shorthand);
    assert(0 !== shorthand.length, "empty repo specifier");

    // This grammar is context insensitive and very easy to parse.
    // We will populate the following variables as we parse overrides:

    let head;
    let currentBranchName;
    let branches = {};
    let commits = {};
    let remotes = {};

    /**
     * Parse a string in the form of "=<foo>" between the specified `begin`
     * and `end`, or `null` if there is no string.
     *
     * @param {String}
     * @return {String|null}
     */
    function parseSimpleAssign(begin, end) {
        assert.equal(shorthand[begin],
                     "=",
                     "no assignment for HEAD override");
        begin += 1;
        return begin === end ? null : shorthand.substr(begin, end - begin);
    }

    /**
     * Parse the branch override beginning at the specified `begin` and ending
     * at the specified `end`.
     *
     * @param {Number} begin
     * @param {Number} end
     */
    function parseBranchOverride(begin, end) {
        let nameEnd = begin;

        while (end !== nameEnd && "=" !== shorthand[nameEnd]) {
            ++nameEnd;
        }
        assert.notEqual(end, nameEnd, "invalid branch override");
        assert.equal(shorthand[nameEnd], "=", "missing branch assignment");

        let branchOverride = null;

        let assignmentBegin = nameEnd + 1;  // skip "="
        if (assignmentBegin !== end) {
            branchOverride = shorthand.substr(assignmentBegin,
                                              end - assignmentBegin);
        }

        const name = shorthand.substr(begin, nameEnd - begin);

        assert.notProperty(branches,
                           name,
                           "multiple overrides for same branch");

        branches[name] = branchOverride;
    }

    /**
     * Parse the head override beginning at the specified `begin` and
     * terminating at the specfied `end`;
     *
     * @param {Number} begin
     * @param {Number} end
     */
    function parseHeadOverride(begin, end) {
        assert.isUndefined(head, "multiple head overrides");
        assert.isUndefined(currentBranchName,
                           "* and H cannot be used together");
        head = parseSimpleAssign(begin, end);
    }

    /**
     * Parse the head override beginning at the specified `begin` and
     * terminating at the specified `end`.
     *
     * @param {Number} begin
     * @param {Number} end
     */
    function parseCurrentBranchOverride(begin, end) {
        assert.isUndefined(currentBranchName, "multiple head overrides");
        assert.isUndefined(head, "* and H cannot be used together");
        currentBranchName = parseSimpleAssign(begin, end);
    }

    /**
     * Parse a new commit beginning at the specified `begin` and terminating at
     * the specified `end`.
     *
     * @param {Number} begin
     * @param {Number} end
     */
    function parseNewCommit(begin, end) {
        const idEnd = findChar(shorthand, "-", begin, end);
        assert.notEqual(idEnd, begin, "no commit id");
        assert.isNotNull(idEnd, "no commit id");
        const parentStart = idEnd + 1;
        assert.notEqual(parentStart, end, "no parent commit id");
        const commitId = shorthand.substr(begin, idEnd - begin);
        const parentEnd = findChar(shorthand, " ", idEnd, end) || end;
        const parentId = shorthand.substr(parentStart,
                                          parentEnd - parentStart);
        assert.notProperty(commits, commitId, "duplicate new commit ids");
        let changes = {};

        // If there are specified changes, process them; otherwise use the
        // default.

        if (parentEnd !== end) {
            assert.equal(shorthand[parentEnd], " ");
            let changeStart = parentEnd + 1;
            assert.notEqual(changeStart, end, "must be at least one change");
            while (end !== changeStart) {
                const assign = findChar(shorthand, "=", changeStart, end);
                assert.isNotNull(assign, "no assignment");
                assert.notEqual(changeStart, assign, "no path");
                const dataStart = assign + 1;
                let next = findChar(shorthand, ",", dataStart, end) || end;
                const path = shorthand.substr(changeStart,
                                              assign - changeStart);
                const data = shorthand.substr(dataStart, next - dataStart);
                changes[path] = data;
                changeStart = Math.min(next + 1, end);
            }
        }
        else {
            changes[commitId] = commitId;
        }
        commits[commitId] = new RepoAST.Commit({
            parents: [parentId],
            changes: changes,
        });
        return Math.min(end + 1, shorthand.length);
    }

    /**
     * Parse a new remote beginning at the specified `begin` and terminating at
     * the specified `end`.
     *
     * @param {Number} begin
     * @param {Number} end
     */
    function parseRemote(begin, end) {
        const equal = findChar(shorthand, "=", begin, end);
        assert.isNotNull(equal);
        assert.notEqual(equal, begin);
        const startUrl = equal + 1;
        const endUrl = findChar(shorthand, " ", startUrl, end) || end;
        const name = shorthand.substr(begin, equal - begin);
        let url = null;
        if (startUrl !== endUrl) {
            url = shorthand.substr(startUrl, endUrl - startUrl);
        }
        assert.notProperty(remotes, name);

        let branches = {};
        let nextBranch = endUrl;
        while (end !== nextBranch) {
            const branchBegin = nextBranch + 1;
            assert.notEqual(branchBegin, end);
            const equal = findChar(shorthand, "=", branchBegin, end);
            assert.isNotNull(equal);
            assert.notEqual(equal, branchBegin);
            const branchEnd = findChar(shorthand, ",", equal, end) || end;
            const branchName = shorthand.substr(branchBegin,
                                                equal - branchBegin);
            let branchCommit = null;
            const commitBegin = equal + 1;
            if (commitBegin !== branchEnd) {
                branchCommit = shorthand.substr(commitBegin,
                                                branchEnd - commitBegin);
            }
            branches[branchName] = branchCommit;
            nextBranch = branchEnd;
        }
        remotes[name] = {
            url: url,
            branches: branches,
        };
    }

    /**
     * Parse the override beginning at the specified `begin` and then call
     * self on remainder.
     *
     * @param {Number} begin
     */
    function parseOverride(begin) {
        const override = shorthand[begin];  // current override to parse

        begin += 1;
        const end = findChar(shorthand, ";", begin, shorthand.length) ||
                                                              shorthand.length;
        const nextParser = (() => {
            switch(override) {
                case "*": return parseCurrentBranchOverride;
                case "B": return parseBranchOverride;
                case "C": return parseNewCommit;
                case "H": return parseHeadOverride;
                case "R": return parseRemote;
                default:
                    assert.isNull(`Invalid override ${override}.`);
                break;
            }
        })();

        nextParser(begin, end);

        const next = end + 1;

        // If `next` is short of the length of the string, recurse.
        if (next < shorthand.length) {
            parseOverride(next);
        }
    }

    // Manually process the base repository type; there is only one and it must
    // be at the beginning.

    let typeEnd = findChar(shorthand, ":", 0, shorthand.length) ||
                                                              shorthand.length;

    let typeStr = shorthand[0];
    let typeData =
                  (typeEnd > 1) ? shorthand.substr(1, typeEnd - 1) : undefined;

    // If there is data after the base type description, recurse.

    if (shorthand.length !== typeEnd) {
        assert.equal(shorthand[typeEnd], ":");
        const overridesBegin = typeEnd + 1;
        assert(shorthand.length > overridesBegin,
               "must have at least one override");
        parseOverride(overridesBegin);
    }

    let result = {
        type: typeStr,
        commits: commits,
        branches: branches,
        remotes: remotes,
    };

    if (undefined !== typeData) {
        result.typeData = typeData;
    }

    if (undefined !== head) {
        result.head = head;
    }
    if (undefined !== currentBranchName) {
        result.currentBranchName = currentBranchName;
    }
    return result;
};

/**
 * Return the AST described by the specified `shorthand`.  The behavior is
 * undefined unless `shorthand` specifies a valid shorthand according to the
 * syntax described in the documentation for this module.
 *
 * @param {String] shorthand
 * @return {RepoAST}
 */
exports.parseRepoShorthand = function (shorthand) {
    assert.isString(shorthand);

    const rawResult = exports.parseRepoShorthandRaw(shorthand);
    assert.property(exports.RepoType, rawResult.type, "invalid override");
    const baseAST = exports.RepoType[rawResult.type];

    const resultArgs = prepareASTArguments(baseAST, rawResult);
    const fin = baseAST.copy(resultArgs);
    return fin;
};

/**
 * Return a map from repo name to AST from the specified `shorthand` as
 * described by the multi-repo syntax described in the documentation for this
 * module.
 *
 * @param {String} shorthand
 * @return {Object} map from repo name to its AST
 */
exports.parseMultiRepoShorthand = function (shorthand) {
    assert.isString(shorthand);

    // First, parse out the repo definitions.

    let rawRepos = {};
    let begin = 0;
    while (begin !== shorthand.length) {
        const equal = findChar(shorthand, "=", begin, shorthand.length);
        assert.isNotNull(equal, "no assign operator");
        assert.notEqual(equal, begin, "empty name");
        const repoBegin = equal + 1;
        assert.notEqual(repoBegin, shorthand.length, "no repo definition");
        const end = findChar(shorthand, "|", repoBegin, shorthand.length) ||
                                                              shorthand.length;
        assert.notEqual(repoBegin, end, "empty repo definition");
        const name = shorthand.substr(begin, equal - begin);
        const repoShorthand = shorthand.substr(repoBegin, end - repoBegin);
        begin = Math.min(end + 1, shorthand.length);
        const repo = exports.parseRepoShorthandRaw(repoShorthand);
        rawRepos[name] = repo;
    }

    // Collect the commits and check for duplicates.

    let commits = {};

    function addCommit(id, commit) {
        if (id in commits) {
            const oldCommit = commits[id];
            RepoASTUtil.assertEqualCommits(
                                      commit,
                                      oldCommit,
                                      `diffferent duplicate for commit ${id}`);
        }
        else {
            commits[id] = commit;
        }
    }

    for (let name in rawRepos) {
        const repo = rawRepos[name];
        for (let id in repo.commits) {
            addCommit(id, repo.commits[id]);
        }
        if (repo.type in exports.RepoType) {
            const base = exports.RepoType[repo.type];
            const baseCommits = base.commits;
            for (let id in baseCommits) {
                addCommit(id, baseCommits[id]);
            }
        }
    }

    // Build the actual RepoAST objects.  This must be done as a separate step
    // so that commits may be used even if defined out of order.

    let result = {};

    Object.keys(rawRepos).forEach(name => {
        const rawRepo = rawRepos[name];

        // Preliminary setup based on base repo type
        let baseAST;
        if ("C" === rawRepo.type) {
            assert.property(rawRepo,
                            "typeData",
                            `missing url for clone ${name}`);
            const url = rawRepo.typeData;
            assert.isString(url);
            assert.property(result,
                            url,
                            `parent for clone ${name} not defined`);
            const parentRepo = result[url];
            const parentBranches = parentRepo.branches;
            let baseArgs = {
                currentBranchName: parentRepo.currentBranchName,
                commits: {},
                remotes: {
                    origin: new RepoAST.Remote(url, {
                        branches: parentBranches,
                    }),
                },
            };

            // Copy reachable commits

            Object.keys(parentBranches).forEach(
                branch => copyCommitAndParents(baseArgs.commits,
                                               commits,
                                               parentBranches[branch]));

            if (null !== parentRepo.currentBranchName) {
                const currentCommit =
                                  parentBranches[parentRepo.currentBranchName];
                baseArgs.head = currentCommit;
                let branches = {};
                branches[parentRepo.currentBranchName] = currentCommit;
                baseArgs.branches = branches;
            }
            baseAST = new RepoAST(baseArgs);
        }
       else {
            assert.property(exports.RepoType, rawRepo.type, `repo ${name}`);
            baseAST = exports.RepoType[rawRepo.type];
        }
        const resultArgs = prepareASTArguments(baseAST, rawRepo);

        // Now we need to copy in necessary commits that weren't directly
        // included.

        function includeCommit(id) {
            copyCommitAndParents(resultArgs.commits, commits, id);
        }
        for (let branch in resultArgs.branches) {
            includeCommit(resultArgs.branches[branch]);
        }
        if (resultArgs.head) {
            includeCommit(resultArgs.head);
        }
        for (let remoteName in resultArgs.remotes) {
            const remote = resultArgs.remotes[remoteName];
            for (let branch in remote.branches) {
                includeCommit(remote.branches[branch]);
            }
        }
        result[name] = new RepoAST(resultArgs);
    });

    return result;
};

/**
 * Return the AST for a simple repository type.
 *
 * @property {Object} map from repo type to AST
 */
exports.RepoType = (() => {
    function makeS() {
        return new RepoAST({
            commits: {
                "1": new RepoAST.Commit({
                    changes: {
                        "README.md": "hello world"
                    }
                }),
            },
            branches: {
                "master": "1",
            },
            head: "1",
            currentBranchName: "master",
        });
    }
    function makeB() {
        const S = makeS();
        return S.copy({
            head: null
        });
    }
    return {
        S: makeS(),  // simple repo
        B: makeB()   // bare repo
    };
})();
