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
 * This module contains methods for committing.
 */

const assert  = require("chai").assert;
const co      = require("co");
const colors  = require("colors");
const NodeGit = require("nodegit");
const path    = require("path");

const DiffUtil            = require("./diff_util");
const GitUtil             = require("./git_util");
const Open                = require("./open");
const RepoStatus          = require("./repo_status");
const PrintStatusUtil     = require("./print_status_util");
const StatusUtil          = require("./status_util");
const SubmoduleFetcher    = require("./submodule_fetcher");
const SubmoduleConfigUtil = require("./submodule_config_util");
const SubmoduleUtil       = require("./submodule_util");
const TreeUtil            = require("./tree_util");
const UserError           = require("./user_error");

/**
 * Stage the specified `filename` having the specified `change` in the
 * specified `index`.
 *
 * @param {NodeGit.Index}       index
 * @param {String}              path
 * @param {RepoStatus.FILEMODE} change
 */
exports.stageChange = co.wrap(function *(index, path, change) {
    assert.instanceOf(index, NodeGit.Index);
    assert.isString(path);
    assert.isNumber(change);

    if (RepoStatus.FILESTATUS.REMOVED !== change) {
        yield index.addByPath(path);
    }
    else {
        try {
            yield index.remove(path, -1);
        }
        catch (e) {
            // NOOP: this case will be hit if the removal of `path` has
            // already been staged; we don't have any way that I can see to
            // check for this other than just trying to remove it.
        }
    }
});

/**
 * Commit changes in the specified `repo`.  If the specified `doAll` is true,
 * stage files indicated that they are to be committed in the `staged` section.
 * Use the specified `message` as the commit message.  If there are no files to
 * commit and `false === force`, do nothing and return null; otherwise, return
 * the created commit object.  Ignore submodules.  Use the specified
 * `signature` to identify the commit creator.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {RepoStatus}         repoStatus
 * @param {Boolean}            doAll
 * @param {String}             message
 * @param {Boolean}            force
 * @param {NodeGit.Signature}  signature
 * @return {NodeGit.Oid|null}
 */
const commitRepo = co.wrap(function *(repo,
                                      changes,
                                      doAll,
                                      message,
                                      force,
                                      signature) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isObject(changes);
    assert.isBoolean(doAll);
    assert.isString(message);
    assert.isBoolean(force);
    assert.instanceOf(signature, NodeGit.Signature);

    const doCommit = 0 !== Object.keys(changes).length || force;

    // If we're auto-staging files, loop through workdir and stage them.

    if (doAll) {
        const index = yield repo.index();
        for (let path in changes) {
            yield exports.stageChange(index, path, changes[path]);
        }
        yield index.write();
    }
    if (doCommit) {
        return yield repo.createCommitOnHead([],
                                             signature,
                                             signature,
                                             message);
    }
    return null;
});

const editorMessagePrefix = `\
Please enter the commit message for your changes. Lines starting
with '#' will be ignored, and an empty message aborts the commit.
`;

function branchStatusLine(status) {
    if (null !== status.currentBranchName) {
        return `On branch ${status.currentBranchName}.\n`;
    }
    return `On detached head ${GitUtil.shortSha(status.headCommit)}.\n`;
}

/**
 * Return a string having the same value as the specified `text` except that
 * each empty line is replaced with "#", and each non-empty line is prefixed
 * with "# ".  The result of calling with the empty string is the empty string.
 * The behavior is undefined unless `"" === text || text.endsWith("\n")`.
 *
 * @param {String} text
 * @return {String}
 */
exports.prefixWithPound = function (text) {
    assert.isString(text);
    if ("" === text) {
        return "";                                                    // RETURN
    }
    assert(text.endsWith("\n"));
    const lines = text.split("\n");
    const resultLines = lines.map((line, i) => {

        // The split operation makes an empty line that we don't want to
        // prefix.

        if (i === lines.length - 1) {
            return "";
        }

        // Empty lines don't get "# ", just "#".

        if ("" === line) {
            return "#";                                               // RETURN
        }

        return `# ${line}`;
    });
    return resultLines.join("\n");
};

/**
 * Return text describing the changes in the specified `status`.  Use the
 * specified `cwd` to show relative paths.
 *
 * @param {RepoStatus} status
 * @param {String}     cwd
 */
exports.formatStatus = function (status, cwd) {
    assert.instanceOf(status, RepoStatus);
    assert.isString(cwd);

    let result = "";

    const statuses = PrintStatusUtil.accumulateStatus(status);

    if (0 !== statuses.staged.length) {
        result += `Changes to be committed:\n`;
        result += PrintStatusUtil.printStatusDescriptors(statuses.staged,
                                                         x => x,
                                                         cwd);
    }

    if (0 !== statuses.workdir.length) {
        result += "\n";
        result += `Changes not staged for commit:\n`;
        result += PrintStatusUtil.printStatusDescriptors(statuses.workdir,
                                                         x => x,
                                                         cwd);
    }
    if (0 !== statuses.untracked.length) {
        result += "\n";
        result += "Untracked files:\n";
        result += PrintStatusUtil.printUntrackedFiles(statuses.untracked,
                                                      x => x,
                                                      cwd);
    }
    return result;
};

/**
 * Return a string describing the specified `status` that is appropriate as a
 * description in the editor prompting for a commit message; adjust paths to be
 * relative to the specified `cwd`.
 *
 * @param {RepoStatus} status
 * @param {String}     cwd
 * @return {String}
 */
exports.formatEditorPrompt  = function (status, cwd) {
    assert.instanceOf(status, RepoStatus);
    assert.isString(cwd);

    let result = editorMessagePrefix + branchStatusLine(status);

    result += exports.formatStatus(status, cwd);

    const prefixed = exports.prefixWithPound(result);
    return "\n" + prefixed + "#\n";
};

