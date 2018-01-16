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

const assert  = require("chai").assert;
const co = require("co");
const NodeGit = require("nodegit");
const SubmoduleUtil = require("./submodule_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const SubmoduleFetcher = require("./submodule_fetcher");
const SyntheticBranchUtil = require("./synthetic_branch_util");
const UserError = require("./user_error");
const GitUtil = require("./git_util");
const fs = require("fs");

const SYNTHETIC_BRANCH_BASE = "refs/commits/";

const detail = {

    /**
     * Remove gubbins from the specified 'path'.
     *
     * @param {String}      path
     * @return {String}
     */
    rebuildUrl : function(path) {
        path = path.replace(new RegExp("\.\./main/"), "");
        path = path.replace(new RegExp("\.d/", "g"), "/");
        if (path.endsWith("-git")) {
            path = path.replace(new RegExp("-git$"), ".git");
        }

        return path;
    },

    /**
     * Return a collection of synthetic refs reachable locally for specified
     * 'repo'.
     *
     * @param {NodeGit.Repository} repo
     * @return {Set<String>}
     */
    getLocalSyntheticRefs : function*(repo) {
        assert.instanceOf(repo, NodeGit.Repository);

        let references = yield NodeGit.Reference.list(repo);
        references = references.filter(
                ref => ref.startsWith(SYNTHETIC_BRANCH_BASE));
        references = references.map(ref =>
            ref.split(SYNTHETIC_BRANCH_BASE)[1]);

        return new Set(references);
    }
};

/**
 * This class provides a way to list/delete redundant synthetic refs, i.e
 * synthetic refs of the commits reachable by any of their children.
 *
 * @SEE_ALSO: lib/synthetic_gc
 */
class SyntheticGcRunner {

    /**
    * Create a 'SyntheticGcRunner' object for synthetic refs manipulation.
    */
    constructor(args) {
        if (args === undefined) {
            throw new UserError("Specify args to SyntheticGcRunner");
        }

        this.d_simulation = !args.force;
        this.d_verbose = args.verbose;
        this.d_headOnly = args.head_only;
        this.d_continueOnError = args.continue_on_error;

        this.d_visited = {};
        this.d_metaVisited = {};
        // We only need to fetch submodule url once, so keeping track.
        this.d_fetchedUrl = {};

        // To keep track of visited submodule commits.
        this.d_subCommitStored = {};
        this.d_syntheticRefsBatchForRemoval = [];
    }

    /**
    * If simulation set to true, no synthetic refs are
    * actually being removed.
    * @param {Boolean}
    */
    get simulation() {
        return this.d_simulation;
    }

    set simulation(value) {
        this.d_simulation = value;
    }

    /**
    * @param {Set} visited commits
    */
    get visited() {
        return this.d_visited;
    }

    set visited(value) {
        this.d_visited = value;
    }

    get verbose() {
        return this.d_verbose;
    }
    set verbose(value) {
        this.d_verbose = value;
    }

    get headOnly() {
        return this.d_headOnly;
    }
    set headOnly(value) {
        this.d_headOnly = value;
    }

    get continueOnError() {
        return this.d_continueOnError;
    }
    set continueOnError(value) {
        this.d_continueOnError = value;
    }
} // SyntheticGcRunner

/**
 * Return bare submodule repository corresponding to a specified `refHeadCommit`
 * within specified meta `repo`.
 *
 * @param {NodeGit.Repository}   repo
 * @param {NodeGit.Commit}       commit
 * @return {NodeGit.Repository}  subRepo
 */
SyntheticGcRunner.prototype.getBareSubmoduleRepo = co.wrap(
    function*(repo, subName, refHeadCommit) {

        assert.instanceOf(repo, NodeGit.Repository);
        assert.instanceOf(refHeadCommit, NodeGit.Commit);

        const fetcher = new SubmoduleFetcher(repo, refHeadCommit);

        let subUrl = yield fetcher.getSubmoduleUrl(subName);
        let subPath = subUrl;

        if (subUrl.startsWith(".")) {
            // relative url specified
            subUrl = detail.rebuildUrl(subUrl);
            subPath = yield SyntheticBranchUtil.urlToLocalPath(repo, subUrl);
        }

        if (!fs.existsSync(subPath)) {

            if (this.d_verbose) {
                console.log("Submodule at following path does not exist: " +
                    subPath);
            }

            const metaUrl = yield GitUtil.getOriginUrl(repo);
            if (metaUrl === null) {
                console.error("Cannot determine origin url. Something is " +
                    "wrong, exiting.");
                process.exit(-1);
            }

            subUrl = yield fetcher.getSubmoduleUrl(subName);
            subUrl = SubmoduleConfigUtil.resolveSubmoduleUrl(metaUrl,
                                                             subUrl);
            if (this.d_verbose) {
                console.log("Going to clone bare repo from: " + subUrl);
            }
            yield GitUtil.cloneBareRepo(subUrl, subPath);
        }

        const subRepo = yield NodeGit.Repository.open(subPath);
        try {
            if (!(subUrl in this.d_fetchedUrl)) {
                this.d_fetchedUrl[subUrl] = 1;
                yield GitUtil.fetch(subRepo, "origin");
            }
        } catch (exception) {
            // eat the exception here, most likely submodule is corrupted.
            // 'populatePerCommit' has more infromative error for this
            console.log("Error fetching submodule: " + subName +
                " with error: " + exception);
        }

        return subRepo;
});

/**
 * Execute batch removal of synthetic references contained by
 * 'd_syntheticRefsBatchForRemoval' for the specified 'repo'. Lastly, clean up
 * 'd_syntheticRefsBatchForRemoval'.
 *
 * @param {NodeGit.Repository}   repo
 */
SyntheticGcRunner.prototype.commitSyntheticRefRemoval = co.wrap(
    function*(repo) {

   yield GitUtil.removeRemoteRef(repo,
                                 this.d_syntheticRefsBatchForRemoval);
   this.d_syntheticRefsBatchForRemoval = [];

});

/**
 * Remove synthetic ref corresponding to specified `commit` in the specified
 * `repo`.
 * If running outside of git server, synthetic ref will be marked for batch
 * removal, you will need to call 'SyntheticGcRunner.commitSyntheticRefRemoval'
 * to actually remove them.
 *
 * @param {NodeGit.Repository}   repo
 * @param {NodeGit.Commit}       commit
 */
SyntheticGcRunner.prototype.removeSyntheticRef = function(repo, commit) {

    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);

    const synRefPath = SyntheticBranchUtil.getSyntheticBranchForCommit(commit);

    if (this.d_simulation) {
        // following 'git clean -n'
        console.log("Would remove: " + synRefPath);
        return;
    }

    const failed = NodeGit.Reference.remove(repo, synRefPath);
    if (failed) {
        throw new UserError("Failed to remove the reference: " + synRefPath);
    }

    this.d_syntheticRefsBatchForRemoval.push(synRefPath);
};

