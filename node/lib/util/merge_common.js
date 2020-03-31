/*
 * Copyright (c) 2019, Two Sigma Open Source
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

const assert                = require("chai").assert;
const CherryPickUtil        = require("./cherry_pick_util");
const co                    = require("co");
const ConfigUtil            = require("./config_util");
const GitUtil               = require("./git_util");
const NodeGit               = require("nodegit");
const Open                  = require("./open");
const UserError             = require("./user_error");

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
 * @class MergeContext
 * A class that manages the necessary objects for merging.
 */
class MergeContext {
    /**
    * @param {NodeGit.Repository}      repo
    * @param {NodeGit.Commit|null}     ourCommit
    * @param {NodeGit.Commit}          theirCommit
    * @param {MergeCommon.MODE}        mode
    * @param {Open.SUB_OPEN_OPTION}    openOption
    * @param {[String]}                doNotRecurse
    * @param {String|null}             commitMessage
    * @param {() -> Promise(String)}   editMessage
    */
    constructor(metaRepo,
                ourCommit,
                theirCommit,
                mode,
                openOption,
                doNotRecurse,
                commitMessage,
                editMessage,
                authorName,
                authorEmail,
                committerName,
                committerEmail) {
        assert.instanceOf(metaRepo, NodeGit.Repository);
        if (null !== ourCommit) {
            assert.instanceOf(ourCommit, NodeGit.Commit);
        }
        assert.instanceOf(theirCommit, NodeGit.Commit);
        assert.isNumber(mode);
        assert.isNumber(openOption);
        if (null !== commitMessage) {
            assert.isString(commitMessage);
        }
        assert.isFunction(editMessage);
        this.d_metaRepo = metaRepo;
        this.d_ourCommit = ourCommit;
        this.d_theirCommit = theirCommit;
        this.d_mode = mode;
        this.d_openOption = openOption;
        this.d_doNotRecurse = doNotRecurse;
        this.d_commitMessage = commitMessage;
        this.d_editMessage = editMessage;
        this.d_opener = new Open.Opener(metaRepo, ourCommit);
        this.d_changeIndex = null;
        this.d_changes = null;
        this.d_conflictsMessage = "";
        this.d_authorName = authorName;
        this.d_authorEmail = authorEmail;
        this.d_committerName = committerName;
        this.d_committerEmail = committerEmail;
    }

    /**
     * @property {Boolean} forceBare if working directory is disabled
     */
    get forceBare() {
        return Open.SUB_OPEN_OPTION.FORCE_BARE === this.d_openOption;
    }

    /**
     * @property {NodeGit.Repository}
     */
    get metaRepo() {
        return this.d_metaRepo;
    }

    /**
     * @property {Opener}
     */
    get opener() {
        return this.d_opener;
    }

    /**
     * @property {NodeGit.Commit}
     */
    get theirCommit() {
        return this.d_theirCommit;
    }

    /**
     * @property {Open.SUB_OPEN_OPTION}
     */
    get openOption() {
        return this.d_openOption;
    }


    /**
     * @property {[String]}
     */
    get doNotRecurse() {
        return this.d_doNotRecurse;
    }

    /**
     * @property {MODE}
     */
    get mode() {
        return this.d_mode;
    }

    /**
     * Reference to update when creating the merge commit
     * @property {String | null}
     */
    get refToUpdate() {
        return this.forceBare ? null : "HEAD";
    }
}

/**
 * @async
 * @return {Object} return from sub name to `SubmoduleChange`
 * @return {Object} return.simpleChanges from sub name to `Submodule`
 * @return {Object} return.changes from sub name to `Submodule`
 * @return {Object} return.conflicts from sub name to `Conflict`
 */
MergeContext.prototype.getChanges = co.wrap(function *() {
    if (null === this.d_changes) {
        this.d_changes =
            yield CherryPickUtil.computeChangesBetweenTwoCommits(
                this.d_metaRepo,
                yield this.getChangeIndex(),
                yield this.getOurCommit(),
                this.d_theirCommit,
                this.d_doNotRecurse);
    }
    return this.d_changes;
});

/**
 * @async
 * @return {NodeGit.Commit} return left side merge commit
 */
MergeContext.prototype.getOurCommit = co.wrap(function *() {
    if (null !== this.d_ourCommit) {
        return this.d_ourCommit;
    }
    if (this.forceBare) {
        throw new UserError("Left side merge commit is undefined!");
    }
    this.d_ourCommit = yield this.d_metaRepo.getHeadCommit();
    return this.d_ourCommit;
});

