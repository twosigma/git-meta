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

const assert         = require("chai").assert;
const co             = require("co");
const NodeGit        = require("nodegit");

const Commit              = require("./commit");
const ConfigUtil          = require("./config_util");
const DoWorkQueue         = require("./do_work_queue");
const GitUtil             = require("./git_util");
const SubmoduleChange     = require("./submodule_change");
const SubmoduleConfigUtil = require("./submodule_config_util");
const SubmoduleUtil       = require("./submodule_util");
const SyntheticBranchUtil = require("./synthetic_branch_util");
const TreeUtil            = require("./tree_util");

const FILEMODE            = NodeGit.TreeEntry.FILEMODE;

// This constant defines the maximum number of simple, multi-threaded parallel
// operations we'll perform.  We allow the user to configure the number of
// parallel operations that we must shell out for, but this value is just to
// prevent us from running out of JavaScript heap.

const maxParallel = 1000;


// TODO: the `writeNotes` and `readNotes` methods should be moved to a utility
// for notes, if they're needed elsewhwere.

/**
 * Write the specified `contents` to the note having the specified `refName` in
 * the specified `repo`.
 *
 * Writing notes oneo-at-a-time is slow.  This method let's you write them in
 * bulk, far more efficiently.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             refName
 * @param {Object}             contents    SHA to data
 */
exports.writeNotes = co.wrap(function *(repo, refName, contents) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(refName);
    assert.isObject(contents);

    if (0 === Object.keys(contents).length) {
        // Nothing to do if no contents; no point in making an empty commit or
        // in making clients check themselves.
        return;                                                       // RETURN
    }

    // We're going to directly write the tree/commit for a new note containing
    // `contents`.

    let currentCommit = null;
    let currentTree = null;
    const parents = [];
    const ref = yield GitUtil.getReference(repo, refName);
    if (null !== ref) {
        currentCommit = yield repo.getCommit(ref.target());
        parents.push(currentCommit);
        currentTree = yield currentCommit.getTree();
    }
    const odb = yield repo.odb();
    const changes = {};
    const ODB_BLOB = 3;
    const BLOB = NodeGit.TreeEntry.FILEMODE.BLOB;
    const writeBlob = co.wrap(function *(sha) {
        const content = contents[sha];
        const blobId = yield odb.write(content, content.length, ODB_BLOB);
        changes[sha] = new TreeUtil.Change(blobId, BLOB);
    });
    yield DoWorkQueue.doInParallel(Object.keys(contents),
                                   writeBlob,
                                   maxParallel);

    const newTree = yield TreeUtil.writeTree(repo, currentTree, changes);
    const sig = yield ConfigUtil.defaultSignature(repo);
    const commit = yield NodeGit.Commit.create(repo,
                                               null,
                                               sig,
                                               sig,
                                               null,
                                               "git-meta updating notes",
                                               newTree,
                                               parents.length,
                                               parents);
    yield NodeGit.Reference.create(repo, refName, commit, 1, "updated");
});

/**
 * Return the contents of the note having the specified `refName` in the
 * specified `repo` or an empty object if no such note exists.
 *
 * Reading notes one-at-a-time is slow.  This method let's you read them all at
 * once for a given ref.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             refName
 * @return {Object} sha to content
 */
exports.readNotes = co.wrap(function *(repo, refName) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(refName);

    const ref = yield GitUtil.getReference(repo, refName);
    if (null === ref) {
        return {};
    }
    const result = {};
    const commit = yield repo.getCommit(ref.target());
    const tree = yield commit.getTree();
    const entries = tree.entries();
    const processEntry = co.wrap(function *(e) {
        const blob = yield e.getBlob();
        const text = blob.toString();
        result[e.name()] = text === "" ? null : text;
    });
    yield DoWorkQueue.doInParallel(entries, processEntry, maxParallel);
    return result;
});


/**
 * The name of the note used to record conversion information.
 *
 * @property {String}
 */
