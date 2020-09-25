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

const ArgumentParser = require("argparse").ArgumentParser;
const co             = require("co");
const NodeGit        = require("nodegit");
const path           = require("path");
const rimraf         = require("rimraf");

const RepoAST             = require("./util/repo_ast");
const Stopwatch           = require("./util/stopwatch");
const SubmoduleUtil       = require("./util/submodule_util");
const SubmoduleConfigUtil = require("./util/submodule_config_util");
const SyntheticBranchUtil = require("./util/synthetic_branch_util");
const WriteRepoASTUtil    = require("./util/write_repo_ast_util");

const description = `Write the repos described by a string having the syntax \
described in ./util/shorthand_parser_util.`;

const parser = new ArgumentParser({
    addHelp: true,
    description: description
});

parser.addArgument(["destination"], {
    type: "string",
    help: `directory to create repository in.  If present and '--overwrite' \
isn't specified, generate commits into the repository at that location.`
});

parser.addArgument(["-o", "--overwrite"], {
    required: false,
    action: "storeConst",
    constant: true,
    help: `automatically remove existing directories`,
});

parser.addArgument(["-c", "--count"], {
    required: false,
    defaultValue: -1,
    type: "int",
    help: "number of meta-repo commit block iterations, omit to go forever",
});

parser.addArgument(["-b", "--block-size"], {
    required: false,
    defaultValue: 100,
    type: "int",
    help: "number of commits to write at once",
});

const args = parser.parseArgs();

/**
 * Return a random integer in the range of [0, max).
 * 
 * @param {Number} max
 * @return {Number}
 */
function randomInt(max) {
    return Math.floor(Math.random() * max);
}

const baseChar = "a".charCodeAt(0);

function generateCharacter() {
    return String.fromCharCode(baseChar + randomInt(26));
}

function generatePath(depth) {
    let result = "";
    for (let i = 0; i < depth; ++i) {
        if (0 !== i) {
            result += "/";
        }
        result += (generateCharacter() + generateCharacter());
    }
    // Make leaves have three characters so they're always distinct from
    // directories.

    return result + generateCharacter();
}


class State {
    constructor() {
        this.treeCache        = {};     // used in writing commits
        this.renderCache      = {};     // used in writing commits
        this.oldCommitMap     = {};     // maps logical to physical sha
        this.commits          = {};     // logical sha to RepoAST.Commit
        this.submoduleNames   = [];     // paths of all subs
        this.submoduleHeads   = {};     // map to last sub commit
        this.oldHeads         = [];     // meta-refs to delete
        this.metaHead         = null;   // array of shas
        this.nextCommitId     = 2;      // next logical sha
        this.totalCommits     = 0;      // total meta and sub commits made
    }

    generateCommitId() {
        return "" + this.nextCommitId++;
    }
}

function makeSubCommits(state, name, madeShas) {
    const numCommits = randomInt(2) + 1;
    const subHeads = state.submoduleHeads;
    let lastHead = subHeads[name];
    if (undefined !== lastHead) {
        state.oldHeads.push(lastHead);
    }
    const commits = state.commits;
    for (let i = 0; i < numCommits; ++i) {
        const newHead = state.generateCommitId();
        let changes = {};

        // If this subrepo already has changes, we'll go back and update a few
        // of them at random.

        if (undefined !== lastHead) {
            const oldChanges = RepoAST.renderCommit(state.renderCache,
                                                    commits,
                                                    lastHead);
            const paths = Object.keys(oldChanges);
            const numChanges = randomInt(2) + 1;
            for (let j = 0; j < numChanges; ++j) {
                const pathToUpdate = paths[randomInt(paths.length)];
                changes[pathToUpdate] = new RepoAST.File(
                    state.nextCommitId + generateCharacter(), false);
            }
        }

        // Add a path if there are no commits yet, or on a chance

        if (undefined === lastHead || 0 === randomInt(6)) {
            const path = generatePath(randomInt(3) + 1);
            changes[path] = new RepoAST.File(
                state.nextCommitId + generateCharacter(), false);
        }
        const parents = undefined === lastHead ? [] : [lastHead];
        lastHead = newHead;
        subHeads[name] = newHead;
        const commit = new RepoAST.Commit({
            parents: parents,
            changes: changes,
            message: `a random commit for sub ${name}, #${newHead}`,
        });
        madeShas.push(newHead);
        commits[newHead] = commit;
    }
    state.totalCommits += numCommits;
    return lastHead;
}

