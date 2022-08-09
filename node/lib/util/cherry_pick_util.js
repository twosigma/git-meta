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

const assert  = require("chai").assert;
const co      = require("co");
const colors  = require("colors");
const mkdirp    = require("mkdirp");
const NodeGit = require("nodegit");
const path    = require("path");
const rimraf  = require("rimraf");

const ConflictUtil        = require("./conflict_util");
const DoWorkQueue         = require("./do_work_queue");
const GitUtil             = require("./git_util");
const Hook            = require("../util/hook");
const Open                = require("./open");
const RepoStatus          = require("./repo_status");
const Reset               = require("./reset");
const SequencerState      = require("./sequencer_state");
const SequencerStateUtil  = require("./sequencer_state_util");
const SparseCheckoutUtil  = require("./sparse_checkout_util");
const StatusUtil          = require("./status_util");
const Submodule           = require("./submodule");
const SubmoduleChange     = require("./submodule_change");
const SubmoduleUtil       = require("./submodule_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const SubmoduleRebaseUtil = require("./submodule_rebase_util");
const TreeUtil            = require("./tree_util");
const UserError           = require("./user_error");

const CommitAndRef = SequencerState.CommitAndRef;
const CHERRY_PICK = SequencerState.TYPE.CHERRY_PICK;
const STAGE = RepoStatus.STAGE;

/**
 * Throw a `UserError` if the specfied `seq` is null or does not indicate a
 * cherry-pick.
 *
 * @param {SequencerState|null} seq
 */
function ensureCherryInProgress(seq) {
    if (null !== seq) {
        assert.instanceOf(seq, SequencerState);
    }
    if (null === seq || CHERRY_PICK !== seq.type) {
        throw new UserError("No cherry-pick in progress.");
    }
}

/**
 * Change the specified `submodules` in the specified index.  If a name maps to
 * a `Submodule`, update it in the specified `index` in the specified `repo`
 * and if that submodule is open, reset its HEAD, index, and worktree to
 * reflect that commit.  Otherwise, if it maps to `null`, remove it.  Obtain
 * submodule repositories from the specified `opener`, but do not open any
 * closed repositories.  The behavior is undefined if any referenced submodule
 * is open and has index or workdir modifications.
 *
 * @param {NodeGit.Repository} repo
 * @param {Open.Opener}        opener
 * @param {NodeGit.Index}      index
 * @param {Object}             submodules    name to Submodule
 * @param {(null|Object)}      urlsInIndex   name to sub.url
 */
exports.changeSubmodules = co.wrap(function *(repo,
                                              opener,
                                              index,
                                              submodules,
                                              urlsInIndex) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(opener, Open.Opener);
    assert.instanceOf(index, NodeGit.Index);
    assert.isObject(submodules);
    if (0 === Object.keys(submodules).count) {
        return;                                                       // RETURN
    }
    const urls = (urlsInIndex === null || urlsInIndex === undefined) ?
        (yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, index)) :
        urlsInIndex;
    const changes = {};
    function rmrf(dir) {
        return new Promise(callback => {
            return rimraf(path.join(repo.workdir(), dir), {}, callback);
        });
    }
    const fetcher = yield opener.fetcher();
    for (let name in submodules) {
        const sub = submodules[name];
        if (null === sub) {
            console.log(`Deleting ${name}`);
            changes[name] = null;
            delete urls[name];
            yield rmrf(name);
        }
        else if (opener.isOpen(name)) {
            console.log(`Fast-forwarding open submodule ${name}`);
            const subRepo =
                yield opener.getSubrepo(name,
                                        Open.SUB_OPEN_OPTION.FORCE_OPEN);
            yield fetcher.fetchSha(subRepo, name, sub.sha);
            const commit = yield subRepo.getCommit(sub.sha);
            yield GitUtil.setHeadHard(subRepo, commit);
            yield index.addByPath(name);
        } else {
            console.log(`Fast-forwarding closed submodule ${name}`);
            changes[name] = new TreeUtil.Change(
                                            NodeGit.Oid.fromString(sub.sha),
                                            NodeGit.TreeEntry.FILEMODE.COMMIT);
            urls[name] = sub.url;
            const subPath = path.join(repo.workdir(), name);
            mkdirp.sync(subPath);
        }
    }
    const parentTreeId = yield index.writeTree();
    const parentTree = yield repo.getTree(parentTreeId);
    const newTree = yield TreeUtil.writeTree(repo, parentTree, changes);
    yield index.readTree(newTree);
    yield SubmoduleConfigUtil.writeUrls(repo, index, urls);
});

