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
const colors = require("colors/safe");

/**
 * This module contains methods for pulling.
 */

/**
 * help text for the `pull` command
 * @property {String}
 */
exports.helpText = `Show the working tree status.`;

/**
 * description of the `pull` command
 * @property {String}
 */
exports.description =`
Displays paths that have differences between the index file and the current
HEAD commit, paths that have differences between the working tree and the
index file, and paths in the working tree that are not tracked. The first are
what you would commit by running git commit; the second and third are what you
could commit by running git add before running git commit.  Output is grouped
sub-repo.  Also show diagnostic information if the repository is in consistent
state, e.g., when a sub-repo is on a different branch than the meta-repo.`;

exports.configureParser = function (parser) {

    parser.addArgument(["-s", "--sub-repo"], {
        type: "string",
        required: false,
        action: "append",
        help: `show the status of only the named sub-repo(s); may be specified
multiple times`,
    });

    parser.addArgument(["-l", "--list-submodules"], {
        defaultValue: false,
        required: false,
        action: "storeConst",
        constant: true,
        help: `show one-line summary of each open submodule: the current \
SHA-1 for that submodule, followed by its name`
    });

    parser.addArgument(["-v", "--verbose"], {
        defaultValue: false,
        required: false,
        action: "storeConst",
        constant: true,
        help: `show one-line summary of each submodule: a '-' if the \
submodule is closed, followed by the current SHA-1 for \
that submodule, followed by its name. `
    });
};

/**
 * Execute the pull command according to the specified `args`.
 *
 * @async
 * @param {Object}  args
 * @param {Boolean} args.any
 * @param {String}  repository
 * @param {String}  [source]
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const GitUtil       = require("../util/git_util");
    const Status        = require("../util/status");

    const repo = yield GitUtil.getCurrentRepo();
    const repoStatus = yield Status.getRepoStatus(repo);
    const subStats = repoStatus.submodules;

    // If the user specified sub-repo names, validate them.

    if (null !== args.sub_repo) {
        let failed = false;
        args.sub_repo.forEach(name => {
            if (!(name in subStats)) {
                console.error(`
${colors.cyan(name)} is not the name of a sub-repo in this repository.`
                             );
            failed = true;
        }
        });

        if (failed) {
            process.exit(-1);
        }
    }

    function doStatus() {
        let text;
        if (null === args.sub_repo) {
            text = Status.printRepoStatus(repoStatus);
        }
        else {
            text = Status.printSubmodulesStatus(repoStatus, args.sub_repo);
        }
        process.stdout.write(text);
    }

    function doSummary(showClosed) {
        let requestedNames;
        if (null === args.sub_repo) {
            requestedNames = Object.keys(subStats);
        }
        else {
            requestedNames = args.sub_repo;
        }
        requestedNames = requestedNames.sort();

        requestedNames.forEach(name => {
            const sub = subStats[name];
            const isVis = null !== sub.repoStatus;
            const visStr = isVis ? " " : "-";
            const sha = sub.indexSha || "<deleted>";
            if (isVis || showClosed) {
                console.log(`${visStr} ${sha}  ${colors.cyan(name)}`);
            }
        });
    }

    if (args.verbose) {
        console.log(`${colors.grey("All submodules: ")}`);
        doSummary(true);
        console.log(`${colors.grey("\nWorking tree: ")}`);
        doStatus();
    }
    else if (args.list_submodules) {
        console.log(`${colors.grey("Open submodules: ")}`);
        doSummary(false);
    }
    else {
        doStatus();
    }
});
