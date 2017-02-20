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

const DiffUtil            = require("./diff_util");
const GitUtil             = require("./git_util");
const Open                = require("./open");
const RepoStatus          = require("./repo_status");
const PrintStatusUtil     = require("./print_status_util");
const SubmoduleFetcher    = require("./submodule_fetcher");
const SubmoduleConfigUtil = require("./submodule_config_util");
const SubmoduleUtil       = require("./submodule_util");

/**
 * Commit changes in the specified `repo`.  If the specified `doAll` is true,
 * commit staged and unstaged files; otherwise, commit only staged files.  Use
 * the specified `message` as the commit message.  If there are no files to
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
                                      repoStatus,
                                      doAll,
                                      message,
                                      force,
                                      signature) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(repoStatus, RepoStatus);
    assert.isBoolean(doAll);
    assert.isString(message);
    assert.isBoolean(force);
    assert.instanceOf(signature, NodeGit.Signature);

    let areStagedFiles = 0 !== Object.keys(repoStatus.staged).length || force;

    // If we're auto-staging files, loop through workdir and stage them.

    if (doAll) {
        let indexUpdated = false;
        const index = yield repo.index();
        const workdir = repoStatus.workdir;
        for (let path in workdir) {
            switch (workdir[path]) {
                case RepoStatus.FILESTATUS.MODIFIED:
                    yield index.addByPath(path);
                    indexUpdated = true;
                    areStagedFiles = true;
                    break;
                case RepoStatus.FILESTATUS.REMOVED:
                    yield index.remove(path, -1);
                    indexUpdated = true;
                    areStagedFiles = true;
                    break;
            }
        }
        if (indexUpdated) {
            yield index.write();
        }
    }
    if (areStagedFiles) {
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

function prefixWithPound(text) {
    return text.replace(/^/mg, "# ").replace(/^# $/mg, "#");
}

/**
 * Return text describing the changes in the specified `status`; including in
 * the changes to be committed section modified working directory files if the
 * specified `all` is true.  Use the specified `cwd` to show relative paths.
 *
 * @param {RepoStatus} status
 * @param {String}     cwd
 * @param {Boolean}    all
 */
