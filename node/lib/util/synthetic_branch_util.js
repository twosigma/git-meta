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

const ConfigUtil = require("./config_util");
const NodeGit = require("nodegit");
const GitUtil = require("./git_util");
const SubmoduleUtil = require("./submodule_util");
const split = require("split");
const co = require("co");
const path = require("path");
const assert = require("chai").assert;

const NOTES_REF = "refs/notes/git-meta/subrepo-check";
const SYNTHETIC_BRANCH_BASE = "refs/commits/";
exports.SYNTHETIC_BRANCH_BASE = SYNTHETIC_BRANCH_BASE;

/**
 * The identity function
 */
function identity(v) {
    return v;
}

function SyntheticBranchConfig(urlSkipPattern, pathSkipPattern) {
    if (urlSkipPattern.length > 0) {
        const urlSkipRE = new RegExp(urlSkipPattern);
        this.urlSkipTest = function(url) {
            return urlSkipRE.test(url);
        };
    } else {
        this.urlSkipTest = function() { return false; };
    }

    if (pathSkipPattern.length > 0) {
        const pathSkipRE = new RegExp(pathSkipPattern);
        this.pathSkipTest = function(path) {
            return pathSkipRE.test(path);
        };
    } else {
        this.pathSkipTest = function() { return false; };
    }
}

    /**
     * (This has to be public so we can mock it for testing)
     * @param {NodeGit.Commit} commit
     */
exports.getSyntheticBranchForCommit = function(commit) {
    return SYNTHETIC_BRANCH_BASE + commit;
};

    /**
      * Public for testing.  Gets the local path corresponding to
      * a submodule's URL.
      * @param {NodeGit.Repository} repo
      * @param {String} url
      */
exports.urlToLocalPath = function *(repo, url) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(url);

    const config = yield repo.config();
    const subrepoUrlBase =
    (yield ConfigUtil.getConfigString(config, "gitmeta.subrepourlbase")) || "";
    const subrepoRootPath =
        yield config.getStringBuf("gitmeta.subreporootpath");
    let subrepoSuffix =
     (yield ConfigUtil.getConfigString(config, "gitmeta.subreposuffix")) || "";
    if (!url.startsWith(subrepoUrlBase)) {
        throw "Your git configuration gitmeta.subrepoUrlBase, '" +
            subrepoUrlBase + "', must be a prefix of all submodule " +
            "urls.  Submodule url '" + url + "' fails.";
    }
    const remotePath = url.slice(subrepoUrlBase.length);
    if (remotePath.endsWith(subrepoSuffix)) {
        subrepoSuffix = "";
    }
    const localPath = path.join(subrepoRootPath, remotePath + subrepoSuffix);
    if (localPath[0] === "/") {
        return localPath;
    } else {
        return path.normalize(path.join(repo.path(), localPath));
    }
};

/**
 * Check that a given path is on the path synthetic-ref-check skiplist, if
 * such a skiplist exists.
 * @async
 * @param {SyntheticBranchConfig} cfg The configuration for
 * synthetic_branch_util
 * @param {String}                url The path of the submodule
 * in the meta tree.
 */
function skipCheckForPath(cfg, path) {
    assert.instanceOf(cfg, SyntheticBranchConfig);
    assert.isString(path);
    return cfg.pathSkipTest(path);
}

/**
 * Check that a given URL is on the URLs synthetic-ref-check skiplist, if
 * such a skiplist exists.
 * @async
 * @param {SyntheticBranchConfig} cfg The configuration for
 * synthetic_branch_util
 * @param {String}                url The configured URL of the submodule
 * in the meta tree.
 */
function skipCheckForURL(cfg, url) {
    assert.instanceOf(cfg, SyntheticBranchConfig);
    assert.isString(url);
    return cfg.urlSkipTest(url);
}

/**
 * Check that a commit exists exists for a given submodule
 * at a given commit.
 * @async
 * @param {NodeGit.Repostory}     repo The meta repository
 * @param {SyntheticBranchConfig} cfg The configuration for
 * synthetic_branch_util
 * @param {NodeGit.TreeEntry}     submoduleEntry the submodule's tree entry
 * @param {String}                url the configured URL of the submodule
 * in the meta tree.
 */
function* checkSubmodule(repo, cfg, metaCommit, submoduleEntry, url, path) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(cfg, SyntheticBranchConfig);
    assert.instanceOf(submoduleEntry, NodeGit.TreeEntry);

    if (skipCheckForURL(cfg,  url)) {
        return true;
    }

    if (skipCheckForPath(cfg, path)) {
        return true;
    }

    const localPath = yield *exports.urlToLocalPath(repo, url);
    const submoduleRepo = yield NodeGit.Repository.open(localPath);
    const submoduleCommitId = submoduleEntry.id();
    try {
        const subrepoCommit =
              yield NodeGit.Object.lookup(submoduleRepo, submoduleCommitId,
                                          NodeGit.Object.TYPE.COMMIT);
        return subrepoCommit !== null;
    } catch (e) {
        console.error("Could not look up ", submoduleCommitId, " in ",
                      localPath, ": ", e);
        return false;
    }
}

/**
 * Return a list of submodules changed or added in between `commit`
 * and `parent`.  Exclude deleted submodules.
 *
 * If parent is null, return null.
 */
function* computeChangedSubmodules(repo, commit, parent) {
    if (parent === null) {
        return null;
    }
    const changed = [];
    const changes = yield SubmoduleUtil.getSubmoduleChanges(repo, commit,
                                                            parent, true);
    for (const sub of Object.keys(changes)) {
        const change = changes[sub];
        if (!change.deleted) {
            changed.push(sub);
        }
    }
    return changed;
}

