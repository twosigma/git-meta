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
 * This module provides utilities for reading `RepoStatus` objects --
 * describing state changes -- from a repository.
 *
 */

const assert  = require("chai").assert;
const co      = require("co");
const NodeGit = require("nodegit");

const DiffUtil            = require("./diff_util");
const GitUtil             = require("./git_util");
const Rebase              = require("./rebase");
const RebaseFileUtil      = require("./rebase_file_util");
const RepoStatus          = require("./repo_status");
const SubmoduleUtil       = require("./submodule_util");
const SubmoduleConfigUtil = require("./submodule_config_util");

/**
 * Return a new `RepoStatus.Submodule` object having the same value as the
 * specified `sub` but with all commit shas replaced by commits in the
 * specified `commitMap` and all urls replaced by the values in the specified
 * `urlMap`.
 *
 * @param {RepoStatus.Submodule} sub
 * @param {Object}               commitMap from sha to sha
 * @param {Object}               urlMap    from url to url
 * @return {RepoStatus.Submodule}
 */
exports.remapSubmodule = function (sub, commitMap, urlMap) {
    assert.instanceOf(sub, RepoStatus.Submodule);
    assert.isObject(commitMap);
    assert.isObject(urlMap);

    function mapSha(sha) {
        return sha && (commitMap[sha] || sha);
    }

    function mapUrl(url) {
        return url && (urlMap[url] || url);
    }
    const Submodule = RepoStatus.Submodule;

    const commit = sub.commit &&
          new Submodule.Commit(mapSha(sub.commit.sha), mapUrl(sub.commit.url));
    const index = sub.index && new Submodule.Index(mapSha(sub.index.sha),
                                                   mapUrl(sub.index.url),
                                                   sub.index.relation);
    const workdir = sub.workdir &&
        new Submodule.Workdir(exports.remapRepoStatus(sub.workdir.status,
                                                      commitMap,
                                                      urlMap),
                              sub.workdir.relation);

    return new RepoStatus.Submodule({
        commit: commit,
        index: index,
        workdir: workdir,
    });
};

/**
 * Return a new `Rebase` object having the same value as the specified `rebase`
 * but with commit shas being replaced by commits in the specified `commitMap`.
 *
 * @param {Rebase} rebase
 * @param {Object} commitMap from sha to sha
 */
function remapRebase(rebase, commitMap) {
    assert.instanceOf(rebase, Rebase);
    assert.isObject(commitMap);

    let originalHead = rebase.originalHead;
    let onto = rebase.onto;
    if (originalHead in commitMap) {
        originalHead = commitMap[originalHead];
    }
    if (onto in commitMap) {
        onto = commitMap[onto];
    }
    return new Rebase(rebase.headName, originalHead, onto);
}

/**
 * Return a new `RepoStatus` object having the same value as the specified
 * `status` but with all commit shas replaced by commits in the specified
 * `comitMap` and all urls replaced by the values in the specified `urlMap`.
 *
 * @param {RepoStatus} status
 * @param {Object}     commitMap
 * @param {Object}     urlMap
 * @return {RepoStatus}
 */
exports.remapRepoStatus = function (status, commitMap, urlMap) {
    assert.instanceOf(status, RepoStatus);
    assert.isObject(commitMap);
    assert.isObject(urlMap);

    function mapSha(sha) {
        return sha && (commitMap[sha] || sha);
    }

    let submodules = {};
    const baseSubmods = status.submodules;
    Object.keys(baseSubmods).forEach(name => {
        submodules[name] = exports.remapSubmodule(baseSubmods[name],
                                                  commitMap,
                                                  urlMap);
    });

    return new RepoStatus({
        currentBranchName: status.currentBranchName,
        headCommit: mapSha(status.headCommit),
        staged: status.staged,
        submodules: submodules,
        workdir: status.workdir,
        rebase: status.rebase === null ? null : remapRebase(status.rebase,
                                                            commitMap),
    });
};

/**
 * Return COMMIT_RELATION.AHEAD if the commit having the specified `to` sha in
 * the specified `repo` is a descendant of the specified `from`, BEHIND if
 * `from` is a descendant of `to`, and UNRELATED if neither is descended from
 * the other.  If null is provided for either value, return null.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             [from]
 * @param {String}             [to]
 * @return {RepoStatus.Submodule.COMMIT_RELATION|null}
 */
exports.getRelation = co.wrap(function *(repo, from, to) {
    assert.instanceOf(repo, NodeGit.Repository);
    if (null === from || null === to) {
        return null;
    }
    assert.isString(from);
    assert.isString(to);
    const COMMIT_RELATION = RepoStatus.Submodule.COMMIT_RELATION;
    if (from === to) {
        return COMMIT_RELATION.SAME;
    }

    const fromId = NodeGit.Oid.fromString(from);
    const toId = NodeGit.Oid.fromString(to);

    // If one of the commits is not present, `descendantOf` will throw.

    let toDescendant;
    try {
        toDescendant = yield NodeGit.Graph.descendantOf(repo, toId, fromId);
    }
    catch (e) {
        return COMMIT_RELATION.UNKNOWN;
    }

    if (toDescendant) {
        return COMMIT_RELATION.AHEAD;
    }

    const fromDescendant = yield NodeGit.Graph.descendantOf(repo,
                                                            fromId,
                                                            toId);
    if (fromDescendant) {
        return COMMIT_RELATION.BEHIND;
    }
    return COMMIT_RELATION.UNRELATED;
});

