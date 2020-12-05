/*
 * Copyright (c) 2018, Two Sigma Open Source
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

const assert         = require("chai").assert;
const co             = require("co");
const NodeGit        = require("nodegit");
const path           = require("path");

const BulkNotesUtil       = require("./bulk_notes_util");
const DoWorkQueue         = require("./do_work_queue");
const ForcePushSpec       = require("./force_push_spec");
const GitUtil             = require("./git_util");
const StitchUtil          = require("./stitch_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const SubmoduleUtil       = require("./submodule_util");
const SyntheticBranchUtil = require("./synthetic_branch_util");
const TreeUtil            = require("./tree_util");
const UserError           = require("./user_error");

const FILEMODE = NodeGit.TreeEntry.FILEMODE;

/**
 * @property {String} local record of stitched commits
 */
exports.localReferenceNoteRef = "refs/notes/stitched/local-reference";

/**
 * Return the destitched data corresponding to the specified `stitchedSha` in
 * the specified `repo` if it can be found in `refs/notes/stitched/reference`
 * or `refs/notes/stitched/local-reference` or in the specified
 * `newlyStitched`, and null if it has not been destitched.
 *
 * @param {NodeGit.Repository} repo
 * @param {Object}             newlyStitched
 * @param {String}             stitchedSha
 * @return {Object}
 * @return {String} metaRepoCommit
 * @return {Object} subCommits      name to sha
 */
exports.getDestitched = co.wrap(function *(repo, newlyStitched, stitchedSha) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isObject(newlyStitched);
    assert.isString(stitchedSha);
    if (stitchedSha in newlyStitched) {
        return newlyStitched[stitchedSha];
    }
    let note = yield GitUtil.readNote(repo,
                                      exports.localReferenceNoteRef,
                                      stitchedSha);
    if (null === note) {
        note = yield GitUtil.readNote(repo,
                                      StitchUtil.referenceNoteRef,
                                      stitchedSha);
    }
    return note && JSON.parse(note.message());
});

/**
 * Return the name in the specified `submodules` to which the specified
 * `filename` maps or null if it maps to no submodule.  A filename maps to a
 * submodule if the submodule's path contains the filename. *
 * @param {Object} submodules  name to URL
 * @param {String} filename
 * @return {String|null}
 */
exports.findSubmodule = function (submodules, filename) {
    assert.isObject(submodules);
    assert.isString(filename);

    while ("." !== filename) {
        if (filename in submodules) {
            return filename;                                          // RETURN
        }
        filename = path.dirname(filename);
    }
    return null;
};

/**
 * Return the names of the specified `submodules` in the specified `repo` that
 * are affected by the changes introduced in the specified `stitchedCommit` as
 * compared against the specified `parentCommit`.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     submodules          name to URL
 * @param {NodeGit.Commit}     stitchedCommit
 * @param {NodeGit.Commit}     parentCommit
 * @return {Set String}
 */
exports.computeChangedSubmodules = co.wrap(function *(repo,
                                                      submodules,
                                                      stitchedCommit,
                                                      parentCommit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isObject(submodules);
    assert.instanceOf(stitchedCommit, NodeGit.Commit);
    assert.instanceOf(parentCommit, NodeGit.Commit);

    // We're going to take a diff between `stitchedCommit` and `parentCommit`,
    // and return a set of all submodule names that map to the modified files.

    const result = new Set();
    const tree = yield stitchedCommit.getTree();
    const parentTree = yield parentCommit.getTree();
    const diff = yield NodeGit.Diff.treeToTree(repo, parentTree, tree, null);
    const numDeltas = diff.numDeltas();
    const modulesFileName = SubmoduleConfigUtil.modulesFileName;
    for (let i = 0; i < numDeltas; ++i) {
        const delta = diff.getDelta(i);
        const file = delta.newFile();
        const filename = file.path();
        if (modulesFileName === filename) {
            continue;                                               // CONTINUE
        }
        const subname = exports.findSubmodule(submodules, filename);
        if (null === subname) {
            throw new UserError(`\
Could not map ${filename} to a submodule, and additions are not supported.`);
        }
        result.add(subname);
    }
    return result;
});

