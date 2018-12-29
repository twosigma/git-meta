/*
 * Copyright (c) 2019, Two Sigma Open Source
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

const assert       = require("chai").assert;
const co           = require("co");
const colors       = require("colors");
const NodeGit      = require("nodegit");

const CherryPickUtil      = require("./cherry_pick_util");
const ConfigUtil          = require("./config_util");
const DoWorkQueue         = require("./do_work_queue");
const GitUtil             = require("./git_util");
const Open                = require("./open");
const UserError           = require("./user_error");


/**
 * Update meta repo index and point the submodule to a commit sha
 * 
 * @param {NodeGit.Index} index
 * @param {String} subName
 * @param {String} sha
 */
const addSubmoduleCommit = co.wrap(function *(index, subName, sha) {
    assert.instanceOf(index, NodeGit.Index);
    assert.isString(subName);
    assert.isString(sha);

    const entry = new NodeGit.IndexEntry();
    entry.path = subName;
    entry.mode = NodeGit.TreeEntry.FILEMODE.COMMIT;
    entry.id = NodeGit.Oid.fromString(sha);
    entry.flags = entry.flagsExtended = 0;
    yield index.add(entry);
});

/**
 * Merge in each submodule and update in memory index accordingly.
 * 
 * @param {NodeGit.Repository}  repo
 * @param {Open.Opener}         opener
 * @param {NodeGit.Index}       mergeIndex
 * @param {Object}              subs  map from sub name to changes
 * @param {String}              message commit message
 * */
exports.mergeSubmoduleBare = co.wrap(function *(repo, 
                                                opener,
                                                mergeIndex,
                                                subs,
                                                message) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(mergeIndex, NodeGit.Index);
    assert.isObject(subs);
    assert.isString(message);

    const result = {
        conflicts: {},
        commits: {},
    };
    const sig = yield ConfigUtil.defaultSignature(repo);
    const fetcher = yield opener.fetcher();

    const mergeSubmodule = co.wrap(function *(name) {

        const subRepo = yield opener.getSubrepo(name, true);
        const change = subs[name];

        const theirSha = change.newSha;
        const ourSha = change.ourSha;
        yield fetcher.fetchSha(subRepo, name, theirSha);
        yield fetcher.fetchSha(subRepo, name, ourSha);
        const theirCommit = yield subRepo.getCommit(theirSha);
        const ourCommit = yield subRepo.getCommit(ourSha);

        // No change if ours is up-to-date
        if (yield NodeGit.Graph.descendantOf(subRepo, ourSha, theirSha)) {
            return result;                                            // RETURN
        }

        // use their sha if it is a fast forward merge
        if (yield NodeGit.Graph.descendantOf(subRepo, theirSha, ourSha)) {
            yield addSubmoduleCommit(mergeIndex, name, theirSha);
            return result;                                            // RETURN
        }

        console.log(`Submodule ${colors.blue(name)}: merging commit ` +
            `${colors.green(theirSha)}.`);

        // Start the merge.
        let subIndex = yield NodeGit.Merge.commits(subRepo,
                                                   ourCommit,
                                                   theirCommit,
                                                   null);

        // Abort if conflicted.
        if (subIndex.hasConflicts()) {
            result.conflicts[name] = theirSha;
            return;                                                   // RETURN
        }

        // Otherwise, finish off the merge.
        const treeId = yield subIndex.writeTreeTo(subRepo);
        const mergeCommit 
            = yield subRepo.createCommit(null,
                                         sig,
                                         sig,
                                         message,
                                         treeId,
                                         [ourCommit, theirCommit]);
        const mergeSha = mergeCommit.tostrS();
        result.commits[name] = mergeSha;
        yield addSubmoduleCommit(mergeIndex, name, mergeSha);
    });
    yield DoWorkQueue.doInParallel(Object.keys(subs), mergeSubmodule);
    return result;
});

/**
 * Return a formatted string indicating merge will abort for 
 * irresolvable conflicts.
 */
function formatConflictsMessage(conflicts) {
    let errorMessage = "CONFLICT (content): \n";
    const names = Object.keys(conflicts).sort();
    for (let name of names) {
        errorMessage += `Conflicting entries for submodule: ` + 
            `${colors.red(name)}\n`;
    }
    errorMessage += "Automatic merge failed\n";
    return errorMessage;
}