/**
 * Go through the parents of `commit` of the specified `repo` and remove
 * synthetic reference recursively if they satisfy `isDeletable` and not part of
 * `existingReferences`.
 *
 * @param {NodeGit.Repository}   repo
 * @param {NodeGit.Commit}       commit
 * @param {Function}             isDeletable
 * @param {Set<String>}          existingReferences
 */

SyntheticGcRunner.prototype.recursiveSyntheticRefRemoval = co.wrap(
    function* (repo, commit, isDeletable, existingReferences) {

    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);

    if (commit.parentcount() === 0) {
        return;
    }

    const parents = yield commit.getParents(commit.parentcount());
    let thisState = this;
    yield parents.map(function *(parent) {
        if (parent.sha() in thisState.d_visited) {
            return;
        }
        thisState.d_visited[parent.sha()] = 1;

        // We are keeping track of 'existingReferences' to avoid trying to
        // delete references that do not exists. This is helpful in simulation
        // mode, since it provides a clear way to a user what actually is being
        // deleted. Also helps in debugging.
        if (isDeletable(parent) && existingReferences.has(parent.sha())) {
            thisState.removeSyntheticRef(repo, parent);
        }
        return yield thisState.recursiveSyntheticRefRemoval(repo, parent,
                                                   isDeletable,
                                                   existingReferences);
    });

});

/**
 * Return all available synthetic refs within specified `subRepo`.
 *
 * @param {NodeGit.Repo}   subRepo
 * @return {String[]}
 */
