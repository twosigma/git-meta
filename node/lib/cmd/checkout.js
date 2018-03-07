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
const Hook = require("../util/hook");

/**
 * This module contains the entrypoint for the `checkout` command.
 */

exports.helpText = `Check out a commit in the meta-repository and each
(visible) submodule.  Fetch commits by SHA as needed for submodules`;

/**
 * Configure the sepcified `parser` for the `checkout` command.
 *
 * @param {ArgumentParser} parser
 */
exports.configureParser = function (parser) {

    parser.addArgument(["-b"], {
        dest: "new branch name",
        help: `Create a new branch to check out.`,
        nargs: 1,
    });

    parser.addArgument(["committish"], {
        type: "string",
        help: `
commit to check out.  If this <committish> is not found, but does \
match a single remote tracking branch, treat as equivalent to \
'checkout -b <committish> -t <remote>/<committish>'`,
        defaultValue: null,
        nargs: "?",
    });

    parser.addArgument(["-t", "--track"], {
        help: "Set tracking branch.",
        action: "storeConst",
        constant: true,
    });

    parser.addArgument(["-f", "--force"], {
        required: false,
        action: "storeConst",
        constant: true,
        help: `Overwrite conflicting local changes.`,
    });
};

/**
 * Execute the `checkout` command based on the supplied arguments.
 *
 * @async
 * @param {Object} args
 * @param {String} args.committish
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const colors  = require("colors");

    const Checkout  = require("../util/checkout");
    const GitUtil   = require("../util/git_util");
    let newBranch = null;
    let branchCheckout = "1";

    const newBranchNameArr = args["new branch name"];
    if (newBranchNameArr) {
        newBranch = newBranchNameArr[0];
    }
    const repo = yield GitUtil.getCurrentRepo();

    // Validate and determine what operation we're actually doing.

    const op = yield Checkout.deriveCheckoutOperation(repo,
                                                      args.committish,
                                                      newBranch,
                                                      args.track || false);

    // If we're already on this branch, note it and exit.

    if (null === op.newBranch && null !== op.switchBranch) {
        const current = yield GitUtil.getCurrentBranchName(repo);
        if (current === op.switchBranch) {
            console.log(`Already on branch ${colors.green(current)}.`);
            return;                                                   // RETURN
        }
    }

    // Remember if we were detached so we can tell the users if we become
    // detached.

    const wasDetached = repo.headDetached() !== 0;

    // Now, do the actual operation.

    yield Checkout.executeCheckout(repo,
                                   op.commit,
                                   op.newBranch,
                                   op.switchBranch,
                                   args.force || false);

    // Tell the user what we just did.

    if (null !== op.commit && null === op.switchBranch) {
        // In this case, we're not making a branch; just let the user know what
        // we checked out.
        
        branchCheckout = "0";
        console.log(`Checked out ${colors.green(args.committish)}.`);
    }

    // Run post-checkout hook.
    // Note: The hook is given three parameters: the ref of the previous HEAD,
    // the ref of the new HEAD (which may or may not have changed), and a flag
    // indicating whether the checkout was a branch checkout (changing
    // branches, flag = "1"), or a file checkout (retrieving a file from the
    // index, flag = "0").

    const headId = yield repo.getHeadCommit();
    const oldHead = headId.id().tostrS();
    const newHead = op.commit;
    yield Hook.execHook("post-checkout", [oldHead, newHead, branchCheckout]);
    // If we made a new branch, let the user know about it.

    const newB = op.newBranch;

    if (null !== newB) {
        const name = newB.name;
        console.log(`Created branch ${colors.green(name)}.`);
        const tracking = newB.tracking;
        if (null !== tracking) {
            if (null === tracking.remoteName) {
                console.log(`\
Configured ${colors.green(name)} to track local branch \
${colors.blue(tracking.branchName)}.`);
            }
            else {
                console.log(`\
Configured ${colors.green(name)} to track remote branch \
${colors.blue(tracking.branchName)} from \
${colors.blue(tracking.remoteName)}.`);
            }
        }
    }
    if (null !== op.switchBranch) {
        // Let the user know if we switched branches.

        console.log(`Switched to branch ${colors.green(op.switchBranch)}.`);
    }
    else if (null !== op.commit) {
        // If we just did a checkout and didn't switch branches, let the user
        // know if we transitioned to a detached state.

        if (!wasDetached) {
            console.log(`You are now in 'detached HEAD' state.`);
        }
    }
});
