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

const assert       = require("chai").assert;
const ChildProcess = require("child-process-promise");
const co           = require("co");
const colors       = require("colors");
const NodeGit      = require("nodegit");

const Checkout            = require("./checkout");
const Commit              = require("./commit");
const DeinitUtil          = require("./deinit_util");
const DoWorkQueue         = require("./do_work_queue");
const GitUtil             = require("./git_util");
const Merge               = require("./merge");
const MergeFileUtil       = require("./merge_file_util");
const Open                = require("./open");
const RepoStatus          = require("./repo_status");
const StatusUtil          = require("./status_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const SubmoduleUtil       = require("./submodule_util");
const UserError           = require("./user_error");

/**
 * @enum {MODE}
 * Flags to describe what type of merge to do.
 */
const MODE = {
    NORMAL      : 0,  // will do a fast-forward merge when possible
    FF_ONLY     : 1,  // will fail unless fast-forward merge is possible
    FORCE_COMMIT: 2,  // will generate merge commit even could fast-forward
};

exports.MODE = MODE;

/**
 * Perform a fast-forward merge in the specified `repo` to the specified
 * `commit`.  If `MODE.FORCE_COMMIT === mode`, generate a merge commit.  When
 * generating a merge commit, use the optionally specified `message`.  The
 * behavior is undefined unless `commit` is different from but descendant of
 * the HEAD commit in `repo`.  If a commit is generated, return its sha;
 * otherwise, return null.
 *
 * @param {NodeGit.Repository}    repo
 * @param {MODE}                  mode
 * @param {NodeGit.Commit}        commit
 * @param {String|null}           message
 * @return {String|null}
 */
exports.fastForwardMerge = co.wrap(function *(repo, mode, commit, message) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isNumber(mode);
    assert.instanceOf(commit, NodeGit.Commit);
    assert.isString(message);

    // Remember the current branch; the checkoutCommit function will move it.

    const branch = yield repo.getCurrentBranch();
    let result = null;
    let newHead;
    if (MODE.FORCE_COMMIT !== mode) {
        // If we're not generating a commit, we just need to checkout the one
        // we're fast-forwarding to.

        yield Checkout.checkoutCommit(repo, commit, false);
        newHead = commit;
    }
    else {
        // Checkout the commit we're fast-forwarding to.

        const head = yield repo.getHeadCommit();
        yield Checkout.checkoutCommit(repo, commit, false);

        // Then, generate a new commit that has the previous HEAD and commit to
        // merge as children.

        const sig = repo.defaultSignature();
        const tree = yield commit.getTree();
        const id = yield NodeGit.Commit.create(
                                           repo,
                                           0,
                                           sig,
                                           sig,
                                           null,
                                           Commit.ensureEolOnLastLine(message),
                                           tree,
                                           2,
                                           [head, commit]);
        newHead = yield repo.getCommit(id);
        result = newHead.id().tostrS();

        // Move HEAD to point to the new commit.

        yield NodeGit.Reset.reset(repo,
                                  newHead,
                                  NodeGit.Reset.TYPE.HARD,
                                  null,
                                  branch.name());
    }

    // If we were on a branch, make it current again.

    if (branch.isBranch()) {
        yield branch.setTarget(newHead, "ffwd merge");
        yield repo.setHead(branch.name());
    }
    return result;
});

/**
 * Perform a fast-forward in the submodule having the specified path.  Use the
 * specified 'opener' to get the submodule repo, if it's open, and move it to
 * the specied 'sha'; stage the change in the specified 'index'.
 */
const doFastForward = co.wrap(function *(opener, index, path, toSha) {
    assert.instanceOf(opener, Open.Opener);
    assert.instanceOf(index, NodeGit.Index);
    assert.isString(path);
    assert.isString(toSha);
    console.log(`Submodule ${colors.blue(path)}: fast-forward to \
${colors.green(toSha)}.`);
    const open = yield opener.isOpen(path);
    if (open) {
        const repo = yield opener.getSubrepo(path);
        const fetcher = yield opener.fetcher();
        yield fetcher.fetchSha(repo, path, toSha);
        const commit = yield repo.getCommit(toSha);
        yield NodeGit.Reset.reset(repo, commit, NodeGit.Reset.TYPE.HARD);
        yield index.addByPath(path);
    }
    yield index.conflictRemove(path);
});