/**
 * Make a destitched commit created by applying changes to the specified
 * `changedSubmodules` from the specified `stitchedCommit` on top of the
 * specified `metaRepoCommits` in the specified `repo`.  Use the specified
 * `subUrls` to compute a new `.gitmodules` file when necessary (e.g., a
 * submodule is deleted).  Return an object describing commits that were
 * created.  The behavior is undefined all commits referenced in
 * `changedSubmodules` exist in `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @param {[NodeGit.Commit]}   metaRepoCommits
 * @param {NodeGit.Commit}     stitchedCommit
 * @param {Object}             subUrls               name to URL
 * @param {Object}             changedSubmodules     name to SHA
 * @return {Object}
 * @return {String} return.metaRepoCommit
 * @return {Object} subCommits           name to String
 */
exports.makeDestitchedCommit = co.wrap(function *(repo,
                                                  metaRepoCommits,
                                                  stitchedCommit,
                                                  changedSubmodules,
                                                  subUrls) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isArray(metaRepoCommits);
    assert.instanceOf(stitchedCommit, NodeGit.Commit);
    assert.isObject(changedSubmodules);
    assert.isObject(subUrls);

    const subCommits = {};  // created submodule commits
    const tree = yield stitchedCommit.getTree();
    let baseTree = null;    // tree of first parent if there is one
    if (0 !== metaRepoCommits.length) {
        const metaRepoCommit = metaRepoCommits[0];
        baseTree = yield metaRepoCommit.getTree();
    }
    const author = stitchedCommit.author();
    const committer = stitchedCommit.committer();
    const messageEncoding = stitchedCommit.messageEncoding();
    const message = stitchedCommit.message();
    const changes = {};     // changes from the meta parent's tree
    const commitUrls = Object.assign({}, subUrls);

    const computeSubChanges = co.wrap(function *(sub) {
        const sha = changedSubmodules[sub];
        let stitchedEntry = null;
        try {
            stitchedEntry = yield tree.entryByPath(sub);
        } catch(e) {
            delete commitUrls[sub];
            changes[sub] = null;
            return;                                                   // RETURN
        }
        const mode = stitchedEntry.filemode();
        if (FILEMODE.TREE !== mode) {
            // Changes must reside in submodules; we're not going to put files
            // directly in the meta-repo.
            // TBD: allow COMMIT changes.

            throw new UserError(`\
Change change of mode ${mode} to '${sub}' is not supported.`);
        }

        // Now we have an entry that's a tree.  We're going to make a new
        // commit whose contents are exactly that tree.

        const treeId = stitchedEntry.id();
        const stitchedTree = yield NodeGit.Tree.lookup(repo, treeId);
        const parent = yield repo.getCommit(sha);
        const commitId = yield NodeGit.Commit.create(repo,
                                                     null,
                                                     author,
                                                     committer,
                                                     messageEncoding,
                                                     message,
                                                     stitchedTree,
                                                     1,
                                                     [parent]);
        const commit = yield repo.getCommit(commitId);
        subCommits[sub] = commit.id().tostrS();
        changes[sub] = new TreeUtil.Change(commit, FILEMODE.COMMIT);
    });
    yield DoWorkQueue.doInParallel(Object.keys(changedSubmodules),
                                   computeSubChanges);

    // Update the modules file if we've removed one.

    const modulesContent = SubmoduleConfigUtil.writeConfigText(commitUrls);
    const modulesId = yield GitUtil.hashObject(repo, modulesContent);
    changes[SubmoduleConfigUtil.modulesFileName] =
                                 new TreeUtil.Change(modulesId, FILEMODE.BLOB);

    // Now we make a new commit using the changes we've computed.

    const newTree = yield TreeUtil.writeTree(repo, baseTree, changes);
    const commitId = yield NodeGit.Commit.create(repo,
                                                 null,
                                                 author,
                                                 committer,
                                                 messageEncoding,
                                                 message,
                                                 newTree,
                                                 metaRepoCommits.length,
                                                 metaRepoCommits);
    return {
        metaRepoCommit: commitId.tostrS(),
        subCommits: subCommits,
    };
});