exports.convertedNoteRef = "refs/notes/stitched/converted";

/**
 * Return the content of the note used to record that a commit was stitched
 * into the specified `stitchedSha`, orm, if `null === stitchedSha`, that the
 * commit could not be stitched.
 * 
 * @param {String|null} stitchedSha
 */
exports.makeConvertedNoteContent = function (stitchedSha) {
    if (null !== stitchedSha) {
        assert.isString(stitchedSha);
    }
    return null === stitchedSha ? "" : stitchedSha;
};

/**
 * Return the commit message to use for a stitch commit coming from the
 * specified `metaCommit` that introduces the specified `subCommits`.
 *
 * @param {NodeGit.Commit} metaCommit
 * @param {Object}         subCommits    from name to NodeGit.Commit
 * @return {String}
 */
exports.makeStitchCommitMessage = function (metaCommit, subCommits) {
    assert.instanceOf(metaCommit, NodeGit.Commit);
    assert.isObject(subCommits);

    const metaAuthor = metaCommit.author();
    const metaName = metaAuthor.name();
    const metaEmail = metaAuthor.email();
    const metaWhen = metaAuthor.when();
    const metaTime = metaWhen.time();
    const metaOffset = metaWhen.offset();
    const metaMessage = metaCommit.message();
    let result = metaCommit.message();

    // Add information from submodule commits that differs from the the
    // meta-repo commit.  When all info (author, time, message) in a sub commit
    // matches that of the meta-repo commit, skip it completely.

    Object.keys(subCommits).forEach(subName => {
        const commit = subCommits[subName];
        const author = commit.author();
        const name = author.name();
        const email = author.email();
        let authorText = "";
        if (name !== metaName || email !== metaEmail) {
            authorText = `Author: ${name} <${email}>\n`;
        }
        const when = author.when();
        let whenText = "";
        if (when.time() !== metaTime || when.offset() !== metaOffset) {
            whenText = `Date:   ${Commit.formatCommitTime(when)}\n`;
        }
        const message = commit.message();
        let messageText = "";
        if (message !== metaMessage) {
            messageText = "\n" + message;
        }
        if ("" !== authorText || "" !== whenText || "" !== messageText) {
            if (!result.endsWith("\n")) {
                result += "\n";
            }
            result += "\n";
            result += `From '${subName}'\n`;
            result += authorText;
            result += whenText;
            result += messageText;
        }
    });
    return result;
};

/**
 * The name of the note used to record conversion information.
 *
 * @property {String}
 */
exports.referenceNoteRef = "refs/notes/stitched/reference";


/**
 * Return the content to be used for a note indicating that a stitched commit
 * originated from the specified `metaRepoSha` and `subCommits`.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             metaRepoSha
 * @param {Object}             subCommits     name to NodeGit.Commit
 */
exports.makeReferenceNoteContent = function (metaRepoSha, subCommits) {
    assert.isString(metaRepoSha);
    assert.isObject(subCommits);
    const object = {
        metaRepoCommit: metaRepoSha,
        submoduleCommits: {},
    };
    Object.keys(subCommits).forEach(name => {
        object.submoduleCommits[name] = subCommits[name].id().tostrS();
    });
    return JSON.stringify(object, null, 4);
};

/**
 * From a map containing a shas mapped to sets of direct parents, and the
 * specified starting `entry` sha, return a list of all shas ordered from least
 * to most dependent, that is, no sha will appear in the list before any of its
 * ancestors.  If no relation exists between two shas, they will be ordered
 * alphabetically.  Note that it is valid for a sha to exist as a parent from a
 * sha in `parentMap`, however, the behavior is undefined if there are entries
 * in 'parentMap' that are not reachable from 'entry'.
 *
 * @param {String} entry
 * @param {Object} parentMap  from sha to Set of its direct parents
 * @return {[String]}
 */
