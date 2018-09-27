#!/usr/bin/env node
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

const ArgumentParser = require("argparse").ArgumentParser;
const co             = require("co");

const StitchUtil = require("./util/stitch_util");
const UserError  = require("./util/user_error");

const description = `Stitch together the specified meta-repo commitish in \
the specified repo.`;

const parser = new ArgumentParser({
    addHelp: true,
    description: description
});

parser.addArgument(["--no-fetch"], {
    required: false,
    action: "storeConst",
    constant: true,
    defaultValue: false,
    help: `If provided, assume commits are present and do not fetch.`,
});

parser.addArgument(["-t", "--target-branch"], {
    required: false,
    type: "string",
    defaultValue: "master",
    help: "Branch to update with committed ref; default is 'master'.",
});

parser.addArgument(["-j"], {
    required: false,
    type: "int",
    help: "number of parallel operations, default 8",
    defaultValue: 8,
});

parser.addArgument(["-c", "--commitish"], {
    type: "string",
    help: "meta-repo commit to stitch, default is HEAD",
    defaultValue: "HEAD",
    required: false,
});

parser.addArgument(["-u", "--url"], {
    type: "string",
    defaultValue: null,
    help: `location of the origin repository where submodules are rooted, \
required unless '--no-fetch' is specified`,
    required: false,
});

parser.addArgument(["-r", "--repo"], {
    type: "string",
    help: "location of the repo, default is \".\"",
    defaultValue: ".",
});

parser.addArgument(["-k", "--keep-as-submodule"], {
    type: "string",
    help: `submodules whose paths are matched by this regex are not stitched, \
but are instead kept as submodules.`,
    required: false,
    defaultValue: null,
});

parser.addArgument(["--skip-empty"], {
    required: false,
    action: "storeConst",
    constant: true,
    defaultValue: false,
    help: "Skip a commit if its  tree would be the same as its first parent.",
});

parser.addArgument(["--root"], {
    type: "string",
    help: "When provided, run a *join* operation that creates a new history \
joining those of the submodules under the specified 'root' path.  \
In this history those paths will be relative to 'root', i.e., they will not \
be prefixed by it. This option implies '--skip-empty'.",
});

parser.addArgument(["--preload-cache"], {
    required: false,
    action: "storeConst",
    constant: true,
    defaultValue: false,
    help: "Load, in one shot, information about previously converted commits \
and submodule changes.  Use this option when processing many commits to \
avoid many individual note reads.  Do not use this option when doing \
incremental updates as the initial load time will be very slow.",
});

co(function *() {
    const args = parser.parseArgs();
    const keepRegex = (null === args.keep_as_submodule) ?
        null :
        new RegExp(args.keep_as_submodule);
    function keep(name) {
        return null !== keepRegex && null !== keepRegex.exec(name);
    }
    const options = {
        numParallel: args.j,
        keepAsSubmodule: keep,
        fetch: !args.no_fetch,
        skipEmpty: args.skip_empty || (null !== args.root),
        preloadCache: args.preload_cache,
    };
    if (!args.no_fetch && null === args.url) {
        console.error("URL is required unless '--no-fetch'");
        process.exit(-1);
    }
    if (null !== args.url) {
        options.url = args.url;
    }
    if (null !== args.root) {
        console.log(`Joining from ${args.root}`);
        options.joinRoot = args.root;
    }
    try {
        yield StitchUtil.stitch(args.repo,
                                args.commitish,
                                args.target_branch,
                                options);
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