/**
* Update meta repo index and point the submodule to a commit sha
*
* @param {NodeGit.Index} index
* @param {String} subName
* @param {String} sha
*/
exports.addSubmoduleCommit = co.wrap(function *(index, subName, sha) {
   assert.instanceOf(index, NodeGit.Index);
   assert.isString(subName);
   assert.isString(sha);

   const entry = new NodeGit.IndexEntry();
   entry.path = subName;
   entry.mode = NodeGit.TreeEntry.FILEMODE.COMMIT;
   entry.id = NodeGit.Oid.fromString(sha);
   entry.flags = entry.flagsExtended = 0;
   yield index.add(entry);
});

/**
 * Similar to exports.changeSubmodules, but it:
 * 1. operates in bare repo
 * 2. does not make any changes to the working directory
 * 3. only deals with simple changes like addition, deletions
 * and fast-forwards
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Index}      index         meta repo's change index
 * @param {Object}             submodules    name to Submodule
 */
exports.changeSubmodulesBare = co.wrap(function *(repo,
                                                  index,
                                                  submodules) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(index, NodeGit.Index);
    assert.isObject(submodules);
    if (0 === Object.keys(submodules).count) {
        return;                                                       // RETURN
    }
    const urls = yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, index);
    for (let name in submodules) {
        // Each sub object is either a {Submodule} object or null, it covers
        // three types of change: addition, deletions and fast-forwards.
        // (see {computeChangesBetweenTwoCommits})
        // In case of deletion, we remove its url from the urls array, update
        //  the .gitmodule file with `writeUrls` and skip adding the submodule
        //  to the meta index.
        // In other case we bump the submodule sha to `sub.sha` by adding a
        //  new index entry to the meta index and add `sub.url` for updates.
        const sub = submodules[name];
        if (null === sub) {
            delete urls[name];
            continue;
        }
        yield exports.addSubmoduleCommit(index, name, sub.sha);
        urls[name] = sub.url;
    }
    // write urls to the in-memory index
    yield SubmoduleConfigUtil.writeUrls(repo, index, urls, true);
});

/**
 * Return true if there are URL changes between the  specified `commit` and
 * `baseCommit` in the specified `repo` and false otherwise.  A URL change is
 * an alteration to a submodule's URL in the `.gitmodules` file that is not an
 * addition or removal.  If `undefined === baseCommit`, then use the first
 * parent of `commit` as the base.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 * @param {NodeGit.Commit}     [baseCommit]
 * @return {Bool}
 */
exports.containsUrlChanges = co.wrap(function *(repo, commit, baseCommit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    if (undefined !== baseCommit) {
        assert.instanceOf(baseCommit, NodeGit.Commit);
    } else {
        const parents = yield commit.getParents();
        if (0 !== parents.length) {
            baseCommit = parents[0];
        }
    }

    let baseUrls = {};
    if (undefined !== baseCommit) {
         baseUrls =
           yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, baseCommit);
    }
    const commitUrls =
               yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, commit);
    for (let name in baseUrls) {
        const baseUrl = baseUrls[name];
        const commitUrl = commitUrls[name];
        if (undefined !== commitUrl && baseUrl !== commitUrl) {
            return true;                                              // RETURN
        }
    }
    return false;
});

const populateLibgit2MergeBugData = co.wrap(function*(repo, data) {
    if (data.mergeBases === undefined) {
        const head = data.head;
        const targetCommit = data.targetCommit;
        const mergeBases = yield GitUtil.mergeBases(repo, head, targetCommit);
        data.mergeBases = [];
        for (const base of mergeBases) {
            const commit = yield NodeGit.Commit.lookup(repo, base);
            data.mergeBases.push(commit);
        }
    }

    return data.mergeBases;
});

