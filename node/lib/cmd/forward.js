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

const ArgParse = require("argparse");
const assert   = require("chai").assert;
const co       = require("co");

/**
 * Return an object to be used in configuring the help of the main git-meta
 * parwser.
 * 
 * @param {String} name
 * @return {Object}
 * @return {String}   return.helpText       help description
 * @return {String}   return.description    detailed description
 * @return {Function} configureParser       set up parser for this command
 * @return {Function} executeableSubcommand function to invoke command
 */
exports.makeModule = function (name) {

    function configureParser(parser) {
        parser.addArgument(["args"], {
            type: "string",
            help: `Arguments to pass to 'git ${name}'.`,
            nargs: ArgParse.Const.REMAINDER,
        });
    }

    const helpText = `\
Invoke 'git -C $(git meta root) ${name}' with all arguments.`;
    return {
        helpText: helpText,
        description: `\
${helpText}  See 'git ${name} --help' for more information.`,
        configureParser: configureParser,
        executeableSubcommand: function () {
            assert(false, "should never get here");
        },
    };
};

/**
 * @property {Set} set of commands to forward
 */
exports.forwardedCommands = new Set([
    "branch",
    "fetch",
    "log",
    "remote",
    "rev-parse",
    "show",
    "tag",
]);

/**
 * Forward the specified `args` to the Git command having the specified `name`.
 *
 * @param {String}    name
 * @param {String []} args
 */
exports.execute = co.wrap(function *(name, args) {
    const ChildProcess = require("child-process-promise");

    const GitUtil = require("../util/git_util");

    const gitArgs = [
        "-C",
        GitUtil.getRootGitDirectory(),
        name,
    ].concat(args);
    try {
        yield ChildProcess.spawn("git", gitArgs, {
            stdio: "inherit",
            shell: true,
        });
    }
    catch (e) {
        process.exit(e.code);
    }
});

