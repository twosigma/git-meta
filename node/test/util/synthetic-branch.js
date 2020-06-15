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
const fsp     = require("fs-promise");
const path    = require("path");
const NodeGit = require("nodegit");
const SyntheticBranch = require("../../lib/util/synthetic_branch_util");
const UserError       = require("../../lib/util/user_error");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");
const TestUtil        = require("../../lib/util/test_util");

describe("synthetic-branch", function () {
    const syntheticBranch = co.wrap(function *(repos) {
        const x = repos.x;
        const notesRepo = repos.n || repos.x;
        const config = yield x.config();
        yield config.setString("gitmeta.subreporootpath", "../../");
        yield config.setString("gitmeta.skipsyntheticrefpattern",
                               "skip");

        const head = yield x.getHeadCommit();

        let old = "0000000000000000000000000000000000000000";
        try {
            const from = yield x.getReferenceCommit("from");
            old = from.id().toString();
        }
        catch (e) {
            /* It's OK if there's no "from" branch -- we just
               treat it as a new branch with no previous
               value. */
        }
        const headId = head.id().toString();
        const pass = yield SyntheticBranch.checkUpdate(x, notesRepo, old,
                                                       headId, {});
        if (!pass) {
            throw new UserError("fail");
        }
    });

    const cases = {
        "simplest": {
            input: "x=S:C8-2;C2-1;Bmaster=8",
            expected: "x=S:C8-2;C2-1;Bmaster=8;" +
                "N refs/notes/git-meta/subrepo-check 8=ok;" +
                "N refs/notes/git-meta/subrepo-check 2=ok",
        },
        "read a note, do nothing": {
            input: "x=S:C8-2;C2-1;Bmaster=8;" +
                "N refs/notes/git-meta/subrepo-check 8=ok",
            expected: "x=S:C8-2;C2-1;Bmaster=8;" +
                "N refs/notes/git-meta/subrepo-check 8=ok",
        },
        "notes block previous (even bad) history": {
            input: "x=S:C2-1;C3-2 y/z=S/z:5;C4-3;Bmaster=4;" +
                "N refs/notes/git-meta/subrepo-check 3=ok|" +
                "z=S:C5-1;Bmaster=5",
            expected: "x=S:C2-1;C3-2 y/z=S/z:5;C4-3;Bmaster=4;" +
                "N refs/notes/git-meta/subrepo-check 3=ok;" +
                "N refs/notes/git-meta/subrepo-check 4=ok|" +
                "z=S:C5-1;Bmaster=5",
        },
        "old shas block previous (even bad) history": {
            input: "x=S:C2-1;C3-2 y/z=S/z:5;C4-3;Bmaster=4;Bfrom=3|" +
                "z=S:C5-1;Bmaster=5",
            expected: "x=S:C2-1;C3-2 y/z=S/z:5;C4-3;Bmaster=4;Bfrom=3;" +
                "N refs/notes/git-meta/subrepo-check 4=ok|" +
                "z=S:C5-1;Bmaster=5",
        },
        //in these tests, we point meta's y to a commit which doesn't exist
        //inside y's repo -- to do this, we use an otherwise unused submodule
        //called 'u'.
        "with a submodule but no synthetic branch": {
            input: "x=S:C2-1;C3-2 y=S/y:7;Bmaster=3|y=S:C4-1;Bmaster=4" +
                "|u=S:C7-1;Bmaster=7",
            expected: "x=S:C2-1;C3-2 y=S/y:7;Bmaster=3|y=S:C4-1;Bmaster=4" +
                "|u=S:C7-1;Bmaster=7",
            fails: true
        },
        "with a submodule in a subdir but no synthetic branch": {
            input: "x=S:C2-1;C3-2 y/z=S/z:7;Bmaster=3|z=S:C4-1;Bmaster=4" +
                "|u=S:C7-1;Bmaster=7",
            expected: "x=S:C2-1;C3-2 y/z=S/z:7;Bmaster=3|z=S:C4-1;Bmaster=4" +
                "|u=S:C7-1;Bmaster=7",
            fails: true
        },
        "with a submodule in a subdir, bad parent commit": {
            input: "x=S:C2-1;C3-2 y/z=S/z:7;C4-3;Bmaster=4" +
                "|z=S:C5-1;Bmaster=5" +
                "|u=S:C7-1;Bmaster=7",
            expected: "x=S:C2-1;C3-2 y/z=S/z:7;C4-3;Bmaster=4" +
                "|z=S:C5-1;Bmaster=5" +
                "|u=S:C7-1;Bmaster=7",
            fails: true
        },
        "with a submodule in a subdir, bad merge commit": {
            input: "x=S:C2-1;C3-2 y/z=S/z:7;C4-3,1;Bmaster=4" +
                "|z=S:C5-1;Bmaster=5" +
                "|u=S:C7-1;Bmaster=7",
            expected: "x=S:C2-1;C3-2 y/z=S/z:7;C4-3,1;Bmaster=4" +
                "|z=S:C5-1;Bmaster=5" +
                "|u=S:C7-1;Bmaster=7",
            fails: true
        },
        "with a submodule, at meta commit": {
            input: "x=S:C2-1;C3-2 y=S/y:4;Bmaster=3|" +
                "y=S:C4-1;Bmaster=4",
            expected: "x=S:C2-1;C3-2 y=S/y:4;Bmaster=3;" +
                "N refs/notes/git-meta/subrepo-check 2=ok;" +
                "N refs/notes/git-meta/subrepo-check 3=ok|" +
                "y=S:C4-1;Bmaster=4",
        },
        "with a change to a submodule which was deleted on master": {
            input: "x=S:C2-1 s=S/s:9;C3-2 s;Bmaster=3;C4-2 s=S/s:8" +
                ";Btombstone=4" +
                "|u=S:C9-1;Bmaster=9" +
                "|s=S:C8-7;C7-1;Bmaster=8",
            expected: "x=S:C2-1 s=S/s:9;C3-2 s;Bmaster=3;C4-2 s=S/s:8" +
                ";Btombstone=4" +
                "|u=S:C9-1;Bmaster=9" +
                "|s=S:C8-7;C7-1;Bmaster=8",
            fails: true
        },
        // This one should fail, but is in skipped URIs, so it passes.
        "with a submodule but no synthetic branch but ignored": {
            input: "x=S:C2-1;C3-2 y=S/skip:7;Bmaster=3" +
                "|y=S:C4-1;Bmaster=4" +
                "|u=S:C7-1;Bmaster=7",
            expected: "x=S:C2-1;C3-2 y=S/skip:7;Bmaster=3;" +
                "N refs/notes/git-meta/subrepo-check 2=ok;" +
                "N refs/notes/git-meta/subrepo-check 3=ok" +
                "|y=S:C4-1;Bmaster=4|u=S:C7-1;Bmaster=7"
        },
        "with a submodule in a subdir, at meta commit": {
            input: "x=S:C2-1;C3-2 y/z=S/z:4;Bmaster=3|" +
                "z=S:C4-1;Bmaster=4",
            expected: "x=S:C2-1;C3-2 y/z=S/z:4;Bmaster=3;" +
                "N refs/notes/git-meta/subrepo-check 2=ok;" +
                "N refs/notes/git-meta/subrepo-check 3=ok|" +
                "z=S:C4-1;Bmaster=4",
        },
        "with a submodule in a subdir, from earlier meta-commit": {
            input: "x=S:C2-1 y/z=S/z:4;C3-2;Bmaster=3|" +
                "z=S:C4-1;Bmaster=4",
            expected: "x=S:C2-1 y/z=S/z:4;C3-2;Bmaster=3;" +
                "N refs/notes/git-meta/subrepo-check 2=ok;" +
                "N refs/notes/git-meta/subrepo-check 3=ok|" +
                "z=S:C4-1;Bmaster=4",
        },
        "with a submodule in a subdir, irrelevant change": {
            input: "x=S:C2-1 y/z=S/z:4;C3-2 y/foo=bar;Bmaster=3|" +
                "z=S:C4-1;Bmaster=4",
            expected: "x=S:C2-1 y/z=S/z:4;C3-2 y/foo=bar;Bmaster=3;" +
                "N refs/notes/git-meta/subrepo-check 2=ok;" +
                "N refs/notes/git-meta/subrepo-check 3=ok|" +
                "z=S:C4-1;Bmaster=4",
        },
    };

    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            yield RepoASTTestUtil.testMultiRepoManipulator(c.input,
                                                           c.expected,
                                                           syntheticBranch,
                                                           c.fails);

            // Test with notes in a separate repo -- we need to create
            // that repo, and make sure it's the one that gets written to and
            // read from.

            let input;
            if (c.input.includes("N")) {
                input = c.input.replace(/N[^|]* /, "|n=B:C5-1;Bmaster=5;$&");
            } else {
                input = c.input + "|n=B:C5-1;Bmaster=5";
            }

            let expected = c.expected;
            if (c.expected.includes("N")) {
                expected = expected.replace(/N[^|]*/,
                                            "|n=B:C5-1;Bmaster=5;$&");
            } // else it's a failure and won't change the notes repo

            yield RepoASTTestUtil.testMultiRepoManipulator(input,
                                                           expected,
                                                           syntheticBranch,
                                                           c.fails);
        }));
    });
});

