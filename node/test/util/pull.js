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

const assert = require("assert");
const co     = require("co");
const fsp    = require("fs-promise");
const path     = require("path");
const NodeGit = require("nodegit");

const Pull            = require("../../lib/util/pull");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");
const TestUtil        = require("../../lib/util/test_util");


describe("pull", function () {
    // Most of the logic for 'pull' is done in terms of fetch and rebase.  We
    // need to ensure that those operatios are invoked correctly, but not that
    // fetch and rebase are correct themselves, and also validate failure
    // conditions.

    const cases = {
        "trivial, no change": {
            initial: "a=B|x=Ca",
            remote: "origin",
            source: "master",
        },
        "bad remote": {
            initial: "x=S",
            remote: "origin",
            source: "master",
            fails: true,
        },
        "bad branch": {
            initial: "a=B|x=Ca",
            remote: "origin",
            source: "foo",
            fails: true,
        },
        "changes": {
            initial: "a=B:C2-1 s=Sa:1;Bfoo=2|x=Ca",
            remote: "origin",
            source: "foo",
            expected: "x=E:Bmaster=2 origin/master",
        },
        "doesn't pull down unneeded branches": {
            initial: "a=B:Bfoo=1|x=S:Rorigin=a",
            remote: "origin",
            source: "foo",
            expected: "x=E:Rorigin=a foo=1",
        },
        "conflict": {
            initial: `
a=B:Ca-1;Cb-1 a=8;Ba=a;Bb=b|y=U:C3-2 s=Sa:a;C4-2 s=Sa:b;Bmaster=3;Bfoo=4|x=Cy`,
            remote: "origin",
            source: "foo",
            expected: `
x=E:H=4;QR 3:refs/heads/master 4: 0 3;Os I *a=~*8*a!Edetached HEAD,a,b! W a=\
<<<<<<< HEAD
8
=======
a
>>>>>>> message
;`,
            fails: true,
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        const pull = co.wrap(function *(repos) {
            const repo = repos.x;
            yield Pull.pull(repo, c.remote, c.source);
        });
        it(caseName, co.wrap(function *() {
            yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                           c.expected,
                                                           pull,
                                                           c.fails);
        }));
    });
});

describe("userWantsRebase", function () {
    it("handles args and config", co.wrap(function *() {
        const root = yield TestUtil.makeTempDir();
        const rootDirectory = yield fsp.realpath(root);
        const repo = yield NodeGit.Repository.init(rootDirectory, 0);
        const index = yield repo.index();
        yield fsp.writeFile(path.join(repo.workdir(), "f"), "hello world");
        yield index.addByPath("f");
        const sig = NodeGit.Signature.create("A U Thor", "author@example.com",
                                                1475535185, -4*60);
        yield repo.createCommitOnHead(["f"], sig, sig, "a commit");

        const master = yield repo.getBranch("master");
        const config = yield repo.config();
        yield config.setString("pull.rebase", "false");

        assert.equal(false, yield Pull.userWantsRebase({"rebase" : false},
                                                       null,
                                                       null));

        assert.equal(true, yield Pull.userWantsRebase({"rebase" : true},
                                                      null,
                                                      null));

        assert.equal(false, yield Pull.userWantsRebase({"rebase": null},
                                                       repo,
                                                       master));

        assert.equal(false, yield Pull.userWantsRebase({},
                                                       repo,
                                                       master));
        yield config.setString("pull.rebase", "true");
        assert.equal(true, yield Pull.userWantsRebase({},
                                                      repo,
                                                      master));

        yield config.setString("pull.rebase", "false");
        yield config.setString("branch.master.rebase", "true");
        assert.equal(true, yield Pull.userWantsRebase({},
                                                      repo,
                                                      master));

        yield config.setString("branch.master.rebase", "false");
        assert.equal(false, yield Pull.userWantsRebase({},
                                                       repo,
                                                       master));
        
    }));
});
