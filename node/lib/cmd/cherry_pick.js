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

const co = require("co");
const Hook = require("../util/hook");

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
        nargs: "?",
        type: "string",
        help: "the commit to cherry-pick",
    });
    parser.addArgument(["--continue"], {
        action: "storeConst",
        constant: true,
        help: "continue an in-progress cherry-pick",
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

/**
 * Execute the `cherry-pick` command according to the specified `args`.
 *
 * @async
 * @param {Object}   args
 * @param {String[]} args.commit
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const colors = require("colors");

    const CherryPickUtil  = require("../util/cherry_pick_util");
    const GitUtil         = require("../util/git_util");
    const UserError       = require("../util/user_error");

    const repo = yield GitUtil.getCurrentRepo();

    if (args.continue + args.abort > 1) {
        throw new UserError("Cannot use continue and abort together.");
    }

    if (args.continue) {
        if (null !== args.commit) {
            throw new UserError("Cannot specify a commit with '--continue'.");
        }
        const result = yield CherryPickUtil.continue(repo);
        if (null !== result.errorMessage) {
            throw new UserError(result.errorMessage);
        }
        return;                                                       // RETURN
    }

    if (args.abort) {
        if (null !== args.commit) {
            throw new UserError("Cannot specify a commit with '--abort'.");
        }
        yield CherryPickUtil.abort(repo);
        return;                                                       // RETURN
    }

    if (null === args.commit) {
        throw new UserError("No commit to cherry-pick.");
    }

    const commitish = args.commit;
    const annotated = yield GitUtil.resolveCommitish(repo, commitish);
    if (null === annotated) {
        throw new UserError(`\
Could not resolve ${colors.red(commitish)} to a commit.`);
    }
    else {
        const id = annotated.id();
        console.log(`Cherry-picking commit ${colors.green(id.tostrS())}.`);
        const commit = yield repo.getCommit(id);
        const result = yield CherryPickUtil.cherryPick(repo, commit);
        if (null !== result.errorMessage) {
            throw new UserError(result.errorMessage);
        }
    }

    // Run post-commit hook as regular git.
    yield Hook.execHook(repo, "post-commit");
});
