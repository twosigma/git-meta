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
 * This module contains methods for implementing the `merge` command.
 */

/**
 * help text for the `merge` command
 * @property {String}
 */
exports.helpText = `merge a commit into the current branch`;

/**
 * description of the `merge` command
 * @property {String}
 */
exports.description =` Merge changes into the current branch.  This command
will not execute if any visible repositories, including the meta-repository,
have uncommitted modifications.  The specified commitish must resolve to a
commit in the meta-repository.  If the change indicates new commits in a
sub-repository, merge those changes in the respective sub-repository, opening
it if necessary.  Only after all sub-repository commits have been merged will
the commit in the meta-repository be made.`;

exports.configureParser = function (parser) {
    parser.addArgument(["commit"], {
        type: "string",
        help: "the commitish to merge"
    });
};

/**
 * Execute the `merge` command according to the specified `args`.
 *
 * @async
 * @param {Object} args
 * @param {String} args.commit
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    // TODO: add applicable `git merge` options.
    // TODO: For now, we will always create a merge commit.  We should be able
    // to control whether FF is allowed/required for meta and sub repos.

    const colors = require("colors");

    const Merge   = require("../metau/metau_merge");
    const GitUtil = require("../metau/metau_gitutil");
    const Status  = require("../metau/metau_status");

    const repo = yield GitUtil.getCurrentRepo();
    yield Status.ensureCleanAndConsistent(repo);
    const commitish = yield GitUtil.resolveCommitish(repo, args.commit);
    if (null === commitish) {
        console.error(`Could not resolve ${colors.red(args.commit)} to a \
commit.`);
        process.exit(-1);
    }
    const commit = yield repo.getCommit(commitish.id());
    yield Merge.merge(repo, commit, args.commit);
});
