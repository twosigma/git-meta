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

/**
 * This module contains the entrypoint for thge `include` command.
 */

const co = require("co");

/**
 * help text for the `include` command
 *
 * @property {String}
 */
exports.helpText = `add an external repository as a sub-repository`;

/**
 * Configure the specified `parser` for the `include` command.
 *
 * @param {ArgumentParser} parser
 */
exports.configureParser = function (parser) {

    parser.addArgument(["repository"], {
        type: "string",
        help: "url or path of repository to add",
    });

    // TODO: allow direcotry to be unspecified.

    parser.addArgument(["directory"], {
        type: "string",
        help: "relative path where the sub-repo will live",
    });
};

/**
 * Execute the command for `include` according to the specified `args`.
 *
 * @async
 * @param {ArgumentParser} args
 * @param {String}         args.repository
 * @param {String}         args.directory
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const GitUtil = require("../util/git_util");
    const include = require("../util/include");

    const repo = yield GitUtil.getCurrentRepo();
    return include.include(repo, args.repository, args.directory);
});