exports.listCommitsInOrder = function (entry, parentMap) {
    assert.isString(entry);
    assert.isObject(parentMap);

    // First, compute the generations of the commits.  A generation '0' means
    // that a commit has no parents.  A generation '1' means that a commit
    // depends only on commits with 0 parents, a generation N means that a
    // commit depends only on commits with a generation less than N.

    const generations = {};
    let queue = [entry];
    while (0 !== queue.length) {
        const next = queue[queue.length - 1];

        // Exit if we've already computed this one; can happen if one gets into
        // the queue more than once.

        if (next in generations) {
            queue.pop();
            continue;                                               // CONTINUE
        }
        let generation = 0;
        const parents = parentMap[next] || [];
        for (const parent of parents) {
            const parentGeneration = generations[parent];
            if (undefined === parentGeneration) {
                generation = undefined;
                queue.push(parent);
            }
            else if (undefined !== generation) {
                // If all parents computed thus far, recompute the max.  It can
                // not be less than or equal to any parent.

                generation = Math.max(generation, parentGeneration + 1);
            }
        }
        if (undefined !== generation) {
            // We were able to compute it, store and pop.

            generations[next] = generation;
            queue.pop();
        }
    }

    // Now we sort, placing lowest generation commits first.

    function compareCommits(a, b) {
        const aGeneration = generations[a];
        const bGeneration = generations[b];
        if (aGeneration !== bGeneration) {
            return aGeneration - bGeneration;                         // RETURN
        }

        // 'a' can never be equal to 'b' because we're sorting keys.

        return a < b ? -1 : 1;
    }
    return Object.keys(parentMap).sort(compareCommits);
};

/**
 * List, in order of least to most dependent, the specified `commit` and its
 * ancestors in the specified `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 * @param {Object}             convertedCommits     map from sha to converted
 * @return {[NodeGit.Commit]}
 */
exports.listCommitsToStitch = co.wrap(function *(repo,
                                                 commit,
                                                 convertedCommits) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    assert.isObject(convertedCommits);

    const toList = [commit];
    const allParents = {};
    const commitMap = {};

    while (0 !== toList.length) {
        const next = toList[toList.length - 1];
        const nextSha = next.id().tostrS();
        toList.pop();

        // Skip processing commits we've seen.

        if (nextSha in allParents) {
            continue;                                               // CONTINUE
        }

        // If it's converted, so, implicitly, are its parents.

        const converted = convertedCommits[nextSha];
        if (undefined !== converted) {
            continue;                                               // CONTINUE
        }
        const parents = yield next.getParents();
        const parentShas = [];
        for (const parent of parents) {
            toList.push(parent);
            const parentSha = parent.id().tostrS();
            parentShas.push(parentSha);
        }
        allParents[nextSha] = parentShas;
        commitMap[nextSha] = next;
    }
    const commitShas = exports.listCommitsInOrder(commit.id().tostrS(),
                                                  allParents);
    return commitShas.map(sha => commitMap[sha]);
});

/**
 * Return the `TreeUtilChange` object corresponding to the `.gitmodules` file
 * synthesized in the specified `repo` from an original commit that had the
 * specified `urls`; this modules will will contain only those urls that are
 * being kept as submodules, i.e., for which the specified `keepAsSubmodule`
 * returns true.
 *
 * @param {NodeGit.Repository}      repo
 * @param {Object}                  urls    submodule name to url
 * @param {(String) => Boolean}     keepAsSubmodule
 * @param {(String) => String|null} adjustPath
 * @pram {TreeUtil.Change}
 */