/**
 * Stage all of the specified `submodules` that are open in the specified
 * `index`.  We need to do this whenever generating a meta-repo commit because
 * otherwise, we could commit a staged commit in a submodule that would have
 * been reverted in its open repo.
 * 
 * @param {NodeGit.Index} index
 * @param {Object}        submodules name -> RepoStatus.Submodule
 */
const stageOpenSubmodules = co.wrap(function *(index, submodules) {
    yield Object.keys(submodules).map(co.wrap(function *(name) {
        const sub = submodules[name];
        if (null !== sub.workdir) {
            yield index.addByPath(name);
        }
    }));
    yield index.write();
});

/**
 * Return true if a commit should be generated for the repo having the
 * specified `status`.  Ignore the possibility of generating a meta-repo commit
 * if the specified `skipMeta` is true.  If the specified `subMessages` is
 * provided, ignore staged changes in submodules unless they have entries in
 * `subMessages`.
 *
 * @param {RepoStatus} status
 * @param {Boolean}    skipMeta
 * @param {Object}     [subMessages]
 * @return {Boolean}
 */
exports.shouldCommit = function (status, skipMeta, subMessages) {
    assert.instanceOf(status, RepoStatus);
    assert.isBoolean(skipMeta);
    if (undefined !== subMessages) {
        assert.isObject(subMessages);
    }

    // If the meta-repo has staged commits, we must commit.

    if (!skipMeta && !status.isIndexClean()) {
        return true;                                                  // RETURN
    }

    const subs = status.submodules;
    const SAME = RepoStatus.Submodule.COMMIT_RELATION.SAME;

    // Look through the submodules looking for one that would require a new
    // commit in the meta-repo.

    for (let name in subs) {
        const sub = subs[name];
        const commit = sub.commit;
        const index = sub.index;
        const workdir = sub.workdir;
        if (null !== workdir) {
            if (!skipMeta && SAME !== workdir.relation) {
                // changed commit in workdir

                return true;                                          // RETURN
            }
            if ((undefined === subMessages || (name in subMessages)) &&
                     !workdir.status.isIndexClean()) {
                // If this sub-repo is to be committed, and it has a dirty
                // index, then we must commit.

                return true;                                          // RETURN
            }
        }

        if (!skipMeta &&
            (null === index ||                // deleted
             null === commit ||               // added
             SAME !== index.relation ||       // changed commit
             commit.url !== index.url)) {     // changed URL
            // changed commit in index

            return true;                                              // RETURN
        }
    }

    return false;
};

/**
 * Create a commit across modified repositories and the specified `metaRepo`
 * with the specified `message`; if `null === message`, do not create a commit
 * for the meta-repo.  If the specified `all` is provided, automatically stage
 * files listed to be committed as `staged` (note that some of these may
 * already be staged).  If the optionally specified `subMessages` is provided,
 * use the messages it contains for the commit messages of the respective
 * submodules in it, and create no commits for submodules with no entries in
 * `subMessages`.  Return an object that lists the sha of the created meta-repo
 * commit and the shas of any commits generated in submodules. The behavior is
 * undefined if there are entries in `.gitmodules` for submodules having no
 * commits, or if `null === message && undefined === subMessages`.  The
 * behavior is undefined unless there is somthing to commit.
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {Boolean}            all
 * @param {RepoStatus}         metaStatus
 * @param {String|null}        message
 * @param {Object}             [subMessages] map from submodule to message
 * @return {Object}
 * @return {String|null} return.metaCommit
 * @return {Object} return.submoduleCommits map submodule name to new commit
 */
exports.commit = co.wrap(function *(metaRepo,
                                    all,
                                    metaStatus,
                                    message,
                                    subMessages) {
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.isBoolean(all);
    assert.instanceOf(metaStatus, RepoStatus);
    assert(exports.shouldCommit(metaStatus, message === null, subMessages),
           "nothing to commit");
    if (null !== message) {
        assert.isString(message);
    }
    if (undefined !== subMessages) {
        assert.isObject(subMessages);
    }
    assert(null !== message || undefined !== subMessages,
           "if no meta message, sub messages must be specified");

    const signature = metaRepo.defaultSignature();
    const submodules = metaStatus.submodules;

    // Commit submodules.  If any changes, remember this so we know to generate
    // a commit in the meta-repo whether or not the meta-repo has its own
    // workdir changes.

    const subCommits = {};
    const commitSubmodule = co.wrap(function *(name) {
        let subMessage = message;

        // If we're explicitly providing submodule messages, look the commit
        // message up for this submodule and return early if there isn't one.

        if (undefined !== subMessages) {
            subMessage = subMessages[name];
            if (undefined === subMessage) {
                return;                                               // RETURN
            }
        }
        const status = submodules[name];
        const repoStatus = (status.workdir && status.workdir.status) || null;
        if (null !== repoStatus &&
            0 !== Object.keys(repoStatus.staged).length) {
            const subRepo = yield SubmoduleUtil.getRepo(metaRepo, name);
            const commit = yield commitRepo(subRepo,
                                            repoStatus.staged,
                                            all,
                                            subMessage,
                                            false,
                                            signature);
            subCommits[name] = commit.tostrS();
        }
    });

    const subCommitters = Object.keys(submodules).map(commitSubmodule);
    yield subCommitters;

    const result = {
        metaCommit: null,
        submoduleCommits: subCommits,
    };

    if (null === message) {
        return result;                                                // RETURN
    }

    const index = yield metaRepo.index();
    yield stageOpenSubmodules(index, submodules);

    result.metaCommit = yield commitRepo(metaRepo,
                                         metaStatus.staged,
                                         all,
                                         message,
                                         true,
                                         signature);

    return result;
});

