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

const ArgParse = require("argparse");
const co       = require("co");

/**
 * This submodule provides the entrypoint for the `reset` command.
 */

/**
 * help text for the `reset` command
 * @property {String}
 */
exports.helpText = `Reset the current HEAD to a specified state.`;

/**
 * description of the `reset` command
 * @property {String}
 */
exports.description = `Change the state of the HEAD, index, and/or current
working directory for some or all of the tree.  This command can be used to
(simultaneously or separately) unstage files, undo changes to the working
directory, and change the commit pointed to by the current HEAD.  This
command should not be confused with the 'revert' command.  The 'reset'
command can be used to return a tree to a previous state in history; the
'revert' command, on the other hand, creates new commits that undo previous
changes.  After resetting the HEAD of the meta-repository, this command will
apply the same change to all open sub-repositories, changing their HEADs to
the commit indicated by the (new) HEAD in the meta-repository.  The index
and working directory of meta- and sub-repositories may or may not be affected
depending on which mode (soft, mixed, or hard) is used; see the documentation
for each mode for more information.
`;

/**
 * Configure the specified `parser` for the `reset` command.
 *
 * @param {ArgumentParser} parser
 */
exports.configureParser = function (parser) {

    parser.addArgument(["--soft"], {
        required: false,
        action: "storeConst",
        constant: true,
        help: `Do not change the working directory or index.`,
    });

    parser.addArgument(["--mixed"], {
        required: false,
        action: "storeConst",
        constant: true,
        help: `Unstage any changes, but do not alter the working dictory.  \
This mode is the default.`,
    });

    parser.addArgument(["--hard"], {
        required: false,
        action: "storeConst",
        constant: true,
        help: `Discard all changes and reset both working directory and index \
as specified by the selected commit.`
    });

    parser.addArgument(["commitish"], {
        type: "string",
        help: "commit to reset the head of the current branch to",
        defaultValue: null,
        required: false,
        nargs: ArgParse.Const.OPTIONAL,
    });

    // I want to use `Const.REMAINDER` here, but it doesn't work right; it
    // doesn't show 'path' in the command line list and doesn't behave any
    // differently that `ZERO_OR_MORE`; the `--` doesn't serve to delimit paths
    // from commitishes.

    parser.addArgument(["path"], {
        type: "string",
        help: `\
When paths are provided, git-meta resets the index entries for all <paths> to
their state at <commitish>. (It does not affect the working tree or the
current branch.)

This means that git meta reset <paths> is the opposite of git meta add
<paths>.`,
        nargs: ArgParse.Const.ZERO_OR_MORE,
    });
};

/**
 * Execute the `reset` command according to the specified `args`.
 *
 * @async
 * @param {Object}  args
 * @param {String}  [args.commitish]
 * @param {Boolean} args.mixed
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const path   = require("path");

    const GitUtil         = require("../util/git_util");
    const Hook            = require("../util/hook");
    const Reset           = require("../util/reset");
    const UserError       = require("../util/user_error");
    const StatusUtil      = require("../util/status_util");
    const PrintStatusUtil = require("../util/print_status_util");

    const repo = yield GitUtil.getCurrentRepo();

    // Figure out which commit to reset to.  If a commit was specified, look it
    // up.  Otherwise, use HEAD.

    let commit;
    let paths = args.path;
    if (args.commitish) {

        const commitish = args.commitish;
        const annotated = yield GitUtil.resolveCommitish(repo, commitish);

        // TODO: This is the workaround for the fact that argparse doesn't seem
        // to handle '--'correctly. E.g., if I set the 'path' argument above to
        // be 'ArgParse.Const.REMAINDER', and run:
        //
        // ```
        //    $ git meta reset -- foo
        // ```
        //
        // It populates 'committish' with "foo" instead of 'path'.  As I note
        // above, it also messes with my help text, so I've gone back to using
        // 'ZERO_OR_MORE'.  So, my logic is going to be that if 'committish'
        // can be resolved as a commit I'll treat it that way, otherwise I'l
        // treat it as a path.

        if (null === annotated) {
            paths = paths.concat(args.commitish);
        }
        else {
            commit = yield repo.getCommit(annotated.id());
        }
    }
    if (undefined === commit) {
        commit = yield repo.getHeadCommit();
    }

    // If we have one or more path, perform a path-based reset.

    if (0 !== paths.length) {
        if (args.soft || args.mixed || args.hard) {
            throw new UserError("Cannot specify mode with path-based reset.");
        }
        yield Reset.resetPaths(repo, process.cwd(), commit, paths);
        return;                                                       // RETURN
    }

    // Perform the reset.

    let type = Reset.TYPE.MIXED;

    if (args.soft + args.mixed + args.hard > 1) {
        throw new UserError("Cannot specify multiple modes.");
    }

    if (args.soft) {
        type = Reset.TYPE.SOFT;
    }
    else if (args.hard) {
        type = Reset.TYPE.HARD;
    }

    yield Reset.reset(repo, commit, type);

    // Then print out the new status.

    const repoStatus = yield StatusUtil.getRepoStatus(repo);
    const cwd = process.cwd();
    const relCwd = path.relative(repo.workdir(), cwd);
    const statusText = PrintStatusUtil.printRepoStatus(repoStatus, relCwd);
    process.stdout.write(statusText);

    // Run post-reset hook.
    yield Hook.execHook(repo, "post-reset");
});
