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

const assert = require("chai").assert;
const co     = require("co");
const fs     = require("fs-promise");
const path   = require("path");

const SubmoduleConfigUtil = require("../../lib/util/submodule_config_util");
const TestUtil            = require("../../lib/util/test_util");

describe("SubmoduleConfigUtil", function () {
    describe("parseSubmoduleConfig", function () {
        const cases = {
            "trivial": {
                input: "",
                expected: {},
            },
            "one": {
                input: `\
[submodule "x/y"]
    path = x/y
[submodule "x/y"]
    url = /foo/bar/baz
`,
                expected: {
                    "x/y": "/foo/bar/baz",
                }
            },
            "all in one": {
                input: `\
[submodule "x/y"]
    path = x/y
    url = /foo/bar/baz
`,
                expected: {
                    "x/y": "/foo/bar/baz",
                }
            },
            "two": {
                input: `\
[submodule "x/y"]
    path = x/y
[submodule "x/y"]
    url = /foo/bar/baz
[submodule "a"]
    path = foo
[submodule "a"]
    url = wham-bam
`,
                expected: {
                    "x/y": "/foo/bar/baz",
                    a: "wham-bam",
                }
            },
            "two togethers": {
                input: `\
[submodule "x/y"]
    path = x/y
    url = /foo/bar/baz
[submodule "a"]
    path = foo
    url = wham-bam
`,
                expected: {
                    "x/y": "/foo/bar/baz",
                    a: "wham-bam",
                }
            },
            "with tabs": {
                input: `\
[submodule "x/y"]
\tpath = x/y
\turl = /foo/bar/baz
[submodule "a"]
\tpath = foo
\turl = wham-bam
`,
                expected: {
                    "x/y": "/foo/bar/baz",
                    a: "wham-bam",
                }
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result =
                             SubmoduleConfigUtil.parseSubmoduleConfig(c.input);
                assert.deepEqual(result, c.expected);
            });
        });
    });

    describe("parseSubmoduleConfig", function () {
        const cases = {
            "trivial": {
                input: "",
                expected: [],
            },
            "no subs": {
                input: `\
[core]
        repositoryformatversion = 0
        filemode = true
        bare = false
        logallrefupdates = true
        ignorecase = true
        precomposeunicode = true
`,
                expected: []
            },
            "one sub": {
                input: `\
[core]
        repositoryformatversion = 0
        filemode = true
        bare = false
        logallrefupdates = true
        ignorecase = true
        precomposeunicode = true
[submodule "x/y"]
        url = /Users/someone/trash/tt/foo
`,
                expected: ["x/y"],
            },
            "two": {
                input: `\
[core]
        repositoryformatversion = 0
        filemode = true
        bare = false
        logallrefupdates = true
        ignorecase = true
        precomposeunicode = true
[submodule "x/y"]
        url = /Users/someone/trash/tt/foo
[submodule "foo"]
        url = /Users/someone/trash/tt/foo
`,
                expected: ["x/y", "foo"],
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result =
                             SubmoduleConfigUtil.parseOpenSubmodules(c.input);
                assert.deepEqual(result.sort(), c.expected.sort());
            });
        });
    });

    describe("getSubmodulesFromCommit", function () {
        // We know that the actual parsing is done by `parseSubmoduleConfig`;
        // we just need to check that the parsing happens and that it works in
        // the case where there is no `.gitmodules` file.

        it("no gitmodules", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const headCommit = yield repo.getHeadCommit();
            const result = yield SubmoduleConfigUtil.getSubmodulesFromCommit(
                                                                   repo,
                                                                   headCommit);
            assert.deepEqual(result, {});
        }));

        it("with gitmodules", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const modulesPath = path.join(repo.workdir(),
                                          SubmoduleConfigUtil.modulesFileName);

            yield fs.writeFile(modulesPath, `\
[submodule "x/y"]
    path = x/y
[submodule "x/y"]
    url = /foo/bar/baz
`
                              );
            const withCommit = yield TestUtil.makeCommit(
                                        repo,
                                        [SubmoduleConfigUtil.modulesFileName]);

            const result = yield SubmoduleConfigUtil.getSubmodulesFromCommit(
                                                                   repo,
                                                                   withCommit);
            assert.deepEqual(result, {
                "x/y": "/foo/bar/baz",
            });
        }));
    });

    describe("getSubmodulesFromIndex", function () {
        // We know that the actual parsing is done by `parseSubmoduleConfig`;
        // we just need to check that the parsing happens and that it works in
        // the case where there is no `.gitmodules` file.

        it("no gitmodules", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const index = yield repo.index();
            const result = yield SubmoduleConfigUtil.getSubmodulesFromIndex(
                                                                        repo,
                                                                        index);
            assert.deepEqual(result, {});
        }));

        it("with gitmodules", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const modulesPath = path.join(repo.workdir(),
                                          SubmoduleConfigUtil.modulesFileName);

            yield fs.writeFile(modulesPath, `\
[submodule "x/y"]
    path = x/y
[submodule "x/y"]
    url = /foo/bar/baz
`
                              );
            const index = yield repo.index();
            index.addByPath(SubmoduleConfigUtil.modulesFileName);

            const result = yield SubmoduleConfigUtil.getSubmodulesFromIndex(
                                                                        repo,
                                                                        index);
            assert.deepEqual(result, {
                "x/y": "/foo/bar/baz",
            });
        }));
    });

});

