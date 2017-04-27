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

    const findMetaParser = subParsers.addParser("find-meta", {
        help: "find the meta-repo commit from a submodule commit",
        description: `\
given a meta-repo commit M and a sub-repo commit S, find the nearest \
ancestor of M (or M itself) that references S (or a descendant of S)`,
    });

    findMetaParser.addArgument(["path"], {
        type: "string",
        help: "path to the submodule (or a path inside the submodule)",
    });

    findMetaParser.addArgument(["submodule committish"], {
        help: "submodule commit to look for",
        type: "string",
        required: false,
        defaultValue: "HEAD",
        nargs: "?",
    });

    findMetaParser.addArgument(["-m", "--meta-committish"], {
        help: "meta-repo commit from which to begin searching",
        type: "string",
        required: false,
        defaultValue: "HEAD",
    });
};

const doStatusCommand = co.wrap(function *(paths, verbose) {
    const path   = require("path");

    const GitUtil         = require("../util/git_util");
    const PrintStatusUtil = require("../util/print_status_util");
    const StatusUtil      = require("../util/status_util");

    const repo = yield GitUtil.getCurrentRepo();
    const workdir = repo.workdir();
    const cwd = process.cwd();

    paths = yield paths.map(filename => {
        return GitUtil.resolveRelativePath(workdir, cwd, filename);
    });
    const status = yield StatusUtil.getRepoStatus(repo, {
        paths: paths,
        showMetaChanges: false,
    });
    const relCwd = path.relative(workdir, cwd);
    process.stdout.write(PrintStatusUtil.printSubmoduleStatus(status,
                                                              relCwd,
                                                              verbose));
});

const doFindCommand = co.wrap(function *(path, metaCommittish, subCommittish) {
    const colors = require("colors");

    const GitUtil             = require("../util/git_util");
    const LogUtil             = require("../util/log_util");
    const Open                = require("../util/open");
    const SubmoduleConfigUtil = require("../util/submodule_config_util");
    const SubmoduleFetcher    = require("../util/submodule_fetcher");
    const SubmoduleUtil       = require("../util/submodule_util");
    const UserError           = require("../util/user_error");

    // We need to resolve and validate the committishes and submodule path
    // before calling `findMetaCommit` to do the real work.

    const repo = yield GitUtil.getCurrentRepo();
    const workdir = repo.workdir();

    const subNames = yield SubmoduleUtil.getSubmoduleNames(repo);
    const openSubNames = yield SubmoduleUtil.listOpenSubmodules(repo);

    // Here, we find which submodule `path` refers too.  It migt be invalid by
    // referring to no submodule, or by referring to more than one.

    const relPath = yield GitUtil.resolveRelativePath(workdir,
                                                      process.cwd(),
                                                      path);
    const resolvedPaths = yield SubmoduleUtil.resolvePaths(workdir,
                                                           [relPath],
                                                           subNames,
                                                           openSubNames);
    const paths = Object.keys(resolvedPaths);
    if (0 === paths.length) {
        throw new UserError(`No submodule found in ${colors.red(path)}.`);
    }
    if (1 !== paths.length) {
        throw new UserError(`Multiple submodules: \
${colors.yellow(paths.join(", "))} found in ${colors.red(path)}.`);
    }

    // Resolve `metaCommittish` first; if this resolve fails there is no reason
    // to potentially open the sub-repo.

    const metaAnnotated = yield GitUtil.resolveCommitish(repo, metaCommittish);
    if (null === metaAnnotated) {
        throw new UserError(`\
Could not find ${colors.red(metaCommittish)} in the meta-repo.`);
    }

    // Create a `SubmoduleFetcher` to be used for opening the submodule, if
    // closed, and for fetching commits during the search.

    const head = yield repo.getHeadCommit();
    const fetcher = new SubmoduleFetcher(repo, head);

    const subName = paths[0];
    let subRepo;

    // Open the submodule if it's closed.

    if (-1 === openSubNames.findIndex(x => x === subName)) {
        console.log(`Opening ${colors.blue(subName)}.`);
        const shas = yield SubmoduleUtil.getSubmoduleShasForCommit(repo,
                                                                   [subName],
                                                                   head);
        const subSha = shas[subName];
        const templatePath = yield SubmoduleConfigUtil.getTemplatePath(repo);
        subRepo = yield Open.openOnCommit(fetcher,
                                          subName,
                                          subSha,
                                          templatePath);
    }
    else {
        subRepo = yield SubmoduleUtil.getRepo(repo, subName);
    }

    const metaCommit = yield repo.getCommit(metaAnnotated.id());

    // Now that we have an open submodule, we can attempt to resolve
    // `subCommittish`.

    const subAnnotated = yield GitUtil.resolveCommitish(subRepo,
                                                        subCommittish);
    if (null === subAnnotated) {
        throw new UserError(`\
Could not find ${colors.red(subCommittish)} in ${colors.blue(subName)}.\
`);
    }

    // This command could take a while; let the user know exactly what we're
    // doing.

    console.log(`\
Searching for ${colors.green(GitUtil.shortSha(subAnnotated.id().tostrS()))} \
from submodule ${colors.blue(subName)}, starting at \
${colors.green(GitUtil.shortSha(metaAnnotated.id().tostrS()))} in the \
meta-repo.`);

    const subCommit = yield subRepo.getCommit(subAnnotated.id());

    // Finally, we do the search.

    const result = yield LogUtil.findMetaCommit(repo,
                                                metaCommit,
                                                subCommit,
                                                subName,
                                                subRepo,
                                                fetcher);
    if (null === result) {
        console.log("Not found.");
    }
    else {
        console.log(`Found ${colors.green(result)}`);
    }
});

/**
 * Execute the `submodule` command according to the specified `args`.
 *
 * @async
 * @param {Object}  args
 * @param {Boolean} args.any
 * @param {String}  repository
 * @param {String}  [source]
 */
exports.executeableSubcommand = function (args) {
    if ("status" === args.command) {
        return doStatusCommand(args.path, args.verbose);
    }
    return doFindCommand(args.path,
                         args.meta_committish,
                         args["submodule committish"]);
};
