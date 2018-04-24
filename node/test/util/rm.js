/*
 * Copyright (c) 2018, Two Sigma Open Source
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

const co = require("co");

const Rm              = require("../../lib/util/rm");
const RepoASTTestUtil = require("../../lib/util/repo_ast_test_util");

describe("rm", function () {
    describe("rmPaths", function () {
        const cases = {
            // Cases in meta repo
            "everything from empty repo": {
                initial: "x=S:I README.md",
                paths: [""],
                fails: true,
            },
            "a clean file by name": {
                initial: "x=S:C2-1 x/y/z=foo;W x/q/z=bar;Bmaster=2",
                paths: ["x/y/z"],
                expect: "x=E:I x/y/z",
            },
            "a clean file by name --cached": {
                initial: "x=S:C2-1 x/y/z=foo;W x/q/z=bar;Bmaster=2",
                paths: ["x/y/z"],
                cached: true,
                expect: "x=E:I x/y/z;W x/y/z=foo",
            },            
            "a clean file by removing its containing dir, no --recursive": {
                initial: "x=S:C2-1 x/y/z=foo;W x/q/z=bar;Bmaster=2",
                paths: ["x/y"],
                fails: true,
            },
            "a clean file by removing its containing dir": {
                initial: "x=S:C2-1 x/y/z=foo;W x/q/z=bar;Bmaster=2",
                paths: ["x/y"],
                recursive: true,
                expect: "x=E:I x/y/z"
            },
            "two clean files by removing their containing dir": {
                initial: "x=S:C2-1 x/y/a=foo,x/y/z=foo;W x/q/z=bar;Bmaster=2",
                paths: ["x/y"],
                recursive: true,
                expect: "x=E:I x/y/a,x/y/z"
            },
            "two clean by removing their grandparent dir": {
                initial: "x=S:C2-1 x/y/a=foo,x/y/z=foo;W x/q/z=bar;Bmaster=2",
                paths: ["x"],
                recursive: true,
                expect: "x=E:I x/y/a,x/y/z"
            },
            "a non-existent thing": {
                initial: "x=S:C2-1 x/y/a=foo,x/y/z=foo;W x/q/z=bar;Bmaster=2",
                paths: ["z"],
                fails: true,
            },
            "a file that only exists in the index": {
                initial: "x=S:I x/y/a=foo;W x/y/a",
                paths: ["x/y/a"],
                expect: "x=S",
            },
            "a file that only exists in the index, --cached": {
                initial: "x=S:I x/y/a=foo;W x/y/a",
                paths: ["x/y/a"],
                cached: true,
                expect: "x=S",
            },
            "a file that only exists in the index, -f": {
                initial: "x=S:I x/y/a=foo;W x/y/a=",
                paths: ["x/y/a"],
                force: true,
                expect: "x=S"
            },
            "a submodule": {
                initial: `x=S:C2-1 x/y/a=foo,x/y/z=foo;C3-1 d=S/baz.git:2;
                          Bmaster=3;Bsub=2`,
                paths: ["d"],
                expect: "x=E:I d"
            },
            "an open submodule": {
                initial: `sub=S:C8-1 x/y/a=foo,x/y/z=foo;Bmaster=8|
                          x=S:C2-1 d=Ssub:8;Bmaster=2;Od`,
                paths: ["d"],
                expect: "x=S:C2-1 d=Ssub:8;Bmaster=2;I d"
            },
            "a submodule that only exists in the index": {
                // because this only exists in the index, need -f to remove it
                initial: `sub=S:C8-1 x/y/a=foo;Bmaster=8|
                          x=S:I d=Ssub:8;Bmaster=1;Od`,
                paths: ["d"],
                cached: true,
                force: true,
                expect: "x=S:Bmaster=1"
            },
            "a submodule that only exists in the wt and .gitmodules": {
                initial: `sub=B|x=S:I d=Ssub:;Od`,
                paths: ["d"],
                expect: `x=S`,
            },
            // cases inside submodules
            "a non-existent thing from a submodule": {
                initial: `sub=S:C4-1;Bsub=4|x=S:C2-1 x/y/a=foo,x/y/z=foo;
                          C3-2 d=Ssub:4;
                          Bmaster=3;Od`,
                paths: ["d/f"],
                fails: true,
            },
            "a file from a closed submodule": {
                initial: `x=S:C2-1 x/y/a=foo,x/y/z=foo;C3-1 d=S/baz.git:2;
                          Bmaster=3;Bsub=2`,
                paths: ["d/x/y/z"],
                fails: true,
            },
            "a file from an open submodule": {
                initial: `sub=S:C2-1 x/y/a=foo,x/y/z=foo;Bmaster=2|
                          x=S:C3-1 d=Ssub:2;Bmaster=3;Od`,
                paths: ["d/x/y/z"],
                expect: "x=E:Od I x/y/z",
            },
            "a nonexistent dir from an open submodule": {
                initial: `sub=S:C2-1 x/y/a=foo,x/y/z=foo;Bmaster=2|
                          x=S:C3-1 d=Ssub:2;Bmaster=3;Od`,
                paths: ["d/q"],
                fails: true,
            },
            "a file an open submodule via dir, no --recursive": {
                initial: `sub=S:C2-1 x/y/a=foo,x/y/z=foo;Bmaster=2|
                          x=S:C3-1 d=Ssub:2;Bmaster=3;Od`,
                paths: ["d/x/y"],
                fails: true,
            },
            "a file from an open submodule via dir": {
                initial: `sub=S:C2-1 x/y/a=foo,x/y/z=foo;Bmaster=2|
                          x=S:C3-1 d=Ssub:2,d2=Ssub:2;Bmaster=3;Od;Od2`,
                paths: ["d/x/y"],
                recursive: true,
                expect: "x=E:Od I x/y/a,x/y/z;Od2",
            },
            "a modified file from an open submodule via dir": {
                initial: `sub=S:C2-1 x/y/a=foo,x/y/z=foo;Bmaster=2|
                          x=S:C3-1 d=Ssub:2;Bmaster=3;Od W x/y/z=mod`,
                paths: ["d/x/y"],
                recursive: true,
                fails: true,
            },
            "a cached file from an open submodule via dir": {
                initial: `sub=S:C2-1 x/y/a=foo,x/y/z=orig;Bmaster=2|
                          x=S:C3-1 d=Ssub:2;
                          Bmaster=3;Od I x/y/z=mod!W x/y/z=orig`,
                paths: ["d/x/y"],
                recursive: true,
                fails: true,
            },
            "a cached file from an open submodule via dir --cached": {
                initial: `sub=S:C2-1 x/y/a=foo,x/y/z=orig;Bmaster=2|
                          x=S:C3-1 d=Ssub:2;
                          Bmaster=3;Od I x/y/z=mod!W x/y/z=orig`,
                paths: ["d/x/y"],
                recursive: true,
                cached: true,
                fails: true,
            },
            "a cached file from an open submodule, --cached, index = head":
            {
                initial: `sub=S:C2-1 x/y/a=foo,x/y/z=orig;Bmaster=2|
                          x=S:C3-1 d=Ssub:2;
                          Bmaster=3;Od I x/y/z=orig!W x/y/z=mod`,
                paths: ["d/x/y/z"],
                recursive: true,
                cached: true,
                expect: "x=E:Od I x/y/z!W x/y/z=mod",
            },
            "a cached file from an open submodule, --cached, index = wt": {
                initial: `sub=S:C2-1 x/y/a=foo,x/y/z=orig;Bmaster=2|
                          x=S:C3-1 d=Ssub:2;
                          Bmaster=3;Od I x/y/z=mod!W x/y/z=mod`,
                paths: ["d/x/y/z"],
                recursive: true,
                cached: true,
                expect: "x=E:Od I x/y/z!W x/y/z=mod",
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, co.wrap(function *() {
                const rmPaths = co.wrap(function *(repos) {
                    const repo = repos.x;
                    yield Rm.rmPaths(repo, c.paths, {
                        recursive: c.recursive,
                        cached: c.cached,
                        force: c.force});
                });
                yield RepoASTTestUtil.testMultiRepoManipulator(c.initial,
                                                               c.expect,
                                                               rmPaths,
                                                               c.fails);
            }));
        });
    });
});
