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

const BulkNotesUtil       = require("./bulk_notes_util");
const Commit              = require("./commit");
const ConfigUtil          = require("./config_util");
const DoWorkQueue         = require("./do_work_queue");
const GitUtil             = require("./git_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const SubmoduleUtil       = require("./submodule_util");
const TreeUtil            = require("./tree_util");
const UserError           = require("./user_error");

const FILEMODE            = NodeGit.TreeEntry.FILEMODE;

/**
 * @property {String}
 */
exports.allowedToFailNoteRef = "refs/notes/stitched/allowed_to_fail";

/**
 * Return a set of meta-repo commits that are allowed to fail.
 *
 * @param {NodeGit.Repository} repo
 * @return {Set}
 */
exports.readAllowedToFailList = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const notes =
                 yield BulkNotesUtil.readNotes(repo,
                                               exports.allowedToFailNoteRef);
    return new Set(Object.keys(notes));
});

/**
 * The name of the note used to record conversion information.
 *
 * @property {String}
 */
exports.convertedNoteRef = "refs/notes/stitched/converted";

/**
 * Return the content of the note used to record that a commit was stitched
 * into the specified `stitchedSha`, or, if `null === stitchedSha`, that the
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

    // Sometimes (I don't know if this is libgit2 vs. git or what) otherwise
    // matching messages may be missing line endings.

    const metaMessage = Commit.ensureEolOnLastLine(metaCommit.message());
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
        const message = Commit.ensureEolOnLastLine(commit.message());
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
    yield BulkNotesUtil.writeNotes(repo, exports.changeCacheRef, cache);
});

/**
 * Read the cached list of submodule changes per commit in the specified
 * `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @return {Object}   sha to path to SubmoduleChange-like object
 */
exports.readSubmoduleChangeCache = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const cached = yield BulkNotesUtil.readNotes(repo, exports.changeCacheRef);
    return BulkNotesUtil.parseNotes(cached);
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
    yield DoWorkQueue.doInParallel(commits, listForCommit);

    // If there's anything left in the cache, write it out now.

    yield exports.writeSubmoduleChangeCache(repo, toCache);

    return result;
});

/**
 * Return a map from submodule name to list of objects containing the
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
                                         adjustPath) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isArray(toFetch);
    assert.isObject(commitChanges);
    assert.isFunction(keepAsSubmodule);
    assert.isFunction(adjustPath);

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
 * Return true if any parent of the specified `commit` other than the first has
 * the specified `sha` for the submodule having the specified `name` in the
 * specified repo.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodEGit.Commit}     commit
 * @param {String}             name
 * @param {String}             sha
 */
