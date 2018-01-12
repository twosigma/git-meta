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

const assert    = require("chai").assert;
const co        = require("co");
const NodeGit   = require("nodegit");

const RepoStatus    = require("./repo_status");
const StatusUtil    = require("./status_util");
const SubmoduleUtil = require("./submodule_util");

/**
 * Stage modified content at the specified `paths` in the specified `repo`.  If
 * a path in `paths` refers to a file, stage it; if it refers to  a directory,
 * stage all modified content rooted at that path, including that in open
 * submodules.  Note that a path of "" is taken to indicate the entire
 * repository.  The behavior is undefined unless every path in `paths` is a
 * valid relative path in `repo.workdir()`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String []}          paths
 */
exports.stagePaths = co.wrap(function *(repo, paths, stageMetaChanges, update) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isArray(paths);
    assert.isBoolean(stageMetaChanges);
    assert.isBoolean(update);

    const repoStatus = yield StatusUtil.getRepoStatus(repo, {
        showMetaChanges: stageMetaChanges,
        paths: paths,
        showAllUntracked: true,
    });

    // First, stage submodules.

    const subs = repoStatus.submodules;
    yield Object.keys(subs).map(co.wrap(function *(name) {
        const subStat = subs[name];
        if (null !== subStat.workdir) {
            const subRepo = yield SubmoduleUtil.getRepo(repo, name);
            const workdir = subStat.workdir.status.workdir;
            const index = yield subRepo.index();
            yield Object.keys(workdir).map(filename => {
                // if -u flag is provided, update tracked files only.
                if (update) {
                    if (RepoStatus.FILESTATUS.ADDED !== workdir[filename]) {
                       return index.addByPath(filename);
                    }
                } else {
                    return index.addByPath(filename);
                }
            });
            yield index.write();
        }
    }));

    // Then meta changes.

    const toAdd = Object.keys(repoStatus.workdir);
    if (0 !== toAdd.length) {
        const index = yield repo.index();
        yield toAdd.map(filename => index.addByPath(filename));
        yield index.write();
    }
});