const workAroundLibgit2MergeBug = co.wrap(function *(data, repo, name,
                                                     entries) {
    let ancestor = entries[STAGE.ANCESTOR];
    const ours = entries[STAGE.OURS];
    const theirs = entries[STAGE.THEIRS];
    if (undefined === ancestor &&
        undefined !== ours &&
        undefined !== theirs) {
        // This might be a normal conflict that libgit2 is falsely
        // telling us is an add-add conflict.  I don't yet have a
        // libgit2 bug report for this because the only repro is a
        // complex case in Two Sigma's proprietary monorepo.

        // We work around this by looking at all merge-bases, and checking
        // if any of them have an entry for this name, and if so, filling
        // in the ancestor with it
        const mergeBases = yield populateLibgit2MergeBugData(repo, data);
        for (const base of mergeBases) {
            const shas = yield SubmoduleUtil.getSubmoduleShasForCommit(
                repo, [ours.path], base);
            const sha = shas[name];
            // Avoid creating a synthetic ancestor with the same sha as
            // theirs. See more in `SubmoduleChange`
            if (sha !== undefined && sha !== theirs.id.tostrS()) {
                ancestor = new NodeGit.IndexEntry();
                ancestor.id = NodeGit.Oid.fromString(sha);
                ancestor.mode = NodeGit.TreeEntry.FILEMODE.COMMIT;
                ancestor.path = ours.path;
                ancestor.flags = ours.flags;
                ancestor.gid = ours.gid;
                ancestor.uid = ours.uid;
                ancestor.fileSize = 0;
                ancestor.ino = 0;
                ancestor.dev = 0;
                entries[STAGE.ANCESTOR] = ancestor;
                break;
            }
        }
    }
});

/**
 *
 * @param {Object} ancestorUrls urls from the merge base
 * @param {Object} ourUrls urls from the left side of a merge
 * @param {Object} theirUrls urls from the right side
 * @returns {Object}
 * @returns {Object} return.url submodule name to URLs
 * @returns {Object} return.conflicts: name to a conflict object that contains
 *                   urls of ancestors, ours and theirs.
  */
exports.resolveUrlsConflicts = function(ancestorUrls, ourUrls, theirUrls) {
    const allSubNames = new Set(Object.keys(ancestorUrls));
    Object.keys(ourUrls).forEach(x => allSubNames.add(x));
    Object.keys(theirUrls).forEach(x => allSubNames.add(x));

    const result = {
        urls: {},
        conflicts: {},
    };
    const addUrl = function(name, url) {
        if (url) {
            result.urls[name] = url;
        }
    };
    for (const sub of allSubNames) {
        const ancestorUrl = ancestorUrls[sub];
        const ourUrl = ourUrls[sub];
        const theirUrl = theirUrls[sub];
        if (ancestorUrl === ourUrl) {
            addUrl(sub, theirUrl);
        } else if (ancestorUrl === theirUrl) {
            addUrl(sub, ourUrl);
        } else if (ourUrl === theirUrl) {
            addUrl(sub, ourUrl);
        } else {
            result.conflicts[sub] = {
                ancestor: ancestorUrl,
                our: ourUrl,
                their: theirUrl
            };
        }
    }
    return result;
};


/**
 * Resolve conflicts to `.gitmodules` file, return the merged list of urls or
 * a Conflict object indicating the merge cannot be done automatically.
 *
 * @param repo repository where blob of `.gitmodules` can be read
 * @param {(null|NodeGit.IndexEntry)} ancestorEntry entry of `.gitmodules`
 *        from merge base
 * @param {(null|NodeGit.IndexEntry)} ourEntry entry of `.gitmodules`
 *        on the left side
 * @param {(null|NodeGit.IndexEntry)} theirEntry entry of `.gitmodules`
 *        on the right side
 * @returns {Object}
 * @returns {Object} return.urls, list of sub names to urls
 * @returns {Object} return.conflicts, object describing conflicts
 */
exports.resolveModuleFileConflicts = co.wrap(function*(
    repo,
    ancestorEntry,
    ourEntry,
    theirEntry
) {
    assert.instanceOf(repo, NodeGit.Repository);
    const getUrls = SubmoduleConfigUtil.getSubmodulesFromIndexEntry;
    const ancestorUrls = yield getUrls(repo, ancestorEntry);
    const ourUrls = yield getUrls(repo, ourEntry);
    const theirUrls = yield getUrls(repo, theirEntry);
    return exports.resolveUrlsConflicts(ancestorUrls, ourUrls, theirUrls);
});

