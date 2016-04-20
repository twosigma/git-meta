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

const branch     = require("./metac/metac_branch");
const checkout   = require("./metac/metac_checkout");
const cherryPick = require("./metac/metac_cherrypick");
const close      = require("./metac/metac_close");
const commit     = require("./metac/metac_commit");
const include    = require("./metac/metac_include");
const merge      = require("./metac/metac_merge");
const open       = require("./metac/metac_open");
const pull       = require("./metac/metac_pull");
const push       = require("./metac/metac_push");
const rebase     = require("./metac/metac_rebase");
const status     = require("./metac/metac_status");
const version    = require("./metac/metac_version");

const UserError  = require("./metau/metau_usererror");

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

configureSubcommand(subParser, "branch", branch);
configureSubcommand(subParser, "checkout", checkout);
configureSubcommand(subParser, "cherry-pick", cherryPick);
configureSubcommand(subParser, "close", close);
configureSubcommand(subParser, "commit", commit);
configureSubcommand(subParser, "include", include);
configureSubcommand(subParser, "merge", merge);
configureSubcommand(subParser, "open", open);
configureSubcommand(subParser, "pull", pull);
configureSubcommand(subParser, "push", push);
configureSubcommand(subParser, "rebase", rebase);
configureSubcommand(subParser, "status", status);
configureSubcommand(subParser, "version", version);

const args = parser.parseArgs();

args.func(args);