exports.computeModulesFile = co.wrap(function *(repo,
                                                urls,
                                                keepAsSubmodule,
                                                adjustPath) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isObject(urls);
    assert.isFunction(keepAsSubmodule);
    assert.isFunction(adjustPath);

    const keptUrls = {};
    for (let name in urls) {
        const adjusted = adjustPath(name);
        if (null !== adjusted && keepAsSubmodule(name)) {
            keptUrls[adjusted] = urls[name];
        }
    }
    const modulesText = SubmoduleConfigUtil.writeConfigText(keptUrls);
    const db = yield repo.odb();
    const BLOB = 3;
    const id = yield db.write(modulesText, modulesText.length, BLOB);
    return new TreeUtil.Change(id, FILEMODE.BLOB);
});

exports.changeCacheRef = "refs/notes/stitched/submodule-change-cache";

/**
 * Add the specified `submoduleChanges` to the changed cache in the specified
 * `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @param {Object}             changes    from sha to path to SubmoduleChange
 */
exports.writeSubmoduleChangeCache = co.wrap(function *(repo, changes) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isObject(changes);

    const cache = {};
    for (let sha in changes) {
        const shaChanges = changes[sha];
        const cachedChanges = {};
        for (let path in shaChanges) {
            const change = shaChanges[path];
            cachedChanges[path] = {
                oldSha: change.oldSha,
                newSha: change.newSha
            };
        }
        cache[sha] = JSON.stringify(cachedChanges, null, 4);
    }
    yield exports.writeNotes(repo, exports.changeCacheRef, cache);
});

/**
 * Read the cached list of submodule changes per commit in the specified
 * `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @return {Object}   sha to path to SubmoduleChange
 */
exports.readSubmoduleChangeCache = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const cached = yield exports.readNotes(repo, exports.changeCacheRef);
    const result = {};
    for (let sha in cached) {
        const data = JSON.parse(cached[sha]);
        const changes = {};
        for (let path in data) {
            const change = data[path];
            changes[path] = new SubmoduleChange(change.oldSha, change.newSha);
        }
        result[sha] = changes;
    }
    return result;
});

/**
 * Return a map of the submodule changes for the specified `commits` in the
 * specified `repo`.
 *
 * @param {[NodeGit.Commit]} commits
 * @return {Object}     sha -> name -> SubmoduleChange
 */
exports.listSubmoduleChanges = co.wrap(function *(repo, commits) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isArray(commits);

    const result = yield exports.readSubmoduleChangeCache(repo);
    let numListed = Object.keys(result).length;
    console.log("Loaded", numListed, "from cache");

    console.log("Listing submodule changes");

    let toCache = {};     // bulk up changes that we'll write out periodically
    let caching = false;  // true if we're in the middle of writing the cache
    const writeCache = co.wrap(function *() {

        // This code is reentrant, so we skip out if we're already writing some
        // notes.  Also, we don't want to write tiny note changes, so we
        // arbitrarily wait until we've got 1,000 changes.

        if (caching || 1000 > Object.keys(toCache).length) {
            return;                                                   // RETURN
        }


        caching = true;
        const oldCache = toCache;
        toCache = {};
        yield exports.writeSubmoduleChangeCache(repo, oldCache);
        caching = false;
    });

    const listForCommit = co.wrap(function *(commit) {
        const sha = commit.id().tostrS();
        if (sha in result) {
            // was cached
            return;                                                   // RETURN
        }
        const parents = yield commit.getParents();
        let parentCommit = null;
        if (0 !== parents.length) {
            parentCommit = parents[0];
        }
        const changes = yield SubmoduleUtil.getSubmoduleChanges(repo,
                                                                commit,
                                                                parentCommit,
                                                                true);
        result[sha] = changes;
        toCache[sha] = changes;
        ++numListed;
        if (0 === numListed % 100) {
            console.log("Listed", numListed, "of", commits.length);
        }
        yield writeCache();
    });
    yield DoWorkQueue.doInParallel(commits, listForCommit, maxParallel);

    // If there's anything left in the cache, write it out now.

    yield exports.writeSubmoduleChangeCache(repo, toCache);

    return result;
});