/**
 * Determine how to apply the submodule changes introduced in the
 * specified `srcCommit` to the commit `targetCommit` of the specified repo
 * as described in the specified in-memory `index`.  Return an object
 * describing what changes to make, including which submodules cannot be
 * updated at all due to a conflicts, such as a change being introduced to a
 * submodule that does not exist in HEAD.  Throw a `UserError` if non-submodule
 * changes are detected.  The behavior is undefined if there is no merge base
 * between `srcCommit` and the `targetCommit`.
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Index}      index
 * @param {NodeGit.Commit}     srcCommit
 * @param {NodeGit.Commit}     targetCommit
 * @return {Object} return
 * @return {Object} return.changes        from sub name to `SubmoduleChange`
 * @return {Object} return.simpleChanges  from sub name to `Submodule` or null
 * @return {Object} return.conflicts      from sub name to `Conflict`
 * */
exports.computeChangesBetweenTwoCommits = co.wrap(function *(repo,
                                                             index,
                                                             srcCommit,
                                                             targetCommit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(index, NodeGit.Index);
    assert.instanceOf(srcCommit, NodeGit.Commit);
    assert.instanceOf(targetCommit, NodeGit.Commit);
    const conflicts = {};

    // Group together all parts of conflicted entries.
    const conflictEntries = new Map();  // name -> normal, ours, theirs
    const entries = index.entries();
    for (const entry of entries) {
        const name = entry.path;
        const stage = NodeGit.Index.entryStage(entry);
        if (STAGE.NORMAL !== stage) {
            let subEntry = conflictEntries.get(name);
            if (undefined === subEntry) {
                subEntry = {};
                conflictEntries.set(name, subEntry);
            }
            subEntry[stage] = entry;
        }
    }

    // Now, look at `conflictEntries` and see if any are eligible for further
    // work -- basically, submodule changes where there is a conflict that
    // could be resolved by an internal merge, cherry-pick, etc.  Otherwise,
    // log and resolve conflicts.

    const COMMIT = NodeGit.TreeEntry.FILEMODE.COMMIT;
    const ConflictEntry = ConflictUtil.ConflictEntry;
    const Conflict = ConflictUtil.Conflict;
    const changes = {};
    function makeConflict(entry) {
        if (undefined === entry) {
            return null;
        }
        return new ConflictEntry(entry.mode, entry.id.tostrS());
    }

    const libgit2MergeBugData = {
        head: srcCommit,
        targetCommit: targetCommit
    };
    for (const [name, entries] of conflictEntries) {
        yield workAroundLibgit2MergeBug(libgit2MergeBugData, repo, name,
                                        entries);
        const ancestor = entries[STAGE.ANCESTOR];
        const ours = entries[STAGE.OURS];
        const theirs = entries[STAGE.THEIRS];
        if (undefined !== ancestor &&
            undefined !== ours &&
            undefined !== theirs &&
            COMMIT === ours.mode &&
            COMMIT === theirs.mode) {
            changes[name] = new SubmoduleChange(ancestor.id.tostrS(),
                                                theirs.id.tostrS(),
                                                ours.id.tostrS());
        } else if (SubmoduleConfigUtil.modulesFileName !== name) {
            conflicts[name] = new Conflict(makeConflict(ancestor),
                                           makeConflict(ours),
                                           makeConflict(theirs));
        }
    }

    // Get submodule urls. If there are no merge conflicts to `.gitmodules`,
    // parse the file and return its list. If there are, best effort merging
    // the urls. Throw user error if merge conflict cannot be resolved.
    const modulesFileEntry =
        conflictEntries.get(SubmoduleConfigUtil.modulesFileName);
    let urls;
    if (modulesFileEntry) {
        const urlsRes = yield exports.resolveModuleFileConflicts(repo,
            modulesFileEntry[STAGE.ANCESTOR],
            modulesFileEntry[STAGE.OURS],
            modulesFileEntry[STAGE.THEIRS]
        );
        if (Object.keys(urlsRes.conflicts).length > 0) {
            let errMsg = "Conflicts to submodule URLs: \n" +
                JSON.stringify(urlsRes.conflicts);
            throw new UserError(errMsg);
        }
        urls = urlsRes.urls;
    } else {
        urls = yield SubmoduleConfigUtil.getSubmodulesFromIndex(repo, index);
    }

    // Now we handle the changes that Git was able to take care of by itself.
    // First, we're going to need to write the index to a tree; this write
    // requires that we clean the conflicts.  Anything we've already diagnosed
    // as either a conflict or a non-simple change will be ignored here.

    yield index.conflictCleanup();
    const simpleChanges = {};
    const treeId = yield index.writeTreeTo(repo);
    const tree = yield NodeGit.Tree.lookup(repo, treeId);
    const srcTree = yield srcCommit.getTree();
    const diff = yield NodeGit.Diff.treeToTree(repo, srcTree, tree, null);
    const treeChanges =
                  yield SubmoduleUtil.getSubmoduleChangesFromDiff(diff, false);
    for (let name in treeChanges) {
        // Skip changes we've already taken into account and the `.gitmodules`
        // file.

        if (SubmoduleConfigUtil.modulesFileName === name ||
            name in changes ||
            name in conflicts) {
            continue;                                               // CONTINUE
        }
        const change = treeChanges[name];
        if (null === change.newSha) {
            simpleChanges[name] = null;
        } else {
            simpleChanges[name] = new Submodule(urls[name], change.newSha);
        }
    }
    return {
        simpleChanges: simpleChanges,
        changes: changes,
        conflicts: conflicts,
        urls: urls,
    };
});