/**
 * Merge the specified `commit` in the specified `repo` having the specified
 * `status`, using the specified `mode` to control whether or not a merge
 * commit will be generated.  Return `null` if the repository is up-to-date, or
 * an object describing generated commits otherwise.  If the optionally
 * specified `commitMessage` is provided, use it as the commit message for any
 * generated merge commit; otherwise, use the specified `editMessage` promise
 * to request a message.  Throw a `UserError` exception if a fast-forward merge
 * is requested and cannot be completed.  Throw a `UserError` if there are
 * conflicts, or if local modifications prevent the merge from happening.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 * @param {MODE}               mode
 * @param {String|null}        commitMessage
 * @param {() -> Promise(String)} editMessage
 * @return {Object|null}
 * @return {String} return.metaCommit
 * @return {Object} return.submoduleCommits  map from submodule to commit
 */
exports.merge = co.wrap(function *(repo,
                                   commit,
                                   mode,
                                   commitMessage,
                                   editMessage) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isNumber(mode);
    assert.instanceOf(commit, NodeGit.Commit);
    if (null !== commitMessage) {
        assert.isString(commitMessage);
    }
    assert.isFunction(editMessage);

    const status = yield StatusUtil.getRepoStatus(repo, {
        showMetaChanges: true,
    });

    // Cannot merge if there is an existing merge

    if (null !== status.merge) {
        throw new UserError(`\
There is an existing merge in progress.  Run 'git meta merge --continue'
to complete it, or 'git meta merge --abort' to abandon it.
`);
    }

    // Cannot merge if any staged changes.

    if (!status.isIndexDeepClean()) {
        throw new UserError("Cannot merge due to staged changes.");
    }

    const result = {
        metaCommit: null,
        submoduleCommits: {},
    };

    const commitSha = commit.id().tostrS();

    const head = yield repo.getHeadCommit();

    if (head.id().tostrS() === commit.id().tostrS()) {
        console.log("Nothing to do.");
        return null;                                                  // RETURN
    }

    const canFF = yield NodeGit.Graph.descendantOf(repo,
                                                   commitSha,
                                                   head.id().tostrS());

    let message = "";

    if (!canFF || MODE.FORCE_COMMIT === mode) {
        if (null === commitMessage) {
            const raw = yield editMessage();
            message = GitUtil.stripMessage(raw);
            if ("" === message) {
                console.log("Empty commit message.");
                return result;
            }
        }
        else {
            message = commitMessage;
        }
    }

    if (MODE.FF_ONLY === mode && !canFF) {
        throw new UserError(`The meta-repository cannot be fast-forwarded to \
${colors.red(commitSha)}.`);
    }
    else if (canFF) {
        console.log(`Fast-forwarding meta-repo to ${colors.green(commitSha)}.`);


        const sha = yield exports.fastForwardMerge(repo,
                                                   mode,
                                                   commit,
                                                   message);
        result.metaCommit = sha;
        return result;
    }


    const sig = repo.defaultSignature();

    // Kick off the merge.  It is important to note is that `Merge.commit` does
    // not directly modify the working directory or index.  The `index`
    // object it returns is magical, virtual, does not operate on HEAD or
    // anything, has no effect.

    const mergeIndex = yield SubmoduleUtil.cacheSubmodules(repo, () => {
        return NodeGit.Merge.commits(repo, head, commit, null);
    });

    const checkoutOpts =  {
        checkoutStrategy: NodeGit.Checkout.STRATEGY.FORCE
    };
    yield SubmoduleUtil.cacheSubmodules(repo, () => {
        return NodeGit.Checkout.index(repo, mergeIndex, checkoutOpts);
    });
    const index = yield repo.index();

    let errorMessage = "";

    const subCommits = result.submoduleCommits;
    const subUrls = yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo,
                                                                      head);
    const headTree = yield head.getTree();
    const opener = new Open.Opener(repo, null);
    const subFetcher = yield opener.fetcher();

    let hasModulesFile = false;

    const mergeEntry = co.wrap(function *(entry) {
        const path = entry.path;
        const stage = RepoStatus.getStage(entry.flags);

        if (path === SubmoduleConfigUtil.modulesFileName) {
            hasModulesFile = true;
            return;                                                   // RETURN
        }
        else if (RepoStatus.STAGE.THEIRS === stage && !(path in subUrls)) {
            errorMessage += `Conflict in ${colors.red(path)}`;
            return;                                                   // RETURN
        }

        // We don't need to do anything with an entry unless it is a conflicted
        // submodule.

        if (!(path in subUrls)) {
            return;                                                   // RETURN
        }

        const subSha = entry.id.tostrS();
        const subCommitId = NodeGit.Oid.fromString(subSha);
        const subEntry = yield headTree.entryByPath(path);
        const subHeadSha = subEntry.sha();

        // If the submodule has a "normal" stage, that means it can be
        // trivially fast-forwarded if there is a change.

        if (RepoStatus.STAGE.NORMAL === stage) {
            if (subSha !== subHeadSha) {
                yield doFastForward(opener, index, path, subSha);
            }
            return;                                                   // RETURN
        }

        // Otherwise, if there is a conflict in the submodule, we'll handle it
        // during the THEIRS entry.

        else if (RepoStatus.STAGE.THEIRS !== stage) {
            return;                                                   // RETURN
        }

        const subRepo = yield opener.getSubrepo(path);

        // Fetch commit to merge.

        yield subFetcher.fetchSha(subRepo, path, subSha);

        const subCommit = yield subRepo.getCommit(subCommitId);

        const upToDate = yield NodeGit.Graph.descendantOf(subRepo,
                                                          subHeadSha,
                                                          subSha);
        if (upToDate) {
            console.log("We're up-to-date with", path);
            yield index.addByPath(path);
            yield index.conflictRemove(path);
            return;                                                   // RETURN
        }

        const canSubFF = yield NodeGit.Graph.descendantOf(subRepo,
                                                          subSha,
                                                          subHeadSha);
        if (canSubFF) {
            yield doFastForward(opener, index, path, subSha);
            return;                                                   // RETURN
        }

        // If we already have the commit being merged in, we don't need to do
        // anything.

        console.log(`Submodule ${colors.blue(path)}: merging commit \
${colors.green(subSha)}.`);

        // Start the merge.

        const subHead = yield subRepo.getCommit(subHeadSha);
        let subIndex = yield NodeGit.Merge.commits(subRepo,
                                                   subHead,
                                                   subCommit,
                                                   null);

        yield NodeGit.Checkout.index(subRepo, subIndex, {
            checkoutStrategy: NodeGit.Checkout.STRATEGY.FORCE,
        });

        // Abort if conflicted.

        if (subIndex.hasConflicts()) {
            const merge = new Merge(message,
                                    subHead.id().tostrS(),
                                    subCommit.id().tostrS());
            yield MergeFileUtil.writeMerge(subRepo.path(), merge);

            errorMessage += `Submodule ${colors.red(path)} is conflicted:\n`;
            const entries = subIndex.entries();
            for (let i = 0; i < entries.length; ++i) {
                const subEntry = entries[i];
                const subStage = RepoStatus.getStage(subEntry.flags);
                if (RepoStatus.STAGE.OURS === subStage) {
                    errorMessage += `\t${colors.red(subEntry.path)}\n`;
                }
            }
            return;                                                   // RETURN
        }

        // Otherwise, finish off the merge.

        subIndex = yield subRepo.index();
        const treeId = yield subIndex.writeTreeTo(subRepo);
        const mergeCommit = yield subRepo.createCommit("HEAD",
                                                       sig,
                                                       sig,
                                                       message,
                                                       treeId,
                                                       [subHead, subCommit]);
        subCommits[path] = mergeCommit.tostrS();

        // Clean up the conflict for this submodule and stage our change.

        yield index.addByPath(path);
        yield index.conflictRemove(path);
    });

    const entries = index.entries();
    yield DoWorkQueue.doInParallel(entries, mergeEntry);

    if (hasModulesFile) {
        const good = yield SubmoduleUtil.mergeModulesFile(repo, head, commit);
        if (!good) {
            errorMessage += `Conflicting submodule additions/removals.`;
        }
        else {
            yield index.addByPath(SubmoduleConfigUtil.modulesFileName);
            yield index.conflictRemove(SubmoduleConfigUtil.modulesFileName);
        }
    }

    // We must write the index here or the staging we've done erlier will go
    // away.
    yield index.write();

    if ("" !== errorMessage) {
        // We're about to fail due to conflict.  First, record that there is a
        // merge in progress so that we can continue or abort it later.

        const merge = new Merge(message,
                                head.id().tostrS(),
                                commit.id().tostrS());
        yield MergeFileUtil.writeMerge(repo.path(), merge);
        throw new UserError(errorMessage);
    }

    console.log(`Merging meta-repo commit ${colors.green(commitSha)}.`);

    const id = yield index.writeTreeTo(repo);

    // And finally, commit it.

    const metaCommit = yield repo.createCommit("HEAD",
                                               sig,
                                               sig,
                                               message,
                                               id,
                                               [head, commit]);

    result.metaCommit = metaCommit.tostrS();

    // Close subs that were opened if no commits were generated to them.

    const closeSub = co.wrap(function *(path) {
        if (!(path in subCommits)) {
            console.log(`Closing ${colors.green(path)} -- no commit created.`);
            yield DeinitUtil.deinit(repo, path);
        }
    });
    const opened = Array.from(yield opener.getOpenedSubs());
    DoWorkQueue.doInParallel(opened, closeSub);
    return result;
});

