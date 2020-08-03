/*
 * Copyright (c) 2017, Two Sigma Open Source
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
 * this module is the entrypoint for the `commit-shadow` command.
 */

/**
 * help text for the `commit-shadow` command
 *
 * @property {String}
 */
exports.helpText =
    `Create a "shadow" commit, leaving index and HEAD unchanged.`;

/**
 * description of the `commit-shadow` comand
 *
 * @property {String}
 */
exports.description  = `Create a "shadow" commit containing all local
modifications (including untracked files if '--include-untracked' is specified,
include only files in the specified directories following '--include-subrepos' 
if it is specified, if unspecified all paths are considered) to all sub-repos 
and then print the SHA of the created commit.  If there are no local 
modifications, print the SHA of HEAD.  Do not modify the index or update HEAD 
to point to the created commit.  Note that this command ignores non-submodule 
changes to the meta-repo. Note also that this command is meant for programmatic 
use and its output format is stable.`;

/**
 * Configure the specified `parser` for the `commit` command.
 *
 * @param {ArgumentParser} parser
 */
exports.configureParser = function (parser) {
    parser.addArgument(["-u", "--include-untracked"], {
        required: false,
        action: "storeConst",
        constant: true,
        defaultValue: false,
        help: "include untracked files in the shadow commit",
    });
    parser.addArgument(["-m", "--message"], {
        type: "string",
        action: "append",
        required: true,
        help: "commit message for shadow commits",
    });
    parser.addArgument(["-e", "--epoch-timestamp"], {
        required: false,
        action: "storeConst",
        constant: true,
        defaultValue: false,
        help: "deprecated, but same as '--increment-timestamp'",
    });

    parser.addArgument(["-i", "--increment-timestamp"], {
        required: false,
        action: "storeConst",
        constant: true,
        defaultValue: false,
        help: "use timestamp of HEAD + 1 instead of current time",
    });
    parser.addArgument(["-s", "--include-subrepos"], {
        type: "string",
        required: false,
        nargs: "+",
        help: "only include specified sub-repos",
    });
};

/**
 * Execute the `commit-shadow` command according to the specified `args`.
 *
 * @async
 * @param {Object}  args
 * @param {String}  args.message
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const GitUtil   = require("../util/git_util");
    const StashUtil = require("../util/stash_util");

    const repo = yield GitUtil.getCurrentRepo();
    const incrementTimestamp =
                              args.increment_timestamp || args.epoch_timestamp;
    const includedSubrepos = args.include_subrepos || [];
    const message = args.message ? args.message.join("\n\n") : null;
    const result = yield StashUtil.makeShadowCommit(repo,
                                                    message,
                                                    incrementTimestamp,
                                                    false,
                                                    args.include_untracked,
                                                    includedSubrepos,
                                                    false);
    if (null === result) {
        const head = yield repo.getHeadCommit();
        console.log(head.id().tostrS());
    }
    else {
        console.log(result.metaCommit);
    }
});
