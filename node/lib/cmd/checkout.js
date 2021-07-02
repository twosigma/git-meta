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

    parser.addArgument(["committish_or_file"], {
        type: "string",
        help: `if this resolves to a commit, check out that commit.
If this <committish> is not found, but does \
match a single remote tracking branch, treat as equivalent to \
'checkout -b <committish> -t <remote>/<committish>'.  Else, treat \
        as a file`,
        defaultValue: null,
        nargs: "?",
    });

    parser.addArgument(["files"], {
        type: "string",
        nargs: "*"
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

/*
Argparse literally can't represent git's semantics here.  Checkout
takes optional arguments [branch] and [files].  In git, anything after
"--" (hereinafter, "the separator") is part of "files".  So if you say
"git checkout -- myfile", it'll assume that last argument is a file.

There are two types of arguments that argparse recognizes: regular and
positional.  Branch can't be a non-required regular argument, because
regular arguments must have names which start with "-".  So it must be
a positional argument with nargs='?'.  In argparse, the right side of
"--" is always positional arguments.  And that means that the branch
will be read from the right side of the separator if it is not present
on the left side.

(Incidentally, the same is true of Python's argparse, of which node's
argparse is a port.)

Thanks, git, for using "--" for an utterly non-standard fashion.
*/
function reanalyzeArgs(args)  {
    const separatorIndex = process.argv.indexOf("--");
    if (separatorIndex === -1) {
        return;
    }

    const countAfterSeparator = (process.argv.length - 1) - separatorIndex;

    if (args.files.length !== countAfterSeparator) {
        const firstFile = args.committish_or_file;
        args.committish_or_file = null;
        args.files.splice(0, 0, firstFile);
    }
}

/**
 * Execute the `checkout` command based on the supplied arguments.
 *
 * @async
 * @param {Object} args
 * @param {String} args.committish
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    reanalyzeArgs(args);

    const colors  = require("colors");

    const Checkout  = require("../util/checkout");
    const GitUtil   = require("../util/git_util");
    const Hook      = require("../util/hook");
    const UserError = require("../../lib/util/user_error");
    let newBranch = null;

    const newBranchNameArr = args["new branch name"];
    if (newBranchNameArr) {
        newBranch = newBranchNameArr[0];
    }
    const repo = yield GitUtil.getCurrentRepo();
    const headId = yield repo.getHeadCommit();
    const zeroSha = "0000000000000000000000000000000000000000";
    const oldHead =  headId === null ? zeroSha : headId.id().tostrS();

    // Validate and determine what operation we're actually doing.

    let committish = args.committish_or_file;
    let files = args.files;

    if (files.length > 0 && newBranch) {
        throw new UserError(`Cannot update paths and switch to branch
                            '${newBranch}' at the same time.`);
    }

    const op = yield Checkout.deriveCheckoutOperation(repo,
                                                      committish,
                                                      newBranch,
                                                      args.track || false,
                                                      files);

    if (null === op.commit && !op.checkoutFromIndex && null === op.newBranch) {
        throw new UserError(`pathspec '${committish}' did not match any \
file(s) known to git.`);
    }

    const newHead = op.commit;

    // If we're going to check out files, just do that
    if (op.resolvedPaths !== null &&
        Object.keys(op.resolvedPaths).length !== 0) {
        yield Checkout.checkoutFiles(repo, op);
        yield Hook.execHook(repo, "post-checkout",
                            [oldHead, newHead, "0"]);
        return;
    }

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

        process.stderr.write(`Checked out ${colors.green(committish)}.\n`);
    }

    // Run post-checkout hook.
    // Note: The hook is given three parameters: the ref of the previous HEAD,
    // the ref of the new HEAD (which may or may not have changed), and a flag
    // indicating whether the checkout was a branch checkout (changing
    // branches, flag = "1"), or a file checkout (retrieving a file from the
    // index, flag = "0").

    yield Hook.execHook(repo, "post-checkout",
                        [oldHead, newHead, "1"]);
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
