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
 * This module contains methods for pushing.
 */

/**
 * help text for the `push` command
 * @property {String}
 */
exports.helpText = `Push commits from meta-repo and visible sub-repos.`;

/**
 * description of the `push` command
 * @property {String}
 */
exports.description =`
Push commits from all (visible) sub-repositories and the meta-repository.  By
default, this command pushes from the current branch to a branch with the
same name in the 'origin' repository.  The name of the remote, as well as the
source and target branches may be overridden.  This command will do refuse to
push the meta-repository unless the remote pushes succeed and the pushed
branches contain the commits indicated by the submodules in
the meta-repository.`;

exports.configureParser = function (parser) {

    parser.addArgument("repository", {
        type: "string",
        nargs: "?",
        defaultValue: "origin",
        help: `remote repository that is the destination of a push; can either
be a URL or name of a remote; 'origin' used if not specified`,
    });

    parser.addArgument("refspec", {
        type: "string",
        nargs: "*",
        defaultValue: null,
        help: `(optional) plus, follow by a source ref, (optionally) followed
by a : and a destination ref <dst>; will push branch to destination branch
if not specified.`,
    });

    parser.addArgument(["-f", "--force"], {
        required: false,
        action: "storeConst",
        constant: true,
        help: `Attempt to push even if not a fast-forward change.`,
    });
};

/**
 * Execute the push command according to the specified `args`.
 *
 * @async
 * @param {Object} args
 * @param {String} args.repository
 * @param {String} [args.refspec]
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const GitUtil = require("../util/git_util");
    const status = require("../util/status");
    const push = require("../util/push");

    const repo = yield GitUtil.getCurrentRepo();

    const repoStatus = yield status.getRepoStatus(repo);
    status.ensureConsistent(repoStatus);

    let strRefspecs = [];
    if (0 === args.refspec.length) {
        const currentBranch = yield repo.getCurrentBranch();
        const activeBranchName = currentBranch.shorthand();
        strRefspecs.push(activeBranchName + ":" + activeBranchName);
    } else {
        strRefspecs = strRefspecs.concat(args.refspec);
    }

    yield strRefspecs.map(co.wrap(function *(strRefspec) {
        const refspec = GitUtil.parseRefspec(strRefspec);
        yield push.push(repo,
            args.repository,
            refspec.src,
            refspec.dst,
            args.force || refspec.force || false);
    }));
});