/**
 * Return a map from submodule name to shas to list of objects containing the
 * fields:
 * - `metaSha` -- the meta-repo sha from which this subodule sha came
 * - `url`     -- url configured for the submodule
 * - `sha`     -- sha to fetch for the submodule
 * this map contains entries for all shas introduced in the specified `toFetch`
 * list in the specified `repo`.  Note that the behavior is undefined unless
 * `toFetch` is ordered from least to most dependent commits.  Perform at most
 * the specified `numParallel` operations in parallel.  Do not process entries
 * for submodules for which the specified `keepAsSubmodule` returns true or the
 * specified `adjustPath` returns null.
 *
 * @param {NodeGit.Repository}      repo
 * @param {[NodeGit.Commit]}        toFetch
 * @param {Object}                  commitChanges    sha->name->SubmoduleChange
 * @param {(String) => Boolean}     keepAsSubmodule
 * @param {(String) => String|null} adjustPath
 * @param {Number}                  numParallel
 * @return {Object}  map from submodule name -> { metaSha, url, sha }
 */
exports.listFetches = co.wrap(function *(repo,
                                         toFetch,
                                         commitChanges,
                                         keepAsSubmodule,
                                         adjustPath,
                                         numParallel) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isArray(toFetch);
    assert.isObject(commitChanges);
    assert.isFunction(keepAsSubmodule);
    assert.isFunction(adjustPath);
    assert.isNumber(numParallel);

    let urls = {};

    // So that we don't have to continuously re-read the `.gitmodules` file, we
    // will assume that submodule URLs never change.

    const getUrl = co.wrap(function *(commit, sub) {
        let subUrl = urls[sub];

        // If we don't have the url for this submodule, load them.

        if (undefined === subUrl) {
            const newUrls =
               yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, commit);
            urls = Object.assign(urls, newUrls);
            subUrl = urls[sub];
        }
        return subUrl;
    });

    const result = {};

    const addTodo = co.wrap(function *(commit, subName, sha) {
        let subTodos = result[subName];
        if (undefined === subTodos) {
            subTodos = [];
            result[subName] = subTodos;
        }
        const subUrl = yield getUrl(commit, subName);
        subTodos.push({
            metaSha: commit.id().tostrS(),
            url: subUrl,
            sha: sha,
        });
    });

    toFetch = toFetch.slice().reverse();
    for (const commit of toFetch) {
        const changes = commitChanges[commit.id().tostrS()];

        // look for added or modified submodules

        for (let name in changes) {
            const change = changes[name];
            if (null !== adjustPath(name) && !keepAsSubmodule(name)) {
                if (null !== change.newSha) {
                    yield addTodo(commit, name, change.newSha);
                }
            }
        }
    }
    return result;
});

/**
 * Write and return a new "stitched" commit for the specified `commit` in the
 * specified `repo`.  If the specified `keepAsSubmodule` function returns true
 * for the path of a submodule, continue to treat it as a submodule in the new
 * commit and do not stitch it.  The specified `adjustPath` function may be
 * used to move the contents of a submodule in the worktree and/or request that
 * its changes be omitted completely (by returning `null`); this function is
 * applied to the paths of submodules that are stitched and those that are kept
 * as submodules.
 *
 * If the specified `skipEmpty` is true and the generated commit would be empty
 * because either:
 *
 * 1. It would have an empty tree and no parents
 * 2. It would have the same tree as its first parent
 *
 * Then do not generate a commit; instead, return the first parent (and an
 * empty `subCommits` map), or null if there are no parents.
 *
 * @param {NodeGit.Repository}      repo
 * @param {NodeGit.Commit}          commit
 * @param {Object}                  subChanges   path to SubmoduleChange
 * @param {[NodeGit.Commit]}        parents
 * @param {(String) => Boolean}     keepAsSubmodule
 * @param {(String) => String|null} adjustPath
 * @param {Bool}                    skipEmpty
 * @return {Object}
 * @return {NodeGit.Commit} [return.stitchedCommit]
 * @return {Object}         return.subCommits       path to NodeGit.Commit
 */