/**
 * Generate a commit in the specified `state`, storing in the specified
 * `madeShas` all generated commit ids and in the specified `subHeads` the
 * shas of submodule heads referenced by meta-repo commits.
 *
 * @param {State}     state
 * @param {String []} madeShas
 * @param {String []} subHeads
 */
function makeMetaCommit(state, madeShas, subHeads) {
    const subsToChange = randomInt(2) + 1;
    let subPaths = {};
    const numSubs = state.submoduleNames.length;

    if (0 !== numSubs) {
        // randomly pick subs to modify

        for (let i = 0; i < subsToChange; ++i) {
            const index = randomInt(numSubs);
            const name = state.submoduleNames[index];
            if (!(name in subPaths)) {
                subPaths[name] = true;
            }
        }
    }

    // Generate a new submodule if no submodules, or chance dictates.

    if (0 === numSubs || 0 === randomInt(10)) {
        while (true) {
            const path = generatePath(3);
            if (!(path in state.submoduleHeads)) {
                subPaths[path] = true;
                state.submoduleNames.push(path);
                break;
            }
        }
    }

    const changes = {};
    Object.keys(subPaths).forEach(function (path) {
        const newHead = makeSubCommits(state, path, madeShas);
        changes[path] = new RepoAST.Submodule(".", newHead);
        subHeads.push(newHead);
    });
    const commitId = state.generateCommitId();
    const lastHead = state.metaHead;
    state.metaHead = commitId;
    const parents = lastHead === null ? [] : [lastHead];
    const commit = new RepoAST.Commit({
        parents: parents,
        changes: changes,
        message: `a friendly meta commit, #${commitId}`,
    });
    state.commits[commitId] = commit;
    madeShas.push(commitId);
    ++state.totalCommits;
}

const renderRefs = co.wrap(function *(repo, oldCommitMap, shas) {
    yield shas.map(sha => {
        const target = oldCommitMap[sha];
        const targetId = NodeGit.Oid.fromString(target);
        return NodeGit.Reference.create(
                       repo,
                       SyntheticBranchUtil.getSyntheticBranchForCommit(target),
                       targetId,
                       0,
                       "meta-ref");
    });
});

const renderBlock = co.wrap(function *(repo, state, shas, subHeads) {
    yield WriteRepoASTUtil.writeCommits(state.oldCommitMap,
                                        state.treeCache,
                                        repo,
                                        state.commits,
                                        shas);
    yield renderRefs(repo, state.oldCommitMap, subHeads);
    yield NodeGit.Reference.create(repo,
                                   "refs/heads/master",
                                   state.oldCommitMap[state.metaHead],
                                   1,
                                   "my ref");
    yield state.oldHeads.map(co.wrap(function *(sha) {
        const realSha = state.oldCommitMap[sha];
        const metaRefName =
                      SyntheticBranchUtil.getSyntheticBranchForCommit(realSha);
        const ref = yield NodeGit.Reference.lookup(repo, metaRefName);
        ref.delete();
    }));
    state.oldHeads = [];
});


function doGc(state) {
    const toKeep = new Set();
    function addToKeep(sha) {
        toKeep.add(sha);
    }
    toKeep.add(state.metaHead);
    const metaCommit = state.commits[state.metaHead];
    metaCommit.parents.forEach(addToKeep);
    for (let path in state.submoduleHeads) {
        const sha = state.submoduleHeads[path];
        toKeep.add(sha);
        const commit = state.commits[sha];
        if (undefined !== commit) {
            commit.parents.forEach(addToKeep);
        }
    }
    function copyIfUsed(map) {
        let result = {};
        for (let sha in map) {
            if (toKeep.has(sha)) {
                result[sha] = map[sha];
            }
        }
        return result;
    }
    state.treeCache = copyIfUsed(state.treeCache);
    state.oldCommitMap = copyIfUsed(state.oldCommitMap);
    state.commits = copyIfUsed(state.commits);
}

/**
 * @return {Object}
 * @return {NodeGit.Tree} return.tree
 * @return {Object}       return.submodules
 */