/**
 * Pick the specified `subs` in the specified `metaRepo` having the specified
 * `metaIndex`.  Stage new submodule commits in `metaRepo`.  Return an object
 * describing any commits that were generated and conflicted commits.  Use the
 * specified `opener` to access submodule repos.
 *
 * @param {NodeGit.Repository} metaRepo
 * @param {Open.Opener}        opener
 * @param {NodeGit.Index}      metaIndex
 * @param {Object}             subs        map from name to SubmoduleChange
 * @return {Object}
 * @return {Object} return.commits    map from name to map from new to old ids
 * @return {Object} return.conflicts  map from name to commit causing conflict
 * @returns {Object} return.ffwds     map from name to if ffwd happend
 */
exports.pickSubs = co.wrap(function *(metaRepo, opener, metaIndex, subs) {
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.instanceOf(opener, Open.Opener);
    assert.instanceOf(metaIndex, NodeGit.Index);
    assert.isObject(subs);
    const result = {
        commits: {},
        conflicts: {},
        ffwds: {},
    };
    const fetcher = yield opener.fetcher();
    const pickSub = co.wrap(function *(name) {
        const repo = yield opener.getSubrepo(name,
                                             Open.SUB_OPEN_OPTION.FORCE_OPEN);
        const change = subs[name];
        const commitText = "(" + GitUtil.shortSha(change.oldSha) + ".." +
            GitUtil.shortSha(change.newSha) + "]";
        console.log(`Sub-repo ${colors.blue(name)}: applying commits \
${colors.green(commitText)}.`);

        // Fetch the commit; it may not be present.

        yield fetcher.fetchSha(repo, name, change.newSha);
        yield fetcher.fetchSha(repo, name, change.oldSha);
        const newCommit = yield repo.getCommit(change.newSha);
        const oldCommit = yield repo.getCommit(change.oldSha);
        const rewriteResult = yield SubmoduleRebaseUtil.rewriteCommits(
                                                                    repo,
                                                                    newCommit,
                                                                    oldCommit);
        result.commits[name] = rewriteResult.commits;
        result.ffwds[name] = rewriteResult.ffwd;
        yield metaIndex.addByPath(name);
        if (null !== rewriteResult.conflictedCommit) {
            result.conflicts[name] = rewriteResult.conflictedCommit;
        }
    });
    yield DoWorkQueue.doInParallel(Object.keys(subs), pickSub);
    return result;
});

