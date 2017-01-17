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
 * This module contains the command entry point for direct interactions with
 * submodules.
 */

/**
 * help text for the `submodule` command
 * @property {String}
 */
exports.helpText = `Submodule-specific commands.`;

/**
 * description of the `submodule` command
 * @property {String}
 */
exports.description =`
Provide commands pertaining to submodules that are not provided, easily or
efficiently by 'git submodule'.`;

exports.configureParser = function (parser) {

    const subParsers = parser.addSubparsers({
        dest: "command",
    });

    const statusParser = subParsers.addParser("status", {
        help: "show information about submodules",
        description: `
The default behavior is to show a one-line summary of each open submodule: the
current SHA-1 for that submodule followed by its name.`,
    });

    statusParser.addArgument(["path"], {
        type: "string",
        help: "show information about only the submodules in these paths",
        nargs: "*",
    });

    statusParser.addArgument(["-v", "--verbose"], {
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
 * Execute the `submodule` command according to the specified `args`.
 *
 * @async
 * @param {Object}  args
 * @param {Boolean} args.any
 * @param {String}  repository
 * @param {String}  [source]
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    // TODO: right now, there is only one sub-command, "status".  Later we will
    // have to split this out.

    const colors = require("colors");
    const path   = require("path");

    const GitUtil       = require("../util/git_util");
    const Status        = require("../util/status");

    const repo = yield GitUtil.getCurrentRepo();
    const workdir = repo.workdir();
    const cwd = process.cwd();
    const paths = yield args.path.map(filename => {
        return GitUtil.resolveRelativePath(workdir, cwd, filename);
    });
    const repoStatus = yield Status.getRepoStatus(repo, {
        paths: paths,
        showMetaChanges: false,
        includeClosedSubmodules: args.verbose,
    });
    const subStats = repoStatus.submodules;
    const relCwd = path.relative(workdir, cwd);
    function doSummary(showClosed) {
        Object.keys(subStats).forEach(name => {
            const relName = path.relative(relCwd, name);
            const sub = subStats[name];
            const isVis = null !== sub.repoStatus;
            const visStr = isVis ? " " : "-";
            const sha = sub.indexSha || "<deleted>";
            if (isVis || showClosed) {
                console.log(`${visStr} ${sha}  ${colors.cyan(relName)}`);
            }
        });
    }

    if (args.verbose) {
        console.log(`${colors.grey("All submodules: ")}`);
        doSummary(true);
    }
    else {
        console.log(`${colors.grey("Open submodules: ")}`);
        doSummary(false);
    }
});
