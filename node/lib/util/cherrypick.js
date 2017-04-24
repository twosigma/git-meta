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

const Open                = require("../util/open");
const SubmoduleConfigUtil = require("../util/submodule_config_util");
const SubmoduleFetcher    = require("./submodule_fetcher");
const SubmoduleUtil       = require("../util/submodule_util");
const UserError           = require("../util/user_error");

/**
 * Cherry-pick the specified `commit` in the specified `metaRepo`.  Return an
 * object with the cherry-picked commits ids.  This object contains the id of
 * the newly-generated meta-repo commit and for each sub-repo, a map from
 * original commit sha to cherry-picked commit sha.  The behavior is undefined
 * unless the `metaRepo` is in a consistent state according to
 * `Status.ensureCleanAndConsistent`.  Throw a `UserError` object if a
 * cherry-pick results in confict; do not generate a meta-repo commit in this
 * case.
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {NodeGit.Commit}     commit
 * @return {Object}    return
 * @return {String}    return.newMetaCommit
 * @return {Object}    returm.submoduleCommits
 */
exports.cherryPick = co.wrap(function *(metaRepo, commit) {
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);

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

    const head = yield metaRepo.getHeadCommit();
    const changes = yield SubmoduleUtil.getSubmoduleChanges(metaRepo, commit);

    yield NodeGit.Cherrypick.cherrypick(metaRepo, commit, {});

    let errorMessage = "";
    let indexChanged = false;
    let pickers = [];

    const headSubs = yield SubmoduleUtil.getSubmodulesForCommit(metaRepo,
                                                                head);
    const commitSubs = yield SubmoduleUtil.getSubmodulesForCommit(metaRepo,
                                                                  commit);

    const metaIndex = yield metaRepo.index();

    const openSubs = new Set(yield SubmoduleUtil.listOpenSubmodules(metaRepo));

    let submoduleCommits = {};
    const subFetcher = new SubmoduleFetcher(metaRepo, commit);
    const templatePath = yield SubmoduleConfigUtil.getTemplatePath(metaRepo);

    const picker = co.wrap(function *(subName, headSha, commitSha) {
        let commitMap = {};
        submoduleCommits[subName] = commitMap;

        // If closed, open this submodule.

        let repo;
        if (!openSubs.has(subName)) {
            console.log(`Opening ${colors.blue(subName)}.`);
            repo = yield Open.openOnCommit(subFetcher,
                                           subName,
                                           headSubs[subName].sha,
                                           templatePath);
        }
        else {
            repo = yield SubmoduleUtil.getRepo(metaRepo, subName);
        }
        console.log(`Sub-repo ${colors.blue(subName)}: cherry-picking commit \
${colors.green(commitSha)}.`);

        // Fetch the commit; it may not be present.

        yield subFetcher.fetchSha(repo, subName, commitSha);

        const commit = yield repo.getCommit(commitSha);
        yield NodeGit.Cherrypick.cherrypick(repo, commit, {});
        const index = yield repo.index();
        if (index.hasConflicts()) {
            errorMessage +=
                           `Submodule ${colors.red(subName)} is conflicted.\n`;
        }
        else {
            repo.stateCleanup();
            const newCommit = yield repo.createCommitOnHead(
                                                  [],
                                                  commit.author(),
                                                  commit.committer(),
                                                  commit.message());
            yield metaIndex.addByPath(subName);
            commitMap[commitSha] = newCommit.tostrS();
            indexChanged = true;
        }
    });


    // Cherry-pick each submodule changed in `commit`.

    changes.changed.forEach(subName => {
        const headSub = headSubs[subName];
        const commitSub = commitSubs[subName];
        const headSha = headSub.sha;
        if (undefined !== commitSub &&
            headSha !== commitSub.sha) {
            pickers.push(picker(subName, headSha, commitSub.sha));
        }
    });

    // Then execute the submodule pickers in parallel.

    yield pickers;

    // If one of the submodules could not be picked, exit.

    if ("" !== errorMessage) {
        throw new UserError(errorMessage);
    }

    // After all the submodules are picked, write the index, perform cleanup,
    // and make the cherry-pick commit on the meta-repo.

    if (indexChanged) {
        yield metaIndex.conflictCleanup();
        yield metaIndex.write();
    }

    metaRepo.stateCleanup();
    const metaCommit = yield metaRepo.createCommitOnHead([],
                                                         commit.author(),
                                                         commit.committer(),
                                                         commit.message());
    return {
        newMetaCommit: metaCommit.tostrS(),
        submoduleCommits: submoduleCommits,
    };
});