/**
 * Return a new `RepoStatus.Submodule` object for the submodule having the
 * optionally specified `repo`, and workdir `status` if open, the optionally
 * specified `indexUrl` and `indexSha` if the submodule exists in the index,
 * and the optionally specified `commitUrl` and `commitSha` if it exists in the
 * HEAD commit.
 * @async
 * @private
 * @param {NodeGit.Repository|null}         repo
 * @param {RepoStatus|null}                 status
 * @param {String|null}                     indexUrl
 * @param {String|null}                     commitUrl
 * @param {String|null}                     indexSha
 * @param {String|null}                     commitSha
 * @return {RepoStatus.Submodule}
 */
exports.getSubmoduleStatus = co.wrap(function *(repo,
                                                status,
                                                indexUrl,
                                                commitUrl,
                                                indexSha,
                                                commitSha) {
    const Submodule = RepoStatus.Submodule;
    const COMMIT_RELATION = Submodule.COMMIT_RELATION;

    // If we have a null commitUrl, it means that the submodule exists in the
    // commit but not on the index; set index status to added.  Otherwise, load
    // up the commit sha.

    let commit = null;
    if (null !== commitSha) {
        commit = new Submodule.Commit(commitSha, commitUrl);
    }

    // A null indexUrl indicates that the submodule was removed.  If that is
    // the case, we're done.

    if (null === indexUrl) {
        return new Submodule({ commit: commit });                     // RETURN
    }

    // We've done all we can for non-visible sub-repos.

    if (null === repo) {
        const indexRelation = (() => {
            if (null === commit) {
                return null;
            }
            return commit.sha === indexSha ?
                COMMIT_RELATION.SAME :
                COMMIT_RELATION.UNKNOWN;
        })();
        return new Submodule({
            commit: commit,
            index: new Submodule.Index(indexSha, indexUrl, indexRelation)
        });                                                           // RETURN
    }

    // Compute the relations between the commits specifed in the workdir,
    // index, and commit.  We care only about the relationship between the
    // workdir commit and the commit from the tree, but we show the change as
    // staged since git-meta treats workdir commits as implicitly staged.  We
    // can provide flags to control this behavior if needed, but it's not
    // needed right now.

    indexSha = status.headCommit || indexSha;  // if empty, use index sha

    let relation = null;

    if (null !== commit) {
        relation = yield exports.getRelation(repo, commit.sha, indexSha);
    }
    const workdirRelation = (null === indexSha || null === status.headCommit) ?
        null :
        COMMIT_RELATION.SAME;
    return new RepoStatus.Submodule({
        commit: commit,
        index: new Submodule.Index(indexSha, indexUrl, relation),
        workdir: new Submodule.Workdir(status, workdirRelation),
    });
});

/**
 * Return a description of the status of changes to the specified `repo`.  If
 * the optionally specified `options.showAllUntracked` is true (default false),
 * return each untracked file individually rather than rolling up to the
 * directory.  If the optionally specified `options.paths` is non-empty
 * (default []), list the status only of the files contained in `paths`.  If
 * the optionally specified `options.showMetaChanges` is provided (default
 * true), return the status of changes in `repo`; otherwise, show only changes
 * in submobules.  If the optionally specified `ignoreIndex` is specified,
 * calculate the status matching the workdir to the underlying commit rather
 * than against the index.  If the specified `options.cwd` is provided, resolve
 * paths in the context of that directory.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {Object}             [options]
 * @param {Boolean}            [options.showAllUntracked]
 * @param {String []}          [options.paths]
 * @param {String}             [options.cwd]
 * @param {Boolean}            [options.showMetaChanges]
 * @param {Boolean}            [options.ignoreIndex]
 * @return {RepoStatus}
 */
