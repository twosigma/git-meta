#!/usr/bin/env node
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

/**
 * This module contains the entrypoint for the `git-meta` program.  All 
 * significant functionality is deferred to the sub-commands.
 */

const ArgumentParser = require("argparse").ArgumentParser;

const add        = require("./cmd/add");
const checkout   = require("./cmd/checkout");
const cherryPick = require("./cmd/cherrypick");
const close      = require("./cmd/close");
const commit     = require("./cmd/commit");
const include    = require("./cmd/include");
const listFiles  = require("./cmd/list_files");
const merge      = require("./cmd/merge");
const newSub     = require("./cmd/new");
const open       = require("./cmd/open");
const pull       = require("./cmd/pull");
const push       = require("./cmd/push");
const rebase     = require("./cmd/rebase");
const reset      = require("./cmd/reset");
const root       = require("./cmd/root");
const submodule  = require("./cmd/submodule");
const status     = require("./cmd/status");
const UserError  = require("./util/user_error");
const version    = require("./cmd/version");

/**
 * Configure the specified `parser` to include the command having the specified
 * `commandName` implemented in the specified `module`.
 *
 * @param {ArgumentParser} parser
 * @param {String}         commandName
 * @param {Object}         module
 * @param {Function}       module.configureParser
 * @param {Function}       module.executeableSubcommand
 * @param {String}         module.helpText
 */
function configureSubcommand(parser, commandName, module) {
    const subParser = parser.addParser(commandName, {
        help: module.helpText,
        description: module.description,
    });
    module.configureParser(subParser);
    subParser.setDefaults({
        func: function (args) {
            module.executeableSubcommand(args)
            .catch(function (error) {

                // If it's a 'UserError', don't print the stack, just the
                // diagnostic message because the stack is irrelevant.

                if (error instanceof UserError) {
                    console.error(error.message);
                }
                else {
                    console.error(error.stack);
                }
                process.exit(-1);
            });
        }
    });
}

const description = `These commands are intended to make Git submodules more
powerful and easier to use.  Commands with the same name as regular Git
commands will generally perform that same operation, but across a *meta*
repository and the *sub* repositories that are locally *opened*.  These
commands work on any Git repository (even one without configured submodules);
we do not provide duplicate commands for Git functionality that does not need
to be applied across sub-modules such as 'clone' and 'init'.`;

const parser = new ArgumentParser({
    addHelp:true,
    description: description
});

const subParser = parser.addSubparsers({});

configureSubcommand(subParser, "add", add);
configureSubcommand(subParser, "checkout", checkout);
configureSubcommand(subParser, "cherry-pick", cherryPick);
configureSubcommand(subParser, "close", close);
configureSubcommand(subParser, "commit", commit);
configureSubcommand(subParser, "include", include);
configureSubcommand(subParser, "ls-files", listFiles);
configureSubcommand(subParser, "merge", merge);
configureSubcommand(subParser, "new", newSub);
configureSubcommand(subParser, "open", open);
configureSubcommand(subParser, "pull", pull);
configureSubcommand(subParser, "push", push);
configureSubcommand(subParser, "rebase", rebase);
configureSubcommand(subParser, "reset", reset);
configureSubcommand(subParser, "root", root);
configureSubcommand(subParser, "submodule", submodule);
configureSubcommand(subParser, "status", status);
configureSubcommand(subParser, "version", version);

const args = parser.parseArgs();

args.func(args);