/**
 * Determine how to apply the submodule changes introduced in the
 * specified `targetCommit` to the commit on the head of the specified `repo`
 * as described in the specified in-memory `index`.  Return an object
 * describing what changes to make, including which submodules cannot be
 * updated at all due to a conflicts, such as a change being introduced to a
 * submodule that does not exist in HEAD.  Throw a `UserError` if non-submodule
 * changes are detected.  The behavior is undefined if there is no merge base
 * between HEAD and `targetCommit`.
 *
 * Note that this method will cause conflicts in `index` to be cleaned up.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Index}      index
 * @param {NodeGit.Commit}     targetCommit
 * @return {Object} return
 * @return {Object} return.changes        from sub name to `SubmoduleChange`
 * @return {Object} return.simpleChanges  from sub name to `Submodule` or null
 * @return {Object} return.conflicts      from sub name to `Conflict`
 */
exports.computeChanges = co.wrap(function *(repo, index, targetCommit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(index, NodeGit.Index);
    assert.instanceOf(targetCommit, NodeGit.Commit);

    const head = yield repo.getHeadCommit();
    const result = yield exports.computeChangesBetweenTwoCommits(repo,
                                                                 index,
                                                                 head,
                                                                 targetCommit);
    return result;
});

/**
 * Write the specified `conflicts` to the specified `index` in the specified
 * `repo`.  If `conflicts` is non-empty, return a non-empty string desribing
 * them.  Otherwise, return the empty string.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Index}      index
 * @param {Object}             conflicts  from sub name to `Conflict`
 * @return {String}
 */
exports.writeConflicts = co.wrap(function *(repo, index, conflicts) {
    let errorMessage = "";
    const names = Object.keys(conflicts).sort();
    for (let name of names) {
        yield ConflictUtil.addConflict(index, name, conflicts[name]);
        errorMessage += `\
Conflicting entries for submodule ${colors.red(name)}
`;
    }
    return errorMessage;
});

/**
 * Throw a user error if there are URL-only changes between the  specified
 * `commit` and `baseCommit`  in the specified `repo`.  If
 * `undefined === baseCommit`, compare against the first parent of `commit`.
 *
 * TODO: independent test
 *
 * TODO: Dealing with these would be a huge hassle and is probably not worth it
 * at the moment since the recommended policy for monorepo implementations is
 * to prevent users from making URL changes anyway.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 * @param {NodeGit.Commit}     [baseCommit]
 */
exports.ensureNoURLChanges = co.wrap(function *(repo, commit, baseCommit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    if (undefined !== baseCommit) {
        assert.instanceOf(baseCommit, NodeGit.Commit);
    }

    const hasUrlChanges =
                    yield exports.containsUrlChanges(repo, commit, baseCommit);
    if (hasUrlChanges) {

        throw new UserError(`\
Applying commits with submodule URL changes is not currently supported.
Please try with normal git commands.`);
    }
});

/**
 * Close submodules that have been opened by the specified `opener` but that
 * have no mapped commits or conflicts in the specified `changes`.
 *
 * TODO: independent test
 *
 * @param {Open.Opener} opener
 * @param {Object}      changes
 * @param {Object}      changes.commits   from sub path to map from sha to sha
 * @param {Object}      changes.conflicts from sub path to sha causing conflict
 */
exports.closeSubs = co.wrap(function *(opener, changes) {
    const repo = opener.repo;
    const toClose = (yield opener.getOpenedSubs()).filter(path => {
        const commits = changes.commits[path];
        if ((undefined === commits || 0 === Object.keys(commits).length) &&
            !(path in changes.conflicts)) {
            console.log(`Closing ${colors.green(path)}`);
            return true;
        }
        return false;
    });
    yield SubmoduleConfigUtil.deinit(repo, toClose);
});

/**
 * Rewrite the specified `commit` on top of HEAD in the specified `repo` using
 * the specified `opener` to open submodules as needed.  The behavior is
 * undefined unless the repository is clean.  Return an object describing the
 * commits that were made and any error message; if no commit was made (because
 * there were no changes to commit), `newMetaCommit` will be null.  Throw a
 * `UserError` if URL changes or direct meta-repo changes are present in
 * `commit`.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 * @param {String} commandName accepts git-meta command that
 * gets checked for any conflicts when running rewriteCommit
 * for a more elaborated errorMessage
 * @return {Object}      return
 * @return {String|null} return.newMetaCommit
 * @return {Object}      returm.submoduleCommits
 * @return {String|null} return.errorMessage
 */