exports.writeStitchedCommit = co.wrap(function *(repo,
                                                 commit,
                                                 subChanges,
                                                 parents,
                                                 keepAsSubmodule,
                                                 adjustPath,
                                                 skipEmpty) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    assert.isObject(subChanges);
    assert.isArray(parents);
    assert.isFunction(keepAsSubmodule);
    assert.isFunction(adjustPath);
    assert.isBoolean(skipEmpty);

    // changes and additions

    let updateModules = false;  // if any kept subs added or removed
    const changes = {};
    let subCommits = {};
    const stitchSub = co.wrap(function *(name, sha) {
        let subCommit;
        try {
            subCommit = yield repo.getCommit(sha);
        }
        catch (e) {
            console.error("On meta-commit", commit.id().tostrS(),
                          name, "is missing", sha);
            throw e;
        }
        const subTreeId = subCommit.treeId();
        changes[name] = new TreeUtil.Change(subTreeId, FILEMODE.TREE);
        subCommits[name] = subCommit;
    });

    function changeKept(name, newSha) {
        const id = NodeGit.Oid.fromString(newSha);
        changes[name] = new TreeUtil.Change(id, FILEMODE.COMMIT);
    }

    for (let name in subChanges) {
        const mapped = adjustPath(name);
        if (null === mapped) {
            continue;                                               // CONTINUE
        }
        const newSha = subChanges[name].newSha;
        changes[mapped] = null;

        if (keepAsSubmodule(name)) {
            updateModules = true;
            if (null !== newSha) {
                changeKept(name, newSha);
            }
        } else if (null !== newSha) {
            yield stitchSub(mapped, newSha);
        }
    }

    // If any kept submodules were added or removed, rewrite the modules
    // file.

    if (updateModules) {
        const newUrls =
               yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, commit);
        const content = yield exports.computeModulesFile(repo,newUrls,
                                                         keepAsSubmodule,
                                                         adjustPath);
        changes[SubmoduleConfigUtil.modulesFileName] = content;
    }

    let newCommit = null;

    if (!skipEmpty || 0 !== Object.keys(changes).length) {
        let parentTree = null;
        if (0 !== parents.length) {
            const parentCommit = parents[0];
            parentTree = yield parentCommit.getTree();
        }

        const newTree = yield TreeUtil.writeTree(repo, parentTree, changes);

        const commitMessage = exports.makeStitchCommitMessage(commit,
                                                              subCommits);
        const newCommitId = yield NodeGit.Commit.create(
                                                      repo,
                                                      null,
                                                      commit.author(),
                                                      commit.committer(),
                                                      commit.messageEncoding(),
                                                      commitMessage,
                                                      newTree,
                                                      parents.length,
                                                      parents);
        newCommit = yield repo.getCommit(newCommitId);
    } else if (0 !== parents.length) {
        newCommit = parents[0];
        subCommits = {};
    }
    return {
        stitchedCommit: newCommit,
        subCommits: subCommits,
    };
});

/**
 * In the specified `repo`, perform the specified `subFetches`.  Use the
 * specified `url` to resolve relative submodule urls.  Each entry in the
 * `subFetches` array is an object containing the fields:
 * 
 * - url -- submodule configured url
 * - sha -- submodule sha
 * - metaSha -- sha it was introcued on
 *
 * @param {NodeGit.Repository}  repo
 * @param {String}              url
 * @param {[Object]}            subFetches
 */