/**
 * Write a commit for the specified `repo` having the specified
 * `status` using the specified commit `message` and return the ID of the new
 * commit.  Note that this method records staged commits for submodules but
 * does not recurse into their repositories.  Note also that changes that would
 * involve altering `.gitmodules` -- additions, removals, and URL changes --
 * are ignored.
 *
 * @param {NodeGit.Repository} repo
 * @param {RepoStatus}         status
 * @param {String}             message
 * @return {String}
 */
exports.writeRepoPaths = co.wrap(function *(repo, status, message) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(status, RepoStatus);
    assert.isString(message);

    const workdir = repo.workdir();
    const headCommit = yield repo.getHeadCommit();
    const changes = {};
    const staged = status.staged;
    const FILEMODE = NodeGit.TreeEntry.FILEMODE;
    const FILESTATUS = RepoStatus.FILESTATUS;
    const Change = TreeUtil.Change;

    // We do a soft reset later, which means that we don't touch the index.
    // Therefore, all of our files must be staged.

    const index = yield repo.index();

    // First, handle "normal" file changes.

    for (let filename in staged) {
        const stat = staged[filename];
        if (FILESTATUS.REMOVED === stat) {
            changes[filename] = null;
        }
        else {
            const filePath = path.join(workdir, filename);

            // 'createFromDisk' is unfinished; instead of returning an id, it
            // takes an ID object and writes into it, unlike the rest of its
            // brethern on `Blob`.  TODO: patch nodegit with corrected API.

            const idPlaceholder = headCommit.id();  // need a place to load ids
            NodeGit.Blob.createFromDisk(idPlaceholder, repo, filePath);
            changes[filename] = new Change(idPlaceholder, FILEMODE.BLOB);

            yield index.addByPath(filename);
        }
    }

    // Then submodules.

    const subs = status.submodules;
    for (let subName in subs) {
        const sub = subs[subName];

        // As noted in the contract, `writePaths` ignores added or removed
        // submodules.

        if (null !== sub.commit &&
            null !== sub.index &&
            sub.commit.sha !== sub.index.sha) {
            const id = NodeGit.Oid.fromString(sub.index.sha);
            changes[subName] = new Change(id, FILEMODE.COMMIT);

            // Stage this submodule if it's open.

            if (null !== sub.workdir) {
                yield index.addByPath(subName);
            }
        }
    }

    yield index.write();

    // Use 'TreeUtil' to create a new tree having the required paths.

    const baseTree = yield headCommit.getTree();
    const tree = yield TreeUtil.writeTree(repo, baseTree, changes);

    // Create a commit with this tree.

    const sig = repo.defaultSignature();
    const parents = [headCommit];
    const commitId = yield NodeGit.Commit.create(repo,
                                                 0,
                                                 sig,
                                                 sig,
                                                 0,
                                                 message,
                                                 tree,
                                                 parents.length,
                                                 parents);

    // Now we need to put the commit on head.  We need to unstage the changes
    // we've just committed, otherwise we see conflicts with the workdir.  We
    // do a SOFT reset because we don't want to affect index changes for paths
    // you didn't touch.

    const commit = yield repo.getCommit(commitId);
    yield NodeGit.Reset.reset(repo, commit, NodeGit.Reset.TYPE.SOFT);
    return commitId.tostrS();
});


/**
 * Commit changes to the files indicated as staged by the specified `status`
 * in the specified `repo`, applying the specified commit `message`.  Return an
 * object listing the commit IDs of the commits that were made in submodules
 * and the meta-repo.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {RepoStatus}         status
 * @param {String}             message
 * @return {Object}
 * @return {String} return.metaCommit
 * @return {Object} return.submoduleCommits  map from sub name to commit id
 */
exports.commitPaths = co.wrap(function *(repo, status, message) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(status, RepoStatus);
    assert.isString(message);

    const subCommits = {};  // map from name to sha

    const committedSubs = {};  // map from name to RepoAST.Submodule

    const subs = status.submodules;
    yield Object.keys(subs).map(co.wrap(function *(subName) {
        const sub = subs[subName];
        const workdir = sub.workdir;

        // Nothing to do for closed submodules.

        if (null === workdir) {
            return;                                                   // RETURN
        }
        const staged = workdir.status.staged;
        const stagedPaths = Object.keys(staged);

        // Nothing to do if no paths listed as stagged.

        if (0 === stagedPaths.length) {
            return;                                                   // RETURN
        }

        const wdStatus = workdir.status;
        const subRepo = yield SubmoduleUtil.getRepo(repo, subName);
        const sha = yield exports.writeRepoPaths(subRepo, wdStatus, message);
        subCommits[subName] = sha;
        const oldIndex = sub.index;
        const Submodule = RepoStatus.Submodule;
        committedSubs[subName] = sub.copy({
            index: new Submodule.Index(sha,
                                       oldIndex.url,
                                       Submodule.COMMIT_RELATION.AHEAD),
            workdir: new Submodule.Workdir(wdStatus.copy({
                headCommit: sha,
            }), Submodule.COMMIT_RELATION.SAME)
        });
    }));

    // We need a `RepoStatus` object containing only the set of the submodules
    // to commit to pass to `writeRepoPaths`.

    const pathStatus = status.copy({
        submodules: committedSubs,
    });

    const id = yield exports.writeRepoPaths(repo, pathStatus, message);
    return {
        metaCommit: id,
        submoduleCommits: subCommits,
    };
});

/**
 * Return true if the specified `x` and `y` commits appear to have been
 * generated by the same `git meta commit` invocation; namely that the
 * committer, email address, and commit message are the same.
 */
exports.sameCommitInstance = function (x, y) {
    assert.instanceOf(x, NodeGit.Commit);
    assert.instanceOf(y, NodeGit.Commit);

    const xCommitter = x.committer();
    const yCommitter = y.committer();

    return xCommitter.name() === yCommitter.name() &&
        xCommitter.email() === yCommitter.email() &&
        x.message() === y.message();
};