exports.getRepoStatus = co.wrap(function *(repo, options) {
    assert.instanceOf(repo, NodeGit.Repository);

    // validate and fill in optional parameters

    if (undefined === options) {
        options = {};
    }
    else {
        assert.isObject(options);
    }
    if (undefined === options.showAllUntracked) {
        options.showAllUntracked = false;
    }
    else {
        assert.isBoolean(options.showAllUntracked);
    }
    if (undefined === options.paths) {
        options.paths = [];
    }
    else {
        assert.isArray(options.paths);
    }
    if (undefined === options.showMetaChanges) {
        options.showMetaChanges = false;
    }
    else {
        assert.isBoolean(options.showMetaChanges);
    }
    if (undefined === options.ignoreIndex) {
        options.ignoreIndex = false;
    }
    else {
        assert.isBoolean(options.ignoreIndex);
    }
    if (undefined !== options.cwd) {
        assert.isString(options.cwd);
        options.paths = yield options.paths.map(filename => {
            return GitUtil.resolveRelativePath(repo.workdir(),
                                               options.cwd,
                filename);
        });
    }
    const headCommit = yield repo.getHeadCommit();

    let args = {
        headCommit: null === headCommit ? null : headCommit.id().tostrS(),
        currentBranchName: yield GitUtil.getCurrentBranchName(repo),
        staged: {},
        workdir: {},
        submodules: {},
    };

    // Rebase, need to get shorthand for branch if available.

    let rebase = yield RebaseFileUtil.readRebase(repo.path());
    if (null !== rebase) {
        const rebaseBranch = yield GitUtil.findBranch(repo, rebase.headName);
        if (null !== rebaseBranch) {
            rebase = new Rebase(rebaseBranch.shorthand(),
                                rebase.originalHead,
                                rebase.onto);
        }
        args.rebase = rebase;
    }

    if (options.showMetaChanges && !repo.isBare()) {
        const head = yield repo.getHeadCommit();
        let tree = null;
        if (null !== head) {
            const treeId = head.treeId();
            tree = yield NodeGit.Tree.lookup(repo, treeId);
        }
        const status = yield SubmoduleUtil.cacheSubmodules(repo, () => {
            return DiffUtil.getRepoStatus(repo,
                                          tree,
                                          options.paths,
                                          options.ignoreIndex,
                                          options.showAllUntracked);
        });
        args.staged = status.staged;
        args.workdir = status.workdir;
    }

    // Now do the submodules.  First, list the submodules visible in the head
    // commit and index.
    //
    // TODO: For now, we're just not going to return the status of submodules
    // in a headless repository (which is better than our previous behavior of
    // crashing); we should fix it so that we can accurately reflect staged
    // submodules in the index.

    if (null !== headCommit) {
        // Now we need to figure out which subs to list, and what paths to
        // inspect in them.

        const openArray = yield SubmoduleUtil.listOpenSubmodules(repo);
        const openSet = new Set(openArray);
        const index = yield repo.index();
        const headTree = yield headCommit.getTree();
        const diff = yield NodeGit.Diff.treeToIndex(repo, headTree, index);
        const changes = yield SubmoduleUtil.getSubmoduleChangesFromDiff(diff);
        const indexUrls =
                 yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, index);
        const headUrls =
           yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, headCommit);

        // No paths specified, so we'll do all submodules, restricting to open
        // ones based on options.

        let filterPaths; // map from sub name to paths to use
        const filtering = 0 !== options.paths.length;

        // Will look at submodules that are open or have changes.  TODO: we're
        // ignoring changes affecting only the `.gitmodules` file for now.

        let subsToList  = Array.from(new Set(
                                      openArray.concat(Object.keys(changes))));

        if (filtering) {
            filterPaths = yield SubmoduleUtil.resolvePaths(repo.workdir(),
                                                           options.paths,
                                                           subsToList,
                                                           openArray);
            subsToList = Object.keys(filterPaths);
        }

        // Make a list of promises to read the status for each submodule, then
        // evaluate them in parallel.

        const subStatMakers = subsToList.map(co.wrap(function *(name) {
            const headUrl = headUrls[name] || null;
            const indexUrl = indexUrls[name] || null;
            let  headSha = null;
            let indexSha = null;
            let subRepo = null;

            // Load commit information available based on whether the submodule
            // was added, removed, changed, or just open.

            const change = changes[name];
            if (undefined !== change) {
                headSha = change.oldSha;
                indexSha = change.newSha;
            }
            else {
                // Just open, we need to load its sha.  Unfortunately, the diff
                // we did above doesn't catch new submodules with unstaged
                // commits; validate that we have commit and index URLs and
                // entries before trying to read them.

                if (null !== headUrl) {
                    headSha = (yield headTree.entryByPath(name)).sha();
                }
                if (null !== indexUrl) {
                    const indexEntry = index.getByPath(name);
                    if (undefined !== indexEntry) {
                        indexSha = indexEntry.id.tostrS();
                    }
                }
            }
            let status = null;
            if (openSet.has(name)) {
                subRepo = yield SubmoduleUtil.getRepo(repo, name);
                status = yield exports.getRepoStatus(subRepo, {
                    paths: filtering ? filterPaths[name] : [],
                    showAllUntracked: options.showAllUntracked,
                    ignoreIndex: options.ignoreIndex,
                    showMetaChanges: true,
                });
            }
            return yield exports.getSubmoduleStatus(subRepo,
                                                    status,
                                                    indexUrl,
                                                    headUrl,
                                                    indexSha,
                                                    headSha);
        }));

        const subStats = yield subStatMakers;

        // And copy them into the arguments.

        subsToList.forEach((name, i) => {
            args.submodules[name] = subStats[i];
        });
    }

    return new RepoStatus(args);
});