/**
 * Merge  `theirCommit` into `ourCommit` in the specified `repo` with specific
 * commitMessage. Return `null` if there are merge conflicts and the conflicts
 * cannot be resolved automatically. Return an object describing merge commits
 * otherwise. Use our commit as the merged commit if our commit is up to date,
 * use theirs if this is a fast forward merge and return a new merge commit
 * otherwise. Throw a `UserError` if there are no commits in common between 
 * `theirCommit` and `ourCommit`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     ourCommit
 * @param {NodeGit.Commit}     theirCommit
 * @param {String}             commitMessage
 * @return {Object}
 * @return {String|null} return.metaCommit
 * @return {Object}      return.submoduleCommits  map from submodule to commit
 * @return {String|null} return.errorMessage
 */
exports.merge = co.wrap(function *(repo,
                                   ourCommit,
                                   theirCommit,
                                   commitMessage) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(ourCommit, NodeGit.Commit);
    assert.instanceOf(theirCommit, NodeGit.Commit);
    assert.isString(commitMessage);

    const baseCommit = yield GitUtil.getMergeBase(repo, ourCommit, theirCommit);

    if (null === baseCommit) {
        throw new UserError(`No commits in common with `+
            `${colors.red(GitUtil.shortSha(ourCommit.id().tostrS()))} and ` +
            `${colors.red(GitUtil.shortSha(theirCommit.id().tostrS()))}`);
    }

    yield CherryPickUtil.ensureNoURLChanges(repo, ourCommit, theirCommit);

    const result = {
        metaCommit: null,
        submoduleCommits: {},
        errorMessage: null,
    };

    const ourCommitSha = ourCommit.id().tostrS();
    const theirCommitSha = theirCommit.id().tostrS();
    if (ourCommitSha === theirCommitSha) {
        console.log(`Nothing to do for merging ${colors.green(ourCommitSha)}` +
            `into itself.`);
        result.metaCommit = ourCommitSha;
        return result;
    }

    const upToDate  = yield NodeGit.Graph.descendantOf(repo,
                                                       ourCommitSha,
                                                       theirCommitSha);

    if (upToDate) {
        console.log(`${colors.green(ourCommitSha)} is up-to-date.`);
        result.metaCommit = ourCommitSha;
        return result;                                                // RETURN
    }

    const canFF  = yield NodeGit.Graph.descendantOf(repo,
                                                    theirCommitSha,
                                                    ourCommitSha);

    if (canFF) {
        console.log(`Fast-forward merge: `+
            `${colors.green(theirCommitSha)} is a descendant of `+
            `${colors.green(ourCommitSha)}`);
        result.metaCommit = theirCommitSha;
        return result;                                                // RETURN
    }

    const sig = yield ConfigUtil.defaultSignature(repo);

    const changeIndex
        = yield NodeGit.Merge.commits(repo, ourCommit, theirCommit, []);
    const changes 
        = yield CherryPickUtil.computeChangesBetweenTwoCommits(repo,
                                                               changeIndex,
                                                               ourCommit,
                                                               theirCommit);
    if (Object.keys(changes.conflicts).length > 0) {
        result.errorMessage = formatConflictsMessage(changes.conflicts);
        return result;                                                // RETURN
    }
    const opener = new Open.Opener(repo, null);

    const makeMetaCommit = co.wrap(function *(indexToWrite) {
        console.log(`Merging meta-repo commits ` +
                    `${colors.green(ourCommitSha)} and ` +
                    `${colors.green(theirCommitSha)}`);

        const id = yield indexToWrite.writeTreeTo(repo);
        // And finally, commit it.
        const metaCommit = yield repo.createCommit(null,
                                                   sig,
                                                   sig,
                                                   commitMessage,
                                                   id,
                                                   [ourCommit, theirCommit]);
        result.metaCommit = metaCommit.tostrS();
        console.log(`Merge commit created at ` +
            `${colors.green(result.metaCommit)}.`);
    });


    yield CherryPickUtil.changeSubmodulesBare(repo,
                                              opener,
                                              changeIndex,
                                              changes.simpleChanges);
    const merges = yield exports.mergeSubmoduleBare(repo, 
                                                    opener, 
                                                    changeIndex, 
                                                    changes.changes, 
                                                    commitMessage);
    if (Object.keys(merges.conflicts).length > 0) {
        result.errorMessage = formatConflictsMessage(merges.conflicts);
    } else {
        yield makeMetaCommit(changeIndex);
        result.submoduleCommits = merges.commits;    
    }
    return result;

});