exports.sameInAnyOtherParent = co.wrap(function *(repo, commit, name, sha) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    assert.isString(name);
    assert.isString(sha);

    const parents = yield commit.getParents();
    for (const parent of parents.slice(1)) {
        const tree = yield parent.getTree();
        try {
            const entry = yield tree.entryByPath(name);
            if (entry.sha() === sha) {
                return true;
            }
        } catch (e) {
            // missing in parent
        }
    }
    return false;
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
 * Allow commits in the specified `allowed_to_fail` to reference invalid
 * submodule commits; skip those (submodule) commits.
 *
 * @param {NodeGit.Repository}      repo
 * @param {NodeGit.Commit}          commit
 * @param {Object}                  subChanges   path to SubmoduleChange
 * @param {[NodeGit.Commit]}        parents
 * @param {(String) => Boolean}     keepAsSubmodule
 * @param {(String) => String|null} adjustPath
 * @param {Bool}                    skipEmpty
 * @param {Set of String}           allowed_to_fail
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
                                                 skipEmpty,
                                                 allowed_to_fail) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    assert.isObject(subChanges);
    assert.isArray(parents);
    assert.isFunction(keepAsSubmodule);
    assert.isFunction(adjustPath);
    assert.isBoolean(skipEmpty);
    assert.instanceOf(allowed_to_fail, Set);

    let updateModules = false;  // if any kept subs added or removed
    const changes = {};         // changes and additions
    let subCommits = {};        // included submodule commits
    const stitchSub = co.wrap(function *(name, oldName, sha) {
        let subCommit;
        try {
            subCommit = yield repo.getCommit(sha);
        }
        catch (e) {
            const metaSha = commit.id().tostrS();
            if (allowed_to_fail.has(metaSha)) {
                return;                                               // RETURN
            }
            throw new UserError(`\
On meta-commit ${metaSha}, ${name} is missing ${sha}.
To add to allow this submodule change to be skipped, run:
git notes --ref ${exports.allowedToFailNoteRef} add -m skip ${metaSha}`);
        }
        const subTreeId = subCommit.treeId();
        changes[name] = new TreeUtil.Change(subTreeId, FILEMODE.TREE);

        // Now, record this submodule change as introduced by this commit,
        // unless it already existed in another of its parents, i.e., it was
        // merged in.

        const alreadyExisted =
                yield exports.sameInAnyOtherParent(repo, commit, oldName, sha);
        if (!alreadyExisted) {
            subCommits[name] = subCommit;
        }
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
            yield stitchSub(mapped, name, newSha);
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
        // If we've got changes or are not skipping commits, we make one.

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
        // If we skip this commit, map to its parent to indicate that whenever
        // we see this commit in the future, substitute its parent.

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
exports.fetchSubCommits = co.wrap(function *(repo, name, url, subFetches) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(url);
    assert.isArray(subFetches);

    for (const fetch of subFetches) {
        const subUrl = SubmoduleConfigUtil.resolveSubmoduleUrl(url, fetch.url);

        const sha = fetch.sha;
        let fetched;
        try {
            fetched = yield GitUtil.fetchSha(repo, subUrl, sha, name + "/");
        }
        catch (e) {
            console.log("Fetch of", subUrl, "failed:", e.message);
            return;                                               // RETURN
        }

        // Make a ref to protect fetched submodule commits from GC.

        if (fetched) {
            console.log("Fetched:", sha, "from", subUrl);
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
 * Return the SHA in the specified `content` or null if it represents no sha.
 *
 * @param {String} content
 * @retiurm {String|null}
 */
exports.readConvertedContent = function (content) {
    assert.isString(content);
    return content === "" ? null : content;
};

/**
 * Return the converted commit for the specified `sha` in the specified `repo`,
 * null if it could not be converted, or undefined if it has not been
 * attempted.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             sha
 * @return {String|null|undefined}
 */
exports.readConvertedCommit = co.wrap(function *(repo, sha) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(sha);
    const result = yield GitUtil.readNote(repo, exports.convertedNoteRef, sha);
    return result === null ? 
        undefined :
        exports.readConvertedContent(result.message());
});

/**
 * Return the previously converted commits in the specified `repo`.
 *
 * @param {Repo}
 * @return {Object} map from string to string or null
 */
exports.readConvertedCommits = co.wrap(function *(repo) {

    // We use "" to indicate that a commit could not be converted.

    const result =
                 yield BulkNotesUtil.readNotes(repo, exports.convertedNoteRef);
    for (const [key, oldSha] of Object.entries(result)) {
        const sha = exports.readConvertedContent(oldSha);
        try {
            yield repo.getCommit(sha);
            result[key] = sha;
        } catch (e) {
            // We have the note but not the commit, delete from cache
            delete result[key];
        }
    }
    return result;
});

/**
 * Return a function that can return the result of previous attempts to convert
 * the specified `commit` in the specified `repo`.  If there is a value in
 * `cache`, return it, otherwise try to read the note and then cache that
 * result.
 *
 * @param {NodeGit.Repository} repo
 * @param {Object}             cache
 * @return {(String) => Promise}
 */
exports.makeGetConvertedCommit = function (repo, cache) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isObject(cache);
    return co.wrap(function *(sha) {
        assert.isString(sha);

        if (sha in cache) {
            return cache[sha];
        }
        const result = yield exports.readConvertedCommit(repo, sha);

        try {
            yield repo.getCommit(result);
        } catch (e) {
            // We have the note but not the commit; treat as missing
            return undefined;
        }

        cache[sha] = result;
        return result;
    });
};

/**
 * List, in order of least to most dependent, the specified `commit` and its
 * ancestors in the specified `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 * @param {(String) => Promise(String|null|undefined)}
 * @return {[NodeGit.Commit]}
 */
exports.listCommitsToStitch = co.wrap(function *(repo,
                                                 commit,
                                                 getConvertedCommit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    assert.isFunction(getConvertedCommit);

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

        const converted = yield getConvertedCommit(nextSha);
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

    let convertedCommits = {};
    if (options.preloadCache) {
        convertedCommits = yield exports.readConvertedCommits(repo);
    }
    const getConverted = exports.makeGetConvertedCommit(repo,
                                                        convertedCommits);

    console.log("listing unconverted ancestors of", commit.id().tostrS());

    const commitsToStitch =
                 yield exports.listCommitsToStitch(repo, commit, getConverted);

    console.log("listing submodule changes");

    const changes = yield exports.listSubmoduleChanges(repo, commitsToStitch);

    const adjustPath = exports.makeAdjustPathFunction(joinRoot);

    console.log(commitsToStitch.length, "to stitch");

    if (fetch) {
        console.log("listing fetches");
        const fetches = yield exports.listFetches(repo,
                                                  commitsToStitch,
                                                  changes,
                                                  options.keepAsSubmodule,
                                                  adjustPath);
        console.log("Found", Object.keys(fetches).length, "subs to fetch.");
        const subNames = Object.keys(fetches);
        let subsRepo = repo;
        const config = yield repo.config();
        /*
         * The stitch submodules repository is a separate repository
         * to hold just the submodules that are being stitched (no
         * meta repository commits).  It must be an alternate
         * of this repository (the repository that stitching is
         * being done in), so that we can access the objects
         * that we fetch to it.  This lets us have a second alternate
         * repository for just the meta repository commits.  And that
         * saves a few seconds on meta repository fetches.
         */
        const subsRepoPath = yield ConfigUtil.getConfigString(
            config,
            "gitmeta.stitchSubmodulesRepository");
        if (subsRepoPath !== null) {
            subsRepo = yield NodeGit.Repository.open(subsRepoPath);
        }
        const doFetch = co.wrap(function *(name, i) {
            const subFetches = fetches[name];
            const fetchTimeMessage = `\
(${i + 1}/${subNames.length}) -- fetched ${subFetches.length} SHAs for \
${name}`;
            console.time(fetchTimeMessage);
            yield exports.fetchSubCommits(subsRepo, name, url, subFetches);
            console.timeEnd(fetchTimeMessage);
        });
        yield DoWorkQueue.doInParallel(subNames,
                                       doFetch,
                                       {limit: options.numParallel});
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
                referenceNotes[stitchedSha] =
                      exports.makeReferenceNoteContent(sha, record.subCommits);
            }
        }
        yield BulkNotesUtil.writeNotes(repo,
                                       exports.referenceNoteRef,
                                       referenceNotes);
        yield BulkNotesUtil.writeNotes(repo,
                                       exports.convertedNoteRef,
                                       convertedNotes);
        records = {};
    });

    const allowed_to_fail = yield exports.readAllowedToFailList(repo);

    for (let i = 0; i < commitsToStitch.length; ++i) {
        const next = commitsToStitch[i];

        const nextSha = next.id().tostrS();
        const parents = yield next.getParents();
        const newParents = [];
        for (const parent of parents) {
            const newParentSha = yield getConverted(parent.id().tostrS());
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
                                                       skipEmpty,
                                                       allowed_to_fail);
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

    // Delete submodule change cache if we succeeded; we won't need these
    // submodules again.

    if (0 !== Object.keys(changes)) {
        NodeGit.Reference.remove(repo, exports.changeCacheRef);
    }

    if (null !== lastCommit) {
        console.log(
               `Updating ${targetBranchName} to ${lastCommit.id().tostrS()}.`);
        yield NodeGit.Branch.create(repo, targetBranchName, lastCommit, 1);
    }
});

