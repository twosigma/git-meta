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
const NodeGit        = require("nodegit");

const ReadRepoASTUtil = require("./util/read_repo_ast_util");

const description = `Read and output the AST describing a repo.`;

const parser = new ArgumentParser({
    addHelp: true,
    description: description
});

parser.addArgument(["path"], {
    type: "string",
    help: "directory from which to read",
    defaultValue: ".",
    nargs: "?",
});

const args = parser.parseArgs();

co(function *() {
    try {
        const repo = yield NodeGit.Repository.open(args.path);
        const ast = yield ReadRepoASTUtil.readRAST(repo);
        console.log(JSON.stringify(ast, undefined, 2));
    }
    catch(e) {
        console.error(e.stack);
    }
});
