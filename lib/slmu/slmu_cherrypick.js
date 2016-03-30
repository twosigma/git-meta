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
 * * Neither the name of slim nor the names of its
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
const colors = require("colors");
const NodeGit = require("nodegit");

const Open          = require("../slmu/slmu_open");
const Status        = require("../slmu/slmu_status");
const SubmoduleUtil = require("../slmu/slmu_submoduleutil");

/**
 * Cherry-pick the specified `commit` in the specified `metaRepo`.  The
 * behavior is undefined unless the `metaRepo` is in a consistent state
 * according to `Status.ensureCleanAndConsistent`.
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {NodeGit.Commit}     commit
 */
exports.cherryPick = co.wrap(function *(metaRepo, commit) {
    // TODO: handle possibility of a (single) meta-repo commit corresponding to
    // multiple commits.
    // TODO: See how we do with a variety of edge cases, e.g.: submodules added
    // and removed.
    // TODO: Deal with conflicts.

    // Basic algorithm:
    // - start cherry-pick on meta-repo
    // - detect changes in sub-repos
    // - cherry-pick changes in sub-repos
    // - if any conflicts in sub-repos, bail
    // - finalize commit in meta-repo

    var openSubs = {};
    (yield SubmoduleUtil.getSubmoduleRepos(metaRepo)).forEach(sub => {
        openSubs[sub.submodule.name()] = sub;
    });
    const allSubNames = yield SubmoduleUtil.getSubmoduleNames(metaRepo);
    const allSubNamesSet = new Set(allSubNames);
    yield NodeGit.Cherrypick.cherrypick(metaRepo, commit, {});

    var allPicked = true;
    var indexChanged = false;
    var pickers = [];
    const metaIndex = yield metaRepo.openIndex();

    const picker = co.wrap(function *(subName, id) {
        // If this submodule's not open, open it.

        var sub = openSubs[subName];
        if (!sub) {
            console.log(`Opening ${colors.blue(subName)}.`);
            sub = yield Open.open(subName);
        }
        const repo = sub.repo;
        console.log(`Sub-repo ${colors.blue(subName)}: cherry-picking commit \
${colors.green(id)}.`);
        const commit = yield repo.getCommit(id);
        yield NodeGit.Cherrypick.cherrypick(repo, commit, {});
        const index = yield repo.openIndex();
        if (index.hasConflicts()) {
            console.warn(`Sub-repo ${colors.red(subName)} is conflicted.`);
            allPicked = false;
        }
        else {
            repo.stateCleanup();
            yield repo.createCommitOnHead([],
                                          commit.author(),
                                          commit.committer(),
                                          commit.message());
                                          metaIndex.addByPath(subName);
            indexChanged = true;
        }
    });

    // Createa a submodule picker for each submodule in the index.

    metaIndex.entries().forEach((entry) => {
        const path = entry.path;
        const stage = Status.getStage(entry.flags);

        // If it's not the other side of the stage, return.

        if (Status.STAGE.THEIRS !== stage) {
            return;                                                   // RETURN
        }
        //
        // If it's not a submodule, (or is a new one), move on.

        if (!allSubNamesSet.has(path)) {
            return;                                                   // RETURN
        }
        const id = NodeGit.Oid.fromString(entry.id.tostrS());
        pickers.push(picker(path, id));
    });

    // Then execute the submodule pickers in parallel.

    yield pickers;

    // If one of the submodules could not be picked, exit.

    if (!allPicked) {
        process.exit(-1);
    }

    // After all the submodules are picked, write the index, perform cleanup,
    // and make the cherry-pick commit on the meta-repo.

    if (indexChanged) {
        metaIndex.conflictCleanup();
        metaIndex.write();
    }

    metaRepo.stateCleanup();

    yield metaRepo.createCommitOnHead([],
                                      commit.author(),
                                      commit.committer(),
                                      commit.message());
});
