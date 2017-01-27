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
    parser.addArgument(["--meta"], {
        required: false,
        action: "storeConst",
        constant: true,
        help: `
Include changes to the meta-repo; disabled by default to prevent mistakes.`,
        defaultValue: false,
    });
    parser.addArgument(["--closed"], {
        required: false,
        action: "storeConst",
        constant: true,
        help: `
Include changes to the index for closed submodules, a very rare situation \
that is expensive to check.`,
        defaultValue: false,
    });
};

/**
 * Exeucte the `commit` command according to the specified `args`.
 *
 * @async
 * @param {Object}  args
 * @param {Boolean} args.all
 * @param {String}  [args.message]
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const colors = require("colors");
    const path   = require("path");

    const Commit          = require("../util/commit");
    const GitUtil         = require("../util/git_util");
    const PrintStatusUtil = require("../util/print_status_util");
    const StatusUtil      = require("../util/status_util");

    const repo = yield GitUtil.getCurrentRepo();
    const cwd = process.cwd();
    const workdir = repo.workdir();
    const relCwd = path.relative(workdir, cwd);
    const repoStatus = yield StatusUtil.getRepoStatus(repo, {
        showMetaChanges: args.meta,
        includeClosedSubmodules: args.closed,
    });

    // Abort if there are uncommittable submodules; we don't want to commit a
    // .gitmodules file with references to a submodule that doesn't have a
    // commit.
    //
    // TODO: potentially do somthing more intelligent like committing a
    // different versio of .gitmodules than what is on disk to omit
    // "uncommittable" submodules.  Considering that this situation should be
    // relatively rare, I don't think it's worth the additional complexity at
    // this time.

    if (repoStatus.areUncommittableSubmodules()) {
        process.stderr.write(PrintStatusUtil.printRepoStatus(repoStatus,
                                                             relCwd));
        console.error(`\
${colors.yellow("Please stage changes in new submodules before committing.")}\
`);
        process.exit(1);
    }

    // If there are no staged changes, and we either didn't specify "all" or we
    // did but there are no working directory changes, warn the user and exit
    // early.

    if (repoStatus.isIndexDeepClean() &&
        (!args.all || repoStatus.isWorkdirDeepClean())) {
        process.stdout.write(PrintStatusUtil.printRepoStatus(repoStatus,
                                                             relCwd));
        return;
    }

    if (null === args.message) {
        const initialMessage = Commit.formatEditorPrompt(repoStatus,
                                                         cwd,
                                                         args.all);
        const rawMessage = yield GitUtil.editMessage(repo, initialMessage);
        args.message = GitUtil.stripMessage(rawMessage);
    }

    if ("" === args.message) {
        console.error("Aborting commit due to empty commit message.");
        process.exit(1);
    }

    yield Commit.commit(repo, args.all, repoStatus, args.message);
});