exports.fetchSubCommits = co.wrap(function *(repo, url, subFetches) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(url);
    assert.isArray(subFetches);

    for (const fetch of subFetches) {
        const subUrl = SubmoduleConfigUtil.resolveSubmoduleUrl(url, fetch.url);

        const sha = fetch.sha;
        let fetched;
        try {
            fetched = yield GitUtil.fetchSha(repo, subUrl, sha);
        }
        catch (e) {
            console.log("Fetch of", subUrl, "failed:", e.message);
            return;                                               // RETURN
        }

        // Make a ref to protect fetched submodule commits from GC.

        if (fetched) {
            console.log("Fetched:", sha, "from", subUrl);
            const refName =
                          SyntheticBranchUtil.getSyntheticBranchForCommit(sha);
            yield NodeGit.Reference.create(repo, refName, sha, 1, "fetched");
        }
    }
});

/**
 * Return a function for adjusting paths while performing a join operation.
 * For paths that start with the specified `root` path, return the part of that
 * path following `root/`; for other paths return null.  If `root` is null,
 * return the identity function.
 *
 * @param {String|null} root
 * @return {(String) => String|null}
 */
exports.makeAdjustPathFunction = function (root) {
    if (null !== root) {
        assert.isString(root);
    }
    if (null === root) {
        return (x) => x;                                              // RETURN
    }
    if (!root.endsWith("/")) {
        root += "/";
    }
    return function (filename) {
        if (filename.startsWith(root)) {
            return filename.substring(root.length);
        }
        return null;
    };
};

/**
 * Stitch the repository at the specified `repoPath` starting with the
 * specified `commitish` and point the specified `targetBranchName` to the
 * result.  Use the specified `options.keepAsSubmodule` function to determine
 * which paths to keep as submodule rather than stitching.  If the optionally
 * specified `options.joinRoot` is provided, create a history containing only
 * commits touching that tree of the meta-repo, rooted relative to
 * `options.joinRoot`.  Perform at most the specified `options.numParallel`
 * fetch operations at once.  If the specified `options.fetch` is provied and
 * true, fetch submodule commits as needed using the specified `url` to resolve
 * relative submodule URLs.  If the specified `skipEmpty` is provided and true,
 * omit, from the generated history, commits whose trees do not differ from
 * their first parents.  The behavior is undefined if `true === fetch` and
 * `options.url` is not provided.
 *
 * TBD: Write a unit test for this; this logic used to be in the command
 * handler, and all the pieces are tested.
 *
 * @param {String}           repoPath
 * @param {String}           commitish
 * @param {String}           targetBranchName
 * @param {Object}           options
 * @param {Bool}             [options.fetch]
 * @param {String}           [options.url]
 * @param {(String) => Bool} options.keepAsSubmodule
 * @param {String}           [options.joinRoot]
 * @param {Number}           numParallel
 * @param {Bool}             [skipEmpty]
 */