/**
 * Return lists of submodules in the specified `repo`, having the specified
 * `status`, that cannot be amended because they have new comits or commits
 * that do not match up with the commit indicated in the specified `oldSubs`.
 * This method may need to open closed submodules to inspect the signature and
 * message of their last commits; it returns a new `RepoStatus` object
 * reflecting the status of submodules that were opened.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {RepoStatus}         status
 * @param {Object}             oldSubs map from name to `Submodule`
 * @return {Object}
 * @return {String[]} return.deleted           submodule is removed
 * @return {Object}   return.newCommits        map from sub name to relation
 * @return {String[]} return.mismatchCommits   commit doesn't match
 * @return {RepoStatus} return.status          adjusted repo status
 */
exports.checkIfRepoIsAmendable = co.wrap(function *(repo, status, oldSubs) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(status, RepoStatus);
    assert.isObject(oldSubs);

    const head = yield repo.getHeadCommit();
    const deleted = [];
    const newCommits = {};
    const mismatchCommits = [];
    const subFetcher = new SubmoduleFetcher(repo, head);
    const currentSubs = status.submodules;
    const submodules = status.submodules;
    const templatePath = yield SubmoduleConfigUtil.getTemplatePath(repo);
    const getSubRepo = co.wrap(function *(name) {
        const subStatus = currentSubs[name];
        if (null === subStatus.workdir) {
            console.log(`Opening ${colors.blue(name)}.`);
            // Update `submodules` to reflect that this one is now open.

            submodules[name] = subStatus.open();
            return yield Open.openOnCommit(subFetcher,
                                           name,
                                           subStatus.index.sha,
                                           templatePath);
        }
        return yield SubmoduleUtil.getRepo(repo, name);
    });

    yield Object.keys(currentSubs).map(co.wrap(function *(subName) {
        const oldSub = oldSubs[subName];

        const newSub = currentSubs[subName];

        // If the sub has been deleted in the index, it's bad.

        if (null === newSub.index) {
            deleted.push(subName);
            return;                                                   // RETURN
        }

        // If the submodule didn't exist before, it's inherently OK.

        if (undefined === oldSub) {
            return;                                                   // RETURN
        }

        // If a submodule has a different commit fail.

        const relation = newSub.index.relation;
        if (RepoStatus.Submodule.COMMIT_RELATION.SAME !== relation) {
            newCommits[subName] = relation;
            return;                                                   // RETURN
        }

        // Otherwise, if it's one of the submodules affecetd by HEAD, validate
        // that the comit signature and message matches.

        if (oldSub.sha !== newSub.commit.sha) {
            const subRepo = yield getSubRepo(subName);
            const subCommit = yield subRepo.getCommit(newSub.commit.sha);
            if (!exports.sameCommitInstance(head, subCommit)) {
                mismatchCommits.push(subName);
            }
        }
    }));
    return {
        deleted: deleted,
        newCommits: newCommits,
        mismatchCommits: mismatchCommits,
        status: status.copy({ submodules: submodules }),
    };
 });

 /**
  * Return the `NodeGit.Tree` object for the (left) parent of the head commit
  * in the specified `repo`, or null if the commit has no parent.
  *
  * @param {NodeGit.Repository} repo
  * @return {NodeGit.Tree|null}
  */
const getHeadParentTree = co.wrap(function *(repo) {
    const head = yield repo.getHeadCommit();
    const parent = yield GitUtil.getParentCommit(repo, head);
    if (null === parent) {
        return null;                                                 // RETURN
    }
    const treeId = parent.treeId();
    return yield NodeGit.Tree.lookup(repo, treeId);
 });

const getAmendStatusForRepo = co.wrap(function *(repo, all) {
    const tree = yield getHeadParentTree(repo);
    const normal = yield DiffUtil.getRepoStatus(repo, tree, [], false, true);

    if (!all) {
        return normal;                                                // RETURN
    }

    // If we're ignoring the index, need calculate the changes in two steps.
    // We've already got the "normal" comparison now we need to get changes
    // directly against the workdir.

    const toWorkdir = yield DiffUtil.getRepoStatus(repo, tree, [], true, true);

    // And use `calculateAllStatus` to create the final value.

    return exports.calculateAllStatus(normal.staged, toWorkdir.workdir);
});


/**
 * Return a list of submodules to be amended and a new `RepoStatus` object
 * reflecting all changes to be part of an amend commit (including the
 * meta-repo if the specified `includeMeta` is true) to the specified `repo`,
 * having the current specified `status`, and the specified `oldSubs` as the
 * state of submodules in HEAD^.  Include  modified files in working
 * directories if the specified `all` is true.  The behavior is undefined
 * unless the repository is *amendable* as described by
 * `checkIfRepoIsAmendable`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {Object}             oldSubs map from name to `Submodule`
 * @param {RepoStatus}         status
 * @param {Boolean}            includeMeta
 * @param {Boolean}            all
 * @return {Object}
 * @return {String[]}   return.subsToAmend
 * @return {RepoStatus} return.status
 */
