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
 * This module contains the pre-recieve hook for a git-meta server.  Only
 the meta-repo should use this hook.
 */

const NodeGit = require("nodegit");
const GitUtil = require("./git_util");
const SubmoduleUtil = require("./submodule_util");
const split = require("split");
const co = require("co");
const path = require("path");
const assert = require("chai").assert;

const NOTES_REF = "refs/notes/git-meta/subrepo-check";
const SYNTHETIC_BRANCH_BASE = "refs/commits/";

/**
 * The identity function
 */
function identity(v) {
    return v;
}

    /**
     * (This has to be public so we can mock it for testing)
     * @param {NodeGit.Commit} commit
     */
exports.getSyntheticBranchForCommit = function(commit) {
    return SYNTHETIC_BRANCH_BASE + commit;
};

function *urlToLocalPath(repo, url) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(url);

    const config = yield repo.config();
    let subrepoUrlBase = "";
    try {
        subrepoUrlBase =
              yield config.getStringBuf("gitmeta.subrepourlbase");
    } catch (e) {
        //It's OK for this to be missing, but nodegit lacks an
        //API that expresses this.

    }
    const subrepoRootPath =
        yield config.getStringBuf("gitmeta.subreporootpath");
    let subrepoSuffix = "";
    try {
        subrepoSuffix = yield config.getStringBuf("gitmeta.subreposuffix");
    } catch (e) {
        //It's OK for this to be missing, but nodegit lacks an
        //API that expresses this.
    }
    if (!url.startsWith(subrepoUrlBase)) {
        throw "Your git configuration gitmeta.subrepoUrlBase, '" +
            subrepoUrlBase + "', must be a prefix of all submodule " +
            "urls.  Submodule url '" + url + "' fails.";
    }
    const remotePath = url.slice(subrepoUrlBase.length);
    const localPath = path.join(subrepoRootPath, remotePath + subrepoSuffix);
    if (localPath[0] === "/") {
        return localPath;
    } else {
        return path.normalize(path.join(repo.path(), localPath));
    }
}

/**
 * Check that a synthetic branch exists for a given submodule
 * at a given commit.
 * @async
 * @param {NodeGit.Repostory} repo The meta repository
 * @param {NodeGit.TreeEntry} submoduleEntry the submodule's tree entry
 * @param {String}            url the configured URL of the submodule
 * in the meta tree.
 */
function* checkSubmodule(repo, metaCommit, submoduleEntry, url) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(submoduleEntry, NodeGit.TreeEntry);

    const localPath = yield *urlToLocalPath(repo, url);
    const submoduleRepo = yield NodeGit.Repository.open(localPath);
    const submoduleCommitId = submoduleEntry.id();
    const branch = exports.getSyntheticBranchForCommit(submoduleCommitId);
    try {
        const subrepoCommit =
            yield submoduleRepo.getReferenceCommit(branch);
        return subrepoCommit.id().equal(submoduleEntry.id());
    } catch (e) {
        console.error("Could not look up ", branch, " in ", localPath,
                      ": ", e);
        return false;
    }
}

function* checkSubmodules(repo, commit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);

    const submodules = yield SubmoduleUtil.getSubmodulesForCommit(repo,
                                                                  commit);
    const getChanges = SubmoduleUtil.getSubmoduleChanges;
    const changes = yield getChanges(repo, commit);
    const allChanges = [
        Object.keys(changes.added),
        Object.keys(changes.changed)
    ];
    const result = allChanges.map(function *(changeSet) {
        const result = changeSet.map(function *(path) {
            const entry = yield commit.getEntry(path);
            const submodulePath = entry.path();
            const url = submodules[submodulePath].url;
            return yield *checkSubmodule(repo, commit, entry, url);
        });
        return (yield result).every(identity);
    });
    return (yield result).every(identity);
}

/**
 * Recurse over the parents of a commit, checking each for git-meta's
 * invariants. Returns when all (transitive) parents have already been
 * marked as checked, or a failure is found.
 *
 * Returns true if the check passes on all branches; false if any
 * fail.
 *
 * @async
 * @param {NodeGit.Repostory} repo The meta repository
 * @param {NodeGit.Commit} commit The meta branch's commit to check
 * @param {String} oldSha the previous (known-good) value of this ref
 * @param {Object} handled the commit ids that have been already
 * processed (and the result of processing them).
 */
function* parentLoop(repo, commit, oldSha, handled) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    assert.isString(oldSha);
    assert.isObject(handled);

    if (commit.id() in handled)  {
        return handled[commit.id()];
    }

    if (oldSha === commit.id().toString()) {
        handled[commit.id()] = true;
        return true;
    }

    const ok = yield GitUtil.readNote(repo, NOTES_REF, commit.id());
    if (ok !== null && ok.message() === "ok") {
        handled[commit.id()] = true;
        return true;
    }

    const check = yield *checkSubmodules(repo, commit);
    if (!check) {
        handled[commit.id()] = false;
        return false;
    }

    if (commit.parentcount() === 0) {
        handled[commit.id()] = true;
        return true;
    }

    const parents = yield commit.getParents(commit.parentcount());
    const parentChecks = yield parents.map(function *(parent) {
        return yield *parentLoop(repo, parent, oldSha, handled);
    });
    const result = parentChecks.every(identity);
    handled[commit.id()] = result;
    return result;
}