exports.stitch = co.wrap(function *(repoPath,
                                    commitish,
                                    targetBranchName,
                                    options) {
    assert.isString(repoPath);
    assert.isString(commitish);
    assert.isString(targetBranchName);
    assert.isObject(options);

    let fetch = false;
    let url = null;
    if ("fetch" in options) {
        assert.isBoolean(options.fetch);
        fetch = options.fetch;
        assert.isString(options.url, "url required with fetch");
        url = options.url;
    }

    assert.isFunction(options.keepAsSubmodule);

    let joinRoot = null;
    if ("joinRoot" in options) {
        assert.isString(options.joinRoot);
        joinRoot = options.joinRoot;
    }

    assert.isNumber(options.numParallel);

    let skipEmpty = false;
    if ("skipEmpty" in options) {
        assert.isBoolean(options.skipEmpty);
        skipEmpty = options.skipEmpty;
    }

    const repo = yield NodeGit.Repository.open(repoPath);
    const annotated = yield GitUtil.resolveCommitish(repo, commitish);
    if (null === annotated) {
        throw new Error(`Could not resolve ${commitish}.`);
    }
    const commit = yield repo.getCommit(annotated.id());

    console.log("Listing previously converted commits.");

    const convertedCommits = yield exports.readNotes(repo,
                                                     exports.convertedNoteRef);

    console.log("listing unconverted ancestors of", commit.id().tostrS());

    const commitsToStitch =
             yield exports.listCommitsToStitch(repo, commit, convertedCommits);

    const changes = yield exports.listSubmoduleChanges(repo, commitsToStitch);

    const adjustPath = exports.makeAdjustPathFunction(joinRoot);

    console.log(commitsToStitch.length, "to stitch");

    if (fetch) {
        console.log("listing fetches");
        const fetches = yield exports.listFetches(repo,
                                                  commitsToStitch,
                                                  changes,
                                                  options.keepAsSubmodule,
                                                  adjustPath,
                                                  options.numParallel);
        console.log("Found", Object.keys(fetches).length, "subs to fetch.");
        const subNames = Object.keys(fetches);
        const doFetch = co.wrap(function *(name, i) {
            const subFetches = fetches[name];
            const fetchTimeMessage = `\
(${i + 1}/${subNames.length}) -- fetched ${subFetches.length} SHAs for \
${name}`;
            console.time(fetchTimeMessage);
            yield exports.fetchSubCommits(repo, url, subFetches);
            console.timeEnd(fetchTimeMessage);
        });
        yield DoWorkQueue.doInParallel(subNames, doFetch, options.numParallel);
    }

    console.log("Now stitching");
    let lastCommit = null;

    let records = {};

    const writeNotes = co.wrap(function *() {
        console.log(
                  `Writing notes for ${Object.keys(records).length} commits.`);
        const convertedNotes = {};
        const referenceNotes = {};
        for (let sha in records) {
            const record = records[sha];
            const stitchedCommit = record.stitchedCommit;
            const stitchedSha =
                 null === stitchedCommit ? null : stitchedCommit.id().tostrS();
            convertedNotes[sha] =
                                 exports.makeConvertedNoteContent(stitchedSha);
            if (null !== stitchedSha) {
                referenceNotes[sha] = exports.makeReferenceNoteContent(
                                                            stitchedSha,
                                                            record.subCommits);
            }
        }
        yield exports.writeNotes(repo,
                                 exports.referenceNoteRef,
                                 referenceNotes);
        yield exports.writeNotes(repo,
                                 exports.convertedNoteRef,
                                 convertedNotes);
        records = {};
    });

    for (let i = 0; i < commitsToStitch.length; ++i) {
        const next = commitsToStitch[i];

        const nextSha = next.id().tostrS();
        const parents = yield next.getParents();
        const newParents = [];
        for (const parent of parents) {
            const newParentSha = convertedCommits[parent.id().tostrS()];
            if (null !== newParentSha && undefined !== newParentSha) {
                const newParent = yield repo.getCommit(newParentSha);
                newParents.push(newParent);
            }
        }

        const result = yield exports.writeStitchedCommit(
                                                       repo,
                                                       next,
                                                       changes[nextSha],
                                                       newParents,
                                                       options.keepAsSubmodule,
                                                       adjustPath,
                                                       skipEmpty);
        records[nextSha] = result;
        const newCommit = result.stitchedCommit;
        const newSha = null === newCommit ? null : newCommit.id().tostrS();
        convertedCommits[nextSha] = newSha;
        const desc = null === newCommit ? "skipped" : newCommit.id().tostrS();
        const log = `\
Of [${commitsToStitch.length}] done [${i + 1}] : ${nextSha} -> ${desc}`;
        console.log(log);

        if (10000 <= Object.keys(records).length) {
            yield writeNotes();
        }

        // If `writeStitchedCommit` returned null to indicate that it did not
        // make a commit (because it would have been empty), leave `lastCommit`
        // unchanged.

        lastCommit = newCommit || lastCommit;
    }
    yield writeNotes();
    if (null !== lastCommit) {
        console.log(
               `Updating ${targetBranchName} to ${lastCommit.id().tostrS()}.`);
        yield NodeGit.Branch.create(repo, targetBranchName, lastCommit, 1);
    }
});