exports.getAmendChanges = co.wrap(function *(repo,
                                             oldSubs,
                                             status,
                                             includeMeta,
                                             all) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isObject(oldSubs);
    assert.instanceOf(status, RepoStatus);
    assert.isBoolean(includeMeta);
    assert.isBoolean(all);

    // If we're including meta-repo data, load it.

    let metaStaged = {};
    let metaWorkdir = {};
    if (includeMeta) {
        const changes = yield getAmendStatusForRepo(repo, all);
        metaStaged = changes.staged;
        metaWorkdir = changes.workdir;
    }

    // Now, load the submodules.  We need to examine only those whose SHAs
    // *changed* (not added or deleted) between HEAD^ and HEAD -- no other
    // submodules need amend commits.

    const subsToAmend = [];
    const subs = status.submodules;

    yield Object.keys(subs).map(co.wrap(function *(subName) {
        const oldSub = oldSubs[subName];
        const newSub = subs[subName];

        // Bail if:
        // - the sub is new (didn't exist in 'oldSubs')
        // - the sub has been removed
        // - the sub is unchanged
        // Subs in those situations will not need an amend commit.

        if (undefined === oldSub ||
            null === newSub.index ||
            oldSub.sha === newSub.commit.sha) {
            return;                                                   // RETURN
        }

        const subRepo = yield SubmoduleUtil.getRepo(repo, subName);
        const changes = yield getAmendStatusForRepo(subRepo, all);
        subsToAmend.push(subName);

        // Now, we need to update the repo status of the submodule to reflect
        // the actual changes to be made rather than the changes that would be
        // made agains the current HEAD.

        const newRepoStatus = newSub.workdir.status.copy({
            staged: changes.staged,
            workdir: changes.workdir,
        });
        subs[subName] = newSub.copy({
            workdir: new RepoStatus.Submodule.Workdir(
                newRepoStatus,
                RepoStatus.Submodule.COMMIT_RELATION.SAME),
        });
    }));
    return {
        subsToAmend: subsToAmend,
        status: status.copy({
            staged: metaStaged,
            workdir: metaWorkdir,
            submodules: subs,
        }),
    };
});

/**
 * Amend the specified `repo`, using the specified commit `message`, and return
 * the sha of the created commit.
 *
 * @param {NodeGit.Repository} repo
 * @param {String} message
 * @return {String}
 */
exports.amendRepo = co.wrap(function *(repo, message) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(message);

    const head = yield repo.getHeadCommit();
    const index = yield repo.index();
    const treeId = yield index.writeTree();
    const tree = yield NodeGit.Tree.lookup(repo, treeId);
    const id = yield head.amend("HEAD", null, null, null, message, tree);
    return id.tostrS();
});

/**
 * Amend the specified meta `repo` and the shas of the created commits.  Amend
 * the head of `repo` and submodules listed in the specified `subsToAmend`
 * array.  Create new commits for other modified submodules described in the
 * specified `status`.  If the specified `all` is true, stage files marked as
 * `staged` preemptively (some of these files may already be staged).
 * Use the specified `message` for all commits.  The behavior is undefined if
 * the amend should result in the first commit of a submodule being stripped,
 * or any meta-repo commit being stripped (i.e., when there would be no
 * changes).  The behavior is also undefined if any of `subsToAmend` submodules
 * do not have an open repo indicated in `status`.
 *
 * @param {NodeGit.Repository} repo
 * @param {RepoStatus}         status
 * @param {String[]}           subsToAmend
 * @param {Boolean}            all
 * @param {String}             message
 * @return {Object}
 * @return {String} return.meta sha of new commit on meta-repo
 * @return {Object} return.subs map from sub name to sha of created commit
 */
exports.amendMetaRepo = co.wrap(function *(repo,
                                           status,
                                           subsToAmend,
                                           all,
                                           message) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(status, RepoStatus);
    assert.isArray(subsToAmend);
    assert.isBoolean(all);
    assert.isString(message);

    const head = yield repo.getHeadCommit();
    const signature = head.author();

    const stageFiles = co.wrap(function *(repo, staged, index) {
        if (all) {
            yield Object.keys(staged).map(co.wrap(function *(path) {
                yield exports.stageChange(index, path, staged[path]);
            }));
        }
        yield index.write();
    });

    const subCommits = {};
    const subs = status.submodules;
    const amendSubSet = new Set(subsToAmend);

    yield Object.keys(subs).map(co.wrap(function *(subName) {
        const subStatus = subs[subName];

        // If the sub-repo doesn't have an open status, and there are no amend
        // changes, there's nothing to do.

        if (null === subStatus.workdir) {
            return;                                                   // RETURN
        }

        const repoStatus = subStatus.workdir.status;
        const subRepo = yield SubmoduleUtil.getRepo(repo, subName);

        // If the submodule is to be amended, we don't do the normal commit
        // process.

        if (amendSubSet.has(subName)) {
            // First, we check to see if this submodule needs to have its last
            // commit stripped.  That will be the case if we have no files
            // staged indicated as staged.

            assert.isNotNull(repoStatus);
            const staged = repoStatus.staged;
            if (0 === Object.keys(staged).length) {
                const head = yield subRepo.getHeadCommit();
                const parent = yield GitUtil.getParentCommit(subRepo, head);
                const TYPE = NodeGit.Reset.TYPE;
                const type = all ? TYPE.HARD : TYPE.MIXED;
                yield NodeGit.Reset.reset(subRepo, parent, type);
                return;                                               // RETURN

            }
            const subIndex = yield subRepo.index();
            yield stageFiles(subRepo, staged, subIndex);
            subCommits[subName] = yield exports.amendRepo(subRepo, message);
            return;                                                   // RETURN
        }

        const commit = yield commitRepo(subRepo,
                                        repoStatus.staged,
                                        all,
                                        message,
                                        false,
                                        signature);
        if (null !== commit) {
            subCommits[subName] = commit.tostrS();
        }
    }));

    const index = yield repo.index();
    yield stageOpenSubmodules(index, subs);
    yield stageFiles(repo, status.staged, index);

    const metaCommit = yield exports.amendRepo(repo, message);
    return {
        meta: metaCommit,
        subs: subCommits,
    };
});

/**
 * Return the text with which to prompt a user prior to making an amend commit
 * in specified `repo` having the changes indicated by the specified `status`,
 * reflecting that unstaged (tracked) files are to be committed if the
 * specified `all` is true.  Format paths relative to the specified `cwd`.
 * Display the specified `date` value for the date section of the message.
 *
 * @param {Signature}  commitSig
 * @param {Signature}  repoSig
 * @param {RepoStatus} status
 * @param {String}     cwd
 * @param {Booelan}    all
 * @param {String}     date
 * @return {String}
 */