/**
 * Destitch the specified `stitchedCommit` and (recursively) any of its
 * ancestors, but do nothing if the SHA for `stitchedCommit` exists in the
 * specified `newlyDestitched` map or in reference notes.  If a destitched
 * commit is created, record it in `newlyDestitched`.  Both of these map from
 * SHA to { metaRepoCommit, subCommits: submodule name to commit}.  Use the
 * specified `baseUrl` to fetch needed meta-repo commits and to resolve
 * submodule URLs.  Return the SHA of the destitched version of
 * `stitchedCommit`.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     stitchedCommit
 * @param {String}             baseUrl
 * @param {Object}             newlyDestitched
 * @return {String}
 */
exports.destitchChain = co.wrap(function *(repo,
                                           stitchedCommit,
                                           baseUrl,
                                           newlyDestitched) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(stitchedCommit, NodeGit.Commit);
    assert.isString(baseUrl);
    assert.isObject(newlyDestitched);

    const stitchedSha = stitchedCommit.id().tostrS();
    const done = yield exports.getDestitched(repo,
                                             newlyDestitched,
                                             stitchedSha);
    if (null !== done) {
        // Nothing to do here if it's been destitched.

        return done.metaRepoCommit;                                   // RETURN
    }

    // Make sure all destitched parents are available and load their commits.

    const parents = yield stitchedCommit.getParents();
    if (0 === parents.length) {
        throw new UserError(`Cannot destitch orphan commit ${stitchedSha}`);
    }
    const destitchedParents = [];
    for (const stitchedParent of parents) {
        const stitchedSha = stitchedParent.id().tostrS();
        const destitched = yield exports.getDestitched(repo,
                                                       newlyDestitched,
                                                       stitchedSha);
        let destitchedSha;
        if (null === destitched) {
            // If a parent has yet to be destiched, recurse.

            destitchedSha = yield exports.destitchChain(repo,
                                                        stitchedParent,
                                                        baseUrl,
                                                        newlyDestitched);
        } else {
            // If the parent was already destitched, make sure its meta-repo
            // commit is present,.

            destitchedSha = destitched.metaRepoCommit;
            console.log(`Fetching meta-repo commit, ${destitchedSha}.`);
            yield GitUtil.fetchSha(repo, baseUrl, destitchedSha);
        }
        const commit = yield repo.getCommit(destitchedSha);
        destitchedParents.push(commit);
    }

    const firstParent = destitchedParents[0];
    const urls =
          yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, firstParent);
    const changes = yield exports.computeChangedSubmodules(repo,
                                                           urls,
                                                           stitchedCommit,
                                                           parents[0]);

    const names = Array.from(changes);
    const shas = yield SubmoduleUtil.getSubmoduleShasForCommit(repo,
                                                               names,
                                                               firstParent);

    // Make sure we have all the commits needed for each changed submodule, and
    // do the fetch before processing ancestor commits to minimize the number
    // of fetches.

    const fetchSub = co.wrap(function *(name) {
        const url = SubmoduleConfigUtil.resolveUrl(baseUrl, urls[name]);
        const sha = shas[name];
        if (undefined !== sha) {
            console.log(`Fetching submodule ${name}.`);
            yield GitUtil.fetchSha(repo, url, sha);
        }
    });
    yield DoWorkQueue.doInParallel(names, fetchSub);

    const result = yield exports.makeDestitchedCommit(repo,
                                                      destitchedParents,
                                                      stitchedCommit,
                                                      shas,
                                                      urls);
    newlyDestitched[stitchedSha] = result;
    return result.metaRepoCommit;
});

/**
 * Push synthetic refs for the submodule commits described in the specified
 * `newCommits` created for the specified `destitchedCommit` in the specified
 * `repo`.  Use the specified `baseUrl` to resolve relative URLS
 * 
 * TBD: Minimize the number of pushes so that we do not push a commit and its
 * ancestor.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             baseUrl
 * @param {NodeGit.Commit}     destitchedCommit
 * @param {Object} commits  map from sha to { metaRepoCommit, subCommits }
 */
