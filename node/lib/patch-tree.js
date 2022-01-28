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
const argparse = require("argparse");
const ArgumentParser = argparse.ArgumentParser;
const co = require("co");
const fs = require("fs");
const NodeGit = require("nodegit");
const TreeUtil = require("./util/tree_util");
const UserError = require("./util/user_error");

const FILEMODE = NodeGit.TreeEntry.FILEMODE;
const RE_DIFF_RAW = /^:\d+ (\d+) [0-9a-f]{40} ([0-9a-f]{40}) \w\s(.+)$/;
const RE_SHORT_DIFF = /^(T|C|B|tree|commit|blob):([0-9a-f]{40})?:(.+)$/;
const DELETION_SHA = "0".repeat(40);
const ALLOWED_FILE_MODES = {
    "100644": FILEMODE.BLOB,
    "040000": FILEMODE.TREE,
    "160000": FILEMODE.COMMIT,
    "B": FILEMODE.BLOB,
    "T": FILEMODE.TREE,
    "C": FILEMODE.COMMIT,
    "blob": FILEMODE.BLOB,
    "tree": FILEMODE.TREE,
    "commit": FILEMODE.COMMIT,
};

const description = `Creating a new tree by patching an existing one
 with git-diff-tree output. Works in bare repository too.

Suppose you are in a bare repo, and you want to create a new commit by
 adding a file, you can run:

echo '
:000000 100644 0000000000000000000000000000000000000000
 a86fc6156eafad6fd0c40d17752da3232dded9b0
 A      ts/foo/baz.txt' | amend-tree HEAD

The input should have the same format as the output of "git diff-tree -r --raw".

amend-tree will first upsert foo/bar/baz.txt as a leaf to HEAD's tree, and then
recursively running mktree for "foo/bar", "foo/" and then root.
ss
Tree entry change can also be defined by short hand diff.

For example:
    t1=$(patch-tree -s "commit::ts/modeling/bamboo/core" HEAD)
    patch-tree -s \
        "T:467c15c20ab76a4fc89c6c09b4f047e31d531879:ts/modeling/bamboo/core" $t1

means removing the commit at 'ts/modeling/bamboo/core' and adding its tree.
`;


const parser = new ArgumentParser({
    addHelp: true,
    description: description,
});

parser.addArgument(["-F", "--diff-file"], {
    type: "string",
    help: "File from which to read diff-tree style input.",
    required: false,
});

parser.addArgument(["-s", "--short"], {
    defaultValue: false,
    required: false,
    action: "storeConst",
    constant: true,
    help: `Diff format, either raw: '${RE_DIFF_RAW}' ` +
        `or short: '${RE_SHORT_DIFF}'.`
});

parser.addArgument(["treeish"], {
    type: "string",
    help: "tree to amend",
});


/**
 * Read the output from "git diff-tree --raw" and return a map of 
 * structured tree entry changes.
 * 
 * @param {str} diff multi-lines of git diff-tree output
  * @returns {Object} changes map from path to `TreeUtil.Change`
 */
const getChanges = (
    diff, 
    isShort
) => diff.split(/\r\n|\r|\n/).reduce((acc, line) => {
    const PAT = isShort ? RE_SHORT_DIFF : RE_DIFF_RAW;
    const match = PAT.exec(line);
    if (!line) {
        return acc;
    }
    if (!match) {
        throw new UserError(`'${line}' is invalid, accept format: ` + PAT);
    }
    const mode = ALLOWED_FILE_MODES[match[1]];
    const blobId = match[2];
    const filePath = match[3];
    if (!mode) {
        throw new UserError(
            `Unsupported file mode: '${match[1]}', only
            ${Object.keys(ALLOWED_FILE_MODES)} are supported` + PAT);
    }
    acc[filePath] = (blobId === DELETION_SHA || !blobId) ?
        null :
        new TreeUtil.Change(NodeGit.Oid.fromString(blobId), mode);
    return acc;
}, {});


const runCmd = co.wrap(function* (args) {
    const diff = fs.readFileSync(args.diff_file || 0, "utf-8");
    const changes = getChanges(diff, args.short);
    const location = yield NodeGit.Repository.discover(".", 0, "");
    const repo = yield NodeGit.Repository.open(location);
    const treeOrCommitish = yield NodeGit.Revparse.single(repo, args.treeish);

    if (!treeOrCommitish) {
        throw new UserError(
            `Cannot rev-parse: '${args.treeish}', make sure it is valid`);
    }
    const baseTreeObj = yield treeOrCommitish.peel(NodeGit.Object.TYPE.TREE);

    if (!baseTreeObj) {
        throw new UserError(
            `${args.treeish} cannot be resolve to a tree` +
            "is should be a commitish or treeish");
    }
    const baseTree = yield NodeGit.Tree.lookup(repo, baseTreeObj);
    const amendedTree = yield TreeUtil.writeTree(repo, baseTree, changes);
    console.log(amendedTree.id().tostrS());
});

co(function* () {
    try {
        yield runCmd(parser.parseArgs());
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
