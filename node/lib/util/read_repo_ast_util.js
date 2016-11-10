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
 * @module {ReadRepoAST}
 * This module exports a methods for reading `RepoAST` objects.
 */

const assert   = require("chai").assert;
const co       = require("co");
const deeper   = require("deeper");
const fs       = require("fs-promise");
const NodeGit  = require("nodegit");
const path     = require("path");

const RepoAST             = require("../util/repo_ast");
const SubmoduleConfigUtil = require("../util/submodule_config_util");

/**
 * Return a representation of the specified `repo` encoded in an `AST` object.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @return {RepoAST}
 */
exports.readRAST = co.wrap(function *(repo) {
    // We're going to list all the branches in `repo`, and walk each of their
    // histories to generate a complete set of commits.

    assert.instanceOf(repo, NodeGit.Repository);
    const branches = yield repo.getReferences(NodeGit.Reference.TYPE.LISTALL);
    let commits = {};
    let branchTargets = {};

    // Load up the remotes.

    const remotes = yield NodeGit.Remote.list(repo);
    let remoteMap = {};
    for (let i = 0; i < remotes.length; ++i) {
        const remoteName = remotes[i];
        const remote = yield NodeGit.Remote.lookup(repo, remoteName);
        remoteMap[remoteName] = {
            url: remote.url(),
            branches: {},
        };
    }

    // For various operations where `NodeGit` can return arrays, it requires a
    // maximum count size; I think it sets up a pre-allocated buffer.  I'm
    // picking a fairly arbitrary, but probably large enough, number for this.

    const MAX_IDS = 1000000;

    // Load all the commits.

    const loadCommit = co.wrap(function *(id) {
        assert.instanceOf(id, NodeGit.Oid);
        const revwalk = repo.createRevWalk();
        revwalk.push(id);
        const ids = yield revwalk.fastWalk(MAX_IDS);
        const commitLoaders = ids.map(co.wrap(function *(commitId) {

            const commitStr = commitId.tostrS();

            // Don't load already loaded commits

            if (commitStr in commits) {
                return;                                               // RETURN
            }

            let changes = {};

            // Put a placeholder in the `commits` map to prevent duplicate
            // processing of a commit.

            commits[commitStr] = true;

            // Loop through all the diffs for the commit and read the value of
            // each changed file.  Special action must be taken for submodules.
            // We will first load up a list of them from the `.gitmodules` file
            // in the specified commit (if it exists) and that is how we will
            // be able to identify changed paths as being submodules.

            const commit = yield repo.getCommit(commitId);
            const submodules =
               yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, commit);
            const diffs = yield commit.getDiff();
            const differs = diffs.map(co.wrap(function *(diff) {
                for (let i = 0; i < diff.numDeltas(); ++i) {
                    const delta = diff.getDelta(i);
                    const path = delta.newFile().path();

                    // We ignore the `.gitmodules` file.  Changes to it are an
                    // implementation detail and will be reflected in changes
                    // to submodule paths.

                    if (SubmoduleConfigUtil.modulesFileName === path) {
                        continue;
                    }
                    const DELETED = 2;
                    if (DELETED === delta.status()) {
                        changes[path] = null;
                    }
                    else if (path in submodules) {
                        const url = submodules[path];
                        const entry = yield commit.getEntry(path);
                        const sha = entry.sha();
                        changes[path] = new RepoAST.Submodule(url, sha);
                    }
                    else {
                        const entry = yield commit.getEntry(path);
                        const blob = yield entry.getBlob();
                        changes[path] = blob.toString();
                    }
                }
            }));
            yield differs;

            // Now get a list of parent commits.  We don't need to process them
            // (recursively) because the `ids` returned by `fastwalk` contains
            // all commits in the branch's history.

            const parents = yield commit.getParents(MAX_IDS);
            const parentShas = parents.map(p => p.id().tostrS());

            commits[commitStr] = new RepoAST.Commit({
                parents: parentShas,
                changes: changes,
                message: commit.message(),
            });
        }));
        yield commitLoaders;
    });

    // List all the branches.

    const branchListers = branches.map(co.wrap(function *(branch) {
        const id = branch.target();

        // If it's not a remote or a local branch, skip it.

        if (branch.isRemote()) {
            const shorthand = branch.shorthand();
            const slash = shorthand.indexOf("/");
            const remoteName = shorthand.substr(0, slash);
            const branchNameStart = slash + 1;
            const branchName = shorthand.substr(branchNameStart);
            remoteMap[remoteName].branches[branchName] = id.tostrS();
        }
        else if (branch.isBranch()) {
            branchTargets[branch.shorthand()] = id.tostrS();
        }
        else {
            return;                                                   // RETURN
        }
        yield loadCommit(id);
    }));
    yield branchListers;

    // Handle current branch.

    let branchName = null;
    let headCommitId = null;
    if (!repo.headDetached()) {
        const branch = yield repo.getCurrentBranch();
        branchName = branch.shorthand();
    }

    // If the repo isn't bare, process the index, HEAD, and workdir.

    let index = {};
    let workdir = {};
    if (!repo.isBare()) {
        const headCommit = yield repo.getHeadCommit();
        yield loadCommit(headCommit.id());
        headCommitId = headCommit.id().tostrS();

        // Process index and workdir changes.

        const repoIndex = yield repo.index();
        const submodules =
             yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, repoIndex);

        const STATUS = NodeGit.Status.STATUS;

        const stats = yield repo.getStatusExt();
        for (let i = 0; i < stats.length; ++i) {
            const stat = stats[i].statusBit();
            const filePath = stats[i].path();

            // skip the modules file

            if (SubmoduleConfigUtil.modulesFileName === filePath) {
                continue;
            }

            // Check index.

            if (stat & STATUS.INDEX_DELETED) {
                index[filePath] = null;
            }
            else if (stat & STATUS.INDEX_NEW || stat & STATUS.INDEX_MODIFIED) {

                // If the path indicates a submodule, we have to load its sha
                // separately, and use the url from the modules file.

                if (filePath in submodules) {
                    const url = submodules[filePath];
                    const entry = repoIndex.getByPath(filePath, 0);
                    const sha = entry.id.tostrS();
                    index[filePath] = new RepoAST.Submodule(url, sha);
                }
                else {

                    // Otherwise, read the blob for the file from the index.

                    const entry = repoIndex.getByPath(filePath, 0);
                    const oid = entry.id;
                    const blob = yield repo.getBlob(oid);
                    const data = blob.toString();
                    index[filePath] = data;
                }
            }
            // Check workdir

            if (stat & STATUS.WT_DELETED) {
                workdir[filePath] = null;
            }
            else if (stat & STATUS.WT_NEW || stat & STATUS.WT_MODIFIED) {
                if (!(filePath in submodules)) {
                    const absPath = path.join(repo.workdir(), filePath);
                    const data = yield fs.readFile(absPath, {
                        encoding: "utf8"
                    });
                    workdir[filePath] = data;
                }
            }
        }
    }

    // Now we can actually build the remote objects.

    let remoteObjs = {};
    for (let remoteName in remoteMap) {
        const remote = remoteMap[remoteName];
        remoteObjs[remoteName] = new RepoAST.Remote(remote.url, {
            branches: remote.branches
        });
    }

    // Read the notes
    let notes = {};
    let refName = null;
    const readNote = function *(noteData) {
        const commit = yield NodeGit.Blob.lookup(repo, noteData.commitId);
        notes[refName][noteData.annotatedId] = commit.content().toString();
    };
    const noteIds = [];
    const saveNote = function (commitId, annotatedId) {
        noteIds.push({
            commitId: commitId,
            annotatedId: annotatedId,
        });
        return 0;
    };

    const allRefs = yield NodeGit.Reference.list(repo);
    for (let i = 0; i < allRefs.length; ++i) {
        noteIds.length = 0;
        refName = allRefs[i];
        if (!refName.startsWith("refs/notes/")) {
            continue;
        }

        yield NodeGit.Note.foreach(repo, refName, saveNote);
        notes[refName] = {};
        yield noteIds.map(readNote);
    }

    // Lastly, load up submodules.

    let openSubmodules = {};

    if (!repo.isBare()) {
        const subNames = yield repo.getSubmoduleNames();
        for (let i = 0; i < subNames.length; ++i) {
            const subName = subNames[i];
            const status = yield NodeGit.Submodule.status(repo, subName, 0);
            const WD_UNINITIALIZED = (1 << 7);  // means "closed"
            if (!(status & WD_UNINITIALIZED)) {
                const sub = yield NodeGit.Submodule.lookup(repo, subName);
                const subRepo = yield sub.open();
                const subAST = yield exports.readRAST(subRepo);
                openSubmodules[subName] = subAST;
            }
        }
    }

    // In order to put our commit histories into canonical format, we need to
    // adjust merge commits s.t. the set of changes in a merge commit is
    // "against" the left-most parent, that is, the changes for a commit should
    // not contain duplicates from the first parent.

    const renderCache = {};

    Object.keys(commits).forEach(id => {
        const commit = commits[id];
        const parents = commit.parents;

        // Early exit if no parents.

        if (0 === parents.length) {
            return;                                                   // RETURN
        }

        const workdir = RepoAST.renderCommit(renderCache, commits, parents[0]);

        // Loop through the set of changes and delete any that are duplicates
        // from the first parent.

        let changeRemoved = false;
        const changes = commit.changes;
        Object.keys(changes).forEach(path => {
            if (deeper(workdir[path], changes[path])) {
                changeRemoved = true;
                delete changes[path];
            }
        });

        // Don't update the commit in the map unless we had to remove an entry.

        if (changeRemoved) {
            commits[id] = new RepoAST.Commit({
                parents: commit.parents,
                changes: changes,
                message: commit.message,
            });
        }
    });

    return new RepoAST({
        commits: commits,
        branches: branchTargets,
        head: headCommitId,
        currentBranchName: branchName,
        remotes: remoteObjs,
        index: index,
        notes: notes,
        workdir: workdir,
        openSubmodules: openSubmodules,
    });
});


