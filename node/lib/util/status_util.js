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
 * Return the `RepoStatus.Submodule` for the submodule having the specified
 * `name` in the specified `metaRepo`.  The specified `indexUrl` contains the
 * configured url for this submodule, unless it has been removed in the index.
 * The specified `commitUrl` contains the configured url for this submodule,
 * unless it has just been added to the index. The specified `isVisible` is
 * true if the submodule has an open repository.  Use the specified
 * `readRepoStatus` to read the status of a repository.  The specified `index`
 * and `commitTree` are used to read the shas for the meta repository index and
 * current commit, respectively.
 *
 * Note that this method is mostly exposed to make it easier to test, and the
 * `readRepoStatus` parameter is provided to break a cycle between this method
 * and `getRepoStatus`.
 *
 * @async
 * @private
 * @param {String}                          name
 * @param {NodeGit.Repository}              metaRepo
 * @param {String}                          [indexUrl]
 * @param {String}                          [commitUrl]
 * @param {NodeGit.Index}                   index
 * @param {NodeGit.Tree}                    commitTree
 * @param {Boolean}                         isVisible
 * @param {(repo) => Promise -> RepoStatus} readRepoStatus
 * @return {RepoStatus.Submodule}
 */
exports.getSubmoduleStatus = co.wrap(function *(name,
                                                metaRepo,
                                                indexUrl,
                                                commitUrl,
                                                index,
                                                commitTree,
                                                isVisible,
                                                readRepoStatus) {
    const Submodule = RepoStatus.Submodule;
    const COMMIT_RELATION = Submodule.COMMIT_RELATION;

    // If we have a null commitUrl, it means that the submodule exists in the
    // commit but not on the index; set index status to added.  Otherwise, load
    // up the commit sha.

    let commit = null;
    if (null !== commitUrl) {
        const commitSha = (yield commitTree.entryByPath(name)).sha();
        commit = new Submodule.Commit(commitSha, commitUrl);
    }

    // A null indexUrl indicates that the submodule was removed.  If that is
    // the case, we're done.

    if (null === indexUrl) {
        return new Submodule({ commit: commit });                     // RETURN
    }

    let indexSha = null;
    const entry = index.getByPath(name);
    if (entry) {
        indexSha = entry.id.tostrS();
    }

    // We can't actually check the relation between the index commit and the
    // head commit unless we have an open repo in which to perform the check.
    // For now, we will set it to null if there is no relation (the case if
    // there is no `commit`), SAME if we can trivially tell they're the same
    // commit, and UNKNOWN otherwise.  If we set to UNKNOWN, we'll validate
    // later if we have an open repository.

    let indexRelation = null;
    if (null !== commit) {
        if (commit.sha !== indexSha) {
            indexRelation = COMMIT_RELATION.UNKNOWN;
        }
        else {
            indexRelation = COMMIT_RELATION.SAME;
        }
    }

    // We've done all we can for non-visible sub-repos.

    if (!isVisible) {
        return new Submodule({
            commit: commit,
            index: new Submodule.Index(indexSha, indexUrl, indexRelation)
        });                                                           // RETURN
    }

    const subRepo = yield SubmoduleUtil.getRepo(metaRepo, name);
    const subStatus = yield readRepoStatus(subRepo);

    /**
     * Return COMMIT_RELATION.AHEAD if the commit having the specified `to` sha
     * in `subRepo` is a descendant of the specified `from`, BEHIND if `from`
     * is a descendant of `to`, and UNRELATED if neither is descended from the
     * other.  If null is provided for either value, return null.
     *
     * @param {String} [from]
     * @param {String} [to]
     * @return {RepoStatus.Submodule.COMMIT_RELATION|null}
     */
    const getRelation = co.wrap(function *(from, to) {
        if (!from || !to) {
            return null;
        }
        assert.isString(from);
        assert.isString(to);
        if (from === to) {
            return COMMIT_RELATION.SAME;
        }

        const fromId = NodeGit.Oid.fromString(from);
        const toId = NodeGit.Oid.fromString(to);

        // If one of the commits is not present, `descendantOf` will throw.

        let toDescendant;
        try {
            toDescendant = yield NodeGit.Graph.descendantOf(subRepo,
                                                            toId,
                                                            fromId);
        }
        catch (e) {
            return COMMIT_RELATION.UNKNOWN;
        }

        if (toDescendant) {
            return COMMIT_RELATION.AHEAD;
        }

        const fromDescendant = yield NodeGit.Graph.descendantOf(subRepo,
                                                                fromId,
                                                                toId);
        if (fromDescendant) {
            return COMMIT_RELATION.BEHIND;
        }
        return COMMIT_RELATION.UNRELATED;
    });

    // Compute the relations between the commits specifed in the workdir,
    // index, and commit.

    // An 'UNKNOWN' commit relation for the index indicates that we have both
    // commit and index shas to compare, but couldn't without an open repo --
    // which we now have.

    if (COMMIT_RELATION.UNKNOWN === indexRelation) {
        indexRelation = yield getRelation(commit.sha, indexSha);
    }

    const workdirRelation = yield getRelation(indexSha, subStatus.headCommit);

    return new RepoStatus.Submodule({
        commit: commit,
        index: new Submodule.Index(indexSha, indexUrl, indexRelation),
        workdir: new Submodule.Workdir(subStatus, workdirRelation),
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
 * in submobules.  If the optionally specified `workdirToTree` is specified,
 * calculate the status matching the workdir to the underlying commit rather
 * than against the index, typically to calculate the status relevant to an
 * `commit -a`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {Object}             [options]
 * @param {Boolean}            [options.showAllUntracked]
 * @param {String []}          [options.paths]
 * @param {Boolean}            [options.showMetaChanges]
 * @param {Boolean}            [options.workdirToTree]
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
        options.showMetaChanges = true;
    }
    else {
        assert.isBoolean(options.showMetaChanges);
    }
    if (undefined === options.workdirToTree) {
        options.workdirToTree = false;
    }
    else {
        assert.isBoolean(options.workdirToTree);
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
        const status = yield DiffUtil.getRepoStatus(repo,
                                                    tree,
                                                    options.paths,
                                                    options.workdirToTree,
                                                    options.showAllUntracked);
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
        const indexUrls =
                 yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, index);
        const indexNames = Object.keys(indexUrls);
        const headUrls =
           yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, headCommit);


        // No paths specified, so we'll do all submodules, restricing to open
        // ones based on options.

        let filterPaths; // map from sub name to paths to use
        let subsToList;  // array of subs that will be in result
        const filtering = 0 !== options.paths.length;
        if (filtering) {
            filterPaths = yield SubmoduleUtil.resolvePaths(repo.workdir(),
                                                           options.paths,
                                                           indexNames,
                                                           openArray);
            subsToList = Object.keys(filterPaths);
        }
        else {
            // Compute the list by joining the list of submodules listed in the
            // index and on head.
            subsToList = Array.from(new Set(
                                    Object.keys(headUrls).concat(indexNames)));
        }
        const commitTree = yield headCommit.getTree();


        // Make a list of promises to read the status for each submodule, then
        // evaluate them in parallel.

        const getSubRepo = function (subName, subRepo) {
            const paths = filtering ? filterPaths[subName] : [];
            return exports.getRepoStatus(subRepo, {
                paths: paths,
                showAllUntracked: options.showAllUntracked,
                workdirToTree: options.workdirToTree,
            });
        };

        const subStatMakers = subsToList.map(name => {
            return exports.getSubmoduleStatus(name,
                                              repo,
                                              indexUrls[name] || null,
                                              headUrls[name] || null,
                                              index,
                                              commitTree,
                                              openSet.has(name),
                                              repo => getSubRepo(name, repo));
        });
        const subStats = yield subStatMakers;

        // And copy them into the arguments.

        subsToList.forEach((name, i) => {
            args.submodules[name] = subStats[i];
        });
    }

    return new RepoStatus(args);
});
