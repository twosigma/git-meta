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

const assert  = require("chai").assert;
const co      = require("co");
const fsp     = require("fs-promise");
const path    = require("path");
const NodeGit = require("nodegit");
const TestUtil        = require("../../lib/util/test_util");
const SyntheticGcUtil = require("../../lib/util/synthetic_gc_util");
const SubmoduleConfigUtil = require("../../lib/util/submodule_config_util");
const DeinitUtil          = require("../../lib/util/deinit_util");
const SYNTHETIC_BRANCH_BASE = "refs/commits/";

// HELPER FUNCTIONS
//------------------------------------------------------------------------------
const createCommit = function*(repo, contents, fileName, message) {
    const index = yield repo.index();

    yield contents(repo, index, fileName, message);

    const sig = NodeGit.Signature.create("A U Thor", "author@example.com",
                                         1475535185, -4*60);
    return yield repo.createCommitOnHead([fileName], sig, sig, "a commit");
};

const addFile = function*(repo, index, fileName, message) {
    yield fsp.writeFile(path.join(repo.workdir(), fileName), message);
    yield index.addByPath(fileName);
};

const setupRepo = co.wrap(function *(repo,
                                   subRootRepo,
                                   url,
                                   subName) {
    const originUrl = "";
    const subHead = yield subRootRepo.getHeadCommit();
    const submodule   = yield NodeGit.Submodule.addSetup(repo,
                                                         url,
                                                         subName,
                                                         1);
    const subRepo = yield submodule.open();
    yield subRepo.fetchAll();
    subRepo.setHeadDetached(subHead.id());
    const newHead = yield subRepo.getCommit(subHead.id().tostrS());
    yield NodeGit.Reset.reset(subRepo,
                              newHead,
                              NodeGit.Reset.TYPE.HARD);
    yield submodule.addFinalize();
    const sig = repo.defaultSignature();
    yield repo.createCommitOnHead([".gitmodules", subName],
                                  sig,
                                  sig,
                                  "my message");
    yield DeinitUtil.deinit(repo, subName);
    const result = yield SubmoduleConfigUtil.initSubmoduleAndRepo(
                                                             originUrl,
                                                             repo,
                                                             subName,
                                                             url,
                                                             null);
    return result;
});

let isDeletable = function() {
    return true;
};

let isOlderThanToday = function(input) {
    let threshold = new Date();
    threshold.setMonth(threshold.getMonth() - 6);

    return input.date() < threshold;
};

let isOlderThanTomorrow = function(input) {
    let threshold = new Date();
    threshold.setDate(threshold.getDate() + 1);

    return input.date() < threshold;
};
//------------------------------------------------------------------------------

