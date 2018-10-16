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
 * This module contains methods for implementing the `new` command.
 */

/**
 * help text for the `new` command
 * @property {String}
 */
exports.helpText = `add a submodule`;

exports.configureParser = function (parser) {
    parser.addArgument(["url"], {
        type: "string",
        help: "url of the submodule to add",
    });
    parser.addArgument(["path"], {
        type: "string",
        help: "path to new sub-repo",
    });
    parser.addArgument(["-i", "--import-from"], {
        type: "string",
        help: `\
URL from which to import.  Will configure this URL as the \
remote named 'upstream' and checkout HEAD to the commit indicated on its \
'master' branch (unless overridden with -b).`,
    });

    parser.addArgument(["-b", "--branch"], {
        type: "string",
        help: `\
Branch in repo from which we are importing to checkout as HEAD.`,
    });
};

/**
 * Execute the `new` command according to the specified `args`.
 *
 * @async
 * @param {Object}   args
 * @param {String[]} args.paths
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const colors = require("colors");
    const fs     = require("fs-promise");
    const path   = require("path");

    const AddSubmodule = require("../util/add_submodule");
    const GitUtil      = require("../util/git_util");
    const Hook         = require("../util/hook");
    const UserError    = require("../util/user_error");

    if (null !== args.branch && null === args.import_from) {
        throw new UserError(`Cannot use '-b' without '-i'.`);
    }

    const repo = yield GitUtil.getCurrentRepo();

    // Bail if the path exists.

    let exists = false;
    try {
        yield fs.stat(path.join(repo.workdir(), args.path));
        exists = true;
    }
    catch (e) {
    }
    if (exists) {
        throw new UserError(`\
The path ${colors.red(args.path)} already exists.`);
    }

    // Setup for an import if provided, default branch to 'master'.

    let importArg = null;
    if (null !== args.import_from) {
        importArg = {
            url: args.import_from,
            branch: (null === args.branch) ?  "master" : args.branch,
        };
    }

    // Generate the new submodule.

    yield AddSubmodule.addSubmodule(repo, args.url, args.path, importArg);

    // Warn the user to create commits or stage changes before committing.

    if (null === importArg) {
        console.log(`\
Added new sub-repo ${colors.blue(args.path)}.  It is currently empty.  Please
stage changes under sub-repo before finishing with 'git meta commit';
you will not be able to use 'git meta commit' until you do so.`);
    }

    //Run post-add-submodule hook with submodule names which added successfully.
    yield Hook.execHook(repo, "post-add-submodule", [args.path]);
});
