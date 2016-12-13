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
 * This module is the entry point for the `open` command.
 */

const co = require("co");

/**
 * help text for the `open` command
 *
 * @property {String}
 */
exports.helpText = "make a repository visible locally";

/**
 * detailed description of the `open` command
 * @property {String}
 */
exports.description = `Open one or more submodules and check out their heads
as specified in the index of the meta-repo.  If there is a
'meta.submoduleTemplatePath' configuration entry, use its value to locate a
template configuration directory whose contents will be copied into the '.git'
directory of the opened submodules.  Note that if this entry contains a
relative path, it will be resolved against the working direcotry of the
meta-repo.`;

/**
 * Configure the specified `parser` for the `open` command.
 *
 * @param {ArgumentParser} parser
 */
exports.configureParser = function (parser) {

    parser.addArgument(["path"], {
        type: "string",
        help: "path of one or more sub-repositories to open",
        nargs: "+",
    });
};

/**
 * Execute the `open` command according to the specified `args`.
 *
 * @param {Object} args
 * @param {String} args.path
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const colors = require("colors");

    const GitUtil          = require("../util/git_util");
    const Open             = require("../util/open");
    const Status           = require("../util/status");
    const SubmoduleFetcher = require("../util/submodule_fetcher");
    const SubmoduleUtil    = require("../util/submodule_util");
    const UserError        = require("../util/user_error");

    const repo   = yield GitUtil.getCurrentRepo();
    const index  = yield repo.index();
    const status = yield Status.getRepoStatus(repo);

    let errors = "";

    const subs = status.submodules;

    const subsToOpen = args.path;

    const shas = yield SubmoduleUtil.getCurrentSubmoduleShas(index,
                                                             subsToOpen);
    const head = yield repo.getHeadCommit();
    const fetcher = new SubmoduleFetcher(repo, head);

    const opener = co.wrap(function *(name, index) {
        if (!(name in subs)) {
            errors += `Invalid submodule ${colors.cyan(name)}.\n`;
            return;                                                   // RETURN
        }
        const sub = subs[name];
        if (null !== sub.repoStatus) {
            errors += `Submodule ${colors.cyan(name)} is already open.\n`;
        }
        else if (null === sub.indexSha) {
            errors += `Submodule ${colors.cyan(name)} has been deleted.\n`;
        }
        else {
            console.log(
              `Opening ${colors.blue(name)} on ${colors.green(shas[index])}.`);
            yield Open.openOnCommit(fetcher, name, shas[index]);
            console.log(`Finished opening ${colors.blue(name)}.`);
        }
    });
    let done = 0;
    function makeOpener(name, index) {
        return opener(name, index + done);
    }
    while (0 !== subsToOpen.length) {
        const next = subsToOpen.splice(0, 50);
        yield next.map(makeOpener);
        done += next.length;
    }

    if ("" !== errors) {
        throw new UserError(errors);
    }
});
