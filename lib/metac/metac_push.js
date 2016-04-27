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
 * name of the `push` command
 * @property {String}
 */
exports.command = `push`;

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
    const GitUtil = require("../metau/metau_gitutil");
    const status = require("../metau/metau_status");
    const push = require("../metau/metau_push");

    const repo = yield GitUtil.getCurrentRepo();

    yield status.ensureConsistent(repo);

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
    return push.push(repo, args.repository, source, target);
});
