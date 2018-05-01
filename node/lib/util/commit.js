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

// TODO: This module is getting to be too big and we need to split it, probably
// into `commit_util` and `commit_status_util`.

/**
 * This module contains methods for committing.
 */

const assert  = require("chai").assert;
const co      = require("co");
const colors  = require("colors");
const NodeGit = require("nodegit");
const path    = require("path");

const DoWorkQueue         = require("../util/do_work_queue");
const DiffUtil            = require("./diff_util");
const GitUtil             = require("./git_util");
const Open                = require("./open");
const RepoStatus          = require("./repo_status");
const PrintStatusUtil     = require("./print_status_util");
const StatusUtil          = require("./status_util");
const Submodule           = require("./submodule");
const SubmoduleConfigUtil = require("./submodule_config_util");
const SubmoduleUtil       = require("./submodule_util");
const TreeUtil            = require("./tree_util");
const UserError           = require("./user_error");

/**
 * If the specified `message` does not end with '\n', return the result of
 * appending '\n' to 'message'; otherwise, return 'message'.
 *
 * @param {String} message
 */
exports.ensureEolOnLastLine = function (message) {
    // TODO: test independently
    return message.endsWith("\n") ? message : (message + "\n");
};

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
 * This class reprents the meta-data associated with a commit.
 */
class CommitMetaData {
    /**
     * Create a new `CommitMetaData` object having the specified `signature`
     * and `message`.
     *
     * @param {NodeGit.Signature} signature
     * @param {String}            message
     */
    constructor(signature, message) {
        assert.instanceOf(signature, NodeGit.Signature);
        assert.isString(message);

        this.d_signature = signature;
        this.d_message = message;

        Object.freeze(this);
    }

    /**
     * the signature associated with a commit
     *
     * @property {NodeGit.Signature} signature
     */
    get signature() {
        return this.d_signature;
    }

    /**
     * the message associated with a commit
     *
     * @property {String} message
     */
    get message() {
        return this.d_message;
    }

    /**
     * Return true if the specified `other` represents an equivalent value to
     * this object and false otherwise.  Two `CommitMetaData` values are
     * equivalent if they have the same `message`, `signature.name()`, and
     * `signature.email()` values.
     *
     * @param {CommitMetaData} other
     * @return {Boolean}
     */
    equivalent(other) {
        assert.instanceOf(other, CommitMetaData);
        return this.d_message === other.d_message &&
            this.d_signature.name() === other.d_signature.name() &&
            this.d_signature.email() === other.d_signature.email();
    }
}

exports.CommitMetaData = CommitMetaData;

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
        return yield repo.createCommitOnHead(
                                         [],
                                         signature,
                                         signature,
                                         exports.ensureEolOnLastLine(message));
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
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Index}      index
 * @param {Object}             submodules name -> RepoStatus.Submodule
 */
