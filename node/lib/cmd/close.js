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
 * This module is the entrypoint for the `close` command.
 */

/**
 * help text associated with the `close` command.
 *
 * @property {String}
 */
exports.helpText = `Hide a repository so that it is no longer available
locally.`;

/**
 * Configure the specified `parser` for the `close` command.
 *
 * @param {ArgumentParser} parser
 */
exports.configureParser = function (parser) {

    parser.addArgument(["path"], {
        type: "string",
        help: "close all (open) submodules at or in 'path'",
        nargs: "+",
    });

    parser.addArgument(["-f", "--force"], {
        defaultValue: false,
        required: false,
        action: "storeConst",
        constant: true,
        help: `The command refuses to close submodules that have
unpushed or uncommitted changes. This flag disables those checks.`
    });

};

/**
 * Execute the `close` command according to the specfied `args`.
 *
 * @async
 * @param {Object} args
 * @param {String} args.path
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const colors        = require("colors");

    const GitUtil       = require("../util/git_util");
    const Close         = require("../util/close");
    const Status        = require("../util/status");
    const SubmoduleUtil = require("../util/submodule_util");
    const UserError     = require("../util/user_error");

    const repo = yield GitUtil.getCurrentRepo();
    const repoStatus = yield Status.getRepoStatus(repo);
    const subStats = repoStatus.submodules;
    let errorMessage = "";

    const workdir = repo.workdir();
    const cwd     = process.cwd();
    const subs    = yield SubmoduleUtil.getSubmoduleNames(repo);

    const subsToClose = yield SubmoduleUtil.resolveSubmoduleNames(workdir,
                                                                  cwd,
                                                                  subs,
                                                                  args.path);
    const closers = subsToClose.map(co.wrap(function *(name) {
        const sub = subStats[name];
        const subRepo = sub.repoStatus;
        if (null === subRepo) {
            errorMessage += `${colors.cyan(name)} is not open.\n`;
            return;                                                   // RETURN
        }

        if (!args.force) {
            // Determine if there are any uncommited changes:
            // 1) Clean (no staged or unstaged changes)
            // 2) new files

            if (!subRepo.isClean() ||
                                   0 !== Object.keys(subRepo.workdir).length) {
                errorMessage += `\
Could not close ${colors.cyan(name)} because it is not clean:
${Status.printFileStatuses(subRepo.staged, subRepo.workdir)}.
Pass ${colors.magenta("--force")} to close it anyway.
`;
                return;                                               // RETURN
            }
        }
        yield Close.close(repo, name);
    }));
    yield closers;
    if ("" !== errorMessage) {
        throw new UserError(errorMessage);
    }
});
