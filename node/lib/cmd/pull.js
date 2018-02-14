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

/**
 * This module contains methods for pulling.
 */

/**
 * help text for the `pull` command
 * @property {String}
 */
exports.helpText = `pull commits into the meta-repo and open sub-repos`;

/**
 * description of the `pull` command
 * @property {String}
 */
exports.description =`
Pull commits from the meta-repository and visible sub-repositories.  This
command will not execute if any visible repositories, including the
meta-repository, have uncommitted modifications.  The pull command does not
generate merge commits; local commits are rebased on top of pulled commits.`;

exports.configureParser = function (parser) {

    parser.addArgument(["repository"], {
        type: "string",
        nargs: "?",
        defaultValue: null,
        help: `name of remote from which to pull; 'origin' used if not
specified`,
    });

    parser.addArgument(["source"], {
        type: "string",
        nargs: "?",
        defaultValue: null,
        help: `name of remote branch from which to pull; active branch name
used if not specified`,
    });

    parser.addArgument(["--rebase"], {
        help: "rebase local changes on top of pulled commits",
        action: "storeConst",
        constant: true,
    });
};

/**
 * Execute the pull command according to the specified `args`.
 *
 * @async
 * @param {Object}  args
 * @param {Boolean} args.rebase
 * @param {String}  repository
 * @param {String}  [source]
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const GitUtil   = require("../util/git_util");
    const pull      = require("../util/pull");
    const UserError =  require("../util/user_error");

    const repo = yield GitUtil.getCurrentRepo();
    const branch = yield repo.getCurrentBranch();

    if (!(yield pull.userWantsRebase(args, repo, branch))) {
        throw new UserError("Non-rebase pull not supported.");
    }

    // TODO: move the following code into `util/push.js` and add test

    const tracking = (yield GitUtil.getTrackingInfo(repo, branch)) || {};

    // The source branch is (in order of preference): the name passed on the
    // commandline, the tracking branch name, or the current branch name.

    const source = args.source || tracking.branchName || branch.shorthand();

    // The repo is the value passed by the user, the tracking branch's remote,
    // or just "origin", in order of preference.

    const remoteName = args.repository || tracking.remoteName || "origin";

    return yield pull.pull(repo, remoteName, source);
});
