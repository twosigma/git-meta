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
exports.helpText = `Add file contents to the index.`;

/**
 * description of the `add` command
 * @property {String}
 */
exports.description =`
This command updates the index using the current content found in the working
tree, to prepare the content staged for the next commit.  If a path is
specified, this command will stage all modified content in the meta-repo
and submodules rooted in that path.
`;

exports.configureParser = function (parser) {
    parser.addArgument(["paths"], {
        nargs: "+",
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
    const Add     = require("../util/add");
    const GitUtil = require("../util/git_util");

    const repo    = yield GitUtil.getCurrentRepo();
    const workdir = repo.workdir();
    const cwd     = process.cwd();

    const paths = yield args.paths.map(filename => {
        return  GitUtil.resolveRelativePath(workdir, cwd, filename);
    });

    yield Add.stagePaths(repo, paths);
});
