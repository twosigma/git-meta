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

const ForcePushSpec = require("../util/force_push_spec");

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

    parser.addArgument("repository", {
        type: "string",
        nargs: "?",
        defaultValue: null,
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
        constant: ForcePushSpec.Force,
        defaultValue: ForcePushSpec.NoForce,
        help: `Attempt to push even if not a fast-forward change.`,
    });

    parser.addArgument(["--force-with-lease"], {
        required: false,
        action: "storeConst",
        constant: ForcePushSpec.ForceWithLease,
        dest: "force",
        help: `Force-push only if the remote ref is in the expected state
(i.e. matches the local version of that ref)`,
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
    const push = require("../util/push");

    const repo = yield GitUtil.getCurrentRepo();

    // TODO: this all needs to move into the `util` and get a test driver.

    const branch = yield repo.getCurrentBranch();
    const tracking = (yield GitUtil.getTrackingInfo(repo, branch)) || {};

    // The repo is the value passed by the user, the tracking branch's remote,
    // or just "origin", in order of preference.

    const remoteName = args.repository || tracking.pushRemoteName || "origin";

    let strRefspecs = [];
    if (0 === args.refspec.length) {
        // We will use the `push.default` `upstream` strategy for now: (see
        // https://git-scm.com/docs/git-config).
        // That is, if there is a tracking (merge) branch configured, and the
        // remote for that branch is the one we're pushing to, we'll use it.
        // Otherwise, we fall back on the name of the active branch.
        //
        // TODO: read and adhere to the configured value for `push.default`.

        const activeBranchName = branch.shorthand();
        let targetName = activeBranchName;
        if (null !== tracking.branchName &&
            remoteName === tracking.remoteName) {
            targetName = tracking.branchName;
        }
        strRefspecs.push(activeBranchName + ":" + targetName);
    } else {
        strRefspecs = strRefspecs.concat(args.refspec);
    }

    yield strRefspecs.map(co.wrap(function *(strRefspec) {
        const refspec = GitUtil.parseRefspec(strRefspec);
        // Force-push if the refspec explicitly tells us to do so (i.e. is
        // prefixed with a '+').
        const force = refspec.force ? ForcePushSpec.Force : args.force;

        // If 'src' is empty, this is a deletion.  Do not use the normal meta
        // push; there is no need to, e.g., push submodules, in this case.

        if ("" !== refspec.src) {
            yield push.push(repo,
                            remoteName,
                            refspec.src,
                            refspec.dst,
                            force);
        }
        else {
            yield GitUtil.push(repo,
                               remoteName,
                               "",
                               refspec.dst,
                               force);
        }
    }));
});
