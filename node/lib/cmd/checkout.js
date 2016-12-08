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

const co = require("co");

/**
 * This module contains the entrypoint for the `checkout` command.
 */

exports.helpText = `Check out a commit in the meta-repository and each
(visible) submodule.  Fetch commits by SHA as needed for submodules`;

/**
 * Configure the sepcified `parser` for the `checkout` command.
 *
 * @param {ArgumentParser} parser
 */
exports.configureParser = function (parser) {

    parser.addArgument(["-b"], {
        dest: "new branch name",
        help: `Create a new branch to check out.`,
        nargs: 1,
    });

    parser.addArgument(["committish"], {
        type: "string",
        help: "commit to check out",
        defaultValue: null,
        nargs: "?",
    });
};

/**
 * Execute the `checkout` command based on the supplied arguments.
 *
 * @async
 * @param {Object} args
 * @param {String} args.committish
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const colors = require("colors");

    const Checkout  = require("../util/checkout");
    const GitUtil   = require("../util/git_util");

    let committish = args.committish;
    let newBranch = null;

    const newBranchNameArr = args["new branch name"];
    if (newBranchNameArr) {
        newBranch = newBranchNameArr[0];
    }

    const repo = yield GitUtil.getCurrentRepo();
    if (null !== committish) {
        yield Checkout.checkout(repo, committish);
    }
    if (null !== newBranch) {
        const branch = yield GitUtil.createBranchFromHead(repo, newBranch);
        yield repo.setHead(branch.name());
        console.log(`Switched to new branch ${colors.green(newBranch)}.`);
    }
    else {
        // TODO display info about whether this is a branch, detached head,
        // etc.
        console.log(`Switched to ${colors.green(committish)}.`);
    }
});
