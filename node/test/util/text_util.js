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

const assert  = require("chai").assert;

const TextUtil = require("../../lib/util/text_util");

describe("TextUtil", function () {
    describe("indent", function () {

        // I don't know if we can verify that the returned directories are
        // "temporary", but we can verify that they subsequent calls return
        // different paths that are directories.

        it("breathing test", function () {
            assert.equal("    morx", TextUtil.indent("morx"));
            assert.equal("   three", TextUtil.indent("three", 3));
        });
    });

    describe("strcmp", function () {
        it("breathing test", function() {
            const cases = [
                {
                    a : "fleem",
                    b : "morx",
                    expect : -1
                },
                {
                    a : "morx",
                    b : "fleem",
                    expect : 1
                },
                {
                    a : "foo",
                    b : "foo",
                    expect : 0
                }
            ];
            for (const c of cases) {
                assert.equal(TextUtil.strcmp(c.a, c.b), c.expect);
            }
        });
    });

    describe("pluralize", function () {
        it("breathing test", function() {
            const cases = [
                {
                    noun : "fleem",
                    count : 1,
                    expect : "fleem"
                },
                {
                    noun : "fleem",
                    count : 0,
                    expect : "fleems"
                },
                {
                    noun : "fleem",
                    count : 2,
                    expect : "fleems"
                },
                {
                    noun : "bass",
                    count : 1,
                    expect : "bass"
                },
                {
                    noun : "bass",
                    count : 2,
                    expect : "basses"
                },
                {
                    noun : "harpy",
                    count : 2,
                    expect : "harpies"
                }
            ];
            for (const c of cases) {
                assert.equal(TextUtil.pluralize(c.noun, c.count), c.expect);
            }
        });
    });
});
