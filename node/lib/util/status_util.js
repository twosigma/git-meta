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
const PrintStatusUtil     = require("./print_status_util");
const Rebase              = require("./rebase");
const RebaseFileUtil      = require("./rebase_file_util");
const RepoStatus          = require("./repo_status");
const SequencerStateUtil  = require("./sequencer_state_util");
const SubmoduleUtil       = require("./submodule_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const UserError           = require("./user_error");

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
 * @return {Rebase}
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
        sequencerState: status.sequencerState === null ?
                          null :
                          SequencerStateUtil.mapCommits(status.sequencerState,
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
 * HEAD commit.  Return `undefined` if the submodule is misconfigured.
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
    // If there is no index URL or commit URL, this submodule cannot be deleted
    // or added.
    if (null === commitUrl && null === indexUrl) {
        return undefined;
    }
    const Submodule = RepoStatus.Submodule;
    const COMMIT_RELATION = Submodule.COMMIT_RELATION;

    // If we have a null commitUrl, it means that the submodule exists in the
    // commit but not on the index; set index status to added.  Otherwise, load
    // up the commit sha.

    let commit = null;
    if (null !== commitSha) {
        commit = new Submodule.Commit(commitSha, commitUrl);
    }

    // A null indexUrl indicates that the submodule doesn't exist in
    // the staged .gitmodules.

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
 * Return the conflicts listed in the specified `index` and
 * the specified `paths`. You can specify an empty Array if
 * you want to list conflicts for the whole index.
 *
 * @param {NodeGit.Index} index
 * @param {String []} paths
 * @return {Object} map from entry name to `RepoStatus.Conflict`
 */
exports.readConflicts = function (index, paths) {
    assert.instanceOf(index, NodeGit.Index);
    assert.isArray(paths);
    paths = new Set(paths);
    const conflicted = {};
    function getConflict(path) {
        let obj = conflicted[path];
        if (undefined === obj) {
            obj = {
                ancestor: null,
                our: null,
                their: null,
            };
            conflicted[path] = obj;
        }
        return obj;
    }
    const entries = index.entries();
    const STAGE = RepoStatus.STAGE;
    for (let entry of entries) {
        const stage = NodeGit.Index.entryStage(entry);
        switch (stage) {
            case STAGE.NORMAL:
                break;
            case STAGE.ANCESTOR:
                getConflict(entry.path).ancestor = entry.mode;
                break;
            case STAGE.OURS:
                getConflict(entry.path).our = entry.mode;
                break;
            case STAGE.THEIRS:
                getConflict(entry.path).their = entry.mode;
                break;
        }
    }
    const result = {};
    const COMMIT = NodeGit.TreeEntry.FILEMODE.COMMIT;
    for (let name in conflicted) {
        const c = conflicted[name];
        if (paths.size !== 0 && !paths.has(name)) {
            continue;
        }
        // Ignore the conflict if it's just between submodule SHAs

        if (COMMIT !== c.our || COMMIT !== c.their) {
            result[name] = new RepoStatus.Conflict(c.ancestor, c.our, c.their);
        }
    }
    return result;
};

/**
 * Return the status of submodules.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {Object}             [options] see `getRepoStatus` for option fields
 * @param {NodeGit.Commit}     headCommit HEAD commit
 * @return {Object}            status of the submodule
 * @returns {Object} return.conflicts list of conflicts in the index
 * @returns {Object} return.submodule list of submodule names to status
 */
const getSubRepoStatus = co.wrap(function *(repo, options, headCommit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(headCommit, NodeGit.Commit);

    const openArray = yield SubmoduleUtil.listOpenSubmodules(repo);
    const openSet = new Set(openArray);
    const index = yield repo.index();
    const headTree = yield headCommit.getTree();
    const diff = yield NodeGit.Diff.treeToIndex(repo, headTree, index);
    const changes =
        yield SubmoduleUtil.getSubmoduleChangesFromDiff(diff, true);
    const indexUrls =
        yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, index);
    const headUrls =
        yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, headCommit);

    const result = {
        conflicts: exports.readConflicts(index, options.paths),
        submodules: {},
    };

    // No paths specified, so we'll do all submodules, restricting to open
    // ones based on options.
    let filterPaths; // map from sub name to paths to use
    const filtering = 0 !== options.paths.length;

    // Will look at submodules that are open or have changes.  TODO: we're
    // ignoring changes affecting only the `.gitmodules` file for now.
    let subsToList = Array.from(new Set(
        openArray.concat(Object.keys(changes))));

    if (filtering) {
        filterPaths = SubmoduleUtil.resolvePaths(options.paths,
            subsToList,
            openArray);
        subsToList = Object.keys(filterPaths);
    }

    // Make a list of promises to read the status for each submodule, then
    // evaluate them in parallel.
    const subStatMakers = subsToList.map(co.wrap(function* (name) {
        const headUrl = headUrls[name] || null;
        const indexUrl = indexUrls[name] || null;
        let headSha = null;
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
                untrackedFilesOption: options.untrackedFilesOption,
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
        const subStat = subStats[i];
        if (undefined !== subStat) {
            result.submodules[name] = subStats[i];
        }
    });
    return result;
});

/**
 * Return a description of the status of changes to the specified `repo`.  If
 * the optionally specified `options.untrackedFilesOption` is ALL (default
 * ALL), return each untracked file individually. If it is NORMAL, roll
 * untracked files up to the directory. If it is NO, don't show untracked files.
 * If the optionally specified `options.paths` is non-empty (default []), list
 * the status only of the files contained in `paths`.  If the optionally
 * specified `options.showMetaChanges` is provided (default true), return the
 * status of changes in `repo`; otherwise, show only changes in submodules.  If
 * the optionally specified `ignoreIndex` is specified, calculate the status
 * matching the workdir to the underlying commit rather than against the index.
 * If the specified `options.cwd` is provided, resolve paths in the context of
 * that directory.
 *
 * TODO: Note that this function is broken when
 * `true === ignoreIndex && true === showMetaChanges` and
 * there are new submodules.  It erroneously reports that the path with the new
 * submodule is an untracked file.  We need to put some logic in that
 * recognizes these paths as being inside a submodule and filters them out.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {Object}             [options]
 * @param {String}             [options.untrackedFilesOption]
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
    if (undefined === options.untrackedFilesOption) {
        options.untrackedFilesOption = DiffUtil.UNTRACKED_FILES_OPTIONS.NORMAL;
    }
    else {
        assert.isString(options.untrackedFilesOption);
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
        options.paths = options.paths.map(filename => {
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

    args.sequencerState =
                      yield SequencerStateUtil.readSequencerState(repo.path());

    if (!repo.isBare()) {
        const head = yield repo.getHeadCommit();
        let tree = null;
        if (null !== head) {
            const treeId = head.treeId();
            tree = yield NodeGit.Tree.lookup(repo, treeId);
        }
        let paths = options.paths;
        if (!options.showMetaChanges && (!paths || paths.length === 0)) {
            paths = [SubmoduleConfigUtil.modulesFileName];
        }
        const status = yield DiffUtil.getRepoStatus(
            repo,
            tree,
            paths,
            options.ignoreIndex,
            options.untrackedFilesOption);
        // if showMetaChanges is off, keep .gitmodules changes only
        if (options.showMetaChanges) {
            args.staged = status.staged;
            args.workdir = status.workdir;
        } else {
            const gitmodules = SubmoduleConfigUtil.modulesFileName;
            if (gitmodules in status.staged) {
                args.staged[gitmodules] = status.staged[gitmodules];
            }
            if (gitmodules in status.workdir) {
                args.workdir[gitmodules] = status.workdir[gitmodules];
            }
        }
    }

    // Now do the submodules.
    if (null !== headCommit) {
        const {conflicts, submodules} =
            yield getSubRepoStatus(repo, options, headCommit);
        Object.assign(args.staged, conflicts);
        args.submodules = submodules;
    }

    return new RepoStatus(args);
});

/**
 * Wrapper around `checkReadiness` and throw a `UserError` if the repo
 * is not in anormal, ready state.
 * @see {checkReadiness}
 * @param {RepoStatus} status
 * @throws {UserError}
 */
exports.ensureReady = function (status) {
    const errorMessage = exports.checkReadiness(status);
    if (null !== errorMessage) {
        throw new UserError(errorMessage);
    }
};

/**
 * Return an error message if the specified `status` of a repository isn't in a
 * normal, ready state, that is, it does not have any conflicts or in-progress
 * operations from the sequencer.  Adjust output paths to be relative to the
 * specified `cwd`.
 *
 * @param {RepoStatus} status
 * @returns {String | null} if not null, the return implies that the repo is
 * not ready.
 */
exports.checkReadiness = function (status) {
    assert.instanceOf(status, RepoStatus);

    if (null !== status.rebase) {
        return (`\
You're in the middle of a regular (not git-meta) rebase.
Before proceeding, you must complete the rebase in progress (by running
'git rebase --continue') or abort it (by running
'git rebase --abort').`);
    }
    if (status.isConflicted()) {
        return (`\
Please resolve outstanding conflicts before proceeding:
${PrintStatusUtil.printRepoStatus(status, "")}`);
    }
    if (null !== status.sequencerState) {
        const command =
               PrintStatusUtil.getSequencerCommand(status.sequencerState.type);
        return (`\
Before proceeding, you must complete the ${command} in progress (by running
'git meta ${command} --continue') or abort it (by running
'git meta ${command} --abort').`);
    }
    return null;
};
