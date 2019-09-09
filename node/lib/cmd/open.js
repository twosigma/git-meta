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
        help: "open all submodules at or in 'path'",
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

    const DoWorkQueue         = require("../util/do_work_queue");
    const GitUtil             = require("../util/git_util");
    const Hook                = require("../util/hook");
    const Open                = require("../util/open");
    const SparseCheckoutUtil  = require("../util/sparse_checkout_util");
    const SubmoduleConfigUtil = require("../util/submodule_config_util");
    const SubmoduleFetcher    = require("../util/submodule_fetcher");
    const SubmoduleUtil       = require("../util/submodule_util");
    const UserError           = require("../util/user_error");

    const repo    = yield GitUtil.getCurrentRepo();
    const workdir = repo.workdir();
    const cwd     = process.cwd();
    const subs = yield SubmoduleUtil.getSubmoduleNames(repo);

    args.path = Array.from(new Set(args.path));
    let subsToOpen = yield SubmoduleUtil.resolveSubmoduleNames(workdir,
                                                               cwd,
                                                               subs,
                                                               args.path);
    subsToOpen = Array.from(new Set(subsToOpen));
    const index      = yield repo.index();
    const shas       = yield SubmoduleUtil.getCurrentSubmoduleShas(index,
                                                                   subsToOpen);
    const head = yield repo.getHeadCommit();
    const fetcher = new SubmoduleFetcher(repo, head);

    let failed = false;
    let subsOpenSuccessfully = [];

    const openSubs = new Set(yield SubmoduleUtil.listOpenSubmodules(repo));

    const templatePath = yield SubmoduleConfigUtil.getTemplatePath(repo);

    const opener = co.wrap(function *(name, idx) {
        if (openSubs.has(name)) {
            console.warn(`Submodule ${colors.cyan(name)} is already open.`);
            return;                                                   // RETURN
        }

        if (shas[idx] === null) {
            console.warn(`Skipping unmerged submodule ${colors.cyan(name)}`);
            return;                                                   // RETURN
        }

        console.log(`\
Opening ${colors.blue(name)} on ${colors.green(shas[idx])}.`);

        // If we fail to open due to an expected condition, indicated by
        // the throwing of a `UserError` object, catch and log the error,
        // but don't let the exception propagate, or else we'll stop trying
        // to open other (probably unaffected) repositories.

        try {
            yield Open.openOnCommit(fetcher,
                                    name,
                                    shas[idx],
                                    templatePath,
                                    false);
            subsOpenSuccessfully.push(name);
        }
        catch (e) {
            if (e instanceof UserError) {
                console.error(`Error opening submodule ${colors.red(name)}:`);
                console.error(e.message);
                failed = true;
            }
            else {
                throw e;
            }
        }
        console.log(`Finished opening ${colors.blue(name)}.`);
    });
    yield DoWorkQueue.doInParallel(subsToOpen, opener);

    // Make sure the index entries are updated in case we're in sparse mode.

    yield SparseCheckoutUtil.writeMetaIndex(repo, index);

    // Run post-open-submodule hook with submodules which opened successfully.
    yield Hook.execHook(repo, "post-open-submodule", subsOpenSuccessfully);

    if (failed) {
        process.exit(1);
    }
});
