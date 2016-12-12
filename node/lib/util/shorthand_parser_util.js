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
const RepoAST     = require("../util/repo_ast");
const RepoASTUtil  = require("../util/repo_ast_util");

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
 * shorthand      = <base repo type> [':'<override>(';\s*'<override>)*]
 * base repo type = 'S' | 'B' | ('C'<url>) | 'A'<commit>
 * override       = <head> | <branch> | <current branch> | <new commit> |
 *                  <remote> | <index> | <workdir> | <open submodule> |
 *                  <note> | <rebase>
 * head           = 'H='<commit>|<nothing>             nothing means detached
 * nothing        =
 * commit         = <alphanumeric>+
 * branch         = 'B'<name>'='<commit>|<nothing>     nothing deletes branch
 * ref            = 'F'<name>'='<commit>|<nothing>     nothing deletes ref
 * current branch = '*='<commit>
 * new commit     = 'C'[message#]<commit>['-'<commit>(,<commit>)*]
 *                  [' '<change>(',\s*'<change>*)]
 * change         = path ['=' <submodule> | "~" | <data>]
 * path           = (<alpha numeric>|'/')+
 * submodule      = Surl:<commit>
 * data           = ('0-9'|'a-z'|'A-Z'|' ')*    basically non-delimiter ascii
 * remote         = R<name>=[<url>]
 *                  [' '<name>=[<commit>](',\s*'<name>=[<commit>])*]
 * note           = N <ref> <commit>=message
 * rebase         = E<head name>,<original commit id>,<onto commit id>
 * index          = I <change>[,<change>]*
 * workdir        = W <change>[,<change>]*
 * open submodule = 'O'<path>[' '<override>('!'<override>)*]
 *
 * Some base repository types are defined by the `RepoType` property:
 *
 * - S -- "Simple" repository
 * - B -- like 'S' but bare
 * - A -- A basic repo, like `S`, but the single commit it contains is
 *        named after the data it is passed; it contains a single file with the
 *        same name as the commit and that name as its data.
 * - U -- like `S`, but with a second commit `2` introducing a submodule named
 *        "s" with a url of "a" on commit `1`
 *
 * Whitespace is skipped at the beginning of shorthanad, and also after some,
 * but not all delimitors.  We can't skip it in places where the space
 * character is itself a separator, such as after the parent commit ids.  It is
 * skipped after separators for:
 *
 * - commit changes
 * - remote branches
 * - overrides (including submodules)
 * - repos
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
 * specified.  If no commit message is specified, the default value is
 * "message".
 *
 * A remote specifies a name, an optional url, and an optional list of
 * branches.  If no url is specified for a remote, the intention is top provide
 * overrides for the existing remote of the specified name.  Branches with no
 * commit specifies removal of the branch from the remote in the base repo.
 *
 * A change generally indicates:
 * - textual data
 * - a submodule definition
 * - if the '=' is omitted, a deletion
 * - if `~` removes the change from the base, if an override
 *
 * An Index override indicates changes staged in the repository index.
 *
 * Working directory overrides function like index overrides except that
 * submodule definitions are not allowed.
 *
 * Open submodules are special in that they are essentially mini-repo
 * definitions, with their base repo being one that has the commits of the
 * submodule referenced in the submodule definition at HEAD, no branches, and a
 * detached HEAD set to the sha recorded in the submodule definition.  Optional
 * overrides can be applied.  Note that the delimiter for overrides with a
 * submodule is '!' to simplify parsing -- otherwise it would require more
 * sophisticated logic to determin when the submodule override ended.  To allow
 * testing of relative URLs, a relative URL in the form of "../foo" will be
 * translated into "foo" in a open submodule.
 *
 * Examples:
 *
 * S                          -- same as RepoType.S
 * A33                        -- Like S but the single commit is named 33 and
 *                               contains a file named 33 with the contents 33.
 * S:H=                       -- removes head, bare repo
 * S:Bmaster=;*=              -- deletes master branch and detaches head
 * S:C2-1;Bmaster=2           -- creates a new commit, '2' derived from '1'
 *                               introducing a file '2' containing the string
 *                               '2'.  Sets master to point to this new commit.
 * S:C2-1 foo=bar;Bmaster=2   -- same as above but changes the file "foo"
 *                               to "bar"
 * S:C2-1 foo=S/baz.gi:1      -- makes a commit setting the path 'foo' to
 *                               be a submodule with a url 'baz' at commit '1'
 * S:Chello#2-1,3             -- a commit, "2", with two parents: "1" and "3",
 *                               and a message of "hello"
 * S:Rorigin=/foo.git           -- 'S' repo with an origin of /foo.git
 * S:Rorigin=/foo.git master=1  -- same as above but with remote branch
 *                              -- named 'master' pointing to commit 1
 * C/foo/bar:Bfoo=1  -- a clone of /foo/bar overriding branch foo to 1
 * S:I foo=bar,x=y              -- staged changes to 'foo' and 'x'
 * S:I foo=bar,x=y;W foo,q=z    -- as above but `foo` is deleted in the
 *                                 workding directory and `q` has been added
 *                                 with content set to `z`.
 * S:I foo=S/a:1;Ofoo           -- A submodule added to the index at `foo`
 *                              -- that is open but no local changes
 * S:I foo=S/a:1;Ofoo W x=y     -- A submodule added to the index at `foo`
 *                              -- that is open and has changed the local
 *                              -- file `x` to be `y`.
 * S:Emaster,1,2                -- rebase in progress started on "master",
 *                                 original head "1", onto commit "2"
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
 * - The `existingRepos` map may be specified to provide base repos.  This
 *   functionality is especially useful for specifying the "expected" values,
 *   as it lets one describe a repo in terms of changes to initial values.
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
 * b=E:Bfoo=2;*=foo           -- `b` is the same as the "existing" `b`, but
 *                               with a new branch named `foo` that is set
 *                               to be the current branch.
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
 * Return the path change data described by the specified `commitData`.  If
 * `commitData` begins with an `S` it is a submodule description; otherwise, it
 * is just `commitData`; if it is "~" it indicates removal from the override.
 *
 * @private
 * @param {String} commitData
 * @return {String|RepoAST.Submodule}
 */
function parseChangeData(commitData) {
    if ("~" === commitData) {
        return undefined;
    }
    const end = commitData.length;
    if (0 === end || "S" !== commitData[0]) {
        return commitData;                                            // RETURN
    }

    // Must have room for 'S', ':', and at least one char for the url and
    // commit id

    assert(commitData.length > 3, `Invalid submodule ${commitData}`);
    const urlBegin = 1;
    const urlEnd = findChar(commitData, ":", urlBegin, end);
    assert.isNotNull(urlEnd);
    const commitIdBegin = urlEnd + 1;
    assert.notEqual(commitIdBegin, end);
    return new RepoAST.Submodule(commitData.substr(urlBegin,
                                                   urlEnd - urlBegin),
                                 commitData.substr(commitIdBegin,
                                                   end - commitIdBegin));
}

/**
 * Copy the specified `source` overrides into the specified `dest` overrides,
 * removing any value in dest for which the correspoding `source` value is
 * `undefined`.
 *
 * @param {Object} dest
 * @param {Object} source
 */
function copyOverrides(dest, source) {
    for (let key in source) {
        const value = source[key];
        if (undefined === value) {
            delete dest[key];
        }
        else {
            dest[key] = value;
        }
    }
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
        refs: baseAST.refs,
        commits: baseAST.commits,
        remotes: baseAST.remotes,
        head: baseAST.head,
        notes: baseAST.notes,
        index: baseAST.index,
        workdir: baseAST.workdir,
        openSubmodules: baseAST.openSubmodules,
        rebase: baseAST.rebase,
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

    // Copy in ref overrides, deleting where `null` was specified.

    Object.keys(rawRepo.refs).forEach(name => {
        const override = rawRepo.refs[name];
        if (null !== override) {
            resultArgs.refs[name] = override;
        }
        else {
            delete resultArgs.refs[name];
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

    // Copy the notes
    Object.assign(resultArgs.notes, rawRepo.notes);

    // Copy the index
    copyOverrides(resultArgs.index, rawRepo.index);

    // Copy the workdir
    copyOverrides(resultArgs.workdir, rawRepo.workdir);

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

    // Override rebase if provided

    if ("rebase" in rawRepo) {
        resultArgs.rebase = rawRepo.rebase;
    }

    return resultArgs;
}

/**
 * Return the range for the specified seprator `char` within the specified
 * [begin,end) range in the `string`.  A seprator range consists of `char` and
 * any trailing whitespace.
 *
 * @param {String} string
 * @param {String} char
 * @param {Number} begin
 * @param {Number} end
 * @return {Object|null}
 * @return {Number} return.begin inclusive
 * @return {Number} return.end   exclusive
 */
function findSeparator (string, char, begin, end) {
    const separator = findChar(string, char, begin, end);
    if (null === separator) {
        return null;                                                  // RETURN
    }
    const whitespace = /\s/;
    let sepEnd = separator + 1;
    while (sepEnd < end && whitespace.test(string[sepEnd])) {
        ++sepEnd;
    }
    return {
        begin: separator,
        end: sepEnd,
    };
}

exports.findSeparator = findSeparator;
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

/**
 * Parse the overrides starting at the specified `begin` character and
 * terminating at the specified `end` character in the specified `shorthand`,
 * separated by the specified `delimiter`.
 *
 * @param {String} shorthand
 * @param {Number} begin
 * @param {Number} end
 * @param {String} delimiter
 */
function parseOverrides(shorthand, begin, end, delimiter) {

    // This grammar is context insensitive and very easy to parse.
    // We will populate the following variables as we parse overrides:

    let head;
    let index = {};
    let workdir = {};
    let currentBranchName;
    let branches = {};
    let refs = {};
    let commits = {};
    let remotes = {};
    let notes = {};
    let openSubmodules = {};
    let rebase;

    /**
     * Parse a set of changes from the specified `begin` character to the
     * specified `end` character.
     *
     * @param {Number} begin
     * @param {Number} end
     */
    function parseChanges(begin, end) {
        let changes = {};
        assert.notEqual(begin, end, "must be at least one change");
        while (end !== begin) {
            const currentEnd = findSeparator(shorthand, ",", begin, end) ||
                               { begin: end, end: end};
            const assign = findChar(shorthand, "=", begin, currentEnd.begin);
            assert.notEqual(begin, assign, "no path");
            let change = null;
            let pathEnd = currentEnd.begin;
            if (null !== assign) {
                pathEnd = assign;
                const dataBegin = assign + 1;
                const rawChange =
                           shorthand.substr(dataBegin,
                                            currentEnd.begin - dataBegin);
                change = parseChangeData(rawChange);
            }
            const path = shorthand.substr(begin, pathEnd - begin);
            changes[path] = change;
            begin = currentEnd.end;
        }
        return changes;
    }

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
     * Return a parser for the specified type of `reference`; copy the results
     * into the specified `dest` object.
     *
     * @param {Object} dest
     * @param {String} type
     */
    function parseRefOverride(dest, type) {
        return function (begin, end) {
            let nameEnd = begin;

            while (end !== nameEnd && "=" !== shorthand[nameEnd]) {
                ++nameEnd;
            }
            assert.notEqual(end, nameEnd, `invalid ${type} override`);
            assert.equal(shorthand[nameEnd],
                         "=",
                         `missing ${type} assignment`);

            let branchOverride = null;

            let assignmentBegin = nameEnd + 1;  // skip "="
            if (assignmentBegin !== end) {
                branchOverride = shorthand.substr(assignmentBegin,
                                                  end - assignmentBegin);
            }

            const name = shorthand.substr(begin, nameEnd - begin);

            assert.notProperty(dest,
                               name,
                               `multiple overrides for same ${type}`);

            dest[name] = branchOverride;
        };
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
        // See if there is a message, indicated by the presence of a '#'.  Set
        // up the start of the 'id' and message boundaries appropriately.

        const messageSeparator = findChar(shorthand, "#", begin, end);
        let message = "message";
        if (null !== messageSeparator) {
            message = shorthand.substr(begin, messageSeparator - begin);
        }

        // Parse the commit id.

        const parents = [];

        // Start of the commit's ID.
        const idBegin = messageSeparator ? messageSeparator + 1 : begin;

        // End of the id and parents.
        const parentsEnd = findChar(shorthand, " ", idBegin, end) || end;

        // End of the commitId
        const idEnd = findChar(shorthand, "-", idBegin, parentsEnd) ||
                                                                    parentsEnd;
        assert.notEqual(idEnd, idBegin, "no commit id");
        const commitId = shorthand.substr(idBegin, idEnd - idBegin);
        assert.notProperty(commits, commitId, "duplicate new commit ids");

        // Parse the parent commit ids if there are any.

        if (parentsEnd !== idEnd) {

            const parentStart = idEnd + 1;
            let nextParent = parentStart;
            while(nextParent !== parentsEnd) {
                const nextParentEnd = findChar(shorthand,
                                               ",",
                                               nextParent,
                                               parentsEnd) || parentsEnd;
                const parentId = shorthand.substr(nextParent,
                                                  nextParentEnd - nextParent);
                parents.push(parentId);
                nextParent = Math.min(nextParentEnd + 1, parentsEnd);
            }
        }

        // If there are specified changes, process them; otherwise use the
        // default.

        let changes = {};
        if (parentsEnd !== end) {
            assert.equal(shorthand[parentsEnd], " ");
            changes = parseChanges(parentsEnd + 1, end);
        }
        else {
            changes[commitId] = commitId;
        }
        commits[commitId] = new RepoAST.Commit({
            parents: parents,
            changes: changes,
            message: message,
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
        let nextBranch = Math.min(endUrl + 1, end);
        while (end !== nextBranch) {
            const branchBegin = nextBranch;
            assert.notEqual(branchBegin, end);
            const equal = findChar(shorthand, "=", branchBegin, end);
            assert.isNotNull(equal);
            assert.notEqual(equal, branchBegin);
            const branchEnd = findSeparator(shorthand, ",", equal, end) ||
                              { begin: end, end: end };
            const branchName = shorthand.substr(branchBegin,
                                                equal - branchBegin);
            let branchCommit = null;
            const commitBegin = equal + 1;
            if (commitBegin !== branchEnd.begin) {
                branchCommit = shorthand.substr(commitBegin,
                                                branchEnd.begin - commitBegin);
            }
            branches[branchName] = branchCommit;
            nextBranch = branchEnd.end;
        }
        remotes[name] = {
            url: url,
            branches: branches,
        };
    }

    /**
     * Parse index changes beginning at the specified `begin` and terminating
     * at the specified `end`.
     *
     * @param {Number} begin
     * @param {Number} end
     */
    function parseIndex(begin, end) {
        assert.notEqual(begin, end);
        assert.equal(shorthand[begin], " ");
        index = parseChanges(begin + 1, end);
    }

    /**
     * Parse note changes beginning at the specified `begin` and terminating
     * at the specified `end`.
     *
     * @param {Number} begin
     * @param {Number} end
     */
    function parseNote(begin, end) {
        assert.notEqual(begin, end);
        assert.equal(shorthand[begin], " ");
        const refEnd = findChar(shorthand, " ", begin + 1, end);
        assert.isNotNull(refEnd);
        const ref = shorthand.substring(begin + 1, refEnd);
        const commitEnd = findChar(shorthand, "=", refEnd + 1, end);
        assert.isNotNull(commitEnd);
        const commit = shorthand.substring(refEnd + 1, commitEnd);
        const message = shorthand.substring(commitEnd + 1, end);

        if (!(ref in notes)) {
            notes[ref] = {};
        }
        assert.notProperty(notes[ref], commit);
        notes[ref][commit] = message;
    }

   /**
     * Parse workdir changes beginning at the specified `begin` and terminating
     * at the specified `end`.
     *
     * @param {Number} begin
     * @param {Number} end
     */
    function parseWorkdir(begin, end) {
        assert.notEqual(begin, end);
        assert.equal(shorthand[begin], " ");
        const result = parseChanges(begin + 1, end);
        Object.keys(result).forEach(path => {
            assert.notInstanceOf(result[path],
                                 RepoAST.Submodule,
                                 `${path} cannot be submodule in workdir`);
        });
        workdir = result;
    }

    /**
     * Parse open submodule beginning at the specified `begin` and terminating
     * at the specified `end`.
     *
     * @param {Number} begin
     * @param {Number} end
     */
    function parseOpenSubmodule(begin, end) {
        assert.notEqual(begin, end);
        assert.notEqual(shorthand[begin], " ");
        const pathEnd = findChar(shorthand, " ", begin, end) || end;
        const path = shorthand.substr(begin, pathEnd - begin);
        assert.notProperty(openSubmodules,
                           path,
                           `open submodules ${path} defined more than once`);
        let overridesBegin = pathEnd;
        if (end !== overridesBegin) {
            overridesBegin += 1;
            assert(end !== overridesBegin, "must be at least one override");
        }
        const overrides = parseOverrides(shorthand, overridesBegin, end, "!");
        openSubmodules[path] = overrides;
    }

    /**
     * Parse the rebase definition beginning at the specified `begin` and
     * terminating at the specified `end`.
     *
     * @param {Number} begin
     * @param {Number} end
     */
    function parseRebase(begin, end) {
        if (begin === end) {
            rebase = null;
            return;                                                   // RETURN
        }
        const rebaseDef = shorthand.substr(begin, end - begin);
        const parts = rebaseDef.split(",");
        assert.equal(parts.length,
                     3,
                     `Wrong number of rebase parts in ${rebaseDef}`);
        rebase = new RepoAST.Rebase(parts[0], parts[1], parts[2]);
    }

    /**
     * Parse the override beginning at the specified `begin` and finishing at
     * the specified `end`.
     *
     * @param {Number} begin
     * @param {Number} end
     */
    function parseOverride(begin, end) {
        const override = shorthand[begin];  // current override to parse

        begin += 1;
        const parser = (() => {
            switch(override) {
                case "*": return parseCurrentBranchOverride;
                case "B": return parseRefOverride(branches, "branch");
                case "F": return parseRefOverride(refs, "ref");
                case "C": return parseNewCommit;
                case "H": return parseHeadOverride;
                case "R": return parseRemote;
                case "I": return parseIndex;
                case "N": return parseNote;
                case "W": return parseWorkdir;
                case "O": return parseOpenSubmodule;
                case "E": return parseRebase;
                default:
                    assert.isNull(`Invalid override ${override}.`);
                break;
            }
        })();

        parser(begin, end);
    }

    while (begin !== end) {
        const nextEnd = findSeparator(shorthand, delimiter, begin, end) ||
                        { begin: end, end: end};
        parseOverride(begin, nextEnd.begin);
        begin = nextEnd.end;
    }

    let result = {
        commits: commits,
        branches: branches,
        refs: refs,
        remotes: remotes,
        notes: notes,
        index: index,
        workdir: workdir,
        openSubmodules: openSubmodules,
    };
    if (undefined !== head) {
        result.head = head;
    }
    if (undefined !== currentBranchName) {
        result.currentBranchName = currentBranchName;
    }
    if (undefined !== rebase) {
        result.rebase = rebase;
    }
    return result;
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
 * @return {Object} return.refs        map from name to commit id
 * @return {String|null} [return.head]
 * @return {String|null} [return.currentBranchName]
 */
exports.parseRepoShorthandRaw = function (shorthand) {
    assert.isString(shorthand);
    assert(0 !== shorthand.length, "empty repo specifier");

    // Manually process the base repository type; there is only one and it must
    // be at the beginning.

    let typeEnd = findChar(shorthand, ":", 0, shorthand.length) ||
                                                              shorthand.length;

    let typeStr = shorthand[0];
    let typeData =
                  (typeEnd > 1) ? shorthand.substr(1, typeEnd - 1) : undefined;

    let result = {
        type: typeStr,
    };

    // If there is data after the base type description, recurse.

    let overridesBegin = typeEnd;

    if (shorthand.length !== typeEnd) {
        assert.equal(shorthand[typeEnd], ":");
        overridesBegin = typeEnd + 1;
        assert(shorthand.length > overridesBegin,
               "must have at least one override");
    }

    Object.assign(
             result,
             parseOverrides(shorthand, overridesBegin, shorthand.length, ";"));
    if (undefined !== typeData) {
        result.typeData = typeData;
    }

    return result;
};

/**
 * Return the base repository AST having the specified `type` configured with
 * the specified `data` or null if there is no base repo for `type`.
 *
 * @private
 * @param {String} type
 * @param {String} [data]
 * @return {RepoAST|null}
 */
function getBaseRepo(type, data) {
    if (type in exports.RepoType) {
        assert.isUndefined(data, `${type} takes no data`);
        return exports.RepoType[type];
    }
    if ("A" === type) {
        let commits = {};
        let changes = {};
        changes[data] = data;
        commits[data] = new RepoAST.Commit({
            changes: changes,
            message: `changed ${data}`,
        });
        return new RepoAST({
            commits: commits,
            branches: {
                master: data,
            },
            head: data,
            currentBranchName: "master",
        });
    }
    return null;
}

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

    shorthand = shorthand.trim();
    const rawResult = exports.parseRepoShorthandRaw(shorthand);
    assert.equal(0,
                 Object.keys(rawResult.openSubmodules),
                 "open submodules not supported in single-repo shorthand");
    const baseAST = getBaseRepo(rawResult.type, rawResult.typeData);
    assert.isNotNull(baseAST, `invalid base repo type ${rawResult.type}`);
    const resultArgs = prepareASTArguments(baseAST, rawResult);
    const fin = baseAST.copy(resultArgs);
    return fin;
};

/**
 * Return a map from repo name to AST from the specified `shorthand` as
 * described by the multi-repo syntax described in the documentation for this
 * module.  The specified `existingRepos` map, if provided, serves the
 * following purposes:
 *
 * - When a repsitory is listed as a URL, it will resolve first to any repos
 *   defined in `shorthand`, but if the repository is not defined there,
 *   `existingRepos` will be checked.
 * - If a repository base type of `E` is specified, the base type will be the
 *   repo having that name in the `existingRepos` map.
 * - Any repository in `existingRepos` that is not defined by `shorthand` will
 *   be present in the return value of this function.
 *
 * @param {String} shorthand
 * @param {Object} [existingRepos]
 * @return {Object} map from repo name to its AST
 */
exports.parseMultiRepoShorthand = function (shorthand, existingRepos) {
    assert.isString(shorthand);
    shorthand = shorthand.trim();
    if (undefined !== existingRepos) {
        assert.isObject(existingRepos);
    }
    else {
        existingRepos = {};
    }

    // First, parse out the repo definitions.

    let rawRepos = {};
    let begin = 0;
    while (begin !== shorthand.length) {
        const equal = findChar(shorthand, "=", begin, shorthand.length);
        assert.isNotNull(equal, "no assign operator");
        assert.notEqual(equal, begin, "empty name");
        const repoBegin = equal + 1;
        assert.notEqual(repoBegin, shorthand.length, "no repo definition");
        const end = findSeparator(shorthand,
                                  "|",
                                  repoBegin,
                                  shorthand.length) ||
                    { begin: shorthand.length, end: shorthand.length };
        assert.notEqual(repoBegin, end.begin, "empty repo definition");
        const name = shorthand.substr(begin, equal - begin);
        const repoShorthand = shorthand.substr(repoBegin,
                                               end.begin - repoBegin);
        begin = end.end;
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

    // Add all the specified `commits` to the commit namespace.

    function addCommitMap(commits) {
        assert.isObject(commits);
        for (let id in commits) {
            addCommit(id, commits[id]);
        }
    }

    // Configure the commit namespace to include all commits that were defined
    // in the raw shorthand.

    for (let name in rawRepos) {
        const repo = rawRepos[name];

        // Commits directly created in repo definition.

        addCommitMap(repo.commits);

        // Commits referenced from base commit types.

        const base = getBaseRepo(repo.type, repo.typeData);
        if (null !== base) {
            const baseCommits = base.commits;
            addCommitMap(baseCommits);
        }

        // Commits defined in open submodule overrides.

        for (let subName in repo.openSubmodules) {
            addCommitMap(repo.openSubmodules[subName].commits);
        }
    }

    // Add all the commits from `existingRepos`.

    for (let name in existingRepos) {
        const repo = existingRepos[name];
        addCommitMap(repo.commits);
        const subs = repo.openSubmodules;
        for (let subName in subs) {
            const sub = subs[subName];
            addCommitMap(sub.commits);
        }
    }

    // Create a `RepoAST` argument from the specified `baseAST` and the
    // specified `rawRepo` that describes overrides.

    function makeRepoAST(baseAST, rawRepo) {
        const resultArgs = prepareASTArguments(baseAST, rawRepo);

        // Now we need to copy in necessary commits that weren't directly
        // included.

        function includeCommit(id) {
            copyCommitAndParents(resultArgs.commits, commits, id);
        }
        for (let branch in resultArgs.branches) {
            includeCommit(resultArgs.branches[branch]);
        }
        for (let ref in resultArgs.refs) {
            includeCommit(resultArgs.refs[ref]);
        }
        if (resultArgs.head) {
            includeCommit(resultArgs.head);
        }
        if (resultArgs.rebase) {
            includeCommit(resultArgs.rebase.originalHead);
            includeCommit(resultArgs.rebase.onto);
        }
        for (let remoteName in resultArgs.remotes) {
            const remote = resultArgs.remotes[remoteName];
            for (let branch in remote.branches) {
                includeCommit(remote.branches[branch]);
            }
        }
        return new RepoAST(resultArgs);
    }

    // Build the actual RepoAST objects.  This must be done as a separate step
    // so that commits may be used even if defined out of order.

    let result = Object.assign({}, existingRepos);

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
        else if ("E" === rawRepo.type) {
            assert.property(existingRepos, name, "existing repo reference");
            assert.notProperty(rawRepo,
                               "typeData",
                               `existing repo base reference takes no data`);
            baseAST = existingRepos[name];
        }
        else {
            baseAST = getBaseRepo(rawRepo.type, rawRepo.typeData);
            assert.isNotNull(baseAST,
                             `invalid base repo type ${rawRepo.type}`);
        }
        result[name] = makeRepoAST(baseAST, rawRepo);
    });

    // Set up open submodules: we require (nearly) complete ASTs to operate on,
    // but do not depend on whether or not the other repos have their open
    // submodules configured.

    Object.keys(result).forEach((name) => {
        // Skip non-parsed (i.e., from existing) repos.
        if (!(name in rawRepos)) {
            return;                                                   // RETURN
        }
        const rawResult = rawRepos[name];
        const openSubNames = Object.keys(rawResult.openSubmodules);
        if (0 !== openSubNames.length) {
            const ast = result[name];
            assert.isNotNull(ast.head,
                             `null head with open submodules for ${name}`);
            let openSubs = {};
            const index = RepoAST.renderIndex(ast.commits,
                                              ast.head,
                                              ast.index);
            openSubNames.forEach((subName) => {
                // Do some sanity checking of submodule and url.

                assert.property(index,
                                subName,
                                `${subName} not valid path in ${name}`);
                const sub = index[subName];
                assert.instanceOf(sub,
                                  RepoAST.Submodule,
                                  `${subName} not a submodule in ${name}`);

                // Configure the url for the sub-repo.  If it's in the form of
                // "../foo", translate it to "foo".

                let openUrl = sub.url;
                if (openUrl.startsWith("../")) {
                    openUrl = openUrl.substr(3);
                }
                assert.property(result,
                                openUrl,
`cannot find url ${openUrl} for submodule ${subName} in repo ${name}.`);

                // Configure the submodule using its origin repo as its base.
                // We configure it similar to a clone, but omitting current
                // branch and any local branches.

                const subBase = result[openUrl];
                const clone = RepoASTUtil.cloneRepo(subBase, openUrl);
                const origin = clone.remotes.origin;
                const rawSubRepo = rawResult.openSubmodules[subName];

                // Also, if the rawSubRepo (overrides) do not specified a HEAD,
                // use the `sha` from the submodule specification.  Note that
                // we can't put this sha in `baseSubAST` because it may point
                // to a commit that exists in the overrides but not in the base
                // repo.

                let head = rawSubRepo.head;
                if (!("head" in rawSubRepo)) {
                    head = sub.sha;
                }

                let subCommits = {};
                copyCommitAndParents(subCommits, commits, head);

                const baseSubAST = clone.copy({
                    branches: {},
                    currentBranchName: null,
                    remotes: { origin: new RepoAST.Remote(origin.url) },
                    commits: subCommits,
                    head: head,
                });

                openSubs[subName] = makeRepoAST(baseSubAST, rawSubRepo);
            });
            result[name] = ast.copy({
                openSubmodules: openSubs,
            });
        }
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
                    },
                    message: "the first commit",
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
    function makeU() {
        return new RepoAST({
            commits: {
                "1": new RepoAST.Commit({
                    changes: {
                        "README.md": "hello world",
                    },
                    message: "the first commit",
                }),
                "2": new RepoAST.Commit({
                    parents: ["1"],
                    changes: {
                        s: new RepoAST.Submodule("a", "1"),
                    },
                    message: "added 's'",
                }),
            },
            branches: {
                master: "2",
            },
            head: "2",
            currentBranchName: "master"
        });
    }
    return {
        S: makeS(),  // simple repo
        B: makeB(),  // bare repo
        U: makeU(),  // repo with a submodule named s pointing to a
    };
})();
