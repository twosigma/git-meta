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

const assert  = require("chai").assert;
const co      = require("co");
const colors  = require("colors");
const NodeGit = require("nodegit");

//const Close         = require("../util/close");
const Open          = require("./open");
const RepoStatus    = require("./repo_status");
const Status        = require("./status");
const SubmoduleUtil = require("./submodule_util");
const UserError     = require("./user_error");

/**
 * @enum {MODE}
 * Flags to describe what type of merge to do.
 */
const MODE = {
    NORMAL      : 0,  // will do a fast-forward merge when possible
    FF_ONLY     : 1,  // will fail unless fast-forward merge is possible
    FORCE_COMMIT: 2,  // will generate merge commit even could fast-forward
};

exports.MODE = MODE;

/**
 * Return true if the specified `source` commit is up-to-date with the
 * specified `target` commit in the specified `repo`.  A commit is up-to-date
 * with `target` if it is the same commit, or if it is descended from `target`.
 *
 * @private
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             source
 * @param {String}             target
 * @return {Boolean}
 */
const isUpToDate = co.wrap(function *(repo, source, target) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(source);
    assert.isString(target);
    if (source === target) {
        return true;                                                  // RETURN
    }
    return yield NodeGit.Graph.descendantOf(repo, source, target);
});

/**
 * Merge the specified `commit` in the specified `metaRepo` having the
 * specified `metaRepoStatus`, using the specified `mode` to control whether or
 * not a merge commit will be generated.  The behavior is undefined unless the
 * `metaRepo` is in a consistent state according to
 * `Status.ensureCleanAndConsistent`.  The specified `commitMessage` will be
 * recorded as the message for merge commits.  Throw a `UserError` exception if
 * a fast-forward merge is requested and cannot be completed.
 *
 * Note that this method will open closed submodules having changes recorded in
 * `commit` compared to HEAD.
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {RepoStatus}         metaRepoStatus
 * @param {NodeGit.Commit}     commit
 * @param {MODE}               mode
 * @param {String}             commitMessage
 * @return {Object|null}
 * @return {String} return.metaCommit
 * @return {Object} return.submoduleCommits  map from submodule to commit
 */
