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

const RepoAST             = require("./repo_ast");
const RebaseFileUtil      = require("./rebase_file_util");
const SparseCheckoutUtil  = require("./sparse_checkout_util");
const SequencerStateUtil  = require("./sequencer_state_util");
const SubmoduleConfigUtil = require("./submodule_config_util");

const FILEMODE = NodeGit.TreeEntry.FILEMODE;
const File = RepoAST.File;

/**
 * Load the submodules objects from the specified `repo` on the specified
 * `commitId`.
 * @param {NodeGit.Repository} repo
 * @param {Object}             urls
 * @param {NodeGit.Commit}     commit
 */
const getSubmodules = co.wrap(function *(repo, urls, commit) {
    let result = {};
    const tree = yield commit.getTree();
    for (let subName in urls) {
        const url = urls[subName];
        const sha = (yield tree.entryByPath(subName)).sha();
        result[subName] = new RepoAST.Submodule(url, sha);
    }
    return result;
});

/**
 * Return the state of the index and working directory of the specified `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit|null} headCommit
 * @return {Object}
 * @return {Object} return.index path to content
 * @return {Object} return.workdir path to content
 */
const loadIndexAndWorkdir = co.wrap(function *(repo, headCommit) {
    // Process index and workdir changes.

    const repoIndex = yield repo.index();
    const index = {};
    const workdir = {};

    const submodules =
             yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, repoIndex);
    const referencedSubmodules = new Set();  // set of changed submodules

    const STATUS = NodeGit.Status.STATUS;

    const readWorkdir = co.wrap(function *(filePath) {
        const absPath = path.join(repo.workdir(), filePath);
        let data;
        try {
            data = yield fs.readFile(absPath, { encoding: "utf8" });
        } catch (e) {
            // no file
        }
        let isExecutable = false;
        try {
            yield fs.access(absPath, fs.constants.X_OK);
            isExecutable = true;
        } catch (e) {
            // cannot execute
        }
        if (undefined !== data) {
            workdir[filePath] = new File(data, isExecutable);
        }
    });

    const readEntryFile = co.wrap(function *(entry) {
        if (undefined === entry) {
            return null;                                              // RETURN
        }
        const oid = entry.id;
        if (FILEMODE.COMMIT === entry.mode) {
            return new RepoAST.Submodule("", oid.tostrS());
        }
        const isExecutable = FILEMODE.EXECUTABLE === entry.mode;
        const blob = yield repo.getBlob(oid);
        return new File(blob.toString(), isExecutable);
    });

    const stats = yield repo.getStatusExt();
    for (let i = 0; i < stats.length; ++i) {
        const statusFile = stats[i];
        const stat = statusFile.statusBit();
        let filePath = statusFile.path();

        // If the path ends with a slash, knock it off so we'll be able to
        // match it to submodules.

        if (filePath.endsWith("/")) {
            filePath = filePath.slice(0, filePath.length - 1);
        }

        // skip the modules file

        if (SubmoduleConfigUtil.modulesFileName === filePath) {
            continue;
        }

        // Check index.

        if (statusFile.isConflicted()) {
            // If the file is conflicted, read the contents for each stage, and
            // the contents of the file in the workdir.

            const ancestorEntry = repoIndex.getByPath(filePath, 1);
            const ourEntry = repoIndex.getByPath(filePath, 2);
            const theirEntry = repoIndex.getByPath(filePath, 3);
            const ancestorData = yield readEntryFile(ancestorEntry);
            const ourData = yield readEntryFile(ourEntry);
            const theirData = yield readEntryFile(theirEntry);
            index[filePath] = new RepoAST.Conflict(ancestorData,
                                                   ourData,
                                                   theirData);
            yield readWorkdir(filePath);
            continue;                                               // CONTINUE
        }

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
                referencedSubmodules.add(filePath);
            }
            else {

                // Otherwise, read the blob for the file from the index.
                const entry = repoIndex.getByPath(filePath, 0);
                index[filePath] = yield readEntryFile(entry);
            }
        }

        // Check workdir

        if (stat & STATUS.WT_DELETED) {
            workdir[filePath] = null;
        }
        else if (stat & STATUS.WT_NEW || stat & STATUS.WT_MODIFIED) {
            if (!(filePath in submodules)) {
                yield readWorkdir(filePath);
            }
        }
    }

    // Check for changes to submodules not reflected in the index (other
    // than via .gitmodules file), i.e.: submodules with just URL changes
    // or those added but with no index entry yet.  We're not (yet) looking
    // for truly kooky situations such as the user manually deleting the
    // entry for a submodule in the index.

    let commitSubmodules = {};  // map from subname to URL for base commit
    if (null !== headCommit) {
        commitSubmodules =
            yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo,
                                                              headCommit);
    }

    for (let subName in submodules) {
        const indexUrl = submodules[subName];
        if (!referencedSubmodules.has(subName) &&
            (!(subName in commitSubmodules) ||
              indexUrl !== commitSubmodules[subName])) {
            let sha = null;
            try {
                sha = repoIndex.getByPath(subName, 0).id.tostrS();
            }
            catch (e) {
                // doesn't have an entry
            }
            index[subName] = new RepoAST.Submodule(indexUrl, sha);
        }
    }
    return {
        index: index,
        workdir: workdir,
    };
});

