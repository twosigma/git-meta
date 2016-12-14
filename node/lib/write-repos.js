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
const co             = require("co");
const fs             = require("fs-promise");
const mkdirp         = require("mkdirp");
const path           = require("path");
const rimraf         = require("rimraf");

const WriteRepoASTUtil    = require("./util/write_repo_ast_util");
const ShorthandParserUtil = require("./util/shorthand_parser_util");

const description = `Write the repos described by a string having the syntax \
described in ./util/shorthand_parser_util.`;

const parser = new ArgumentParser({
    addHelp: true,
    description: description
});

parser.addArgument(["-t", "--target"], {
    type: "string",
    help: "directory into which write the repositories",
    defaultValue: ".",
    required: false,
});

parser.addArgument(["shorthand"], {
    type: "string",
    help: "shorthand description of repos",
    nargs: "?",
    required: false,
});

parser.addArgument(["-o", "--overwrite"], {
    required: false,
    action: "storeConst",
    constant: true,
    help: `automatically remove existing directories`,
});

parser.addArgument(["-f", "--file"], {
    type: "string",
    help: "file from which to read string",
    defaultValue: null,
    required: false,
});

const args = parser.parseArgs();

co(function *() {
    try {
        mkdirp.sync(args.target);
        let shorthand;
        if (args.file) {
            if (args.shorthand) {
                console.error("Cannot use FILE and SHORTHAND together.");
                process.exit(-1);
            }
            shorthand = yield fs.readFile(args.file, { encoding: "utf8" });
        }
        else if (!args.shorthand) {
            console.error("Missing SHORTHAND.");
            process.exit(-1);
        }
        else {
            shorthand = args.shorthand;
        }

        const ast = ShorthandParserUtil.parseMultiRepoShorthand(shorthand);
        if (args.overwrite) {
            yield Object.keys(ast).map(co.wrap(function *(name) {
                const dir = path.join(args.target, name);
                yield (new Promise(callback => {
                    return rimraf(dir, {}, callback);
                }));
            }));
        }
        yield WriteRepoASTUtil.writeMultiRAST(ast, args.target);
    }
    catch(e) {
        console.error(e.stack);
    }
});
