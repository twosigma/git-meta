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
const CherryPickUtil      = require("./cherry_pick_util");
const Commit              = require("./commit");
const DoWorkQueue         = require("./do_work_queue");
const GitUtil             = require("./git_util");
const Open                = require("./open");
const RepoStatus          = require("./repo_status");
const SequencerState      = require("./sequencer_state");
const SequencerStateUtil  = require("./sequencer_state_util");
const StatusUtil          = require("./status_util");
const SubmoduleRebaseUtil = require("./submodule_rebase_util");
const SubmoduleUtil       = require("./submodule_util");
const UserError           = require("./user_error");

const CommitAndRef = SequencerState.CommitAndRef;
const MERGE = SequencerState.TYPE.MERGE;

/**
 * If there is a sequencer with a merge in the specified `path` return it,
 * otherwise, return null.
 *
 * @param {String} path
 * @return {String|null}
 */
const getSequencerIfMerge = co.wrap(function *(path) {
    const seq = yield SequencerStateUtil.readSequencerState(path);
    if (null !== seq && MERGE === seq.type) {
        return seq;
    }
    return null;
});

/**
 * If there is a sequencer with a merge in the specified `path` return it,
 * otherwise, throw a `UserError` indicating that there is no merge.
 *
 * @param {String} path
 * @return {String}
 */
const checkForMerge = co.wrap(function *(path) {
    const seq = yield getSequencerIfMerge(path);
    if (null === seq) {
        throw new UserError("No merge in progress.");
    }
    return seq;
});

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
 * Merge the specified `subs` in the specified `repo` having the specified
 * `index`.  Stage submodule commits in `metaRepo`.  Return an object
 * describing any commits that were generated and conflicted commits.  Use the
 * specified `opener` to acces submodule repos.  Use the specified `message` to
 * write commit messages.
 * @param {NodeGit.Repository} metaRepo
 * @param {Open.Opener}        opener
 * @param {NodeGit.Index}      metaIndex
 * @param {Object}             subs        map from name to SubmoduleChange
 * @return {Object}
 * @return {Object} return.commits    map from name to map from new to old ids
 * @return {Object} return.conflicts  map from name to commit causing conflict
 */
