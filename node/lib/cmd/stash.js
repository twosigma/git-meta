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
"use strict";

const co = require("co");

/**
 * This module contains the command entry point for stash.
 */

/**
 * help text for the `stash` command
 * @property {String}
 */
exports.helpText = `Stash changes to the index and working directory`;

/**
 * description of the `stash` command
 * @property {String}
 */
exports.description =`
Provide commands for saving and restoring the state of the monorepo.
Note that 'stash' affects only the open repositories of *sub-repos*; as
currenty implemented, the meta-repo itself is not affected, including staged
and unstaged commits to the sub-repos.`;

exports.configureParser = function (parser) {

    parser.addArgument(["-m", "--message"], {
        type: "string",
        action: "append",
        required: false,
        help: "description; if not provided one will be generated",
    });

    parser.addArgument("type", {
        help: `
'save' to save a stash, 'pop' to restore, 'list' to show stashes, 'drop' to \
discard a stash, 'apply' to apply a change without popping from stashes; \
'save' is default`,
        type: "string",
        nargs: "?",
        defaultValue: "save",
    });

    parser.addArgument("stash", {
        help: "use the index at <stash>, e.g., 'git meta stash pop 2'",
        type: "int",
        nargs: "?",
        defaultValue: null,
    });

    parser.addArgument(["-u", "--include-untracked"], {
        help: `Include untracked files in the stash.`,
        action: "storeConst",
        constant: true,
    });

    parser.addArgument("--index", {
        help: `Reinstate not only the working tree's changes, but also \
index's ones`,
        action: "storeConst",
        constant: true,
    });
};

const doPop = co.wrap(function *(args) {
    const GitUtil   = require("../../lib/util/git_util");
    const StashUtil = require("../../lib/util/stash_util");

    const repo = yield GitUtil.getCurrentRepo();
    const index = (null === args.stash) ? 0 : args.stash;
    const reinstateIndex = args.index || false;
    yield StashUtil.pop(repo, index, reinstateIndex, true);
});

const doApply = co.wrap(function *(args){
    const GitUtil   = require("../../lib/util/git_util");
    const StashUtil = require("../../lib/util/stash_util");
    
    const repo = yield GitUtil.getCurrentRepo();
    const index = (null === args.stash) ? 0 : args.stash;
    const reinstateIndex = args.index || false;
    yield StashUtil.pop(repo, index, reinstateIndex, false);
});

function cleanSubs(status, includeUntracked) {
    const subs = status.submodules;
    for (let subName in subs) {
        const sub = subs[subName];
        const wd = sub.workdir;
        if (sub.index === null) {
            // This sub was deleted
            return false;
        }
        if (sub.commit.sha !== sub.index.sha) {
            // The submodule has a commit which is staged in the meta repo's
            // index
            return false;
        }
        if (null === wd) {
            continue;
        }
        if ((!wd.status.isClean(includeUntracked)) ||
            wd.status.headCommit !== sub.commit.sha) {
            return false;
        }
    }
    return true;
}

const doSave = co.wrap(function *(args) {
    const GitUtil    = require("../../lib/util/git_util");
    const StashUtil  = require("../../lib/util/stash_util");
    const StatusUtil = require("../../lib/util/status_util");
    const UserError  = require("../../lib/util/user_error");

    if (null !== args.stash) {
        throw new UserError("<stash> option not compatible with 'save'");
    }

    const repo = yield GitUtil.getCurrentRepo();
    const status = yield StatusUtil.getRepoStatus(repo);
    StatusUtil.ensureReady(status);
    const includeUntracked = args.include_untracked || false;
    if (cleanSubs(status, includeUntracked)) {
        console.warn("Nothing to stash.");
        return;                                                       // RETURN
    }
    const message = args.message ? args.message.join("\n\n") : null;
    yield StashUtil.save(repo,
                         status,
                         includeUntracked || false,
                         message);
    console.log("Saved working directory and index state.");
});

const doList = co.wrap(function *(args) {
    const GitUtil    = require("../../lib/util/git_util");
    const StashUtil  = require("../../lib/util/stash_util");
    const UserError  = require("../../lib/util/user_error");

    if (null !== args.message) {
        throw new UserError("-m not compatible with list");
    }

    const repo = yield GitUtil.getCurrentRepo();
    const list = yield StashUtil.list(repo);
    process.stdout.write(list);
});

const doDrop = co.wrap(function *(args) {
    const GitUtil    = require("../../lib/util/git_util");
    const StashUtil  = require("../../lib/util/stash_util");
    const UserError  = require("../../lib/util/user_error");

    if (null !== args.message) {
        throw new UserError("-m not compatible with list");
    }

    const repo = yield GitUtil.getCurrentRepo();
    const index = (null === args.stash) ? 0 : args.stash;
    yield StashUtil.removeStash(repo, index);
});

/**
 * Execute the `stash` command according to the specified `args`.
 *
 * @param {Object}  args
 */
exports.executeableSubcommand = function (args) {
    const colors = require("colors");

    switch(args.type) {
        case "pop" : return doPop(args);
        case "apply": return doApply(args);
        case "save": return doSave(args);
        case "list": return doList(args);
        case "drop": return doDrop(args);
        default: {
            console.error(`Invalid type ${colors.red(args.type)}`);
            process.exit(1);
        }
    }
};