exports.formatAmendEditorPrompt = function (commitSig,
                                            repoSig,
                                            status,
                                            cwd,
                                            date) {
    assert.instanceOf(commitSig, NodeGit.Signature);
    assert.instanceOf(repoSig, NodeGit.Signature);
    assert.instanceOf(status, RepoStatus);
    assert.isString(cwd);
    assert.isString(date);

    let result = editorMessagePrefix;

    result += "\n";

    if (commitSig.name() !== repoSig.name() ||
        commitSig.email() !== repoSig.email()) {
        result += `\
Author:    ${commitSig.name()} <${commitSig.email()}>
`;
    }

    result += `Date:      ${date}\n\n`;
    result += branchStatusLine(status);
    result += exports.formatStatus(status, cwd);
    return "\n" + exports.prefixWithPound(result) + "#\n";
};

/**
 * Calculate and return, from the specified `current` `RepoStatus` object
 * describing the status of the repository, and the specified `requested`
 * `ReposStatus` object describing the state of only the paths the user wants
 * to commit, a new `RepoStatus` object having all changes to be committed
 * indicated as staged and all changes not to be committed (even if actually
 * staged) registered as workdir changes.  Note that the non-path fields of the
 * returned object (such as `currentBranch`) are derived from `current`.
 *
 * @param {RepoStatus} current
 * @param {RepoStatus} requested
 * @return {RepoStatus}
 */
exports.calculatePathCommitStatus = function (current, requested) {
    assert.instanceOf(current, RepoStatus);
    assert.instanceOf(requested, RepoStatus);

    // Anything requested that's staged or not untracked becomes staged.
    // Everything else that's currently staged or in the workdir goes to
    // workdir.

    function calculateOneRepo(currentStaged,
                              currentWorkdir,
                              requestedStaged,
                              requestedWorkdir) {
        const newStaged = {};
        const newWorkdir = {};

        // Initialize `newStaged` with requested files that are already staged.

        Object.assign(newStaged, requestedStaged);

        // Copy over everything requested in the workdir that's not added,
        // i.e., untracked.

        Object.keys(requestedWorkdir).forEach(filename => {
            const status = requestedWorkdir[filename];
            if (RepoStatus.FILESTATUS.ADDED !== status) {
                newStaged[filename] = status;
            }
        });

        // Now copy over to `workdir` the current files that won't be staged.

        function copyToWorkdir(files) {
            Object.keys(files).forEach(filename => {
                if (!(filename in newStaged)) {
                    newWorkdir[filename] = files[filename];
                }
            });
        }

        copyToWorkdir(currentStaged);
        copyToWorkdir(currentWorkdir);

        return {
            staged: newStaged,
            workdir: newWorkdir,
        };
    }

    const newFiles = calculateOneRepo(current.staged,
                                      current.workdir,
                                      requested.staged,
                                      requested.workdir);
    const currentSubs = current.submodules;
    const requestedSubs = requested.submodules;
    const newSubs = {};
    Object.keys(currentSubs).forEach(subName => {
        const currentSub = currentSubs[subName];
        const requestedSub = requestedSubs[subName];
        const curWd = currentSub.workdir;
        if (null !== curWd) {
            const curStatus = curWd.status;

            // If this submodule was not requested (i.e.,
            // `undefined === requestedSubs`, default to an empty repo status;
            // this will cause all current status files to be moved to the
            // workdir.

            let reqStatus = new RepoStatus();
            if (undefined !== requestedSub) {
                reqStatus = requestedSub.workdir.status;
            }
            const newSubFiles = calculateOneRepo(curStatus.staged,
                                                 curStatus.workdir,
                                                 reqStatus.staged,
                                                 reqStatus.workdir);
            const newStatus = curWd.status.copy({
                staged: newSubFiles.staged,
                workdir: newSubFiles.workdir,
            });
            newSubs[subName] = currentSub.copy({
                workdir: new RepoStatus.Submodule.Workdir(newStatus,
                                                          curWd.relation)
            });
        }
        else {
            // If no workdir, no change.

            newSubs[subName] = currentSub;
        }
    });
    return current.copy({
        staged: newFiles.staged,
        workdir: newFiles.workdir,
        submodules: newSubs,
    });
};

/**
 * Return true if the specified `status` contains any submodules that are
 * incompatible with path-based commits.  A submodule is incompatible with
 * path-based commits if:
 * 1. It has a change that would affect the `.gitmodules` file.
 * 2. It has files selected (staged) to be committed on top of new commits.
 * We cannot use path-based commit with previously staged commits because it's
 * impossible to ignore or target those commits.  We can't use them with
 * configuration changes due to the complexity of manipulating the
 * `.gitmodules` file.
 * 
 * TODO:
 *   (a) Consider allowing previously-staged commits to be included with a
 *       flag.
 *   (b) Consider allowing submodules with configuration changes if the
 *       submodule itself is included in the path change.  Note that even if
 *       this makes sense (not sure yet), it would require sophisticated
 *       manipulation of the `gitmodules` file.
 *
 * @param {RepoStatus} status
 * @return {Boolean}
 */
exports.areSubmodulesIncompatibleWithPathCommits = function (status) {
    assert.instanceOf(status, RepoStatus);
    const subs = status.submodules;
    for (let subName in subs) {
        const sub = subs[subName];
        const commit = sub.commit;
        const index = sub.index;

        // Newly added or removed submodules require changes to the modules
        // file.

        if (null === commit || null === index) {
            return true;
        }

        // as do URL changes

        if (commit.url !== index.url) {
            return true;
        }

        // Finally, check for new commits.

        const SAME = RepoStatus.Submodule.COMMIT_RELATION.SAME;

        const workdir = sub.workdir;

        if ((null !== workdir &&
            0 !== Object.keys(workdir.status.staged).length) &&
            (SAME !== index.relation || SAME !== workdir.relation)) {
            return true;
        }
    }
    return false;
};