/**
 * return an index object that contains the merge changes and whose tree
 * representation will be flushed to disk.
 * @async
 * @return {NodeGit.Index}
 */
MergeContext.prototype.getIndexToWrite = co.wrap(function *() {
    return this.forceBare ?
        yield this.getChangeIndex() :
        yield this.d_metaRepo.index();
});

/**
 * in memeory index object by merging `ourCommit` and `theirCommit`
 * @return {NodeGit.Index}
 */
MergeContext.prototype.getChangeIndex = co.wrap(function *() {
    if (null !== this.d_changeIndex) {
        return this.d_changeIndex;
    }
    this.d_changeIndex = yield NodeGit.Merge.commits(this.d_metaRepo,
        yield this.getOurCommit(),
        this.d_theirCommit,
        []);
    return this.d_changeIndex;
});

/**
 * Return the previously set/built commit message, or use the callback to
 * build commit messsage. Once built, the commit message will be cached.
 *
 * @async
 * @return {String} commit message
 */
MergeContext.prototype.getCommitMessage = co.wrap(function *() {
    const message = (null === this.d_commitMessage) ?
        GitUtil.stripMessage(yield this.d_editMessage()) :
        this.d_commitMessage;
    if ("" === message) {
        console.log("Empty commit message.");
    }
    return message;
});

/**
 * @async
 * @returns {NodeGit.Signature}
 */
MergeContext.prototype.getSig = co.wrap(function *() {
    return yield ConfigUtil.defaultSignature(this.d_metaRepo);
});

/**
 * @async
 * @returns {NodeGit.Signature} author to be set with merge commit
 */
MergeContext.prototype.getAuthor = co.wrap(function *() {
    if (this.d_authorName && this.d_authorEmail) {
        return NodeGit.Signature.now(
            this.d_authorName,
            this.d_authorEmail);
    }
    return yield ConfigUtil.defaultSignature(this.d_metaRepo);
});

/**
 * @async
 * @returns {NodeGit.Signature} committer to be set with merge commit
 */
MergeContext.prototype.getCommitter = co.wrap(function *() {
    if (this.d_committerName && this.d_committerEmail) {
        return NodeGit.Signature.now(
            this.d_committerName,
            this.d_committerEmail);
    }
    return yield ConfigUtil.defaultSignature(this.d_metaRepo);
});

/**
 * @async
 * @returns {SubmoduleFetcher}
 */
MergeContext.prototype.getFetcher = co.wrap(function *() {
    return yield this.d_opener.fetcher();
});

exports.MergeContext = MergeContext;

/**
 * A class that tracks result from merging steps.
 */
class MergeStepResult {

    /**
     * @param {String | null} infoMessage message to display to user
     * @param {String | null} errorMessage message signifies a fatal error
     * @param {String | null} finishSha commit sha indicating end of merge
     * @param {Object} submoduleCommits map from submodule to commit
     */
    constructor(infoMessage, errorMessage, finishSha, submoduleCommits) {
        this.d_infoMessage = infoMessage;
        this.d_errorMessage = errorMessage;
        this.d_finishSha = finishSha;
        this.d_submoduleCommits = submoduleCommits;
    }

    /**
     * @property {String|null}
     */
    get errorMessage() {
        return this.d_errorMessage;
    }

    /**
     * @property {String|null}
     */
    get infoMessage() {
        return this.d_infoMessage;
    }

    /**
     * @property {String|null}
     */
    get finishSha() {
        return this.d_finishSha;
    }

    /**
     * @property {Object} map from submodule to commit
     */
    get submoduleCommits() {
        if (null === this.d_submoduleCommits) {
            return {};
        }
        return this.d_submoduleCommits;
    }

    /**
     * @static
     * @return {MergeStepResult} empty result object
     */
    static empty() {
        return new MergeStepResult(null, null, null, {});
    }

    /**
     * A merge result that signifies we need to abort current merging process.
     *
     * @static
     * @param {MergeStepResult} msg error message
     */
    static error(msg) {
        return new MergeStepResult(null, msg, null, {});
    }
    /**
     * A merge result that does not have any submodule commit. Only a finishing
     * sha at the meta repo level will be returned.
     *
     * @static
     * @param {String} infoMessage
     * @param {String} finishSha meta repo commit sha
     */
    static justMeta(infoMessage, finishSha) {
        return new MergeStepResult(infoMessage, null, finishSha, {});
    }
}

exports.MergeStepResult = MergeStepResult;
