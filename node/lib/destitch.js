#!/usr/bin/env node
/*
 * Copyright (c) 2018, Two Sigma Open Source
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

const ArgumentParser = require("argparse").ArgumentParser;
const co             = require("co");
const NodeGit        = require("nodegit");

const DestitchUtil = require("./util/destitch_util");
const UserError    = require("./util/user_error");

const description = `\
Create a meta-repo commit from a stitched history and print its SHA.`;

const parser = new ArgumentParser({
    addHelp: true,
    description: description
});

parser.addArgument(["-r", "--remote"], {
    required: true,
    type: "string",
    help: `The name of the remote for the meta-repo`,
});

parser.addArgument(["-b", "--branch"], {
    required: true,
    type: "string",
    help: "If set BRANCH to the destitched commit",
});

parser.addArgument(["commitish"], {
    type: "string",
    help: "the commit to destitch",
});

co(function *() {
    const args = parser.parseArgs();
    try {
        const location = yield NodeGit.Repository.discover(".", 0, "");
        const repo = yield NodeGit.Repository.open(location);
        yield DestitchUtil.destitch(repo,
                                    args.commitish,
                                    args.remote,
                                    `refs/heads/${args.branch}`);

    }
    catch (e) {
        if (e instanceof UserError) {
            console.error(e.message);
        } else {
            console.error(e.stack);
        }
        process.exit(1);
    }
});