exports.rewriteCommit = co.wrap(function *(repo, commit, commandName) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);

    yield exports.ensureNoURLChanges(repo, commit);

    const head = yield repo.getHeadCommit();
    const changeIndex =
                    yield NodeGit.Cherrypick.commit(repo, commit, head, 0, []);
    const changes = yield exports.computeChanges(repo, changeIndex, commit);
    const index = yield repo.index();

    // Perform simple changes that don't require picks -- addition, deletions,
    // and fast-forwards.

    const opener = new Open.Opener(repo, null);
    yield exports.changeSubmodules(repo,
                                   opener,
                                   index,
                                   changes.simpleChanges,
                                   null);

    // Render any conflicts

    let errorMessage =
                  yield exports.writeConflicts(repo, index, changes.conflicts);

    // Then do the cherry-picks.

    const picks = yield exports.pickSubs(repo, opener, index, changes.changes);
    const conflicts = picks.conflicts;

    yield exports.closeSubs(opener, picks);

    Object.keys(conflicts).sort().forEach(name => {
        errorMessage += SubmoduleRebaseUtil.subConflictErrorMessage(name);
    });

    if (Object.keys(conflicts).length !== 0) {
        errorMessage += `\
        A ${commandName} is in progress.
        (after resolving conflicts mark the corrected paths
        with 'git meta add', then run "git meta ${commandName} --continue")
        (use "git meta ${commandName} --abort" to `+
        "check out the original branch)";
    }


    const result = {
        pickingCommit: commit,
        submoduleCommits: picks.commits,
        errorMessage: errorMessage === "" ? null : errorMessage,
        newMetaCommit: null,
    };
    yield SparseCheckoutUtil.setSparseBitsAndWriteIndex(repo, index);
    const nChanges = Object.keys(picks.commits)
        .map(name => Object.keys(
            picks.commits[name]).length + picks.ffwds[name] ? 1 : 0
        ).reduce((acc, len) => acc + len, 0);
        if ("" === errorMessage &&
        (0 !== Object.keys(changes.simpleChanges).length || 0 !== nChanges)) {
        result.newMetaCommit =
                            yield SubmoduleRebaseUtil.makeCommit(repo, commit);
        }

    if (result.errorMessage === null) {
        // Run post-commit hook as regular git.
        yield Hook.execHook(repo, "post-commit");
    }
    return result;
});

const pickRemainingCommits = co.wrap(function*(metaRepo, seq) {
    const commits = seq.commits;
    let result;
    for (let i = seq.currentCommit; i < commits.length; ++i) {
        const id = commits[i];
        const commit = yield metaRepo.getCommit(id);
        console.log(`Cherry-picking commit ${colors.green(id)}.`);

        seq = seq.copy({currentCommit : i});
        yield SequencerStateUtil.writeSequencerState(metaRepo.path(), seq);
        result = yield exports.rewriteCommit(metaRepo, commit, "cherry-pick");
        if (null !== result.errorMessage) {
            return result;
        }
        if (null === result.newMetaCommit) {
            // TODO: stop and offer the user the option of git commit
            // --allow-empty vs cherry-pick --skip.  For now, tho,
            // empty meta commits are pretty useless so we will just
            // skip.
            console.log("Nothing to commit.");
        }
    }

    yield SequencerStateUtil.cleanSequencerState(metaRepo.path());
    return result;
});


/**
 * Cherry-pick the specified `commits` in the specified `metaRepo`.
 * Return an object with the cherry-picked commits ids for the last
 * cherry-picked commit (whether or not that was successful).  This
 * object contains the id of the newly-generated meta-repo commit and
 * for each sub-repo, a map from new (cherry-pick) sha to the original
 * commit sha.  Throw a `UserError` if the repository is not in a
 * state that can allow a cherry-pick (e.g., it's rebasing), if
 * `commit` contains changes that we cannot cherry-pick (e.g.,
 * URL-only changes), or if the cherry-pick would result in no changes
 * (TODO: provide support for '--allow-empty' if needed).  If the
 * cherry-pick is initiated but results in a conflicts, the
 * `errorMessage` of the returned object will be non-null and will
 * contain a description of the conflicts.
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param [{NodeGit.Commit}]     commits
 * @return {Object}      return
 * @return {String}      return.newMetaCommit
 * @return {Object}      returm.submoduleCommits
 * @return {String|null} return.errorMessage
 */
