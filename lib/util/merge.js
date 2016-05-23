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

const co = require("co");
const colors = require("colors");
const NodeGit = require("nodegit");

const Close         = require("../util/close");
const Open          = require("../util/open");
const Status        = require("../util/status");
const SubmoduleUtil = require("../util/submodule_util");

/**
 * Merge the specified `commit` in the specified `metaRepo`.  The
 * behavior is undefined unless the `metaRepo` is in a consistent state
 * according to `Status.ensureCleanAndConsistent`.  The specified `commitName`
 * will be used in merge commit messages.
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {NodeGit.Commit}     commit
 * @param {String}             commitName
 */
exports.merge = co.wrap(function *(metaRepo, commit, commitName) {
    // TODO: See how we do with a letiety of edge cases, e.g.: submodules added
    // and removed.
    // TODO: Deal with conflicts.
    // TODO: better commit message. What I'm doing isn't quite like Git, which
    // will tell you if the commitish is a branch or commit name.

    // Basic algorithm:
    // - start merge on meta-repo
    // - detect changes in sub-repos
    // - merge changes in sub-repos
    // - if any conflicts in sub-repos, bail
    // - finalize commit in meta-repo
    //
    // The actual problem is complicated by a couple of things:
    //
    // - oddities with and/or poor support of submodules
    // - unlike rebase and cherry-pick, which seem similar on the surface, the
    //   merge operation doesn't operate directly on the current HEAD, index,
    //   or working directory: it creates a weird virtual index
    //
    // I haven't created issues for nodegit or libgit2 yet as I'm not sure how
    // many of these problems are real problems or "by design".  If this
    // project moves out of the prototype phase, we should resolve these
    // issues as much of the code below feels like a hackish workaround.
    //
    // details to follow:

    const head = yield metaRepo.getHeadCommit();

    // If the target commit is an ancestor of the derived commit, then we have
    // nothing to do; the target commit is already part of the current history.

    const upToDate = yield NodeGit.Graph.descendantOf(metaRepo, head, commit);

    if (upToDate) {
        console.log("Already up-to-date.");
        return;
    }

    console.log(`Merging commit ${colors.green(commit.id())}.`);

    // First, collect and cache information about existing and visible
    // submodules.

    let openSubs = {};
    (yield SubmoduleUtil.getSubmoduleRepos(metaRepo)).forEach(sub => {
        openSubs[sub.name] = sub;
    });
    const allSubNames = yield SubmoduleUtil.getSubmoduleNames(metaRepo);
    const allSubNamesSet = new Set(allSubNames);
    const sig = metaRepo.defaultSignature();

    // Kick off the merge.  It is important to note is that `Merge.commit` does
    // not directly modify the working directory or index.  The `metaIndex`
    // object it returns is magical, virtual, does not operate on HEAD or
    // anything, has no effect.

    const metaIndex = yield NodeGit.Merge.commits(metaRepo,
                                                  head,
                                                  commit,
                                                  null);

    let allMerged = true;  // will be set to false if a conflict in sub-repo
    let mergers = [];      // paralell merge operations

    const commitMessage = `Merge of '${commitName}'`;

    // `toAdd` will contain a list of paths that need to be added to the final
    // index when it's ready.  Adding them to the "virtual", `metaIndex` object
    // turns out to have no effect.  This complication is caused by a a
    // combination of merge/index weirdness and submodule weirdness.

    let toAdd = [];

    // Return a promise to merge the submodule with the specified `subName`
    // from the specified commit `id`.

    const merger = co.wrap(function *(subName, id) {
        // If this submodule's not open, open it.

        let sub = openSubs[subName];
        if (!sub) {
            console.log(`Opening ${colors.blue(subName)}.`);
            sub = yield Open.open(subName);
        }
        const subRepo = sub.repo;
        const subHead  = yield subRepo.getHeadCommit();
        const subCommit = yield subRepo.getCommit(id);

        const isUpToDate = yield NodeGit.Graph.descendantOf(subRepo,
                                                            subHead,
                                                            subCommit);

        // If the current commit in the sub-repo is a descendent of the
        // commit we're merging, there's nothing to do.

        if (isUpToDate) {
            return;                                                   // RETURN
        }

        console.log(`Sub-repo ${colors.blue(subName)}: merging commit \
${colors.green(id)}.`);

        // Start the merge.

        const index = yield NodeGit.Merge.commits(subRepo,
                                                  subHead,
                                                  subCommit,
                                                  null);

        // Abort if conflicted.

        if (index.hasConflicts()) {
            console.warn(`Sub-repo ${colors.red(subName)} is conflicted.`);
            allMerged = false;
            return;                                                   // RETURN
        }

        // Otherwise, finish off the merge.

        const subId = yield index.writeTreeTo(subRepo);
        const subBranch = yield subRepo.getCurrentBranch();
        yield subRepo.createCommit(subBranch.name(),
                                   sig,
                                   sig,
                                   commitMessage,
                                   subId,
                                   [subHead, subCommit]);
        yield subRepo.checkoutBranch(subBranch, {
            checkoutStrategy: NodeGit.Checkout.STRATEGY.FORCE
        });

        // And add this sub-repo to the list of sub-repos that need to be added
        // to the index later.

        toAdd.push(subName);
    });

    // Createa a submodule merger for each submodule in the index.

    let possibleNewSubs = new Set();

    metaIndex.entries().forEach((entry) => {
        // TODO: need to deal with non-sub-module conflicts in the meta-repo
        // here and abort if we find them.

        const path = entry.path;
        const stage = Status.getStage(entry.flags);

        // If it's not the other side of the stage, return.

        if (Status.STAGE.THEIRS !== stage) {
            metaIndex.addByPath(path);
            return;                                                   // RETURN
        }

        // If it's not a submodule, (or is a new one), move on.

        if (!allSubNamesSet.has(path)) {
            metaIndex.addByPath(path);

            // Record that this path was added.

            possibleNewSubs.add(path);
            return;                                                   // RETURN
        }

        // Otherwise, queue up the merge.

        const id = NodeGit.Oid.fromString(entry.id.tostrS());
        mergers.push(merger(path, id));
    });

    // Execute the submodule merges in parallel.

    yield mergers;

    // If one of the submodules could not be merged, exit.

    if (!allMerged) {
        process.exit(-1);
    }

    // This bit gets a little nasty.  First, we need to put `metaIndex` into a
    // proper state and write it out.

    metaIndex.conflictCleanup();
    metaIndex.write();
    yield metaIndex.writeTreeTo(metaRepo);

    // Having committed the index with changes, we need to check it out so that
    // it's applied to the current index and working directory.  Only there
    // will we be able to properly reflect the changes to the submodules.  We
    // need to get to a point where we have a "real" index to work with.

    const checkoutOpts =  {
        checkoutStrategy: NodeGit.Checkout.STRATEGY.FORCE
    };
    yield NodeGit.Checkout.index(metaRepo, metaIndex, checkoutOpts);

    // Now that the changes are applied to the current working directory and
    // index, we can open the current index and work with it.

    const newIndex = yield metaRepo.openIndex();

    // We've made changes to (merges into) some of the submodules; now we can
    // finally stage them into the index.

    toAdd.forEach(subName => {
        newIndex.addByPath(subName);
    });

    // And write that index out.

    newIndex.write();
    const id = yield newIndex.writeTreeTo(metaRepo);

    // And finally, commit it.

    yield metaRepo.createCommit("HEAD",
                                sig,
                                sig,
                                commitMessage,
                                id,
                                [head, commit]);

    // One last final bit of hackery: submodules that were added by a merge are
    // left in an invalid state.  They cannot be "opened", so we explicitly
    // close them.  Actually, we don't have to go through the entire "close"
    // process, the only part of these repos left dangling is their submodules
    // directories; this bit is enough to prevent an 'open'operation from
    // succeeding.

    const curSubNames = yield SubmoduleUtil.getSubmoduleNames(metaRepo);
    const workingDir = metaRepo.workdir();
    for (let csi = 0; csi < curSubNames.length; ++csi) {
        let csiName = curSubNames[csi];
        yield Close.cleanModulesDirectory(workingDir, csiName);
    }
});
