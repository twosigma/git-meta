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
 * This module contains methods for implementing the `add` command.
 */

/**
 * help text for the `add` command
 * @property {String}
 */
exports.helpText = `Add file contents to the index of the mono-repo.`;

/**
 * description of the `add` command
 * @property {String}
 */
exports.description =`
This command updates the (logical) mono-repo index using the current content
found in the working tree, to prepare the content staged for the next commit.
If a path is specified, this command will stage all modified content in the
meta-repo and submodules rooted in that path.  Note that the index of a
mono-repo is a logical construct derived from the state of the indices of its
meta-repo and open submodules.  Thus, content that is staged in a submodule
is added to the index for that submodule; the index of the meta-repo is not
affected.  Note also that from the perspective of the mono-repo, the status of
a submodule in the index is irrelevant: 'git meta commit' always stages changes
to submodules with new commits in their working directories.
`;

exports.configureParser = function (parser) {
    parser.addArgument(["-u", "--update"], {
        required: false,
        action: "storeConst",
        constant: true,
        help: "Update tracked files.",
        defaultValue:false
    });

    parser.addArgument(["-v", "--verbose"], {
        required: false,
        action: "storeConst",
        constant: true,
        help: `Log which files are added to / removed from the index`,
        defaultValue: false,
    });

    parser.addArgument(["--meta"], {
        required: false,
        action: "storeConst",
        constant: true,
        help: `
Include changes to the meta-repo; disabled by default to improve performance \
and avoid accidental changes to the meta-repo.`,
        defaultValue: false,
    });

    parser.addArgument(["paths"], {
        nargs: "*",
        type: "string",
        help: "the paths to add",
    });
};

/**
 * Execute the `add` command according to the specified `args`.
 *
 * @async
 * @param {Object}   args
 * @param {String[]} args.paths
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const colors = require("colors");

    const Add        = require("../util/add");
    const GitUtil    = require("../util/git_util");
    const StatusUtil = require("../util/status_util");
    const PrintStatusUtil = require("../util/print_status_util");

    const repo    = yield GitUtil.getCurrentRepo();
    const workdir = repo.workdir();
    const cwd     = process.cwd();

    let userPaths = args.paths;
    if (userPaths.length === 0) {
        if (args.update) {
            const repoStatus = yield StatusUtil.getRepoStatus(repo, {
                cwd: cwd,
                paths: args.path,
                untrackedFilesOption: args.untrackedFilesOption
            });

            const fileStatuses = PrintStatusUtil.accumulateStatus(repoStatus);
            const workdirChanges = fileStatuses.workdir;
            userPaths = workdirChanges.map(workdirChange => {
                return workdirChange.path;
            });
        }
        else {
            const text = "Nothing specified, nothing added.\n" +
                         `${colors.yellow("hint: Maybe you wanted to say ")}` +
                         `${colors.yellow("'git meta add .'?")}\n`;
            process.stdout.write(text);
            return;
        }
    }
    else {
        userPaths = args.paths.map(filename => {
            return GitUtil.resolveRelativePath(workdir, cwd, filename);
        });
    }
    yield Add.stagePaths(repo, userPaths, args.meta, args.update, args.verbose);
});