/**
 * Main entry point.  Check that a proposed ref update from oldSha
 * to newSha has synthetic branches for all submodule updates.
 *
 * On success, create a note reflecting the work done to save time
 * on future updates.
 *
 * @async
 * @param {NodeGit.Repostory} repo The meta repository
 * @param {String} oldSha the previous (known-good) value of this ref
 * @param {String} newSha the new value of this ref
 */

function* checkUpdate(repo, oldSha, newSha, handled) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(oldSha);
    assert.isString(newSha);
    assert.isObject(handled);

    const newAnnotated = yield GitUtil.resolveCommitish(repo, newSha);

    if (newAnnotated === null) {
        // No such commit exists, error
        return false;
    }

    const newCommit = yield repo.getCommit(newAnnotated.id());
    const success = yield parentLoop(repo, newCommit, oldSha,
                                     handled);
    if (success) {
        yield NodeGit.Note.create(repo, NOTES_REF, newCommit.committer(),
                                  newCommit.committer(), newAnnotated.id(),
                                  "ok", 1);
    }
    return success;
}

/**
 * Check that push to a metarepository has synthetic branches for all
 * changed or added submodules.
 *
 * @async
 * @param {NodeGit.Repostory} repo The meta repository
 * @param [{Object}] updates. Each object has fields oldSha, newSha, and ref,
*  @return true if the update should be rejected.
 * all strings.
 */
function* metaUpdateIsBad(repo, updates) {
    const handled = {};
    const checkFailures = updates.map(function*(update) {
        if (!update.ref.startsWith("refs/heads/")) {
            return false;
        }
        const ok = yield checkUpdate(repo, update.oldSha, update.newSha,
                                     handled);
        if (!ok) {
            console.error(
                "Ref update failed synthetic branch check for " +
                    update.ref);
        }
        return !ok;
    });

    const resolved = yield checkFailures;
    return resolved.some(identity);
}

/**
 * Check that push to a submodule's synthetic branch references the commit
 * whose name matches the branch name.  Ignores all other pushes.
 *
 * @async
 * @param {NodeGit.Repostory} repo The meta repository
 * @param [{Object}] updates. Each object has fields oldSha, newSha, and ref,
 * all strings.
 * @return true if the submodule update should be rejected
 */
function* submoduleIsBad(repo, updates) {
    const checkFailures = updates.map(function*(update) {
        /*jshint noyield:true*/
        if (!update.ref.startsWith(SYNTHETIC_BRANCH_BASE)) {
            return false;
        }

        const sha = update.ref.substring(SYNTHETIC_BRANCH_BASE.length);
        return sha !== update.newSha;
    });

    const resolved = yield checkFailures;
    return resolved.some(identity);
}

function* initAltOdb(repo) {
    const odb = yield repo.odb();
    (process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES || "").split(":").forEach(
        function(alt) {
            if (alt !== "") {
                odb.addDiskAlternate(alt);
            }
        }
    );
    const objectDirectory = process.env.GIT_OBJECT_DIRECTORY;
    if (objectDirectory) {
        odb.addDiskAlternate(objectDirectory);
    }
}

/**
 * A git pre-receive hook, which reads from stdin and checks
 * each updated ref.
 */
function doPreReceive(check) {
    process.stdin.setEncoding("binary");

    const updates = [];
    process.stdin.pipe(split()).on("data", function(line) {
        if (line === "") {
            return;
        }
        const parts = line.split(" ");
        if (parts.length !== 3) {
            process.exit(1);
        }
        updates.push({
            "oldSha" : parts[0],
            "newSha" : parts[1],
            "ref" : parts[2]
        });
    }).on("end", function() {
        co(function *() {
            const repo = yield NodeGit.Repository.open(".");
            yield initAltOdb(repo);
            return yield check(repo, updates);
        }).then(function(res) {
            process.exit(+res);
        }, function(e) {
            console.error(e);
            process.exit(2);
        });
    });
}

exports.metaPreReceive = doPreReceive.bind(null, metaUpdateIsBad);
exports.submodulePreReceive = doPreReceive.bind(null, submoduleIsBad);

exports.checkUpdate = co.wrap(checkUpdate);
exports.submoduleIsBad = co.wrap(submoduleIsBad);
exports.metaUpdateIsBad = co.wrap(metaUpdateIsBad);
exports.initAltOdb = co.wrap(initAltOdb);