const createCommit = function*(repo, contents) {
    const index = yield repo.index();

    yield contents(repo, index);

    const sig = NodeGit.Signature.create("A U Thor", "author@example.com",
                                         1475535185, -4*60);
    return yield repo.createCommitOnHead(["f"], sig, sig, "a commit");
};

const addFile = function*(repo, index) {
    yield fsp.writeFile(path.join(repo.workdir(), "f"), "hello world");
    yield index.addByPath("f");
};

describe("synthetic-branch-submodule-pre-receive", function () {
    it("works", co.wrap(function *() {
        const root = yield TestUtil.makeTempDir();
        const rootDirectory = yield fsp.realpath(root);
        const repo = yield NodeGit.Repository.init(rootDirectory, 0);
        const oid = yield createCommit(repo, addFile);

        // an empty push succeeds
        let fail = yield SyntheticBranch.submoduleIsBad(repo, repo, []);
        assert(!fail);

        // a push with f to a correct branch succeeds
        fail = yield SyntheticBranch.submoduleIsBad(repo, repo, [{
            oldSha: "0000000000000000000000000000000000000000",
            newSha: oid.toString(),
            ref: "refs/commits/" + oid.toString(),
        }]);
        assert(!fail);

        // a push with f to a bogus branch fails
        fail = yield SyntheticBranch.submoduleIsBad(repo, repo, [{
            oldSha: "0000000000000000000000000000000000000000",
            newSha: oid.toString(),
            ref: "refs/commits/0000000000000000000000000000000000000000",
        }]);
        assert(fail);
    }));
});

