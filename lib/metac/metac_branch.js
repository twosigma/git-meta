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

const co      = require("co");

/**
 * This submodule provides the entrypoint for the `branch` command.
 */

/**
 * help text for the `branch` command
 * @property {String}
 */
exports.helpText = `Create a branch in the meta-repository and each visible
sub-repository.`;

/**
 * description of the `branch` command
 * @property {String}
 */
exports.description = `Create, delete, or show branches.  When given a branch
name, will create a new branch in the meta-repo and all visible sub-repos, or,
conversley, delete them.  If the operation fails in any repository the command 
will fail. The 'any' argument can be used to specify that the operation does 
not have to succeed in all repositories.  When no branch name is specified, 
lists the branches in the meta-repo.`;

/**
 * Configure the specified `parser` for the `branch` command.
 *
 * @param {ArgumentParser} parser
 */
exports.configureParser = function (parser) {

    parser.addArgument(["branchname"], {
        type: "string",
        help: "name of the branch",
        defaultValue: null,
        required: false,
        nargs: "?",
    });

    parser.addArgument(["-a", "--any"], {
        defaultValue: false,
        required: false,
        action: "storeConst",
        constant: true,
        help: "The operation may succeed or fail in all repositories"
    });

    parser.addArgument(["-d", "--delete"], {
        defaultValue: false,
        required: false,
        action: "storeConst",
        constant: true,
        help: "Delete a branch.",
    });


};

/**
 * Execute the `branch` command according to the specified `args`.
 *
 * @async
 * @param {Object}  args
 * @param {String}  branchName
 * @param {Boolean} any
 * @param {Boolean} delete
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const GitUtil = require("../metau/metau_gitutil");
    const branch  = require("../metau/metau_branch");

    const colors  = require("colors");
    const NodeGit = require("nodegit");

    const repo = yield GitUtil.getCurrentRepo();

    if (args.delete) {
        if (!args.branchname) {
            console.error("'branchname' required");
        }
        else {
            return yield branch.deleteBranch(repo, args.branchname, args.any);
        }
    }
    else if (args.branchname) {
        return yield branch.createBranch(repo, args.branchname, args.any);
    }

    // TODO: Display diagnostic information about branches that exist in
    // meta-repo but not sub-repos and vice-versa.  For now, we'll just list
    // the branches in the meta-repo.

    const currentBranchName = yield GitUtil.getCurrentBranchName(repo);
    let branches = [];
    const refs = yield NodeGit.Reference.list(repo);
    for (let i = 0; i < refs.length; ++i) {
        let name = refs[i];
        let ref = yield NodeGit.Reference.lookup(repo, name);
        if (ref.isBranch()) {
            branches.push(ref.shorthand());
        }
    }
    branches = branches.sort();
    branches.forEach(branchName => {
        if (branchName === currentBranchName) {
            console.log(`* ${colors.green(branchName)}`);
        }
        else {
            console.log(`  ${branchName}`);
        }
    });
});
