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

const DiffUtil = require("../util/diff_util");

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
    parser.addArgument(["-s", "--short"], {
        required: false,
        action: "storeConst",
        constant: true,
        help: "Give the output in a short format",
        dest: "shortFormat" //"short" is a reserved word in js
    });
    parser.addArgument(["-u", "--untracked-files"], {
        required: false,
        choices: [
            DiffUtil.UNTRACKED_FILES_OPTIONS.ALL,
            DiffUtil.UNTRACKED_FILES_OPTIONS.NORMAL,
            DiffUtil.UNTRACKED_FILES_OPTIONS.NO,
        ],
        constant: DiffUtil.UNTRACKED_FILES_OPTIONS.ALL,
        defaultValue: DiffUtil.UNTRACKED_FILES_OPTIONS.NORMAL,
        help: `show untracked files, optional modes: all, normal, no.
        (Default:normal)`,
        dest: "untrackedFilesOption",
        nargs: "?",
    });
    parser.addArgument(["path"], {
        type: "string",
        help: "paths to inspect for changes",
        nargs: "*",
    });
};

/**
 * Execute the status command according to the specified `args`.
 *
 * @async
 * @param {Object}   args
 * @param {Boolean}  args.shortFormat
 * @param {[String]} args.path
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const path = require("path");

    const GitUtil         = require("../util/git_util");
    const PrintStatusUtil = require("../util/print_status_util");
    const StatusUtil      = require("../util/status_util");

    const repo = yield GitUtil.getCurrentRepo();
    const workdir = repo.workdir();
    const cwd = process.cwd();
    const repoStatus = yield StatusUtil.getRepoStatus(repo, {
        cwd: cwd,
        paths: args.path,
        untrackedFilesOption: args.untrackedFilesOption
    });

    // Compute the current directory relative to the working directory of the
    // repo.

    const relCwd = path.relative(workdir, cwd);

    let text;
    if (args.shortFormat) {
        text = PrintStatusUtil.printRepoStatusShort(repoStatus, relCwd);
    } else {
        text = PrintStatusUtil.printRepoStatus(repoStatus, relCwd);
    }

    process.stdout.write(text);
});
