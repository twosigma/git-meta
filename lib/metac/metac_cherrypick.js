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
 * This module contains methods for implementing the `cherry-pick` command.
 */

/**
 * name of the `cherry-pick` command
 * @property {String}
 */
exports.command = `cherry-pick`;

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
Apply some commits to the HEAD of the current branch.  This command will not
execute if any visible repositories, including the meta-repository, have
uncommitted modifications.  Each commit must identify a change in the
meta-repository.  For each commit specified, cherry-pick the changes identified
in that commit to the meta-repository.  If the change indicates new commits
in a sub-repository, cherry-pick those changes in the respective
sub-repository, opening it if necessary.  Only after all sub-repository commits
have been "picked" will the commit in the meta-repository be made.`;

exports.configureParser = function (parser) {
    parser.addArgument(["commits"], {
        nargs: "+",
        type: "string",
        help: "the commits to cherry-pick",
    });
};

/**
 * Execute the `cherry-pick` command according to the specified `args`.
 *
 * @async
 * @param {Object}   args
 * @param {String[]} args.commits
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    // TODO:
    // - abort
    // - continue

    const colors = require("colors");

    const CherryPick = require("../metau/metau_cherrypick");
    const GitUtil    = require("../metau/metau_gitutil");
    const Status     = require("../metau/metau_status");

    const repo = yield GitUtil.getCurrentRepo();
    yield Status.ensureCleanAndConsistent(repo);

    for (let i = 0; i < args.commits.length; ++i) {
        let commitish = args.commits[i];
        let result = yield GitUtil.resolveCommitish(repo, commitish);
        if (null === result) {
            console.error(`Could not resolve ${colors.red(commitish)} to a \
commit.`);
            process.exit(-1);
        }
        else {
            console.log(`Cherry-picking commit ${colors.green(result.id())}.`);
            let commit = yield repo.getCommit(result.id());
            yield CherryPick.cherryPick(repo, commit);
        }
    }
});