exports.cherryPick = co.wrap(function *(metaRepo, commits) {
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.instanceOf(commits[0], NodeGit.Commit);

    const status = yield StatusUtil.getRepoStatus(metaRepo);
    StatusUtil.ensureReady(status);

    // First, perform sanity checks to see if the repo is in a state that we
    // can pick in and if `commit` is something that we can pick.

    if (!status.isDeepClean(false)) {
        // TODO: Git will refuse to run if there are staged changes, but will
        // attempt a cherry-pick if there are just workdir changes.  We should
        // support this in the future, but it basically requires us to dry-run
        // the rebases in all the submodules, and I'm uncertain how to do that
        // at the moment.

        throw new UserError(`\
The repository has uncommitted changes.  Please stash or commit them before
running cherry-pick.`);
    }

    // We're going to attempt a cherry-pick if we've made it this far, record a
    // cherry-pick file.

    const head = yield metaRepo.getHeadCommit();
    const commitIdStrs = commits.map(x => x.id().tostrS());
    let lastCommit = commitIdStrs[commitIdStrs.length - 1];
    let seq = new SequencerState({
        type: CHERRY_PICK,
        originalHead: new CommitAndRef(head.id().tostrS(), null),
        // target is bogus for cherry-picks but must be filled in anyway
        target: new CommitAndRef(lastCommit, null),
        currentCommit: 0,
        commits: commitIdStrs,
    });
    yield SequencerStateUtil.writeSequencerState(metaRepo.path(), seq);

    return yield pickRemainingCommits(metaRepo, seq);
});

/**
 * Continue the in-progress cherry-pick in the specified `repo`.  Throw a
 * `UserError` if the continue cannot be initiated, e.g., because there is not
 * a cherry-pick in progress or there are still conflicts.  Return an object
 * describing the commits that were made and any errors that were generated.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @return {Object}      return
 * @return {String|null} return.newMetaCommit
 * @return {Object}      returm.submoduleCommits
 * @return {Object}      returm.newSubmoduleCommits
 * @return {String|null} return.errorMessage
 */
exports.continue = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const status = yield StatusUtil.getRepoStatus(repo);
    const seq = status.sequencerState;
    ensureCherryInProgress(seq);
    if (status.isConflicted()) {
        throw new UserError("Resolve conflicts then continue cherry-pick.");
    }
    const index = yield repo.index();
    const commit = yield repo.getCommit(seq.commits[seq.currentCommit]);
    const subResult = yield SubmoduleRebaseUtil.continueSubmodules(repo,
                                                                   index,
                                                                   status,
                                                                   commit);

    const result = {
        pickingCommit: commit,
        newMetaCommit: subResult.metaCommit,
        submoduleCommits: subResult.commits,
        newSubmoduleCommits: subResult.newCommits,
        errorMessage: subResult.errorMessage,
    };
    if (subResult.errorMessage !== null ||
        seq.currentCommit + 1 === seq.commits.length) {
        yield SequencerStateUtil.cleanSequencerState(repo.path());
        return result;
    }
    const newSeq = seq.copy({currentCommit : seq.currentCommit + 1});
    return yield pickRemainingCommits(repo, newSeq);
});

/**
 * Abort the cherry-pick in progress in the specified `repo` and return the
 * repository to exactly the state of the initial commit.  Throw a `UserError`
 * if no cherry-pick is in progress.
 *
 * @param {NodeGit.Repository} repo
 */
exports.abort = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const seq = yield SequencerStateUtil.readSequencerState(repo.path());
    ensureCherryInProgress(seq);
    const commit = yield repo.getCommit(seq.originalHead.sha);
    yield Reset.reset(repo, commit, Reset.TYPE.MERGE);
    yield SequencerStateUtil.cleanSequencerState(repo.path());
    console.log("Cherry-pick aborted.");
});