/**
 * Return the staged changes to be committed or left uncommitted for an all
 * commit given the specified `staged` index files and specified `workdir`
 * differences.
 *
 * @param {Object} staged     map from path to {RepoStatus.FILESTATUS}
 * @param {Object} workdir  map from path to {RepoStatus.FILESTATUS}
 * @return {Object}
 * @return {Object} return.staged   map from path to {RepoStatus.FileStatus}
 * @return {Object} return.workdir  map from path to {RepoStatus.FileStatus}
 */
exports.calculateAllStatus = function (staged, workdir) {
    assert.isObject(staged);
    assert.isObject(workdir);

    const ADDED = RepoStatus.FILESTATUS.ADDED;
    const resultIndex = {};
    const resultWorkdir = {};

    Object.keys(workdir).forEach(filename => {
        const workdirStatus = workdir[filename];

        // If untracked, store this change in the workdir section; otherwise,
        // store it in the staged section.

        if (ADDED === workdirStatus && ADDED !== staged[filename]) {
            resultWorkdir[filename] = workdirStatus;
        }
        else {
            resultIndex[filename] = workdirStatus;
        }
    });

    return {
        staged: resultIndex,
        workdir: resultWorkdir,
    };
};

/**
 * Return a `RepoStatus` object reflecting the commit that would be made for a
 * repository having the specified `normalStatus` (indicating HEAD -> index ->
 * workdir changes) and the specified `toWorkdirStatus` (indicating HEAD ->
 * workdir changes).  All workdir changes in `toWorkdirStatus` will be turned
 * into staged changes, except when `toWorkdirStatus` indicates that a file has
 * been added but `normalStatus` does not, i.e., the file is untracked.  The
 * behavior is undefined if `normalStatus` and `toWorkdirStatus` to not have
 * the same values for fields other than `staged` and `workdir` in the main
 * repo status or that of any submodules.
 *
 * @param {RepoStatus} normalStatus
 * @param {RepoStatus} toWorkdirStatus
 * @return {RepoStatus}
 */
exports.calculateAllRepoStatus = function (normalStatus, toWorkdirStatus) {
    assert.instanceOf(normalStatus, RepoStatus);
    assert.instanceOf(toWorkdirStatus, RepoStatus);

    function convertOneRepo(normal, toWorkdir) {
        const index = normal.staged;
        const workdir = toWorkdir.workdir;
        const converted = exports.calculateAllStatus(index, workdir);
        return normal.copy({
            staged: converted.staged,
            workdir: converted.workdir,
        });
    }

    // Convert the status for the meta-repo.

    const base = convertOneRepo(normalStatus, toWorkdirStatus);


    // Then do the same for each submodule.

    const subs = base.submodules;
    const workdirSubs = toWorkdirStatus.submodules;
    const resultSubs = {};
    Object.keys(subs).forEach(subName => {
        const sub = subs[subName];
        const normalSubWorkdir = sub.workdir;
        if (null === normalSubWorkdir) {
            // If the submodule isn't open, take it as is.

            resultSubs[subName] = sub;
            return;                                                   // RETURN
        }

        // Otherwise, when the submodule is open, we need to pull out the
        // `RepoStatus` objects from both the normal and workdir sides and
        // apply `convertOneRepo`.

        const toWorkdirSub = workdirSubs[subName];
        assert.notEqual(undefined, toWorkdirSub);
        const toWorkdirSubWorkdir = toWorkdirSub.workdir;
        assert.isNotNull(toWorkdirSubWorkdir);
        const newStatus = convertOneRepo(normalSubWorkdir.status,
                                         toWorkdirSubWorkdir.status);
        const newWorkdir = new RepoStatus.Submodule.Workdir(
                                                    newStatus,
                                                    normalSubWorkdir.relation);
        resultSubs[subName] = sub.copy({
            workdir: newWorkdir,
        });
    });
    return base.copy({
        submodules: resultSubs,
    });
};

/**
 * Return the status of the specified `repo` indicating a commit that would be
 * performed, including all (tracked) modified files if the specified `all` is
 * provided (default false) and the state of them meta-repo if the specified
 * `showMetaChanges` is true (default is false).  Restrict status to the
 * specified `paths` if nonempty (default []), using the specified `cwd` to
 * resolve their meaning.  The behavior undefined unless
 * `0 === paths.length || !all`.
 * 
 * @param {NodeGit.Repository} repo
 * @param {String}             cwd
 * @param {Object}             [options]
 * @param {Boolean}            [options.all]
 * @param {Boolean}            [options.showMetaChanges]
 * @return {RepoStatus}
 */
exports.getCommitStatus = co.wrap(function *(repo, cwd, options) {
    if (undefined === options) {
        options = {};
    }
    else {
        assert.isObject(options);
    }
    if (undefined === options.all) {
        options.all = false;
    }
    else {
        assert.isBoolean(options.all);
    }
    if (undefined === options.showMetaChanges) {
        options.showMetaChanges = false;
    }
    else {
        assert.isBoolean(options.showMetaChanges);
    }
    if (undefined === options.paths) {
        options.paths = [];
    }
    else {
        assert.isArray(options.paths);
    }
    assert(0 === options.paths.length || !options.all,
           "paths not compatible with auto-staging");

    // The `baseStatus` object holds the "normal" status reflecting the
    // difference between HEAD -> index and index -> workdir.  This status is
    // used to calculate all other types such as for `all` and with `paths.

    const baseStatus = yield StatusUtil.getRepoStatus(repo, {
        showMetaChanges: options.showMetaChanges,
    });

    if (0 !== options.paths.length) {
        // Doing path-based status.  First, we need to compute the
        // `commitStatus` object that reflects the paths requested by the user.
        // First, we need to resolve the relative paths.

        const paths = yield options.paths.map(filename => {
            return GitUtil.resolveRelativePath(repo.workdir(), cwd, filename);
        });

        // Now we get the path-based status.

        const requestedStatus = yield StatusUtil.getRepoStatus(repo, {
            showMetaChanges: options.showMetaChanges,
            paths: paths,
        });

        return exports.calculatePathCommitStatus(baseStatus, requestedStatus);
    }
    if (options.all) {
        // If we're auto-staging, we have to compute the commit status
        // differently, comparing the workdir directly to the tree rather than
        // the index, but still avoiding untracked files.

        const workdirStatus = yield StatusUtil.getRepoStatus(repo, {
            showMetaChanges: options.showMetaChanges,
            ignoreIndex: true,
        });
        return exports.calculateAllRepoStatus(baseStatus, workdirStatus);
    }
    // If no special options, just return `baseStatus` as is.

    return baseStatus;
});