SyntheticGcRunner.prototype.getSyntheticRefs = co.wrap(
    function*(repo) {

    assert.instanceOf(repo, NodeGit.Repository);

    // first lets check if we are on the git server itself.
    let references = yield detail.getLocalSyntheticRefs(repo);
    if (references.size !== 0) {
        return references;
    }

    const syntheticRefExtractor = function(value) {
        if (value && value.includes(SYNTHETIC_BRANCH_BASE)) {
            return value.split("\t")[0];
        }
        return null;
    };

    references = yield GitUtil.getRemoteRefs(repo);
    references = references.map(syntheticRefExtractor).filter(commit => commit);

    return new Set(references);
});

/**
 * Delete all redundant synthetic refs within specified 'repo' satisfying
 * `predicate` by recursively iterating over parents of the specified `roots`.
 *
 * Synthetic ref is considered to be redundant if its commit is reachable from
 * descendant who is guaranteed to be around - i.e part of a persistent roots
 * ('roots' here).
 *
 * @param {NodeGit.Repo}   repo
 * @param {Object[]}       roots
 * @param {Function}       predicate
 */
SyntheticGcRunner.prototype.cleanUpRedundant = co.wrap(
    function*(repo, roots, predicate) {

   assert.instanceOf(repo, NodeGit.Repository);

   for (let subPath in roots) {

       const subRepo = yield NodeGit.Repository.open(subPath);

       let existingReferences = yield this.getSyntheticRefs(subRepo);

       for (let subCommit of roots[subPath]) {
           yield this.recursiveSyntheticRefRemoval(subRepo, subCommit,
                                              predicate,
                                              existingReferences);
       }
       this.commitSyntheticRefRemoval(subRepo);
   }
});

/**
 * Go through every commit of meta repository and populate a map of submodule
 * to its commits.
 *
 * Return value is a mapping between submodule name and collection of persistent
 * refs within that submodules.
 *
 * @param {NodeGit.Repo}   repo
 * @param {NodeGit.Commit} commit
 * @param {Map<String, Set<String>>} classAroots
 * @return {Map<String, Set<String>>}
 */
SyntheticGcRunner.prototype.populatePerCommit = co.wrap(
    function*(repo, commit, classAroots) {

        if (commit.sha() in this.d_metaVisited) {
            return classAroots;
        }

        const tree = yield commit.getTree();

        const submodules = yield SubmoduleUtil.getSubmoduleNamesForCommit(repo,
                                                                commit);
        for (const subName of submodules) {
            try {
                const subRepo =
                    yield this.getBareSubmoduleRepo(repo, subName,
                                                    commit);
                const subSha = yield tree.entryByPath(subName);
                const subCommit = yield subRepo.getCommit(subSha.sha());
                const subPath = subRepo.path();

                // Record all unique paths from all references.
                if (!(subPath in classAroots)) {
                    classAroots[subPath] = new Set();
                    this.d_subCommitStored[subPath] = {};
                }

                if (subCommit.sha() in this.d_subCommitStored[subPath]) {
                    continue;
                }

                classAroots[subPath].add(subCommit);
                this.d_subCommitStored[subPath][subCommit.sha()] = 1;
            } catch(exception) {
                console.error("Cannot process submodule " + subName +
                    "  with following exception: " + exception);
                if (!this.d_continueOnError) {
                    process.exit(-1);
                }
            }
        }

        this.d_metaVisited[commit.sha()] = 1;

        if (this.d_headOnly) {
            return classAroots;
        }

        const parents = yield commit.getParents(commit.parentcount());
        let thisState = this;
        yield parents.map(function *(parent) {
            classAroots = yield thisState.populatePerCommit(repo,
                                                      parent,
                                                      classAroots);
        });

        return classAroots;
});

/**
 * Fetch all refs that are considered to be persistent within the specified
 * `repo`.
 *
 * Return value is a mapping between submodule name and collection of persistent
 * refs within that submodules.
 *
 * @param {NodeGit.Repo}   repo
 * @return {Map<String, Set<String>>}
 */
SyntheticGcRunner.prototype.populateRoots = co.wrap(
    function*(repo) {

    assert.instanceOf(repo, NodeGit.Repository);

    let classAroots = {}; // roots that we can rely on to be around, master or
                          // team branches

    const refs = yield repo.getReferenceNames(NodeGit.Reference.TYPE.LISTALL);
    for (let ref of refs) {
        console.log("looking at ref: " + ref);
        const refHeadCommit = yield repo.getReferenceCommit(ref);
        classAroots = yield this.populatePerCommit(repo,
                                                   refHeadCommit,
                                                   classAroots);
    }

    return classAroots;
});

module.exports = SyntheticGcRunner;

