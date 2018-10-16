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
 * This module contains methods for implementing the `root` command.
 */

/**
 * help text for the `add` command
 * @property {String}
 */
exports.helpText = `Print the root directory of the meta-repo.`;

exports.description = `
From within any subdirectory of a meta-repository -- including when
the working directory is in a submodule -- print the root of the working
directory of that meta-repository.`;

exports.configureParser = function (parser) {
    parser.addArgument(["--relative", "-r"], {
        required: false,
        action: "storeConst",
        constant: true,
        help: `
Print the relative path between current directory and root.  E.g., \
'cd $(git meta root)'; cd a/b/c; git meta root -r' will print 'a/b/c'.`});
};

/**
 * Execute the `add` command according to the specified `args`.
 *
 * @async
 * @param {Object}   args
 * @param {String[]} args.paths
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const path    = require("path");

    const GitUtilFast = require("../util/git_util_fast");
    const UserError   = require("../util/user_error");

    const root = GitUtilFast.getRootGitDirectory();
    if (null === root) {
        throw new UserError("No root repo found.");
    }
    if (args.relative) {
        const cwd = process.cwd();
        console.log(path.relative(root, cwd));
    }
    else {
        console.log(root);
    }
    yield Promise.resolve(0);  // To silence no yield statement warning
});
