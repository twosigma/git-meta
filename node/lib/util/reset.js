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

const assert  = require("chai").assert;
const co      = require("co");
const NodeGit = require("nodegit");

const SubmoduleUtil = require("./submodule_util");
const GitUtil       = require("./git_util");

const TYPE = {
    SOFT: "soft",
    MIXED: "mixed",
    HARD: "hard",
};
Object.freeze(TYPE);
exports.TYPE = TYPE;

/**
 * Return the `NodeGit.Reset.TYPE` value from the specified `type`.
 * @param {TYPE} type
 * @return {NodeGit.Reset.TYPE}
 */
function getType(type) {
    switch (type) {
        case TYPE.SOFT : return NodeGit.Reset.TYPE.SOFT;
        case TYPE.MIXED: return NodeGit.Reset.TYPE.MIXED;
        case TYPE.HARD : return NodeGit.Reset.TYPE.HARD;
    }
    assert(false, `Bad type: ${type}`);
}

/**
 * Change the `HEAD` commit to the specified `commit` in the specified `repo`,
 * unstaging any staged changes.  Reset all open submodule in the same way to
 * the commit indicated by `commit`.  If the specified `type` is `SOFT`,
 * preserve the current index.  If `type` is `MIXED`, preserve the working
 * directory.  If `type` is `HARD`, set both index and working directory to the
 * tree specified by `commit`.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 * @param {TYPE}               type
 */
exports.reset = co.wrap(function *(repo, commit, type) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    assert.isString(type);

    const resetType = getType(type);

    // First, reset the meta-repo.

    yield NodeGit.Reset.reset(repo, commit, resetType);

    // Then, all open subs.

    const openNames = yield SubmoduleUtil.listOpenSubmodules(repo);
    const index = yield repo.index();
    const shas = yield SubmoduleUtil.getCurrentSubmoduleShas(index, openNames);

    yield openNames.map(co.wrap(function *(name, index) {
        const sha = shas[index];
        const subRepo = yield SubmoduleUtil.getRepo(repo, name);

        // Fetch the sha in case we don't already have it.

        yield GitUtil.fetchSha(subRepo, sha);

        const subCommit = yield subRepo.getCommit(sha);
        yield NodeGit.Reset.reset(subRepo, subCommit, resetType);
    }));
});
