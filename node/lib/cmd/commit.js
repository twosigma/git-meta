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
 * this module is the entrypoint for the `commit` command.
 */

// TODO: I need to move the bodies of `doCommit` and `doAmend` into the util
// and create test drivers for them.  I hadn't yet because these methods
// may require user interaction, but I think that's actually pretty easy to
// stub out.

/**
 * help text for the `commit` command
 *
 * @property {String}
 */
exports.helpText = `Commit modifications in local repositories and the
meta-repository to point to these new commits.`;

/**
 * Configure the specified `parser` for the `commit` command.
 *
 * @param {ArgumentParser} parser
 */
exports.configureParser = function (parser) {
    parser.addArgument(["-a", "--all"], {
        defaultValue: false,
        required: false,
        action: "storeConst",
        constant: true,
        help: "commit all changed files",
    });
    parser.addArgument(["-m", "--message"], {
        type: "string",
        action: "append",
        required: false,
        help: "commit message; if not specified will prompt"
    });
    parser.addArgument(["--amend"], {
        required: false,
        action: "storeConst",
        constant: true,
        help: `\
Amend the last commit, including newly staged changes and, (if -a is \
specified) modifications.  Will fail unless all submodules changed in HEAD \
have matching commits and have no new commits.`,
    });
    parser.addArgument(["--no-edit"], {
        required: false,
        action: "storeConst",
        defaultValue: false,
        constant: true,
        help: `When amending, reuse previous messages without editing.`,
    });
    parser.addArgument(["--no-verify"], {
        required: false,
        action: "storeConst",
        defaultValue: false,
        constant: true,
        help: `This option bypasses the pre-commit hooks.`,
    });
    parser.addArgument(["-i", "--interactive"], {
        required: false,
        action: "storeConst",
        defaultValue: false,
        constant: true,
        help: `\
Interactively choose which meta- and sub-repositories to commit, and what
message to use with each one.`,
    });
    parser.addArgument(["file"], {
        type: "string",
        help: `\
When files are provided, this command ignores changes staged in the index,
and instead records the current content of the listed files (which must already
be known to Git).  Note that this command is incompatible with  the '-a' option
and submodule configuration changes (i.e., those that add, remove, or change
the URL of submodules).`,
        nargs: "*",
    });
};

const doCommit = co.wrap(function *(args) {
    const Commit  = require("../util/commit");
    const GitUtil = require("../util/git_util");
    const Hook = require("../util/hook");

    const repo = yield GitUtil.getCurrentRepo();
    const cwd = process.cwd();
    const message = args.message ? args.message.join("\n\n") : null;

    yield Commit.doCommitCommand(repo,
                                 cwd,
                                 message,
                                 args.all,
                                 args.file,
                                 args.interactive,
                                 args.no_verify,
                                 true);
    yield Hook.execHook(repo, "post-commit");
});

const doAmend = co.wrap(function *(args) {
    const Commit             = require("../util/commit");
    const GitUtil            = require("../util/git_util");
    const Hook               = require("../util/hook");
    const SequencerStateUtil = require("../util/sequencer_state_util");
    const UserError          = require("../util/user_error");

    const usingPaths = 0 !== args.file.length;
    const message = args.message ? args.message.join("\n\n") : null;

    if (usingPaths) {
        throw new UserError("Paths not supported with amend yet.");
    }

    const repo = yield GitUtil.getCurrentRepo();
    const cwd = process.cwd();

    const seq = yield SequencerStateUtil.readSequencerState(repo.path());
    if (seq) {
        const ty = seq.type.toLowerCase();
        const msg = "You are in the middle of a " + ty + " -- cannot amend.";
        throw new UserError(msg);
    }

    yield Commit.doAmendCommand(repo,
                                cwd,
                                message,
                                args.all,
                                args.interactive,
                                args.no_verify,
                                !args.no_edit);
    yield Hook.execHook(repo, "post-commit");
});

/**
 * Exeucte the `commit` command according to the specified `args`.
 *
 * @async
 * @param {Object}  args
 * @param {Boolean} args.all
 * @param {String}  [args.message]
 */
exports.executeableSubcommand = function (args) {
    if (args.no_edit && !args.amend) {
        console.error("The '--no-edit' flag makes sense only when amending.");
        process.exit(1);
    }
    if (args.no_edit && null !== args.message) {
        console.error(
                  "Does not make sense to supply a message with '--no-edit'.");
        process.exit(1);
    }
    if (args.all && 0 !== args.file.length) {
        console.error("The use of '-a' and files does not make sense.");
        process.exit(1);
    }
    if (args.message && args.interactive) {
        console.error("The use of '-i' and '-m' does not make sense.");
        process.exit(1);
    }
    if (args.all && args.interactive) {
        console.error("The use of '-i' and '-a' does not make sense.");
        process.exit(1);
    }
    if (args.amend) {
        return doAmend(args);                                         // RETURN
    }
    return doCommit(args);
};