const stageOpenSubmodules = co.wrap(function *(repo, index, submodules) {
    yield Object.keys(submodules).map(co.wrap(function *(name) {
        const sub = submodules[name];
        if (null !== sub.workdir) {
            yield index.addByPath(name);
        }
    }));
    yield GitUtil.writeMetaIndex(repo, index);
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

    yield DoWorkQueue.doInParallel(Object.keys(submodules), commitSubmodule);

    const result = {
        metaCommit: null,
        submoduleCommits: subCommits,
    };

    if (null === message) {
        return result;                                                // RETURN
    }

    const index = yield metaRepo.index();
    yield stageOpenSubmodules(metaRepo, index, submodules);

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
            const blobId = yield TreeUtil.hashFile(repo, filename);
            changes[filename] = new Change(blobId, FILEMODE.BLOB);

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

    yield GitUtil.writeMetaIndex(repo, index);

    // Use 'TreeUtil' to create a new tree having the required paths.

    const baseTree = yield headCommit.getTree();
    const tree = yield TreeUtil.writeTree(repo, baseTree, changes);

    // Create a commit with this tree.

    const sig = repo.defaultSignature();
    const parents = [headCommit];
    const commitId = yield NodeGit.Commit.create(
                                          repo,
                                          0,
                                          sig,
                                          sig,
                                          0,
                                          exports.ensureEolOnLastLine(message),
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
 * Return the meta-data for the specified `commit`.
 *
 * @param {NodeGit.Commit} commit
 * @return {CommitMetaData}
 */
exports.getCommitMetaData = function (commit) {
    assert.instanceOf(commit, NodeGit.Commit);
    return new CommitMetaData(commit.committer(), commit.message());
};

/**
 * Return the amend status for the submodule having the specified current
 * `status` and the optionally specified `old` value in the previous commit.  A
 * missing `old` indicates that the submodule was added in the commit being
 * amended.
 *
 * @param {RepoStatus.Submodule} status
 * @param {String|null}       old
 * @return {Object}
 * @return {CommitMetaData|null}       return.oldCommit if sub in last commit
 * @return {RepoStatus.Submodule|null} return.status    null if shouldn't exist
 */
exports.getSubmoduleAmendStatus = co.wrap(function *(status,
                                                     old,
                                                     getRepo,
                                                     all) {
    assert.instanceOf(status, RepoStatus.Submodule);
    if (null !== old) {
        assert.instanceOf(old, Submodule);
    }
    const index = status.index;
    const commit = status.commit;
    const workdir = status.workdir;

    if (null === old && null === index) {
        // Gone in index and didn't exist before; has no status now.

        return {
            oldCommit: null,
            status: null,
        };
    }

    // We'll create an amend commit for of this sub only if:
    // - it's not gone in the index
    // - it wasn't removed in the last commit
    // - it wasn't added in the last commit
    // - its sha was updated in the last commit
    // - no new commits have been staged or created in the workdir

    const SAME = RepoStatus.Submodule.COMMIT_RELATION.SAME;

    const shouldAmend = null !== index &&
                        null !== commit &&
                        null !== old &&
                        old.sha !== commit.sha &&
                        SAME === index.relation &&
                        (null === workdir || SAME === workdir.relation);

    const commitSha = old && old.sha;
    let indexSha = index && index.sha;
    let workdirStatus = workdir && workdir.status;

    let oldCommit = null;                   // will hold commit meta data
    let repo = null;

    if (shouldAmend) {
        // Set up the index sha to match the old commit -- as it must to be
        // able to do an amend.

        indexSha = commitSha;

        // The read in the staged/workdir changes based on the difference in
        // this submodule's open repo and the prior commit.

        repo = yield getRepo();
        const commit = yield repo.getHeadCommit(repo);
        oldCommit = exports.getCommitMetaData(commit);
        const amendStat = yield getAmendStatusForRepo(repo, all);
        workdirStatus = new RepoStatus({
            headCommit: commitSha,
            staged: amendStat.staged,
            workdir: amendStat.workdir,
        });
    }
    else if (null !== workdirStatus) {
        repo = yield getRepo();
    }

    const commitUrl = old && old.url;
    const indexUrl = index && index.url;

    const newStatus = yield StatusUtil.getSubmoduleStatus(repo,
                                                          workdirStatus,
                                                          indexUrl,
                                                          commitUrl,
                                                          indexSha,
                                                          commitSha);
    return {
        status: newStatus,
        oldCommit: oldCommit,
    };
});

/**
 * Return the status object describing an amend commit to be created in the
 * specified `repo` and a map containing the submodules to have amend
 * commits created mapped to `CommitMetaData` objects describing their current
 * commits; submodules with staged changes not in this map receive normal
 * commits.  Format paths relative to the specified `cwd`.  Ignore
 * non-submodule changes to the meta-repo.  Auto-stage modifications (to
 * tracked files) if the specified `all` is true.
 *
 * @param {NodeGit.Repository} repo
 * @param {Object}             [options]
 * @param {Boolean}            [options.all = false]
 * @param {String}             [options.cwd = ""]
 *
 * @return {Object}
 * @return {RepoStatus} return.status
 * @return {Object}     return.subsToAmend  name -> `CommitMetaData`
 */
exports.getAmendStatus = co.wrap(function *(repo, options) {
    assert.instanceOf(repo, NodeGit.Repository);
    if (undefined === options) {
        options = {};
    }
    else {
        assert.isObject(options);
    }
    let all = options.all;
    if (undefined === all) {
        all = false;
    }
    else {
        assert.isBoolean(all);
    }
    let cwd = options.cwd;
    if (undefined === cwd) {
        cwd = "";
    }
    else {
        assert.isString(cwd);
    }

    const baseStatus = yield exports.getCommitStatus(repo, cwd, {
        all: all,
    });

    const head = yield repo.getHeadCommit();
    const headTree = yield head.getTree();

    const newUrls =
                 yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, head);

    // Read the state of the commits in the commit before the one to be
    // amended.

    let oldUrls = {};
    const parent = yield GitUtil.getParentCommit(repo, head);
    let parentTree = null;
    if (null !== parent) {
        parentTree = yield parent.getTree();
        oldUrls =
               yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo, parent);
    }
    const diff =
               yield NodeGit.Diff.treeToTree(repo, parentTree, headTree, null);
    const changes = yield SubmoduleUtil.getSubmoduleChangesFromDiff(diff,
                                                                    true);
    const submodules = baseStatus.submodules;  // holds resulting sub statuses
    const opener = new Open.Opener(repo, null);

    const subsToAmend = {};  // holds map of subs to amend to their commit info

    // Loop through submodules that either have changes against the current
    // commit, or were changed in the current commit.

    const subsToInspect = Array.from(new Set(
                        Object.keys(submodules).concat(Object.keys(changes))));

    const inspectSub = co.wrap(function *(name) {
        const change = changes[name];
        let currentSub = submodules[name];
        let old = null;
        if (undefined !== change) {
            // We handle deleted submodules later.  TODO: this should not be a
            // special case when we've done the refactoring noted below.

            if (null === change.newSha) {
                return;                                               // RETURN
            }
            // This submodule was affected by the commit; record it's old sha
            // if it wasn't added.

            if (null !== change.oldSha) {
                old = new Submodule(oldUrls[name], change.oldSha);
            }

            if (undefined === currentSub) {
                // This submodule is not open though; we need to construct a
                // `RepoStatus.Submodule` object for it as if it had been
                // loaded; the commit and index parts of this object are the
                // same as they cannot have been changed.
                //
                // TODO: refactor this and `getSubmoduleAmendStatus` to be
                // less-wonky, specifically to not deal in terms of
                // `RepoAST.Submodule` objects.

                const url = newUrls[name];
                const Submodule = RepoStatus.Submodule;
                currentSub = new Submodule({
                    commit: new Submodule.Commit(change.newSha, url),
                    index: new Submodule.Index(change.newSha,
                                               url,
                                               Submodule.COMMIT_RELATION.SAME),
                });
            }
        }
        else {
            // This submodule was opened but not changed.  Populate 'old' with
            // current commit value, if it exists.

            const commit = currentSub.commit;
            if (null !== commit) {
                old = new Submodule(commit.url, commit.sha);
            }
        }
        const getRepo = () => opener.getSubrepo(name);

        const result = yield exports.getSubmoduleAmendStatus(currentSub,
                                                             old,
                                                             getRepo,
                                                             all);
        // If no status was returned, remove this submodule.

        if (null === result.status) {
            delete submodules[name];
        }
        else {
            submodules[name] = result.status;
        }

        // If it's to be amended, populate `subsToAmend` with the last commit
        // info.

        if (null !== result.oldCommit) {
            subsToAmend[name] = result.oldCommit;
        }
    });
    yield DoWorkQueue.doInParallel(subsToInspect, inspectSub);
    // Look for subs that were removed in the commit we are amending; reflect
    // their status.

    Object.keys(changes).forEach(name => {
        // If we find one, create a status entry for it reflecting its
        // deletion.

        const change = changes[name];
        if (null === change.newSha) {
            submodules[name] = new RepoStatus.Submodule({
                commit: new RepoStatus.Submodule.Commit(change.sha,
                                                        oldUrls[name]),
                index: null,
            });
        }
    });

    const resultStatus = baseStatus.copy({
        submodules: submodules,
    });

    return {
        status: resultStatus,
        subsToAmend: subsToAmend,
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
    const termedMessage = exports.ensureEolOnLastLine(message);
    const id = yield head.amend("HEAD", null, null, null, termedMessage, tree);
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
 * @param {String|null}        message
 * @param {Object|null}        subMessages
 * @return {Object}
 * @return {String} return.metaCommit sha of new commit on meta-repo
 * @return {Object} return.submoduleCommits  from sub name to sha
 */
exports.amendMetaRepo = co.wrap(function *(repo,
                                           status,
                                           subsToAmend,
                                           all,
                                           message,
                                           subMessages) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(status, RepoStatus);
    assert.isArray(subsToAmend);
    assert.isBoolean(all);
    if (null !== message) {
        assert.isString(message);
    }
    if (null !== subMessages) {
        assert.isObject(subMessages);
    }
    assert(null !== message || null !== subMessages,
           "if no meta message, sub messages must be specified");

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
        // If we're providing specific sub messages, use it if provided and
        // skip committing the submodule otherwise.

        let subMessage = message;
        if (null !== subMessages) {
            subMessage = subMessages[subName];
            if (undefined === subMessage) {
                return;                                               // RETURN
            }
        }
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
            if (all) {
                const actualStatus = yield StatusUtil.getRepoStatus(subRepo, {
                    showMetaChanges: true,
                });

                // TODO: factor this out.  We cannot use `repoStatus` to
                // determine what to stage as it shows the status vs. HEAD^
                // and so some things that should be changed will not be in it.
                //  We cannot call `Index.addAll` because it will stage
                //  untracked files.  Therefore, we need to use our normal
                //  status routine to examime the workdir and stage changed
                //  files.

                const workdir = actualStatus.workdir;
                for (let path in actualStatus.workdir) {
                    const change = workdir[path];
                    if (RepoStatus.FILESTATUS.ADDED !== change) {
                        yield exports.stageChange(subIndex, path, change);
                    }
                }
                yield subIndex.write();
            }
            subCommits[subName] = yield exports.amendRepo(subRepo, subMessage);
            return;                                                   // RETURN
        }

        const commit = yield commitRepo(subRepo,
                                        repoStatus.staged,
                                        all,
                                        subMessage,
                                        false,
                                        signature);
        if (null !== commit) {
            subCommits[subName] = commit.tostrS();
        }
    }));

    let metaCommit = null;
    if (null !== message) {

        const index = yield repo.index();
        yield stageOpenSubmodules(repo, index, subs);
        yield stageFiles(repo, status.staged, index);
        metaCommit = yield exports.amendRepo(repo, message);
    }
    return {
        metaCommit: metaCommit,
        submoduleCommits: subCommits,
    };
});

