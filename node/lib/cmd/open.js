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

const assert    = require("chai").assert;
const co        = require("co");
const path      = require("path");
const NodeGit   = require("nodegit");
const GitUtil   = require("../util/git_util");
const UserError = require("../util/user_error");

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
        nargs: "*",
    });

    // TODO: allow revlist specs instead of just single commits in -c,
    // which is why we are not also giving it a long argument name of
    // --committish, since that would be weird with a revlist.
    parser.addArgument(["-c"], {
        action: "store",
        type: "string",
        help: "open all submodules modified in a commit, or half open \
        the submodules from this commit",
    });
    parser.addArgument(["-f", "--force"], {
        action: "storeTrue",
        help:
        "open existing submodules even if some requested ones don't exist",
    });
    parser.addArgument(["--half"], {
        action: "storeTrue",
        help:"open the submodule in .git/modules only",
    });
};

const parseArgs = co.wrap(function *(repo, args, commit) {
    assert.instanceOf(repo, NodeGit.Repository);

    args.path = Array.from(new Set(args.path));
    if (args.path.length > 0) {
        if (!args.half && args.c) {
            // one can half open a path from a commit, or fully 
            // open all path in a commit, but cannot fully open
            // some paths from a different commit, because that 
            // will mess up the workspace.
            throw new UserError("-c should take a single argument");
        }
        return Array.from(new Set(args.path));
    }
    if (args.c === null) {
        throw new UserError(
            "Please supply a submodule to open, or -c $commitish");
    }
    const tree = yield commit.getTree();
    const parent = yield commit.parent(0);
    let parentTree = null;
    if (parent) {
        let parentCommit = yield NodeGit.Commit.lookup(repo, parent.id());
        parentTree = yield parentCommit.getTree();
    }
    const diff = yield NodeGit.Diff.treeToTree(repo, parentTree, tree);

    const out = new Set();
    for (let i = 0; i < diff.numDeltas(); i ++) {
        const delta = diff.getDelta(i);
        const newFile = delta.newFile();
        if (newFile.id().iszero()) {
            continue;
        }
        if (newFile.mode() !== NodeGit.TreeEntry.FILEMODE.COMMIT) {
            continue;
        }
        out.add(newFile.path());
    }
    return Array.from(out);
});

/**
 * If commitish is given, return resolved commit object and an in-memory
 * index loaded with the corresponding tree.
 * 
 * Otherwise, return the head commit and default repo index.
 */
const getCommitAndIndex = co.wrap(function *(repo, commitish) {
    if (commitish) {
        const annotated = yield GitUtil.resolveCommitish(repo, commitish);
        if (annotated === null) {
            throw new UserError("Cannot resolve " + commitish + " to a commit");
        }
        const commit = yield NodeGit.Commit.lookup(repo, annotated.id());
        const tree = yield commit.getTree();
        const index = yield repo.refreshIndex();
        yield index.readTree(tree);
        return {
            commit: commit,
            index: index
        };
    } else {
        return {
            index: yield repo.index(),
            commit: yield repo.getHeadCommit(),
        };
    }
});

/**
 * Execute the `open` command according to the specified `args`.
 *
 * @param {Object} args
 * @param {String} args.path
 * @param {String} args.c
 */
exports.executeableSubcommand = co.wrap(function *(args) {
    const colors = require("colors");

    const DoWorkQueue         = require("../util/do_work_queue");
    const Open                = require("../util/open");
    const SparseCheckoutUtil  = require("../util/sparse_checkout_util");
    const SubmoduleConfigUtil = require("../util/submodule_config_util");
    const SubmoduleFetcher    = require("../util/submodule_fetcher");
    const SubmoduleUtil       = require("../util/submodule_util");
    const UserError           = require("../util/user_error");

    const repo    = yield GitUtil.getCurrentRepo();
    const workdir = repo.workdir();
    const cwd     = process.cwd();

    const {commit, index} = yield getCommitAndIndex(repo, args.c);
    
    const subs = Object.keys(
        yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, index)
    );
    
    const paths = yield parseArgs(repo, args, commit);
    const subsToOpen = yield SubmoduleUtil.resolveSubmodules(workdir,
                                                             cwd,
                                                             subs,
                                                             paths,
                                                             !args.force);
    const subNames   = Object.keys(subsToOpen);
    const shas       = yield SubmoduleUtil.getCurrentSubmoduleShas(index,
                                                                   subNames);
    const fetcher = new SubmoduleFetcher(repo, commit);

    let failed = false;
    let subsOpenSuccessfully = [];

    const openSubs = new Set(yield SubmoduleUtil.listOpenSubmodules(repo));

    const templatePath = yield SubmoduleConfigUtil.getTemplatePath(repo);

    const opener = co.wrap(function *(name, idx) {
        if (openSubs.has(name)) {
            let provenance = "";
            for (let filename of subsToOpen[name]) {
                let resolved = path.relative(
                    workdir,
                    path.resolve(cwd, filename));
                if (resolved !== name) {
                    provenance = ` (for filename ${resolved})`;
                    break;
                }
            }

            console.warn(
                `Submodule ${colors.cyan(name)}${provenance} is already open.`);
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
                                    args.half);
            subsOpenSuccessfully.push(name);
            console.log(`Finished opening ${colors.blue(name)}.`);
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
    });
    yield DoWorkQueue.doInParallel(subNames, opener, 10);

    // Make sure the index entries are updated in case we're in sparse mode.
    if (!args.half) {
        yield SparseCheckoutUtil.setSparseBitsAndWriteIndex(repo, index);
    }

    if (failed) {
        process.exit(1);
    }
});