function* checkSubmodules(repo, commit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);

    const config = yield repo.config();
    const urlSkipPattern = (
        yield ConfigUtil.getConfigString(
            config, "gitmeta.skipsyntheticrefpattern")) || "";
    const pathSkipPattern = (
        yield ConfigUtil.getConfigString(
            config, "gitmeta.skipsyntheticrefpathpattern")) || "";

    const cfg = new SyntheticBranchConfig(urlSkipPattern,
                                          pathSkipPattern);

    const parent = yield GitUtil.getParentCommit(repo, commit);
    const names = yield computeChangedSubmodules(repo,
                                                 commit,
                                                 parent);

    const submodules = yield SubmoduleUtil.getSubmodulesForCommit(repo,
                                                                  commit,
                                                                  names);
    const getChanges = SubmoduleUtil.getSubmoduleChanges;
    const changes = yield getChanges(repo, commit, null, true);
    const allChanges = [
        Object.keys(changes).filter(changeName => {
            const change = changes[changeName];
            return null === change.oldSha;
        }),
        Object.keys(changes).filter(changeName => {
            const change = changes[changeName];
            return null !== change.oldSha && null !== change.newSha;
        }),
    ];
    const result = allChanges.map(function *(changeSet) {
        const result = changeSet.map(function *(path) {
            const entry = yield commit.getEntry(path);
            const submodulePath = entry.path();
            const submodule = submodules[submodulePath];
            if (!submodule) {
                console.error(
                    "A submodule exists in the tree but not the .gitmodules.");
                console.error(
                    `The commit ${commit.id().tostrS()} is corrupt`);
                return false;
            }
            const url = submodule.url;
            return yield *checkSubmodule(repo, cfg, commit, entry, url,
                                         submodulePath);
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
 * On success, create a note reflecting the work done to save time
 * on future updates.

 * @async
 * @param {NodeGit.Repostory} repo The meta repository
 * @param {NodeGit.Repostory} notesRepo The repo to store notes for already
                              checked shas
 * @param {NodeGit.Commit} commit The meta branch's commit to check
 * @param {String} oldSha the previous (known-good) value of this ref
 * @param {Object} handled the commit ids that have been already
 * processed (and the result of processing them).
 */
function* parentLoop(repo, notesRepo, commit, oldSha, handled) {
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

    const ok = yield GitUtil.readNote(notesRepo, NOTES_REF, commit.id());
    if (ok !== null && (ok.message() === "ok" || ok.message() === "ok\n")) {
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
    let success = true;
    for (const parent of parents) {
        if (!(yield *parentLoop(repo, notesRepo, parent, oldSha, handled))) {
            success = false;
            break;
        }
    }
    if (success) {
        yield NodeGit.Note.create(notesRepo, NOTES_REF, commit.committer(),
                                  commit.committer(), commit.id(),
                                  "ok", 1);
    }
    handled[commit.id()] = success;
    return success;
}

/**
 * Main entry point.  Check that a proposed ref update from oldSha
 * to newSha has synthetic branches for all submodule updates.
 *
 * @async
 * @param {NodeGit.Repostory} repo The meta repository
 * @param {String} oldSha the previous (known-good) value of this ref
 * @param {String} newSha the new value of this ref
 */

function* checkUpdate(repo, notesRepo, oldSha, newSha, handled) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(notesRepo, NodeGit.Repository);
    assert.isString(oldSha);
    assert.isString(newSha);
    assert.isObject(handled);

    // deleting is OK
    if (newSha === "0000000000000000000000000000000000000000") {
        return true;
    }

    const newAnnotated = yield GitUtil.resolveCommitish(repo, newSha);

    if (newAnnotated === null) {
        // No such commit exists, error
        return false;
    }

    const newCommit = yield repo.getCommit(newAnnotated.id());
    return yield parentLoop(repo, notesRepo, newCommit, oldSha,
                            handled);
}

/**
 * Check that push to a metarepository has synthetic branches for all
 * changed or added submodules.
 *
 * @async
 * @param {NodeGit.Repostory} repo The meta repository
 * @param {NodeGit.Repostory} notesRepo The repo to store notes for already
                              checked shas
 * @param [{Object}] updates. Each object has fields oldSha, newSha, and ref,
*  @return true if the update should be rejected.
 * all strings.
 */
function* metaUpdateIsBad(repo, notesRepo, updates) {
    const handled = {};
    const checkFailures = updates.map(function*(update) {
        if (!update.ref.startsWith("refs/heads/")) {
            return false;
        }
        const ok = yield checkUpdate(repo, notesRepo, update.oldSha,
                                     update.newSha, handled);
        if (!ok) {
            console.error(
                "Update to ref '" +
                    update.ref +
                    "' failed synthetic branch check. " +
                    "Did you forget to use `git meta push`?");
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
 * @param {NodeGit.Repostory} repo ignored
 * @param [{Object}] updates. Each object has fields oldSha, newSha, and ref,
 * all strings.
 * @return true if the submodule update should be rejected
 */
function* submoduleIsBad(repo, notesRepo, updates) {
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

function* getNotesRepoPath(config) {
    const configVar = "gitmeta.syntheticrefnotesrepopath";
    return (yield ConfigUtil.getConfigString(config, configVar)) || ".";
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

            // To avoid processing the same metadata commits over and over
            // again when the hook is used in multiple forks of the same
            // repo, we want to store notes in the "base fork", wich
            // is determined by a config setting.  If no such setting exists,
            // we fall back to using the current repo.
            const config = yield repo.config();
            const notesRepoPath = yield getNotesRepoPath(config);

            const notesRepo = yield NodeGit.Repository.open(notesRepoPath);

            yield initAltOdb(repo);
            return yield check(repo, notesRepo, updates);
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
