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
source and target branches may be overridden.  Push synthetic-meta-refs for
each submodule with changes indicated by commits being pushed to the meta-repo.
Don't push to the meta-repo until the submodule pushes finish successfully.  Do
not consult the remotes configured for the submodules; instead, push the
synthetic-meta-ref for each submodule to a URL that is derived by resolving
its configured URL against the URL being pushed to by the meta-repo.`;

exports.configureParser = function (parser) {

    parser.addArgument(["-r", "--repository"], {
        type: "string",
        required: false,
        defaultValue: "origin",
        help: "name of remote to push to; 'origin' used if not specified",
    });

    parser.addArgument(["-s", "--source"], {
        type: "string",
        required: false,
        defaultValue: null,
        help: `name of local branch to push; active branch used if not
specified`,
    });

    parser.addArgument(["-t", "--target"], {
        type: "string",
        required: false,
        defaultValue: null,
        help: `name of target remote branch to push to; the name of the local
active branch is used if not specified`,
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
 * @param {String} [args.source]
 * @param {String} [args.target]
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const GitUtil = require("../util/git_util");
    const status = require("../util/status");
    const push = require("../util/push");

    const repo = yield GitUtil.getCurrentRepo();

    const repoStatus = yield status.getRepoStatus(repo);
    status.ensureConsistent(repoStatus);

    let activeBranchName = null;
    const getName = co.wrap(function *(inputName) {
        if (inputName) {
            return inputName;
        }
        if (null === activeBranchName) {
            const currentBranch = yield repo.getCurrentBranch();
            activeBranchName = currentBranch.shorthand();
        }
        return activeBranchName;
    });
    const source = yield getName(args.source);
    const target = yield getName(args.target);
    return push.push(repo,
                     args.repository,
                     source,
                     target,
                     args.force || false);
});