/**
 * Return a `RepoStatus` object having the same value as the specified `status`
 * but with all staged and workdir changes removed from all submodules.
 *
 * @param {RepoStatus} status
 * @return {RepoStatus}
 */
exports.removeSubmoduleChanges = function (status) {
    assert.instanceOf(status, RepoStatus);
    const newSubs = {};
    const subs = status.submodules;
    Object.keys(subs).forEach(subName => {
        const sub = subs[subName];
        const workdir = sub.workdir;
        if (null !== workdir) {
            // If the sub is open, make a copy of its status that is the same
            // except for the removal of all staged and workdir changes.

            const workdirStatus = workdir.status;
            const newWorkdirStatus = workdirStatus.copy({
                staged: {},
                workdir: {},
            });
            const newWorkdir = new RepoStatus.Submodule.Workdir(
                                                             newWorkdirStatus,
                                                             workdir.relation);
            const newSub = sub.copy({ workdir: newWorkdir });
            newSubs[subName] = newSub;
        }
        else {
            // If the sub is closed just copy it over as is.

            newSubs[subName] = sub;
        }
    });
    return status.copy({
        submodules: newSubs,
    });
};

/**
 * Return a string to use as a prompt for creating a split commit from the
 * specified `status`.
 *
 * @param {RepoStatus} status
 * @return {String}
 */
exports.formatSplitCommitEditorPrompt = function (status) {
    assert.instanceOf(status, RepoStatus);

    // Put a prompt for the meta repo and its status first.

    let result = `\

# <*> enter meta-repo message above this line; delete to commit only submodules
`;

    result += exports.prefixWithPound(branchStatusLine(status));

    // Remove submodule changes because we're going to display them under each
    // submodule.

    const metaStatus = exports.removeSubmoduleChanges(status);
    result += exports.prefixWithPound(exports.formatStatus(metaStatus, ""));

    const submodules = status.submodules;
    const subNames = Object.keys(submodules).sort();

    // Now, add a section for each submodule that has changes to be committed.

    subNames.forEach(subName => {
        const sub = submodules[subName];

        const workdir = sub.workdir;
        if (null === workdir) {
            // Cannot generate a commit for a closed submodule.

            return;                                                   // RETURN
        }
        const subStat = workdir.status;
        if (subStat.isIndexClean()) {
            // No need to do anything if the submodule has no staged files.

            return;                                                   // RETURN
        }

        result += `\
# -----------------------------------------------------------------------------

# <${subName}> enter message for '${subName}' above this line; delete this \
line to skip committing '${subName}'
`;

        result += exports.prefixWithPound(exports.formatStatus(subStat, ""));
    });

    result += `\
#
# Please enter the commit message(s) for your changes.  The message for a
# repo will be composed of all lines not beginning with '#' that come before
# its tag, but after any other tag (or the beginning of the file).  Tags are
# lines beginning with '# <sub-repo-name>', or '# <*>' for the meta-repo.
# If the tag for a repo is removed, no commit will be generated for that repo.
# If you do not provide a commit message for a sub-repo, the commit
# message for the meta-repo will be used.
`;

    return result;
};

/**
 * Parse the specified `text` and return an object indicating what (if any)
 * commit messages to use for the meta-repo and each sub-repo.  The meta-repo
 * commit message consists of the non-comment lines prior to the first sub-repo
 * tag.  A sub-repo tag is a line in the form of `# <${sub-repo name}>`.  The
 * commit message for a sub-repo consists of the non-comment lines between its
 * tag and the next sub-repo tag, or the end of the file.  If the tag exists
 * for a sub-repo, but its message is blank, the commit message for the
 * meta-repo is used. if it has one.  Throw a `UserError` if the same sub-repo
 * tag is found more than once.
 *
 * @param {String} text
 * @return {Object}
 * @return {String|null} return.metaMessage commit message for the meta-repo
 * @return {Object} return.subMessages commit messages for submodules
 */
exports.parseSplitCommitMessages = function (text) {
    assert.isString(text);
    let metaMessage = null;
    const seen = new Set();
    const subMessages = {};
    const lines = text.split("\n");
    let start = 0;  // start of current block of lines

    function consumeCurrentBlock(tag, start, end) {
        if (seen.has(tag)) {
            throw new UserError(`${tag} was used more than once.`);
        }
        seen.add(tag);

        const blockLines = lines.slice(start, end);
        const message = GitUtil.stripMessageLines(blockLines);
        if ("*" === tag) {
            if ("" !== message) {
                metaMessage = message;
            }
            else {
                throw new UserError("Empty meta-repo commit message.");
            }
        }
        else {
            if ("" === message) {
                if (null !== metaMessage) {
                    subMessages[tag] = metaMessage;
                }
            }
            else {
                subMessages[tag] = message;
            }
        }
    }

    const tagMatcher = /# <(.*)>.*$/;

    for (let i = 0; i < lines.length; ++i) {
        const line = lines[i];
        const match = tagMatcher.exec(line);
        if (null !== match) {
            consumeCurrentBlock(match[1], start, i);
            start = i + 1;
        }
    }
    return {
        metaMessage: metaMessage,
        subMessages: subMessages,
    };
};