const mergeSubmodules = co.wrap(function *(repo,
                                           opener,
                                           index,
                                           subs,
                                           message) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(opener, Open.Opener);
    assert.instanceOf(index, NodeGit.Index);
    assert.isObject(subs);
    assert.isString(message);

    const result = {
        conflicts: {},
        commits: {},
    };
    const sig = repo.defaultSignature();
    const fetcher = yield opener.fetcher();
    const mergeSubmodule = co.wrap(function *(name) {
        const subRepo = yield opener.getSubrepo(name);
        const change = subs[name];

        const fromSha = change.newSha;
        yield fetcher.fetchSha(subRepo, name, fromSha);
        const subHead = yield subRepo.getHeadCommit();
        const headSha = subHead.id().tostrS();
        const fromCommit = yield subRepo.getCommit(fromSha);

        // See if up-to-date

        if (yield NodeGit.Graph.descendantOf(subRepo, headSha, fromSha)) {
            return;                                                   // RETURN
        }

        // See if can fast-forward

        if (yield NodeGit.Graph.descendantOf(subRepo, fromSha, headSha)) {
            yield GitUtil.setHeadHard(subRepo, fromCommit);
            yield index.addByPath(name);
            return result;                                            // RETURN
        }

        console.log(`Submodule ${colors.blue(name)}: merging commit \
${colors.green(fromSha)}.`);

        // Start the merge.

        let subIndex = yield NodeGit.Merge.commits(subRepo,
                                                   subHead,
                                                   fromCommit,
                                                   null);

        yield NodeGit.Checkout.index(subRepo, subIndex, {
            checkoutStrategy: NodeGit.Checkout.STRATEGY.FORCE,
        });

        // Abort if conflicted.

        if (subIndex.hasConflicts()) {
            const seq = new SequencerState({
                type: MERGE,
                originalHead: new CommitAndRef(subHead.id().tostrS(), null),
                target: new CommitAndRef(fromSha, null),
                currentCommit: 0,
                commits: [fromSha],
                message: message,
            });
            yield SequencerStateUtil.writeSequencerState(subRepo.path(), seq);
            result.conflicts[name] = fromSha;
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
                                                       [subHead, fromCommit]);
        result.commits[name] = mergeCommit.tostrS();

        // Clean up the conflict for this submodule and stage our change.

        yield index.addByPath(name);
        yield index.conflictRemove(name);
    });
    yield DoWorkQueue.doInParallel(Object.keys(subs), mergeSubmodule);
    return result;
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
 * Throw a `UserError` if there are no commits in common between `commit` and
 * the HEAD commit of `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 * @param {MODE}               mode
 * @param {String|null}        commitMessage
 * @param {() -> Promise(String)} editMessage
 * @return {Object}
 * @return {String|null} return.metaCommit
 * @return {Object}      return.submoduleCommits  map from submodule to commit
 * @return {String|null} return.errorMessage
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

    const head = yield repo.getHeadCommit();
    const baseCommit = yield GitUtil.getMergeBase(repo, commit, head);

    if (null === baseCommit) {
        throw new UserError(`\
No commits in common with \
${colors.red(GitUtil.shortSha(commit.id().tostrS()))}`);
    }

    yield CherryPickUtil.ensureNoURLChanges(repo, commit, baseCommit);

    const result = {
        metaCommit: null,
        submoduleCommits: {},
        errorMessage: null,
    };

    const status = yield StatusUtil.getRepoStatus(repo);
    StatusUtil.ensureReady(status);
    if (!status.isDeepClean(false)) {
        // TODO: Git will refuse to run if there are staged changes, but will
        // attempt a merge if there are just workdir changes.  We should
        // support this in the future, but it basically requires us to dry-run
        // the merges in all the submodules.

        throw new UserError(`\
The repository has uncommitted changes.  Please stash or commit them before
running merge.`);
    }

    const commitSha = commit.id().tostrS();

    if (head.id().tostrS() === commit.id().tostrS()) {
        console.log("Nothing to do.");
        return result;
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

    const changes = yield CherryPickUtil.computeChanges(repo, commit, true);
    const index = yield repo.index();
    const opener = new Open.Opener(repo, null);

    // Perform simple changes that don't require picks -- addition, deletions,
    // and fast-forwards.

    yield CherryPickUtil.changeSubmodules(repo,
                                          opener,
                                          index,
                                          changes.simpleChanges);

    // Render any conflicts

    let errorMessage =
           yield CherryPickUtil.writeConflicts(repo, index, changes.conflicts);

    // Then do the submodule merges

    const merges =
          yield mergeSubmodules(repo, opener, index, changes.changes, message);
    result.submoduleCommits = merges.commits;
    const conflicts = merges.conflicts;

    yield CherryPickUtil.closeSubs(opener, merges);

    Object.keys(conflicts).sort().forEach(name => {
        errorMessage += SubmoduleRebaseUtil.subConflictErrorMessage(name);
    });

    // We must write the index here or the staging we've done erlier will go
    // away.
    yield GitUtil.writeMetaIndex(repo, index);

    if ("" !== errorMessage) {
        // We're about to fail due to conflict.  First, record that there is a
        // merge in progress so that we can continue or abort it later.
        // TODO: some day when we make use of it, write the ref name for HEAD

        const seq = new SequencerState({
            type: MERGE,
            originalHead: new CommitAndRef(head.id().tostrS(), null),
            target: new CommitAndRef(commit.id().tostrS(), null),
            currentCommit: 0,
            commits: [commit.id().tostrS()],
            message: message,
        });
        yield SequencerStateUtil.writeSequencerState(repo.path(), seq);
        result.errorMessage = errorMessage;
    } else {

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
    }
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
        const stage = NodeGit.Index.entryStage(entry);
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
    const seq = yield checkForMerge(repo.path());
    const index = yield repo.index();

    checkForConflicts(index);

    // We have to do this because there may have been outsanding submodule
    // conflicts.  We validated in `checkForConflicts` that there are no "real"
    // conflicts.

    console.log(`Continuing with merge of ${colors.green(seq.target.sha)}.`);

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
        const subSeq = yield getSequencerIfMerge(subRepo.path());
        if (null === subSeq) {
            // There is no merge in this submodule, but if there are staged
            // changes we need to make a commit.

            const status = yield StatusUtil.getRepoStatus(subRepo, {
                showMetaChanges: true,
            });
            if (!status.isIndexClean()) {
                const id = yield subRepo.createCommitOnHead([],
                                                            sig,
                                                            sig,
                                                            seq.message);
                result.submoduleCommits[subPath] = id.tostrS();
            }
        }
        else {
            // Now, we have a submodule that was in the middle of merging.
            // Continue it and then clean up the merge.

            const head = yield subRepo.getHeadCommit();
            const mergeHead = yield subRepo.getCommit(subSeq.target.sha);
            const treeId = yield subIndex.writeTreeTo(subRepo);
            const id = yield subRepo.createCommit("HEAD",
                                                  sig,
                                                  sig,
                                                  subSeq.message,
                                                  treeId,
                                                  [head, mergeHead]);
            yield SequencerStateUtil.cleanSequencerState(subRepo.path());
            result.submoduleCommits[subPath] = id.tostrS();
        }
        yield index.addByPath(subPath);
        yield index.conflictRemove(subPath);
    });
    const openSubs = yield SubmoduleUtil.listOpenSubmodules(repo);
    yield DoWorkQueue.doInParallel(openSubs, continueSub);
    yield GitUtil.writeMetaIndex(repo, index);

    if ("" !== errorMessage) {
        throw new UserError(errorMessage);
    }
    const treeId = yield index.writeTreeTo(repo);

    const sig = repo.defaultSignature();
    const head = yield repo.getHeadCommit();
    const mergeHead = yield repo.getCommit(seq.target.sha);
    const metaCommit = yield repo.createCommit("HEAD",
                                               sig,
                                               sig,
                                               seq.message,
                                               treeId,
                                               [head, mergeHead]);
    console.log(
            `Finished with merge commit ${colors.green(metaCommit.tostrS())}`);
    yield SequencerStateUtil.cleanSequencerState(repo.path());
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

    yield checkForMerge(repo.path());

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
        yield SequencerStateUtil.cleanSequencerState(subRepo.path());
        yield index.addByPath(subName);
    });
    yield DoWorkQueue.doInParallel(openSubs, abortSub);
    yield index.conflictCleanup();
    yield GitUtil.writeMetaIndex(repo, index);
    yield resetMerge(repo);
    yield SequencerStateUtil.cleanSequencerState(repo.path());
});
