/*
 * Copyright (c) 2022, Two Sigma Open Source
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

const co = require("co");
const range = require("git-range");

const GitUtil   = require("../util/git_util");
const UserError = require("../util/user_error");

/**
 * This module contains methods for implementing the `cherry-pick` command.
 */

/**
 * help text for the `cherry-pick` command
 * @property {String}
 */
exports.helpText = `copy one or more existing commits, creating new commits.`;

/**
 * description of the `cherry-pick` command
 * @property {String}
 */
exports.description =`
Apply a commit to the HEAD of the current branch.  This command will not
execute if any visible repositories have uncommitted modifications.
Cherry-pick looks at the changes introduced by this commit and
applies them to HEAD, rewriting new submodule commits if they cannot be
fast-forwarded.`;

exports.configureParser = function (parser) {
    parser.addArgument(["commit"], {
        nargs: "*",
        type: "string",
        help: "the commit to cherry-pick",
    });
    parser.addArgument(["--continue"], {
        action: "storeConst",
        constant: true,
        help: "continue an in-progress cherry-pick",
    });
    parser.addArgument(["-n", "--no-commit"], {
        action: "storeConst",
        constant: true,
        help: `cherry-picked commits are followed by a soft reset, leaving all
         changes as staged instead of as commits.`,
    }); 
    // TODO: Note that ideally we might do something similar to
    // `git reset --merge`, but that would be (a) tricky and (b) it can fail,
    // leaving the cherry-pick still in progress.

    parser.addArgument(["--abort"], {
        action: "storeConst",
        constant: true,
        help: `\
abort the cherry-pick and return to previous state, throwing away all changes`,
    });
};


exports.isRange = function(spec) {
    // note that this includes ^x, which is not precisely a range
    return spec.search("\\.\\.|\\^[@!-]|^\\^") !== -1;
};

exports.resolveRange = co.wrap(function *(repo, commitArg) {
    const colors  = require("colors");

    // range.parse doesn't offer "--no-walk", so if you pass in an arg
    // that doesn't specify a range (["morx", "fleem"], say, as opposed to
    // "morx..fleem"), it'll give all of the commits which are parents
    // of HEAD.  But ^morx fleem is treated as morx..fleem.

    // So we need to do some pre-parsing.

    // I did some basic testing to ensure that git-range matches the
    // selection and ordering that git cherry-pick uses, and it seems
    // to be correct (including in the surprising case where git
    // cherry-pick will use the topological ordering of commits rather
    // than the order given on the command-line).

    let commits = [];
    if (commitArg.some(exports.isRange)) {
        for (const arg of commitArg) {
            if (arg.search("^@") !== -1) {
                // TODO: patch git-range
                throw new UserError(`\
Could not handle ${arg}, because git-range does not support --no-walk.
Please pre-parse these args using regular git.`);
            }
        }
        const r = yield range.parse(repo, commitArg);
        commits = yield r.commits();
    } else {
        for (let commitish of commitArg) {
            let annotated = yield GitUtil.resolveCommitish(repo, commitish);
            if (null === annotated) {
                throw new UserError(`\
Could not resolve ${colors.red(commitish)} to a commit.`);
            }
            const commit = yield repo.getCommit(annotated.id());
            commits.push(commit);
        }
    }
    if (commits.length === 0) {
        throw new UserError(`empty commit set passed`);
    }
    return commits;
});

/**
 * Execute the `cherry-pick` command according to the specified `args`.
 *
 * @async
 * @param {Object}   args
 * @param {String[]} args.commit
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const path            = require("path");
    const Reset           = require("../util/reset");
    const Hook            = require("../util/hook");
    const StatusUtil      = require("../util/status_util");
    const PrintStatusUtil = require("../util/print_status_util");
    const CherryPickUtil  = require("../util/cherry_pick_util");

    const repo = yield GitUtil.getCurrentRepo();

    if (args.continue + args.abort > 1) {
        throw new UserError("Cannot use continue and abort together.");
    }

    if (args.continue) {
        if (args.commit.length) {
            throw new UserError("Cannot specify a commit with '--continue'.");
        }
        const result = yield CherryPickUtil.continue(repo);
        if (null !== result.errorMessage) {
            throw new UserError(result.errorMessage);
        }
        return;                                                       // RETURN
    }

    if (args.abort) {
        if (args.commit.length) {
            throw new UserError("Cannot specify a commit with '--abort'.");
        }
        yield CherryPickUtil.abort(repo);
        return;                                                       // RETURN
    }

    if (!args.commit.length) {
        throw new UserError("No commit to cherry-pick.");
    }

    // TOOD: check if we are mid-rebase already

    const commits = yield exports.resolveRange(repo, args.commit);
    const result = yield CherryPickUtil.cherryPick(repo, commits);

    if (null !== result.errorMessage) {
        throw new UserError(result.errorMessage);
    }

    if (args.no_commit) {
        const commitish = `HEAD~${commits.length}`;
        const annotated = yield GitUtil.resolveCommitish(repo, commitish);
        const commit = yield repo.getCommit(annotated.id());
        yield Reset.reset(repo, commit, Reset.TYPE.SOFT);

        const repoStatus = yield StatusUtil.getRepoStatus(repo);
        const cwd = process.cwd();
        const relCwd = path.relative(repo.workdir(), cwd);
        const statusText = PrintStatusUtil.printRepoStatus(repoStatus, relCwd);
        process.stdout.write(statusText);

        yield Hook.execHook(repo, "post-reset");
    }
});
