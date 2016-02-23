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

/**
 * This module contains methods for committing.
 */

const assert = require("assert");
const co     = require("co");

const GitUtil       = require("./slmu_gitutil");
const SubmoduleUtil = require("./slmu_submoduleutil");

/**
 * Commit changes in the specified `repo`.  If the specified `doAll` is true,
 * commit staged and unstaged files; otherwise, commit only staged files.  Use
 * the specified `message` as the commit message.  If there are no files to
 * commit, do nothing and return null; otherwise, return the created commit
 * object.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {Boolean}            doAll
 * @param {String}             message
 * @return {NodeGit.Commit|null}
 */
exports.commitRepo = co.wrap(function *(repo, doAll, message) {
    var areStagedFiles = false;
    var indexUpdated = false;
    const index = yield repo.index();
    const statuses = yield repo.getStatusExt();

    // Loop through all the status entries on the repo.  If 'all' is
    // selected, stage unstaged files.  If differences on the index are
    // found, remember that the index has been updated so we'll know to do
    // a commit.

    statuses.forEach(status => {

        // If we're doing all files, stage unstaged (non-new) files.

        if (doAll && null !== status.indexToWorkdir() && !status.isNew()) {
            indexUpdated = true;
            areStagedFiles = true;
            index.addByPath(status.path());
        }
        else {
            // Note that files have been staged.
            areStagedFiles = areStagedFiles || (0 !== status.inIndex());
        }
    });
    if (indexUpdated) {
        index.write();
    }
    if (areStagedFiles) {
        const signature = repo.defaultSignature();
        return yield repo.createCommitOnHead([],
                                             signature,
                                             signature,
                                             message);
    }
    return null;
});

/**
 * Create a commit across modified repositories and the meta-repository with
 * the specified `message`, if provided, prompting the user if no message is
 * provided.  If the specified `all` is provided, automatically stage modified
 * files.
 *
 * @async
 * @param {Boolean} all
 * @param {String}  message
 */
exports.commit = co.wrap(function *(all, message) {
    // TODO: 1. Prompt with editor if no message.
    //       2. Consider adding an "amend" that does something smart, like
    //          amending only repos changed by last commit in meta-repository.

    assert.notEqual(null, message, "message prompting not implemented");

    const metaRepo = yield GitUtil.getCurrentRepo();
    const subRepos = yield SubmoduleUtil.getSubmoduleRepos(metaRepo);
    const committers = subRepos.map(sub => {
        return exports.commitRepo(sub.repo, all, message);
    });

    // Commit to sub-repos first; can't update the meta-repo until the
    // sub-repos are done.

    yield committers;

    // We always commit all for the metaRepo.

    const metaResult = yield exports.commitRepo(metaRepo, true, message);

    // If we didn't generate a commit on the meta-repo that means we didn't
    // commit anything; we warn the user.

    if (null === metaResult) {
        console.warn("Nothing to commit.");
    }
});
