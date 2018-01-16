#! /usr/bin/env node
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

/**
* @PURPOSE: Provide utility for cleaning up synthetic refs.
*
* @UTILITIES:
*   synthetic_gc: utility for manipulating synthetic refs.
*
* @SEE_ALSO: synthetic_gc_runner, synthetic_branch_util
*
* /Usage
* /-----
*  This section illustrates intended use of this component.
*
* /Example 1: Cleanup redundant synthetic references.
* /- - - - - - - - - - - - - - - - - - - - - - - - -
*  Suppose that you have many submodules in your meta repo. Over time you
*  have accumulated myriad of synthetic refs that now probably slow down your
*  git operations within the repo. Most likely, most of those synthetic refs
*  point to commits that have descendants with synthetic refs pointing to
*  them, making some old parent synthetic refs unnecessary.
*
*  Following demonstrates how to clean up redundant synthetic refs with
*  'synthetic_gc'.
*
*  First, go to the root of your meta repository (bare or workdir).
*  and run following command:
*..
*   synthetic-gc
* ..
*  It will run synthetic garbage collection in simulation mode with the default
*  cut-off date for synthetic refs.
*
*  You should be presented with list of synthetic refs candidates for removal.
*
*  Example output:
*..
* Looking for removal of redundant synthetic refs. (parent refs
*                  of persistent branches).
* Removing ref: refs/commits/7f407c80953043b674b94f5137bfa24803fcead7
*..
* Now, if you are satisfied with the candidates for removal, you can run
* synthetic garbage collector with a 'force' option, that will actually remove
* those refs.
*..
*	synthetic_gc --force
*..
*
*/

"use strict";

const co = require("co");
const NodeGit = require("nodegit");
const SyntheticGcRunner = require("./util/synthetic_gc_runner");
const GitUtil = require("./util/git_util");
const ArgumentParser = require("argparse").ArgumentParser;

/**
 * Parse command line options.
 *
 * @return {Object}
 */
function parseOptions() {
    let parser = new ArgumentParser({
        version: "0.1",
        addHelp:true,
        description: `Redundant synthetic refs removal. Removes old synthetic
           refs that are reachable by any child.`
    });

    parser.addArgument(
        [ "-d", "--date" ],
        { help: `Date to use as a threshold for removing old synthetic
            refs.[6 month default]` }
    );

    parser.addArgument(
        [ "-f", "--force" ],
        {
            help: `Actually remove synthetic refs. By Default we only list what
                refs we are about to remove.`,
            action: "storeTrue",
            defaultValue: false,
        }
    );

    parser.addArgument(
        [ "--verbose" ],
        {
            help: "run in verbose mode.",
            action: "storeTrue",
            defaultValue: false,
        }
    );

    parser.addArgument(
        [ "--head-only" ],
        {
            help: "run only for head commit per ref",
            action: "storeTrue",
            defaultValue: false,
        }
    );

    parser.addArgument(
        [ "--submodules-check-only" ],
        {
            help: "Just check if submodules refs are reachable from meta repo",
            action: "storeTrue",
            defaultValue: false,
        }
    );

    parser.addArgument(
        [ "-c", "--continue-on-error" ],
        {
            help: "Continue, if known error is encountered.",
            action: "storeTrue",
            defaultValue: false,
        }
    );

    return parser.parseArgs();
}

function lessThanDate(thresHold) {
    return function(input) {
        return input.date() < thresHold;
    };
}

function getThresholdDate(args) {

    let date = new Date();

    if (args.date !== null) {
        date = new Date(args.date);
    } else {
        const THRESHOLD_MONTHS = 6;
        date.setMonth(date.getMonth() - THRESHOLD_MONTHS);
    }

    return date;
}

const runIt = co.wrap(function *(args) {

    const syntheticGcRunner = new SyntheticGcRunner(args);

    const repo = yield NodeGit.Repository.open(process.cwd());
    yield GitUtil.fetch(repo, "origin");

    const classAroots = yield syntheticGcRunner.populateRoots(repo);
    if (args.submodules_check_only) {
        console.log("Submodules checks performed, exiting.");
        return;
    }

    if (args.verbose) {
        console.log(`Looking for removal of redundant synthetic refs. (parent
                     refs of persistent branches).`);
    }

    const isOldCommit = lessThanDate(getThresholdDate(args));
    yield syntheticGcRunner.cleanUpRedundant(repo, classAroots, isOldCommit);
});

const args = parseOptions();

runIt(args);
