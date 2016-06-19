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

/**
 * This module contains methods for committing.
 */

const assert  = require("chai").assert;
const co      = require("co");
const NodeGit = require("nodegit");

const RepoStatus    = require("./repo_status");
const SubmoduleUtil = require("./submodule_util");
const Status        = require("./status");

/**
 * Commit changes in the specified `repo`.  If the specified `doAll` is true,
 * commit staged and unstaged files; otherwise, commit only staged files.  Use
 * the specified `message` as the commit message.  If there are no files to
 * commit and `false === force`, do nothing and return null; otherwise, return
 * the created commit object.  Ignore submodules.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {RepoStatus}         repoStatus
 * @param {Boolean}            doAll
 * @param {String}             message
 * @param {Boolean}            force
 * @return {NodeGit.Commit|null}
 */
const commitRepo = co.wrap(function *(repo,
                                      repoStatus,
                                      doAll,
                                      message,
                                      force) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(repoStatus, RepoStatus);
    assert.isBoolean(doAll);
    assert.isString(message);
    assert.isBoolean(force);

    let areStagedFiles = 0 !== Object.keys(repoStatus.staged).length || force;

    // If we're auto-staging files, loop through workdir and stage them.

    if (doAll) {
        let indexUpdated = false;
        const index = yield repo.index();
        const workdir = repoStatus.workdir;
        for (let path in workdir) {
            switch (workdir[path]) {
                case RepoStatus.FILESTATUS.MODIFIED:
                    index.addByPath(path);
                    indexUpdated = true;
                    areStagedFiles = true;
                    break;
                case RepoStatus.FILESTATUS.REMOVED:
                    index.remove(path, -1);
                    indexUpdated = true;
                    areStagedFiles = true;
                    break;
            }
        }
        if (indexUpdated) {
            index.write();
        }
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
 * Create a commit across modified repositories and the specified `metaRepo`
 * with the specified `message`, if provided, prompting the user if no message
 * is provided.  If the specified `all` is provided, automatically stage
 * modified files.  If a commit is generated, return an object that lists the
 * sha of the created meta-repo commit and the shas of any commits generated in
 * submodules.
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {Boolean}            all
 * @param {String}             message
 * @return {Object|null}
 * @return {String} return.metaCommit
 * @return {Object} submoduleCommits map from submodule name to new commit
 */
exports.commit = co.wrap(function *(metaRepo, all, message) {
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.isBoolean(all);
    assert.isString(message);

    const metaStatus = yield Status.getRepoStatus(metaRepo);
    const submodules = metaStatus.submodules;

    // Commit submodules.  If any changes, remember this so we know to generate
    // a commit in the meta-repo whether or not the meta-repo has its own
    // workdir changes.

    let subsChanged = false;
    let subCommits = {};
    const commitSubmodule = co.wrap(function *(name) {
        const status = submodules[name];
        const repoStatus = status.repoStatus;
        let committed = null;
        if (null !== repoStatus) {
            const subRepo = yield SubmoduleUtil.getRepo(metaRepo, name);
            committed = yield commitRepo(subRepo,
                                         repoStatus,
                                         all,
                                         message,
                                         false);
        }
        if (null !== committed) {
            subCommits[name] = committed.tostrS();
        }

        // Record a change if we made a commit, or if there was already a
        // change staged for this submodule.

        subsChanged = subsChanged ||
                      null !== committed ||
                      null !== status.indexStatus;
    });

    const subCommitters = Object.keys(submodules).map(commitSubmodule);
    yield subCommitters;

    // If submodule commits were created, we need to stage them.

    if (0 !== Object.keys(subCommits).length) {
        const index = yield metaRepo.index();
        for (let name in subCommits) {
            index.addByPath(name);
        }
        index.write();
    }

    const metaResult = yield commitRepo(metaRepo,
                                        metaStatus,
                                        all,
                                        message,
                                        subsChanged);

    if (null !== metaResult) {
        return {
            metaCommit: metaResult,
            submoduleCommits: subCommits,
        };
    }
    return null;
});