exports.pushSyntheticRefs = co.wrap(function *(repo,
                                               baseUrl,
                                               destitchedCommit,
                                               newCommits) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(baseUrl);
    assert.instanceOf(destitchedCommit, NodeGit.Commit);
    assert.isObject(newCommits);

    const urls = yield SubmoduleConfigUtil.getSubmodulesFromCommit(
                                                             repo,
                                                             destitchedCommit);

    const toPush = [];  // Array of url and sha
    Object.keys(newCommits).forEach(sha => {
        const subs = newCommits[sha].subCommits;
        Object.keys(subs).forEach(sub => {
            const subUrl = SubmoduleConfigUtil.resolveSubmoduleUrl(baseUrl,
                                                                   urls[sub]);
            toPush.push({
                url: subUrl,
                sha: subs[sub],
            });
        });
    });
    const pushOne = co.wrap(function *(push) {
        const sha = push.sha;
        const refName = SyntheticBranchUtil.getSyntheticBranchForCommit(sha);
        yield GitUtil.push(
            repo,
            push.url,
            sha,
            refName,
            ForcePushSpec.Force,
            true);
    });
    yield DoWorkQueue.doInParallel(toPush, pushOne);
});

/**
 * Record the specified `newCommits` to local reference notes in the specified
 * `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @param {Object}             newCommits  sha to { metaRepoCommit, subCommits}
 */
exports.recordLocalNotes = co.wrap(function *(repo, newCommits) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isObject(newCommits);
    const content = {};
    Object.keys(newCommits).forEach(sha => {
        content[sha] = JSON.stringify(newCommits[sha], null, 4);
    });
    yield BulkNotesUtil.writeNotes(repo,
                                   exports.localReferenceNoteRef,
                                   content);
});

/**
 * Create a destitched version of the specified `commitish`, including any
 * ancestors for which destitched versions cannot be found, in the specified
 * `repo`.  Use the specified `metaRemote` to fetch neede meta-repo commits and
 * to resolve submodule URLs.  Use the notes stored in
 * `refs/notes/stitched/reference` and `refs/notes/stitched/local-reference` to
 * match source meta-repo commits to stitched commits.  The behavior is
 * undefined if `stitchedCommit` or any of its (transitive) ancestors is a root
 * commit (having no parents) that cannot be mapped to a destitched commit in
 * `refs/notes/stitched/reference`.  Create and push synthetic references to
 * root all sub-module commits created as part of this operation.  If the
 * specified `targetRefName` is provided, create or update the reference with
 * that name to point to the destitched version of `stitchedCommit`.  Write, to
 * `refs/notes/stitched/local-reference` a record of the destitched notes
 * generated and return an object that describes them.  Throw a `UserError` if
 * `commitish` cannot be resolved or if `metaRemoteName` does not map to a
 * valid remote.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             commitish
 * @param {String}             metaRemoteName
 * @param {String|null}        targetRefName
 * @return {Object}  map from stitched sha to
 *                   { metaRepoCommit, submoduleCommits (from name to sha)}
 */
exports.destitch = co.wrap(function *(repo,
                                      commitish,
                                      metaRemoteName,
                                      targetRefName) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(commitish);
    assert.isString(metaRemoteName);
    if (null !== targetRefName) {
        assert.isString(targetRefName);
    }

    const annotated = yield GitUtil.resolveCommitish(repo, commitish);
    if (null === annotated) {
        throw new UserError(`\
Could not resolve '${commitish}' to a commit.`);
    }
    const commit = yield repo.getCommit(annotated.id());
    if (!(yield GitUtil.isValidRemoteName(repo, metaRemoteName))) {
        throw new UserError(`Invalid remote name: '${metaRemoteName}'.`);
    }
    const remote = yield NodeGit.Remote.lookup(repo, metaRemoteName);
    const baseUrl = remote.url();

    const newlyStitched = {};

    console.log("Destitching");

    const result = yield exports.destitchChain(repo,
                                               commit,
                                               baseUrl,
                                               newlyStitched);
    const resultCommit = yield repo.getCommit(result);

    // Push synthetic-refs

    console.log("Pushing synthetic refs");
    yield exports.pushSyntheticRefs(repo, baseUrl, resultCommit, newlyStitched);

    // Record local notes

    console.log("Recording local note");
    yield exports.recordLocalNotes(repo, newlyStitched);

    // Update the branch if requested.

    if (null !== targetRefName) {
        console.log(`Updating ${targetRefName}`);
        yield NodeGit.Reference.create(repo,
                                       targetRefName,
                                       resultCommit,
                                       1,
                                       "destitched");
    }
    return newlyStitched;
});