/**
 * Return a human-readable format of the time for the specified `time`.
 *
 * @param {NodeGit.Time} time
 * @return {String}
 */
exports.formatCommitTime = function (time) {
    assert.instanceOf(time, NodeGit.Time);
    const signPrefix = time.offset() < 0 ? "-" : "";

    //  TODO: something better than rounding offset, though I think we can live
    //  without showing minute-specific TZ diffs for a long time.

    const offset = Math.floor(time.offset() / 60);
    const date = new Date((time.time() + (time.offset() * 60)) * 1000);

    // TODO: do something user-locale-aware.

    const formatted = new Intl.DateTimeFormat("en-US", {
        hour12: false,
        timeZone: "UTC",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
    }).format(date);
    return `${formatted} ${signPrefix}${Math.abs(offset)}00`;
};

/**
 * Return a string describing the signature of an amend commit, to be used in
 * an editor prompt, based on the specified `currentSignature` that is the
 * current signature used in a normal commit, and the specified `lastSignature`
 * used on the commit to be amended.
 *
 * @param {NodeGit.Signature} currentSignature
 * @param {NodeGit.Signature} lastSignature
 * @return {String}
 */
exports.formatAmendSignature = function (currentSignature, lastSignature) {
    assert.instanceOf(currentSignature, NodeGit.Signature);
    assert.instanceOf(lastSignature, NodeGit.Signature);

    let result = "";
    if (lastSignature.name() !== currentSignature.name() ||
        lastSignature.email() !== currentSignature.email()) {
        result += `\
Author:    ${lastSignature.name()} <${lastSignature.email()}>
`;
    }
    const time = lastSignature.when();
    result += `\
Date:      ${exports.formatCommitTime(time)}

`;
    return result;
};