const syntheticRefRegexp = new RegExp("^refs/commits/[0-9a-f]{40}$");
const isSyntheticRef = function(refName) {
    return syntheticRefRegexp.test(refName);
};

/**
 * Return a representation of the specified `repo` encoded in an `AST` object.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param boolean includeRefsCommits if true, refs from the
 * refs/commits namespace are read.  Ordinarily, these are ignored
 * because they are created any time a submodule is fetched as part of
 * a git meta open, which is often to be done as part of repo writing.
 * But some tests rely on refs in this namespace, and these tests need
 * to include them.
 * @return {RepoAST}
 */
exports.readRAST = co.wrap(function *(repo, includeRefsCommits) {
    // We're going to list all the branches in `repo`, and walk each of their
    // histories to generate a complete set of commits.

    assert.instanceOf(repo, NodeGit.Repository);
    if (includeRefsCommits === undefined) {
        includeRefsCommits = false;
    }
    assert.instanceOf(repo, NodeGit.Repository);
    const branches = yield repo.getReferences();
    let commits = {};
    let branchTargets = {};
    let refTargets = {};

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
            // each changed file.

            const commit = yield repo.getCommit(commitId);
            const submodules =
               yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, commit);
            const diffs = yield commit.getDiff();
            const diff = diffs[0];
            for (let i = 0; i < diff.numDeltas(); ++i) {
                const delta = diff.getDelta(i);
                const path = delta.newFile().path();

                // We ignore the `.gitmodules` file.  Changes to it are an
                // implementation detail and will be reflected in changes
                // to submodule paths.

                if (SubmoduleConfigUtil.modulesFileName === path) {
                    continue;
                }
                if (NodeGit.Diff.DELTA.DELETED === delta.status()) {
                    changes[path] = null;
                }
                else if (!(path in submodules)) {
                    // Skip submodules; we handle them later.
                    const entry = yield commit.getEntry(path);
                    const isExecutable =
                                      FILEMODE.EXECUTABLE === entry.filemode();
                    const blob = yield entry.getBlob();
                    changes[path] = new File(blob.toString(), isExecutable);
                }
            }

            // Now get a list of parent commits.  We don't need to process them
            // (recursively) because the `ids` returned by `fastwalk` contains
            // all commits in the branch's history.

            const parents = yield commit.getParents(MAX_IDS);
            const parentShas = parents.map(p => p.id().tostrS());

            // Check the submodules manually; they may be changed by a change
            // to the tree or to the `.gitmodules` file.  First, load the
            // parent's submodules (this step could be optimized to not reload
            // parent submodules but we currently don't load in any order).

            let parentSubs = {};

            if (0 !== parents.length) {
                const parentCommit = yield repo.getCommit(parents[0]);
                const parentUrls =
                             yield SubmoduleConfigUtil.getSubmodulesFromCommit(
                                                                 repo,
                                                                 parentCommit);
                parentSubs = yield getSubmodules(repo,
                                                 parentUrls,
                                                 parentCommit);
            }
            const mySubs = yield getSubmodules(repo, submodules, commit);
            for (let key in mySubs) {
                const mySub = mySubs[key];
                if (!deeper(mySub, parentSubs[key])) {
                    changes[key] = mySub;
                }
            }

            const result = new RepoAST.Commit({
                parents: parentShas,
                changes: changes,
                message: commit.message(),
            });

            commits[commitStr] = result;
            return result;
        }));
        yield commitLoaders;
        return commits[id.tostrS()];
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
            let tracking = null;
            let upstream = null;
            try {
                upstream = yield NodeGit.Branch.upstream(branch);
            }
            catch (e) {
                // No way to check if it's valid.
            }
            if (null !== upstream) {
                tracking = upstream.shorthand();
            }
            branchTargets[branch.shorthand()] =
                                     new RepoAST.Branch(id.tostrS(), tracking);
        }
        else if (!branch.isNote()) {
            if (includeRefsCommits ||
                !isSyntheticRef(branch.name())) {
                refTargets[branch.shorthand()] = id.tostrS();
            } else {
                return;
            }
        }
        else {
            return;                                           // RETURN
        }
        yield loadCommit(id);
    }));
    yield branchListers;

    // Handle current branch.

    let branchName = null;
    let headCommitId = null;
    if (!repo.headDetached() && !repo.isEmpty()) {
        // It's possible that the repo may be non-empty, non-head-detached
        // (because it's bare), and still not have a current branch, in which
        // case, `getCurrentBranch` will throw.

        let branch = null;
        try {
            branch = yield repo.getCurrentBranch();
        }
        catch (e) {
        }
        if (null !== branch) {
            branchName = branch.shorthand();
        }
    }

    // If the repo isn't bare, process the index, HEAD, and workdir.

    let index = {};
    let workdir = {};
    const bare = repo.isBare() !== 0;
    const headCommit = yield repo.getHeadCommit();
    if (null !== headCommit) {
        yield loadCommit(headCommit.id());
        headCommitId = headCommit.id().tostrS();
    }

    const sparse = yield SparseCheckoutUtil.inSparseMode(repo);

    if (!bare) {
        const current = yield loadIndexAndWorkdir(repo, headCommit);
        index = current.index;

        // Ignore the workdir if it's sparse.

        if (!sparse) {
            workdir = current.workdir;
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

    if (!bare) {
        const index = yield repo.index();
        const subs = yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo,
                                                                      index);
        const subNames = Object.keys(subs);
        for (let i = 0; i < subNames.length; ++i) {
            const subName = subNames[i];
            const status = yield NodeGit.Submodule.status(repo, subName, 0);
            if (status & NodeGit.Submodule.STATUS.IN_WD &&
                !(status & NodeGit.Submodule.STATUS.WD_UNINITIALIZED)) {
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

    const rebase = yield RebaseFileUtil.readRebase(repo.path());

    if (null !== rebase) {
        yield loadCommit(NodeGit.Oid.fromString(rebase.originalHead));
        yield loadCommit(NodeGit.Oid.fromString(rebase.onto));
    }

    const sequencer = yield SequencerStateUtil.readSequencerState(repo.path());

    if (null !== sequencer) {
        yield loadCommit(NodeGit.Oid.fromString(sequencer.originalHead.sha));
        yield loadCommit(NodeGit.Oid.fromString(sequencer.target.sha));
        yield sequencer.commits.map(
                               sha => loadCommit(NodeGit.Oid.fromString(sha)));
    }

    return new RepoAST({
        commits: commits,
        branches: branchTargets,
        refs: refTargets,
        head: headCommitId,
        currentBranchName: branchName,
        remotes: remoteObjs,
        index: index,
        notes: notes,
        workdir: workdir,
        openSubmodules: openSubmodules,
        rebase: rebase,
        sequencerState: sequencer,
        bare: bare,
        sparse: sparse,
    });
});