describe("urlToLocalPath", function () {
    const init = co.wrap(function*() {
        const base = yield TestUtil.makeTempDir();
        const dir = yield fsp.realpath(base);
        const repo = yield NodeGit.Repository.init(dir, 0);
        const config = yield repo.config();
        yield config.setString("gitmeta.subrepourlbase", "http://example.com");
        yield config.setString("gitmeta.subreposuffix", ".GiT");
        yield config.setString("gitmeta.subreporootpath", "/a/b/c");
        return repo;
    });
    const cases = {
        "works without suffix" : {
            input: "http://example.com/foo",
            expected: "/a/b/c/foo.GiT"
        },
        "works with existing suffix" : {
            input: "http://example.com/foo.GiT",
            expected: "/a/b/c/foo.GiT"
        },
        "works with wrong prefix" : {
            input: "http://wrong/foo.GiT",
            expected: null
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            try {
                const repo = yield init();
                const actual =
                      yield SyntheticBranch.urlToLocalPath(repo, c.input);
                assert(c.expected === actual);
            } catch (e) {
                assert(c.expected === null);
            }
        }));
    });
});

describe("synthetic-branch-meta-pre-receive", function () {
    it("works", co.wrap(function *() {
        const base = yield TestUtil.makeTempDir();
        const baseDirectory = yield fsp.realpath(base);
        const subDirectory = path.join(baseDirectory, "sub");
        const metaDirectory = path.join(baseDirectory, "meta");

        const subRepo = yield NodeGit.Repository.init(subDirectory, 0);
        const subOid = yield createCommit(subRepo, addFile);

        const metaRepo = yield NodeGit.Repository.init(metaDirectory, 0);
        yield createCommit(metaRepo, addFile);
        const metaOid = yield createCommit(metaRepo, function*(repo, index) {
            const sub = yield NodeGit.Submodule.addSetup(repo, "../sub",
                                                         "sub", 1);
            const subRepo = yield sub.open();
            yield subRepo.fetchAll();
            subRepo.setHeadDetached(subOid);
            yield index.addByPath("sub");
        });

        //Now, we want to create an empty repo on which we will run
        //these tests, but we'll point them to the ODB of the original
        //repo using GIT_OBJECT_DIRECTORY, as git receive-pack does

        const emptyBaseDirectory = path.join(baseDirectory, "empty");
        yield fsp.mkdir(emptyBaseDirectory);

        const repo = yield NodeGit.Repository.init(emptyBaseDirectory, 0);
        const metaObjects = metaDirectory + "/.git/objects";
        process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = metaObjects;

        //fail: no synthetic ref
        let fail = yield SyntheticBranch.metaUpdateIsBad(repo, repo, [{
            ref: "refs/heads/example",
            oldSha: "0000000000000000000000000000000000000000",
            newSha: metaOid.toString()
        }]);
        assert(fail);

        yield NodeGit.Reference.create(subRepo,
                                       "refs/commits/" + subOid.toString(),
                                       subOid, 0, "create synthetic ref");

        //fail: no alt odb
        fail = yield SyntheticBranch.metaUpdateIsBad(repo, repo, [{
            ref: "refs/heads/example",
            oldSha: "0000000000000000000000000000000000000000",
            newSha: metaOid.toString()
        }]);
        assert(fail);

        //pass
        yield SyntheticBranch.initAltOdb(repo);
        fail = yield SyntheticBranch.metaUpdateIsBad(repo, repo, [{
            ref: "refs/heads/example",
            oldSha: "0000000000000000000000000000000000000000",
            newSha: metaOid.toString()
        }]);
        assert(!fail);

        process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = "";
    }));
});