exports.merge = co.wrap(function *(metaRepo,
                                   metaRepoStatus,
                                   commit,
                                   mode,
                                   commitMessage) {
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.instanceOf(metaRepoStatus, RepoStatus);
    assert.isNumber(mode);
    assert.instanceOf(commit, NodeGit.Commit);
    assert.isString(commitMessage);

    // TODO: See how we do with a variety of edge cases, e.g.: submodules added
    // and removed.
    // TODO: Deal with conflicts.

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

    // If the target commit is an ancestor of the derived commit, then we have
    // nothing to do; the target commit is already part of the current history.

    const commitSha = commit.id().tostrS();

    if (yield isUpToDate(metaRepo, metaRepoStatus.headCommit, commitSha)) {
        return null;
    }

    let canFF = yield NodeGit.Graph.descendantOf(metaRepo,
                                                 commitSha,
                                                 metaRepoStatus.headCommit);

    if (MODE.FF_ONLY === mode && !canFF) {
        throw new UserError(`The meta-repositor cannot be fast-forwarded to \
${colors.red(commitSha)}.`);
    }

    const sig = metaRepo.defaultSignature();

    // Kick off the merge.  It is important to note is that `Merge.commit` does
    // not directly modify the working directory or index.  The `metaIndex`
    // object it returns is magical, virtual, does not operate on HEAD or
    // anything, has no effect.

    const head = yield metaRepo.getCommit(metaRepoStatus.headCommit);
    const metaIndex = yield NodeGit.Merge.commits(metaRepo,
                                                  head,
                                                  commit,
                                                  null);

    let errorMessage = "";

    // `toAdd` will contain a list of paths that need to be added to the final
    // index when it's ready.  Adding them to the "virtual", `metaIndex` object
    // turns out to have no effect.  This complication is caused by a a
    // combination of merge/index weirdness and submodule weirdness.

    const toAdd = [];

    const subCommits = {};  // Record of merge commits in submodules.

    const subs = metaRepoStatus.submodules;

    const mergeEntry = co.wrap(function *(entry) {
        const path = entry.path;
        const stage = RepoStatus.getStage(entry.flags);

        // If the entry is not on the "other" side of the merge move on.

        if (RepoStatus.STAGE.THEIRS !== stage &&
            RepoStatus.STAGE.NORMAL !== stage) {
            return;                                                   // RETURN
        }

        // If it's not a submodule move on.

        if (!(path in subs)) {
            return;                                                   // RETURN
        }

        // Otherwise, we have a submodule that needs to be merged.

        const subCommitId = NodeGit.Oid.fromString(entry.id.tostrS());
        const sub = subs[path];
        const subHeadSha = sub.commitSha;
        const subCommitSha = subCommitId.tostrS();

        // Exit early without opening if we have the same commit as the one
        // we're supposed to merge to.

        if (subCommitSha === subHeadSha) {
            return;                                                   // RETURN
        }

        let subRepoStatus = sub.repoStatus;
        let subRepo;
        if (null === subRepoStatus) {
            // If this submodule's not open, open it.

            console.log(`Opening ${colors.blue(path)}.`);
            subRepo = yield Open.open(metaRepo, path, sub.indexUrl);
            subRepoStatus = yield Status.getRepoStatus(subRepo);
        }
        else {
            subRepo = yield SubmoduleUtil.getRepo(metaRepo, path);
        }
        const subCommit = yield subRepo.getCommit(subCommitId);

        // If this submodule is up-to-date with the merge commit, exit.

        if (yield isUpToDate(subRepo, subHeadSha, subCommitSha)) {
            console.log(`Submodule ${colors.blue(path)} is up-to-date with \
commit ${colors.green(subCommitSha)}.`);
            return;                                                   // RETURN
        }

        // If we can fast-forward, we don't need to do a merge.

        const canSubFF = yield NodeGit.Graph.descendantOf(subRepo,
                                                          subCommitSha,
                                                          subHeadSha);
        if (canSubFF && MODE.FORCE_COMMIT !== mode) {
            console.log(`Submodule ${colors.blue(path)}: fast-forward to
${colors.green(subCommitSha)}.`);
            yield NodeGit.Reset.reset(subRepo,
                                      subCommit,
                                      NodeGit.Reset.TYPE.HARD);

            // We still need to add this submodule's name to the list to add so
            // that it will be recorded to the index if the meta-repo ends up
            // generating a commit.

            toAdd.push(path);
            return;                                                   // RETURN
        }
        else if (MODE.FF_ONLY === mode) {
            // If non-ff merge is disallowed, bail.
            errorMessage += `Submodule ${colors.red(path)} could not be \
fast-forwarded.\n`;
            return;                                                   // RETURN
        }

        // We're going to generate a commit.  Note that the meta-repo cannot be
        // fast-forwarded.

        canFF = false;

        console.log(`Submodule ${colors.blue(path)}: merging commit \
${colors.green(subCommitSha)}.\n`);

        // Start the merge.

        const subHead = yield subRepo.getCommit(subHeadSha);
        let index = yield NodeGit.Merge.commits(subRepo,
                                                  subHead,
                                                  subCommit,
                                                  null);

        // Abort if conflicted.

        if (index.hasConflicts()) {
            errorMessage += `Submodule ${colors.red(path)} is conflicted.\n`;
            return;                                                   // RETURN
        }

        // Otherwise, finish off the merge.

        yield index.writeTreeTo(subRepo);
        yield NodeGit.Checkout.index(subRepo, index, {
            checkoutStrategy: NodeGit.Checkout.STRATEGY.FORCE,
        });
        index = yield subRepo.index();
        const treeId = yield index.writeTreeTo(subRepo);
        const mergeCommit = yield subRepo.createCommit("HEAD",
                                                       sig,
                                                       sig,
                                                       commitMessage,
                                                       treeId,
                                                       [subHead, subCommit]);
        subCommits[path] = mergeCommit.tostrS();

        // And add this sub-repo to the list of sub-repos that need to be added
        // to the index later.

        toAdd.push(path);
    });

    // Createa a submodule merger for each submodule in the index.

    const entries = metaIndex.entries();
    yield entries.map(mergeEntry);

    // If one of the submodules could not be merged, exit.

    if ("" !== errorMessage) {
        throw new UserError(errorMessage);
    }

    // If we've made it through the submodules and can still fast-forward, just
    // reset the head to the right commit and return.

    if (canFF && MODE.FORCE_COMMIT !== mode) {
        console.log(
            `Fast-forwarding meta-repo to ${colors.green(commitSha)}.`);
        yield NodeGit.Reset.reset(metaRepo, commit, NodeGit.Reset.TYPE.HARD);
        return {
            metaCommit: commitSha,
            submoduleCommits: subCommits,
        };
    }

    console.log(`Merging meta-repo commit ${colors.green(commitSha)}.`);

    // This bit gets a little nasty.  First, we need to put `metaIndex` into a
    // proper state and write it out.

    yield metaIndex.conflictCleanup();
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

    const newIndex = yield metaRepo.index();

    // We've made changes to (merges into) some of the submodules; now we can
    // finally stage them into the index.

    yield toAdd.map(subName => newIndex.addByPath(subName));

    // And write that index out.

    yield newIndex.write();
    const id = yield newIndex.writeTreeTo(metaRepo);

    // And finally, commit it.

    const metaCommit = yield metaRepo.createCommit("HEAD",
                                                   sig,
                                                   sig,
                                                   commitMessage,
                                                   id,
                                                   [head, commit]);

    return {
        metaCommit: metaCommit.tostrS(),
        submoduleCommits: subCommits,
    };
});