exports.formatStatus = function (status, cwd, all) {
    assert.instanceOf(status, RepoStatus);
    assert.isString(cwd);
    assert.isBoolean(all);

    let result = "";

    // If `all` is true, roll the workdir changes into the staged changes.

    const statuses = PrintStatusUtil.accumulateStatus(status);
    if (all) {
        statuses.staged = statuses.staged.concat(statuses.workdir);
        statuses.workdir = [];
    }

    result += `Changes to be committed:\n`;
    result += PrintStatusUtil.printStatusDescriptors(statuses.staged,
                                                     x => x,
                                                     cwd);

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
 * relative to the specified `cwd`.  Show that everything (other than
 * untracked) will be committed if the specified `all` is true.
 *
 * @param {RepoStatus} status
 * @param {String}     cwd
 * @param {Boolean}    all
 * @return {String}
 */
exports.formatEditorPrompt  = function (status, cwd, all) {
    assert.instanceOf(status, RepoStatus);
    assert.isString(cwd);
    assert.isBoolean(all);

    let result = editorMessagePrefix + branchStatusLine(status);

    result += exports.formatStatus(status, cwd, all);

    const prefixed = prefixWithPound(result);
    return "\n" + prefixed + "\n";
};

/**
 * Create a commit across modified repositories and the specified `metaRepo`
 * with the specified `message`, if provided, prompting the user if no message
 * is provided.  If the specified `all` is provided, automatically stage
 * modified files.  If a commit is generated, return an object that lists the
 * sha of the created meta-repo commit and the shas of any commits generated in
 * submodules. The behavior is undefined if there are entries in `.gitmodules`
 * for submodules having no commits.
 *
 * @async
 * @param {NodeGit.Repository} metaRepo
 * @param {Boolean}            all
 * @param {RepoStatus}         metaStatus
 * @param {String}             message
 * @return {Object|null}
 * @return {String} return.metaCommit
 * @return {Object} submoduleCommits map from submodule name to new commit
 */
exports.commit = co.wrap(function *(metaRepo, all, metaStatus, message) {
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.isBoolean(all);
    assert.instanceOf(metaStatus, RepoStatus);
    assert.isString(message);

    const signature = metaRepo.defaultSignature();
    const submodules = metaStatus.submodules;

    // Commit submodules.  If any changes, remember this so we know to generate
    // a commit in the meta-repo whether or not the meta-repo has its own
    // workdir changes.

    const subCommits = {};
    const subsToStage = [];
    let subsChanged = false;
    const commitSubmodule = co.wrap(function *(name) {
        const status = submodules[name];
        const repoStatus = status.repoStatus;
        let committed = null;
        if (null !== status.repoStatus) {
            const subRepo = yield SubmoduleUtil.getRepo(metaRepo, name);
            committed = yield commitRepo(subRepo,
                                         repoStatus,
                                         all,
                                         message,
                                         false,
                                         signature);
        }
        if (null !== committed) {
            subCommits[name] = committed.tostrS();
        }

        // Note that we need to stage the submodule in the meta-repo if:
        // - we made a commit
        // - its index status has changed
        // - it's new and has a workdir commit

        if (null !== committed ||
            (null !== repoStatus &&
             (repoStatus.headCommit !== status.indexSha))) {
            subsToStage.push(name);
            subsChanged = true;
        }
        else if (status.indexUrl !== status.commitUrl) {
            subsChanged = true;
        }
    });

    const subCommitters = Object.keys(submodules).map(commitSubmodule);
    yield subCommitters;

    // If submodule commits were created, we need to stage them.

    if (0 !== subsToStage.length) {
        const index = yield metaRepo.index();
        yield subsToStage.map(name => index.addByPath(name));
        yield index.write();
    }

    const metaResult = yield commitRepo(metaRepo,
                                        metaStatus,
                                        all,
                                        message,
                                        subsChanged,
                                        signature);

    if (null !== metaResult) {
        return {
            metaCommit: metaResult,
            submoduleCommits: subCommits,
        };
    }
    return null;
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
 * @return {String[]} return.newCommits        different commit in submodule
 * @return {String[]} return.mismatchCommits   commit doesn't match
 * @return {RepoStatus} return.status          adjusted repo status
 */
exports.checkIfRepoIsAmendable = co.wrap(function *(repo, status, oldSubs) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(status, RepoStatus);
    assert.isObject(oldSubs);

    const head = yield repo.getHeadCommit();
    const newCommits = [];
    const mismatchCommits = [];
    const subFetcher = new SubmoduleFetcher(repo, head);
    const currentSubs = status.submodules;
    const submodules = status.submodules;
    const templatePath = yield SubmoduleConfigUtil.getTemplatePath(repo);
    const getSubRepo = co.wrap(function *(name) {
        const subStatus = currentSubs[name];
        if (null === subStatus.repoStatus) {
            console.log(`Opening ${colors.blue(name)}.`);
            // Update `submodules` to reflect that this one is now open.

            submodules[name] = subStatus.open();
            return yield Open.openOnCommit(subFetcher,
                                           name,
                                           subStatus.indexSha,
                                           templatePath);
        }
        return yield SubmoduleUtil.getRepo(repo, name);
    });

    yield Object.keys(currentSubs).map(co.wrap(function *(subName) {
        const oldSub = oldSubs[subName];

        // If the submodule didn't exist before, it's inherently OK.

        if (undefined === oldSub) {
            return;                                                   // RETURN
        }

        const newSub = currentSubs[subName];

        // If a submodule has a different commit in the index of its workdir,
        // fail.

        if (newSub.indexSha !== newSub.commitSha ||
            (null !== newSub.repoStatus &&
             newSub.repoStatus.headCommit !== newSub.indexSha)) {
            newCommits.push(subName);
            return;                                                   // RETURN
        }

        // Otherwise, if it's one of the submodules affecetd by HEAD, validate
        // that the comit signature and message matches.

        if (oldSub.sha !== newSub.commitSha) {
            const subRepo = yield getSubRepo(subName);
            const subCommit = yield subRepo.getCommit(newSub.commitSha);
            if (!exports.sameCommitInstance(head, subCommit)) {
                mismatchCommits.push(subName);
            }
        }
    }));
    return {
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
    return yield DiffUtil.getRepoStatus(repo, tree, [], all, true);
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
            null === newSub.indexUrl ||
            oldSub.sha === newSub.commitSha) {
            return;                                                   // RETURN
        }

        const subRepo = yield SubmoduleUtil.getRepo(repo, subName);
        const changes = yield getAmendStatusForRepo(subRepo, all);
        subsToAmend.push(subName);

        // Now, we need to update the repo status of the submodule to reflect
        // the actual changes to be made rather than the changes that would be
        // made agains the current HEAD.

        subs[subName] = newSub.copy({
            repoStatus: newSub.repoStatus.copy({
                staged: changes.staged,
                workdir: changes.workdir,
            })
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
 * specified `status`.  If the specified `all` is true, stage (tracked) files.
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


    const stageFiles = co.wrap(function *(repo, workdir, index) {
        if (all) {
            yield Object.keys(workdir).map(co.wrap(function *(path) {
                if (RepoStatus.FILESTATUS.ADDED !== workdir[path]) {
                    yield index.addByPath(path);
                }
            }));
        }
        yield index.write();
    });

    const subCommits = {};
    const subs = status.submodules;
    const amendSubSet = new Set(subsToAmend);
    const subsToStage = [];

    yield Object.keys(subs).map(co.wrap(function *(subName) {
        const subStatus = subs[subName];

        // If the sub-repo doesn't have an open status, and there are no amend
        // changes, there's nothing to do.

        if (null === subStatus.repoStatus) {
            return;                                                   // RETURN
        }

        const subRepo = yield SubmoduleUtil.getRepo(repo, subName);

        // If the submodule is to be amended, we don't do the normal commit
        // process.

        if (amendSubSet.has(subName)) {
            subsToStage.push(subName);

            // First, we check to see if this submodule needs to have its last
            // commit stripped.  That will be the case if we have no files
            // staged or to be staged, indicating that if we were to do an
            // amend, it would create an empty commit.


            // We have workdir changes only if we're including them (with
            // 'all') and we have one that's not ADDED.

            let workdirChanges = false;
            const repoStatus = subStatus.repoStatus;
            assert.isNotNull(repoStatus);
            const staged = repoStatus.staged;
            const workdir = repoStatus.workdir;
            if (all) {
                Object.keys(workdir).forEach(path => {
                    workdirChanges = workdirChanges ||
                        RepoStatus.FILESTATUS.ADDED !== workdir[path];
                });
            }
            if (!workdirChanges &&
                0 === Object.keys(staged).length) {
                const head = yield subRepo.getHeadCommit();
                const parent = yield GitUtil.getParentCommit(subRepo, head);
                const TYPE = NodeGit.Reset.TYPE;
                const type = all ? TYPE.HARD : TYPE.MIXED;
                yield NodeGit.Reset.reset(subRepo, parent, type);
                return;                                               // RETURN

            }
            const subIndex = yield subRepo.index();
            yield stageFiles(subRepo, workdir, subIndex);
            subCommits[subName] = yield exports.amendRepo(subRepo, message);
            return;                                                   // RETURN
        }

        const subRepoStatus = subStatus.repoStatus;
        const commit = yield commitRepo(subRepo,
                                        subRepoStatus,
                                        all,
                                        message,
                                        false,
                                        signature);
        if (null !== commit) {
            subsToStage.push(subName);
            subCommits[subName] = commit.tostrS();
        }
        else if (subStatus.indexSha !== subRepoStatus.headCommit) {
            // If we didn't make a commit, but the sub has a new commit in its
            // workdir, we still need to stage it.

            subsToStage.push(subName);
        }
    }));

    const index = yield repo.index();
    yield subsToStage.map(path => index.addByPath(path));
    yield stageFiles(repo, status.workdir, index);

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
                                            all,
                                            date) {
    assert.instanceOf(commitSig, NodeGit.Signature);
    assert.instanceOf(repoSig, NodeGit.Signature);
    assert.instanceOf(status, RepoStatus);
    assert.isString(cwd);
    assert.isBoolean(all);
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
    result += exports.formatStatus(status, cwd, all);
    return "\n" + prefixWithPound(result) + "\n";
};
