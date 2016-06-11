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

exports.helpText = `Check out a branch in the meta-repository and each
(visible) sub-repository.`;

/**
 * Configure the sepcified `parser` for the `checkout` command.
 *
 * @param {ArgumentParser} parser
 */
exports.configureParser = function (parser) {

    parser.addArgument(["branchname"], {
        type: "string",
        help: "name of the branch",
    });

    parser.addArgument(["-c", "--create"], {
        choices: ["all", "none", "some"],
        defaultValue: "some",
        required: false,
        help: `Control whether creation of new branches is allowed or not.  If
'all' is specified, the branch to create must not exist in the meta-repository
or any (visible) sub-repositories; it will be created.  If 'none' is specified,
the branch must already exist in all repositories.  If 'some' is specified, the
branch will be created in repositories as needed where it does not exist.  The
default value is 'some'.`,
    });
};

/**
 * Execute the `checkout` command based on the supplied arguments.
 *
 * @async
 * @param {Object} args
 * @param {String} args.branchname
 * @param {String} args.create
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const Checkout = require("../util/checkout");
    const GitUtil  = require("../util/git_util");
    const Status   = require("../util/status");

    const repo = yield GitUtil.getCurrentRepo();
    const status = yield Status.getRepoStatus(repo);
    Status.ensureClean(status);
    yield Checkout.checkout(repo, args.branchname, args.create);
});