const loadTree = co.wrap(function *(repo, treeId, renderCache, basePath) {
    // We don't load any submodules here; that will be done manually for the
    // meta-repo.

    const tree = yield NodeGit.Tree.lookup(repo, treeId);
    const entries = tree.entries();
    const result = {
        tree: tree,
        submodules: {},
    };
    for (let i = 0; i < entries.length; ++i) {
        const entry = entries[i];
        const entryPath = entry.path();
        const fullPath = null === basePath ?
                                    entryPath : path.join(basePath, entryPath);
        if (!entry.isTree()) {
            // Just put a placeholder in the render cache for now; the only
            // place we're using it is to determine what paths exist in a
            // submodule.

            renderCache[fullPath] = "";
        }
    }
    return result;
});

const loadState = co.wrap(function *(repo) {
    const master = yield repo.getBranch("master");
    const masterCommitId = master.target();
    const masterCommit = yield repo.getCommit(masterCommitId);
    const state = new State();

    state.submoduleNames = yield SubmoduleUtil.getSubmoduleNamesForCommit(
                                                                 repo,
                                                                 masterCommit);
    const commitsToLoad = [];
    const newToOld = {};
    function mapSha(sha) {
        const logical = state.generateCommitId();
        state.oldCommitMap[logical] = sha;
        newToOld[sha] = logical;
        commitsToLoad.push(logical);
        return logical;
    }
    state.metaHead = mapSha(masterCommitId.tostrS());
    const subShas = yield SubmoduleUtil.getSubmoduleShasForCommit(
                                                          repo,
                                                          state.submoduleNames,
                                                          masterCommit);
    const subUrls = yield SubmoduleConfigUtil.getSubmodulesFromCommit(
                                                                 repo,
                                                                 masterCommit);
    state.submoduleNames.forEach(name => {
        const sha = subShas[name];
        state.submoduleHeads[name] = mapSha(sha);
    });
    yield commitsToLoad.map(co.wrap(function *(logical) {
        const sha = state.oldCommitMap[logical];
        const commit = yield repo.getCommit(sha);
        const treeId = commit.treeId();
        const cache = {};
        state.renderCache[logical] = cache;
        state.treeCache[logical] = yield loadTree(repo, treeId, cache, null);
    }));

    // manually populate submodules for meta repo

    const metaTreeCache = state.treeCache[state.metaHead];
    const metaSubs = metaTreeCache.submodules;
    state.submoduleNames.forEach(name => {
        const url = subUrls[name];
        metaSubs[name] = url;
    });
    return state;
});

co(function *() {
    try {
        const path = args.destination;
        let repo;
        let state;
        if (args.overwrite) {
            const timer = new Stopwatch();
            process.stdout.write("Removing old files... ");
            yield (new Promise(callback => {
                return rimraf(path, {}, callback);
            }));
            process.stdout.write(`took ${timer.elapsed} seconds.\n`);
        }
        else {
            // Try to use an existing repo.
            try {
                repo = yield NodeGit.Repository.open(path);
            }
            catch (e) {
            }
            if (repo) {
                const loadTime = new Stopwatch();
                process.stdout.write("Beginning from existing repository... ");
                state = yield loadState(repo);
                process.stdout.write(`took ${loadTime.elapsed}.\n`);
            }
        }

        if (undefined === repo) {
            repo = yield NodeGit.Repository.init(path, 1);
            state = new State();
        }
        const count = args.count;
        const blockSize = args.block_size;
        console.log(`Generating ${count < 0 ? "infinite" : count} blocks of \
${blockSize} commits.`);
        const totalTime = new Stopwatch();
        let metaCommits = 0;
        for (let i = 0; -1 === count || i < count; ++i) {
            const madeShas = [];
            const subHeads = [];
            for (let i = 0; i < blockSize; ++i) {
                makeMetaCommit(state, madeShas, subHeads);
            }
            metaCommits += blockSize;
            const time = new Stopwatch();
            yield renderBlock(repo, state, madeShas, subHeads);
            time.stop();
            doGc(state);
            console.log(`Writing ${madeShas.length} commits and \
${subHeads.length} sub changes, took ${time.elapsed} seconds.  Commit \
rate ${metaCommits / totalTime.elapsed}/s, meta commits ${metaCommits}, \
total time ${totalTime.elapsed}, total subs: ${state.submoduleNames.length} \
total commits ${state.totalCommits}, \
${state.totalCommits / totalTime.elapsed}/s.`);
        }
    }
    catch(e) {
        console.error(e.stack);
    }
});
