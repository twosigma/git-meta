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

const co = require("co");

/**
 * This module contains methods for implementing the `rebase` command.
 */

/**
 * help text for the `rebase` command
 * @property {String}
 */
exports.helpText = `rewrite commits onto another branch`;

/**
 * description of the `rebase` command
 * @property {String}
 */
exports.description =`Rewrite commits on the current branch onto a target.
This command will not execute if any visible repositories, including the
meta-repository, have uncommitted modifications.  The specified commitish must
resolve to a commit in the meta-repository.  If the change indicates new
commits in a sub-repository, rebase those changes in the respective
sub-repository, opening it if necessary.`;

exports.configureParser = function (parser) {
    parser.addArgument(["commit"], {
        type: "string",
        help: "the commitish to rebase onto",
        defaultValue: null,
        nargs: "?",
    });
    parser.addArgument(["--abort"], {
        action: "storeConst",
        constant: true,
        help: "abort an in-progress rebase",
    });
    parser.addArgument(["--continue"], {
        action: "storeConst",
        constant: true,
        help: "continue an in-progress rebase",
    });
};

/**
 * Execute the `rebase` command according to the specified `args`.
 *
 * @async
 * @param {Object} args
 * @param {String} args.commit
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    // TODO: add applicable `git rebase` options.

    const colors = require("colors");

    const RebaseUtil  = require("../util/rebase_util");
    const GitUtil     = require("../util/git_util");
    const UserError   = require("../util/user_error");

    const repo = yield GitUtil.getCurrentRepo();
    if (args.abort && args.continue) {
        throw new UserError("Cannot use 'continue' and 'abort' together.");
    }

    if (args.abort) {
        yield RebaseUtil.abort(repo);
    }
    else if (args.continue) {
        const result = yield RebaseUtil.continue(repo);
        if (null !== result.errorMessage) {
            throw new UserError(result.errorMessage);
        }
    }
    else {
        let commitName = args.commit;
        if (null === commitName) {
            commitName = yield GitUtil.getCurrentTrackingBranchName(repo);
        }
        if (null === commitName) {
            throw new UserError(`No onto committish specified.`);
        }
        const committish = yield GitUtil.resolveCommitish(repo, commitName);
        if (null === committish) {
            throw new UserError(
                  `Could not resolve ${colors.red(commitName)} to a commit.`);
        }
        const commit = yield repo.getCommit(committish.id());
        const result = yield RebaseUtil.rebase(repo, commit);
        if (null !== result.errorMessage) {
            throw new UserError(result.errorMessage);
        }
    }
});
