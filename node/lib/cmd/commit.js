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
        defaultValue: null,
        required: false,
        help: "commit message; if not specified will prompt"
    });
};

// Ignore the line len warning for the next two lines, which cannot be broken.
/*jshint -W101*/
// http://stackoverflow.com/questions/25245716/remove-all-ansi-colors-styles-from-strings
const stripColor = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
/*jshint +W101*/

const commitMessagePrefix = `\

# Please enter the commit message for your changes. Lines starting
# with '#' will be ignored, and an empty message aborts the commit.
`;

/**
 * Exeucte the `commit` command according to the specified `args`.
 *
 * @async
 * @param {Object}  args
 * @param {Boolean} args.all
 * @param {String}  [args.message]
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const Commit     = require("../util/commit");
    const GitUtil    = require("../util/git_util");
    const Status     = require("../util/status");

    const repo = yield GitUtil.getCurrentRepo();
    const repoStatus = yield Status.getRepoStatus(repo);

    function warnNothing() {
        console.warn("Nothing to commit.");
    }

    // If there are no staged changes, and we either didn't specify "all" or we
    // did but there are no working directory changes, warn the user and exit
    // early.

    if (repoStatus.isIndexDeepClean() &&
        (!args.all || repoStatus.isWorkdirDeepClean())) {
        warnNothing();
        return;
    }

    if (null === args.message) {
        let status = Status.printRepoStatus(repoStatus);

        // TODO: in an upcoming change, I'm going to factor this logic out of
        // the plain `status` code used by `git-meta status` and have
        // commit-specified formatting so this color stripping will be
        // unnecessary.

        // Remove color characters.

        status = status.replace(stripColor, "");
        let lines = status.split("\n");
        lines = lines.slice(0, lines.length - 1);
        const commentLines = lines.map(line => "" === line ? "#" : "# " + line);
        const initialMessage = commitMessagePrefix + commentLines.join("\n");
        const rawMessage = yield GitUtil.editMessage(repo, initialMessage);
        args.message = GitUtil.stripMessage(rawMessage);
    }

    if ("" === args.message) {
        console.error("Aborting commit due to empty commit message.");
        process.exit(1);
    }

    const result = yield Commit.commit(repo,
                                       args.all,
                                       repoStatus,
                                       args.message);
    if (null === result) {
        warnNothing();
    }
});