/**
 * Throw a `UserError` if the specified `index` has non-submodule conflicts and
 * do nothing otherwise.
 *
 * @param {NodeGit.Index} index
 */
const checkForConflicts = function (index) {
    assert.instanceOf(index, NodeGit.Index);
    const entries = index.entries();
    for (let i = 0; i < entries.length; ++i) {
        const entry = entries[i];
        const stage = RepoStatus.getStage(entry.flags);
        if (RepoStatus.STAGE.OURS === stage &&
            NodeGit.TreeEntry.FILEMODE.COMMIT !== entry.mode) {
            throw new UserError("Meta-repo has conflicts.");
        }
    }
};

/**
 * Continue the merge in the specified `repo`.  Throw a `UserError` if there is
 * no merge in progress in `repo` or if `repo` still has outstanding conflicts.
 * Return an object describing generated commits.
 *
 * @param {NodeGit.Repository} repo
 * @return {Object|null}
 * @return {String} return.metaCommit
 * @return {Object} return.submoduleCommits  map from submodule to commit
 */
exports.continue = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const result = {
        metaCommit: null,
        submoduleCommits: {},
    };
    const merge = yield MergeFileUtil.readMerge(repo.path());
    if (null === merge) {
        throw new UserError("No merge in progress.");
    }

    const index = yield repo.index();

    checkForConflicts(index);

    // We have to do this because there may have been outsanding submodule
    // conflicts.  We validated in `checkForConflicts` that there are no "real"
    // conflicts.

    console.log(`Continuing with merge of ${colors.green(merge.mergeHead)}.`);

    let errorMessage = "";

    const continueSub = co.wrap(function *(subPath) {
        const subRepo = yield SubmoduleUtil.getRepo(repo, subPath);
        const subIndex = yield subRepo.index();
        if (subIndex.hasConflicts()) {
            errorMessage +=
                           `Submodule ${colors.red(subPath)} has conflicts.\n`;
            return;                                                   // RETURN
        }
        const sig = subRepo.defaultSignature();
        const subMerge = yield MergeFileUtil.readMerge(subRepo.path());
        if (null === subMerge) {
            // There is no merge in this submodule, but if there are staged
            // changes we need to make a commit.

            const status = yield StatusUtil.getRepoStatus(subRepo, {
                showMetaChanges: true,
            });
            if (!status.isIndexClean()) {
                const id = yield subRepo.createCommitOnHead([],
                                                            sig,
                                                            sig,
                                                            merge.message);
                result.submoduleCommits[subPath] = id.tostrS();
            }
        }
        else {
            // Now, we have a submodule that was in the middle of merging.
            // Continue it and then clean up the merge.

            const head = yield subRepo.getHeadCommit();
            const mergeHead = yield subRepo.getCommit(subMerge.mergeHead);
            const treeId = yield subIndex.writeTreeTo(subRepo);
            const id = yield subRepo.createCommit("HEAD",
                                                  sig,
                                                  sig,
                                                  subMerge.message,
                                                  treeId,
                                                  [head, mergeHead]);
            yield MergeFileUtil.cleanMerge(subRepo.path());
            result.submoduleCommits[subPath] = id.tostrS();
        }
        yield index.addByPath(subPath);
        yield index.conflictRemove(subPath);
    });
    const openSubs = yield SubmoduleUtil.listOpenSubmodules(repo);
    yield DoWorkQueue.doInParallel(openSubs, continueSub);

    yield index.write();

    if ("" !== errorMessage) {
        throw new UserError(errorMessage);
    }
    const treeId = yield index.writeTreeTo(repo);

    const sig = repo.defaultSignature();
    const head = yield repo.getHeadCommit();
    const mergeHead = yield repo.getCommit(merge.mergeHead);
    const metaCommit = yield repo.createCommit("HEAD",
                                               sig,
                                               sig,
                                               merge.message,
                                               treeId,
                                               [head, mergeHead]);
    console.log(
            `Finished with merge commit ${colors.green(metaCommit.tostrS())}`);
    yield MergeFileUtil.cleanMerge(repo.path());
    result.metaCommit = metaCommit.tostrS();
    return result;
});