describe("synthetic_gc_util", function () {

    // TESTING:  'synthetic_gc_util:recursiveSyntheticRefRemoval'
    //
    // Concern:
    //  1) Parents of a commit pointed by persistent ref. should be deleted.
    //  2) Nothing should actually be deleted in simulation mode.
    //
    // Plan:
    //  1) Make two commits to the same ref and observe that parent commit is
    //     deleted. (C-1)
    //  2) Run 'recursiveSyntheticRefRemoval' in simulation first, and observe
    //     that no changes made. (C-2)
    //
    it("parent_of_persistent", co.wrap(function *() {
        const syntheticGcUtil = new SyntheticGcUtil();
        const root = yield TestUtil.makeTempDir();
        const rootDirectory = yield fsp.realpath(root);
        const repo = yield NodeGit.Repository.init(rootDirectory, 0);

        const oid1 = yield createCommit(repo, addFile, "TEST1", "Hello1");
        let syntheticRefName1 = SYNTHETIC_BRANCH_BASE + oid1.toString();
        yield NodeGit.Reference.create(repo, syntheticRefName1,
            oid1, 1, "TEST1 commit");

        const oid2 = yield createCommit(repo, addFile, "TEST2", "Hello2");
        let syntheticRefName2 = SYNTHETIC_BRANCH_BASE + oid2.toString();
        yield NodeGit.Reference.create(repo, syntheticRefName2,
            oid2, 1, "TEST2 commit");

        // First check that we can extract all synthetic refs.
        let EXPECTED_SYNTHETIC_REFS = 2;
        let allSyntheticRefs = yield syntheticGcUtil.getSyntheticRefs(repo);
        assert.equal(allSyntheticRefs.length, EXPECTED_SYNTHETIC_REFS);
        assert(allSyntheticRefs.includes(oid1.toString()));
        assert(allSyntheticRefs.includes(oid2.toString()));

        const lastCommit = yield repo.getCommit(oid2);
        // Then, we will try to run in simulation mode(default),
        // this should do nothing.
        yield syntheticGcUtil.recursiveSyntheticRefRemoval(repo, lastCommit,
                                           isDeletable,
                                           allSyntheticRefs);

        allSyntheticRefs = yield syntheticGcUtil.getSyntheticRefs(repo);
        assert.equal(allSyntheticRefs.length, EXPECTED_SYNTHETIC_REFS);
        assert(allSyntheticRefs.includes(oid1.toString()));
        assert(allSyntheticRefs.includes(oid2.toString()));

        // Now, lets disable simulation, and observe the effects
        // We should see that refs for parent of last commit be deleted.
        syntheticGcUtil.simulation = false;
        syntheticGcUtil.visited = {};
        yield syntheticGcUtil.recursiveSyntheticRefRemoval(repo, lastCommit,
                                           isDeletable,
                                           allSyntheticRefs);

        EXPECTED_SYNTHETIC_REFS = 1;
        allSyntheticRefs = yield syntheticGcUtil.getSyntheticRefs(repo);
        assert.equal(allSyntheticRefs.length, EXPECTED_SYNTHETIC_REFS);
        assert(!allSyntheticRefs.includes(oid1.toString()));
        assert(allSyntheticRefs.includes(oid2.toString()));
    }));


    // TESTING:  'synthetic_gc_util:populate_roots'
    //
    // Concern:
    //  1) 'populate_root' should have a mapping of submodule path to last
    //      commit per reference.
    //
    // Plan:
    //  1) Make two commits to the same submodule/same ref and observe that
    //     root has one key that is a path of the submodule mapped to a Set
    //     with one commit pointing to head of submodule. (C-1)
    //
    it("populate_roots", co.wrap(function *() {
        const syntheticGcUtil = new SyntheticGcUtil();
        const repo        = yield TestUtil.createSimpleRepository();

        const subRootRepo = yield TestUtil.createSimpleRepository();
        yield createCommit(subRootRepo, addFile, "TEST1", "Hello1");
        const oid2 = yield createCommit(subRootRepo,
            addFile, "TEST2", "Hello2");

        const url         = subRootRepo.workdir();
        yield setupRepo(repo, subRootRepo, subRootRepo.workdir(), "foo");

        // roots should contain only last commit.
        const EXPECTED_ROOT_KEY = url + ".git/";
        const EXPECTED_ROOT_SIZE = 1;
        const EXPECTED_COMMIT = oid2;

        const roots = yield syntheticGcUtil.populateRoots(repo);
        assert(EXPECTED_ROOT_KEY in roots);
        assert(EXPECTED_ROOT_SIZE, roots[EXPECTED_ROOT_KEY].size);
        const actualCommit = roots[EXPECTED_ROOT_KEY].values().next().value;
        assert.equal(actualCommit.toString(), EXPECTED_COMMIT.toString());
    }));

    // TESTING:  'synthetic_gc_util:cleanUpOldRefs'
    //
    // Concern:
    //  1) 'cleanUpOldRefs' should delete all synthetic references that are
    //     older that specified date.
    //  2) It should not delete synthetic references that are part of the root
    //     references (i.e master) even if it is old.
    //
    // Plan:
    //  1) Create a submodule with two commits on the same persistent ref.
    //
    //     - Run 'cleanUpOldRefs' with today date as threshold. Observe that
    //       no synthetic ref is being deleted.
    //
    //     - Run 'cleanUpOldRefs' with tomorrow date as threshold. Observe that
    //       all but the last synthetic ref is being deleted.
    //
    it("cleanUpOldRefs", co.wrap(function *() {
        const syntheticGcUtil = new SyntheticGcUtil();
        syntheticGcUtil.simulation = false;
        const repo        = yield TestUtil.createSimpleRepository();
        const subRootRepo = yield TestUtil.createSimpleRepository();

        const subCommit = yield subRootRepo.getHeadCommit();
        let syntheticRefName1 = SYNTHETIC_BRANCH_BASE + subCommit.toString();
        yield NodeGit.Reference.create(subRootRepo, syntheticRefName1,
            subCommit, 1, "TEST1 commit");

        const oid2 = yield createCommit(subRootRepo, addFile,
                                        "coTEST2", "coHello2");
        let syntheticRefName2 = SYNTHETIC_BRANCH_BASE + oid2.toString();
        yield NodeGit.Reference.create(subRootRepo, syntheticRefName2,
            oid2, 1, "TEST2 commit");

        yield setupRepo(repo, subRootRepo, subRootRepo.workdir(), "foo");

        const roots = yield syntheticGcUtil.populateRoots(repo);

        let originalSyntheticRefs
            = yield syntheticGcUtil.getSyntheticRefs(subRootRepo);

        yield syntheticGcUtil.cleanUpOldRefs(repo, roots, isOlderThanToday);

        let newSyntheticRefs =
            yield syntheticGcUtil.getSyntheticRefs(subRootRepo);
        assert.equal(originalSyntheticRefs.toString(),
                     newSyntheticRefs.toString());

        // Now we go into the future, that should delete one of our 'old' non
        // reserved commits.
        syntheticGcUtil.visited = {};
        yield syntheticGcUtil.cleanUpOldRefs(repo, roots, isOlderThanTomorrow);

        newSyntheticRefs = yield syntheticGcUtil.getSyntheticRefs(subRootRepo);
        assert.equal(newSyntheticRefs.toString(), oid2.toString());
    }));
});