/**
 * Return the text with which to prompt a user prior to making an amend commit
 * in specified `repo` having the changes indicated by the specified `status`,
 * reflecting that unstaged (tracked) files are to be committed if the
 * specified `all` is true.  Format paths relative to the specified `cwd`.
 * Display the specified `date` value for the date section of the message.
 *
 * @param {Signature}      repoSignature
 * @param {CommitMetaData} metaCommitData
 * @param {RepoStatus}     status
 * @param {String}         cwd
 * @return {String}
 */
exports.formatAmendEditorPrompt = function (currentSignature,
                                            lastCommitData,
                                            status,
                                            cwd) {
    assert.instanceOf(currentSignature, NodeGit.Signature);
    assert.instanceOf(lastCommitData, CommitMetaData);
    assert.instanceOf(status, RepoStatus);
    assert.isString(cwd);

    let result = editorMessagePrefix + "\n";

    result += exports.formatAmendSignature(currentSignature,
                                           lastCommitData.signature);

    result += branchStatusLine(status);
    result += exports.formatStatus(status, cwd);
    return lastCommitData.message + "\n" + exports.prefixWithPound(result) +
        "#\n";
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
 * provided (default false).  Restrict status to the specified `paths` if
 * nonempty (default []), using the specified `cwd` to resolve their meaning.
 * The behavior undefined unless `0 === paths.length || !all`.
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

        const requestedStatus = yield StatusUtil.getRepoStatus(repo, {
            cwd: cwd,
            paths: options.paths,
            showMetaChanges: options.showMetaChanges,
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
            showAllUntracked: true,
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
 * specified `status`.  If the specified `metaCommitData` is provided, supply
 * information from it and the specified `currentSignature` in the prompt for
 * the meta-repo commit.  Similarly, if there is an entry in`subAmendData` for
 * a submodule, us that entry in the prompt for that submodule and display
 * amend-specific information, but do not prompt with the previous commit
 * message for a submodule if it matches the meta-repo message.
 *
 * @param {RepoStatus}          status
 * @param {NodeGit.Signature}   currentSignature
 * @param {CommitMetaData|null} metaCommitData
 * @param {Object}              subAmendData  map from name to CommitMetaData
 * @return {String}
 */
exports.formatSplitCommitEditorPrompt = function (status,
                                                  currentSignature,
                                                  metaCommitData,
                                                  subAmendData) {
    assert.instanceOf(status, RepoStatus);
    assert.instanceOf(currentSignature, NodeGit.Signature);
    if (null !== metaCommitData) {
        assert.instanceOf(metaCommitData, CommitMetaData);
    }
    assert.isObject(subAmendData);

    // Put a prompt for the meta repo and its status first.

    let result = "";
    if (metaCommitData) {
        result += metaCommitData.message;
    }
    result += `\

# <*> enter meta-repo message above this line; delete this line to \
commit only submodules
`;

    if (metaCommitData) {
        const text = exports.formatAmendSignature(currentSignature,
                                                  metaCommitData.signature);
        result += exports.prefixWithPound(text);
    }

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
`;
        const subData = subAmendData[subName];

        // Prompt with the preexisting commit message for an amended sub,
        // unless that message matches that of the preexisting meta-repo commit
        // message.

        if (undefined !== subData &&
            (null === metaCommitData ||
                metaCommitData.message !== subData.message)) {
            result += subData.message;
        }

        result += `\

# <${subName}> enter message for '${subName}' above this line; delete this \
line to skip committing '${subName}'
`;
        if (undefined !== subData) {
            result += `\
# If this sub-repo is skipped, it will not be amended and the original commit
# will be used.
`;
            const text = exports.formatAmendSignature(currentSignature,
                                                      subData.signature);
            result += exports.prefixWithPound(text);
        }
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

function errorWithStatus(status, relCwd, message) {
    throw new UserError(`\
${PrintStatusUtil.printRepoStatus(status, relCwd)}
${colors.yellow(message)}
`);
}

function checkForPathIncompatibleSubmodules(repoStatus, relCwd) {

    const Commit = require("../util/commit");

    if (Commit.areSubmodulesIncompatibleWithPathCommits(repoStatus)) {
            errorWithStatus(repoStatus, relCwd, `\
Cannot use path-based commit on submodules with staged commits or
configuration changes.`);
    }
}

function abortForNoMessage() {
    throw new UserError("Aborting commit due to empty commit message.");
}

/**
 * Perform the commit command in the specified `repo`. Consider the values in
 * the specified `paths` to be relative to the specified `cwd`, and format
 * paths displayed to the user according to `cwd`.  If the optionally specified
 * `message` is provided use it for the commit message; otherwise, prompt the
 * user to enter a message.  If the specified `all` is true, include (tracked)
 * modified but unstaged changes.  If `paths` is non-empty, include only the
 * files indicated in those `paths` in the commit.  If the specified
 * `interactive` is true, prompt the user to create an "interactive" message,
 * allowing for different commit messages for each changed submodules.  Use the
 * specified `editMessage` function to invoke an editor when needed.  The
 * behavior is undefined if `null !== message && true === interactive` or if `0
 * !== paths.length && all`.
 *
 * @param {NodeGit.Repository}             repo
 * @param {String}                         cwd
 * @param {String|null}                    message
 * @param {Boolean}                        meta
 * @param {Boolean}                        all
 * @param {String[]}                       paths
 * @param {Boolean}                        interactive
 * @param {(repo, txt) -> Promise(String)} editMessage
 * @return {Object}
 * @return {String} return.metaCommit
 * @return {Object} return.submoduleCommits  map from sub name to commit id
 */
exports.doCommitCommand = co.wrap(function *(repo,
                                             cwd,
                                             message,
                                             all,
                                             paths,
                                             interactive,
                                             editMessage) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(cwd);
    if (null !== message) {
        assert.isString(message);
    }
    assert.isBoolean(all);
    assert.isArray(paths);
    assert.isBoolean(interactive);
    assert.isFunction(editMessage);

    const workdir = repo.workdir();
    const relCwd = path.relative(workdir, cwd);
    const repoStatus = yield exports.getCommitStatus(repo, cwd, {
        all: all,
        paths: paths,
    });

    // Abort if there are uncommittable submodules; we don't want to commit a
    // .gitmodules file with references to a submodule that doesn't have a
    // commit.
    //
    // TODO: potentially do somthing more intelligent like committing a
    // different versions of .gitmodules than what is on disk to omit
    // "uncommittable" submodules.  Considering that this situation should be
    // relatively rare, I don't think it's worth the additional complexity at
    // this time.

    if (repoStatus.areUncommittableSubmodules()) {
        errorWithStatus(
                  repoStatus,
                  relCwd,
                  "Please stage changes in new submodules before committing.");
    }

    // If we're using paths, the status of what we're committing needs to be
    // calculated.  Also, we need to see if there are any submodule
    // configuration changes.

    const usingPaths = 0 !== paths.length;

    // If we're doing a path based commit, validate that we are in a supported
    // configuration.

    if (usingPaths) {
        checkForPathIncompatibleSubmodules(repoStatus, relCwd);
    }

    // If there is nothing possible to commit, exit early.

    if (!exports.shouldCommit(repoStatus, false, undefined)) {
        process.stdout.write(PrintStatusUtil.printRepoStatus(repoStatus,
                                                             relCwd));
        return;
    }

    let subMessages;

    if (interactive) {
        // If 'interactive' mode is requested, ask the user to specify which
        // repos are committed and with what commit messages.

        const sig = repo.defaultSignature();
        const prompt = exports.formatSplitCommitEditorPrompt(repoStatus,
                                                             sig,
                                                             null,
                                                             {});
        const userText = yield editMessage(repo, prompt);
        const userData = exports.parseSplitCommitMessages(userText);
        message = userData.metaMessage;
        subMessages = userData.subMessages;

        // Check if there's actually anything to commit.

        if (!exports.shouldCommit(repoStatus, message === null, subMessages)) {
            console.log("Nothing to commit.");
            return;
        }
    }
    else if (null === message) {
        // If no message on the command line, prompt for one.

        const initialMessage = exports.formatEditorPrompt(repoStatus, cwd);
        const rawMessage = yield editMessage(repo, initialMessage);
        message = GitUtil.stripMessage(rawMessage);
    }

    if ("" === message) {
        abortForNoMessage();
    }

    if (usingPaths) {
        return yield exports.commitPaths(repo,
                                         repoStatus,
                                         message,
                                         subMessages);
    }
    else {
        return yield exports.commit(repo,
                                    all,
                                    repoStatus,
                                    message,
                                    subMessages);
    }
});

/**
 * Perform the amend commit command in the specified `repo`.  Use the specified
 * `cwd` to format paths displayed to the user.  If the optionally specified
 * `message` is provided use it for the commit message; otherwise, prompt the
 * user to enter a message.  If the specified `all` is true, include (tracked)
 * modified but unstaged changes.  If the specified `interactive` is true,
 * prompt the user to create an "interactive" message, allowing for different
 * commit messages for each changed submodules.  Use the specified
 * `editMessage` function to invoke an editor when needed.  If
 * `null === editMessage`, use the message of the previous commit.  The
 * behavior is undefined if `null !== message && true === interactive`.  Do not
 * generate a commit if it would be empty.
 *
 * @param {NodeGit.Repository}                    repo
 * @param {String}                                cwd
 * @param {String|null}                           message
 * @param {Boolean}                               all
 * @param {Boolean}                               interactive
 * @param {(repo, txt) -> Promise(String) | null} editMessage
 * @return {Object}
 * @return {String|null} return.metaCommit
 * @return {Object} return.submoduleCommits  map from sub name to commit id
 */
exports.doAmendCommand = co.wrap(function *(repo,
                                            cwd,
                                            message,
                                            all,
                                            interactive,
                                            editMessage) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(cwd);
    if (null !== message) {
        assert.isString(message);
    }
    assert.isBoolean(all);
    assert.isBoolean(interactive);
    if (null !== editMessage) {
        assert.isFunction(editMessage);
    }

    const workdir = repo.workdir();
    const relCwd = path.relative(workdir, cwd);
    const amendStatus = yield exports.getAmendStatus(repo, {
        all: all,
        cwd: relCwd,
    });

    const status = amendStatus.status;
    const subsToAmend = amendStatus.subsToAmend;

    const head = yield repo.getHeadCommit();
    const defaultSig = repo.defaultSignature();
    const headMeta = exports.getCommitMetaData(head);
    let subMessages = null;
    if (interactive) {
        // If 'interactive' mode is requested, ask the user to specify which
        // repos are committed and with what commit messages.

        const prompt = exports.formatSplitCommitEditorPrompt(status,
                                                             defaultSig,
                                                             headMeta,
                                                             subsToAmend);
        const userText = yield editMessage(repo, prompt);
        const userData = exports.parseSplitCommitMessages(userText);
        message = userData.metaMessage;
        subMessages = userData.subMessages;
    }
    else {
        const mismatched = Object.keys(subsToAmend).filter(name => {
            const meta = subsToAmend[name];
            return !headMeta.equivalent(meta);
        });
        if (0 !== mismatched.length) {
            let error = `\
The last meta-repo commit (message or author)
does not match that of the last commit in the following sub-repos:
`;
            mismatched.forEach(name => {
                error += `    ${colors.red(name)}\n`;
            });
            error += `\
To prevent errors, you must make this commit using the interactive ('-i')
option, which will allow you to see and edit the commit messages for each
repository independently.`;
            throw new UserError(error);
        }


        if (null === editMessage) {
            // If no `editMessage` function, use the message of the previous
            // commit.

            message = head.message();
        }
        if (null === message) {
            // If no message, use editor.

            const prompt = exports.formatAmendEditorPrompt(defaultSig,
                                                           headMeta,
                                                           status,
                                                           relCwd);
            const rawMessage = yield editMessage(repo, prompt);
            message = GitUtil.stripMessage(rawMessage);
        }
    }

    if ("" === message) {
        abortForNoMessage();
    }

    if (!exports.shouldCommit(status,
                              null === message,
                              subMessages || undefined)) {
        process.stdout.write(PrintStatusUtil.printRepoStatus(status, relCwd));
        process.stdout.write(`
You asked to amend the most recent commit, but doing so would make
it empty. You can remove the commit entirely with "git meta reset HEAD^".`);
        return {
            metaCommit: null,
            submoduleCommits: {}
        };
    }
    // Finally, perform the operation.

    return yield exports.amendMetaRepo(repo,
                                       status,
                                       Object.keys(subsToAmend),
                                       all,
                                       message,
                                       subMessages);
});