const resetMerge = co.wrap(function *(repo) {
    // TODO: add this to libgit2
    const execString = `git -C '${repo.workdir()}' reset --merge`;
    yield ChildProcess.exec(execString);
});

/**
 * Abort the merge in progress in the specified `repo`, or throw a `UserError`
 * if no merge is in progress.
 *
 * @param {NodeGit.Repository} repo
 */
exports.abort = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const merge = yield MergeFileUtil.readMerge(repo.path());
    if (null === merge) {
        throw new UserError("No merge in progress.");
    }

    const head = yield repo.getHeadCommit(repo);
    const openSubs = yield SubmoduleUtil.listOpenSubmodules(repo);
    const shas = yield SubmoduleUtil.getSubmoduleShasForCommit(repo,
                                                               openSubs,
                                                               head);
    const index = yield repo.index();
    const abortSub = co.wrap(function *(subName) {
        // Our goal here is to do a 'git reset --merge'.  Ideally, we'd do a
        // soft reset first to put the submodule on the right sha, but you
        // can't do a soft reset "in the middle of a merge", so we do an
        // initial 'git reset --merge' once, then if we're not on the right sha
        // we can do the soft reset -- the 'git reset --merge' cleans up any
        // merge conflicts -- then do one final 'git reset --merge'.

        const subRepo = yield SubmoduleUtil.getRepo(repo, subName);
        yield resetMerge(subRepo);
        const subHead = yield subRepo.getHeadCommit();
        if (subHead.id().tostrS() !== shas[subName]) {
            const commit = yield subRepo.getCommit(shas[subName]);
            yield NodeGit.Reset.reset(subRepo,
                                      commit,
                                      NodeGit.Reset.TYPE.SOFT);
            yield resetMerge(subRepo);
        }
        yield MergeFileUtil.cleanMerge(subRepo.path());
        yield index.addByPath(subName);
    });
    yield DoWorkQueue.doInParallel(openSubs, abortSub);
    yield index.conflictCleanup();
    yield index.write();
    yield resetMerge(repo);
    yield MergeFileUtil.cleanMerge(repo.path());
});
