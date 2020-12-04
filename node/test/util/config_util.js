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
const co      = require("co");
const fs      = require("fs-promise");
const path    = require("path");

const ConfigUtil          = require("../../lib/util/config_util");
const TestUtil            = require("../../lib/util/test_util");

describe("ConfigUtil", function () {
describe("getConfigString", function () {
    it("breathing test", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        const configPath = path.join(repo.path(), "config");
        yield fs.appendFile(configPath, `\
[foo]
        bar = baz
`);
        const config = yield repo.config();
        const goodResult =
                           yield ConfigUtil.getConfigString(config, "foo.bar");
        assert.equal(goodResult, "baz");
        const badResult = yield ConfigUtil.getConfigString(config, "yyy.zzz");
        assert.isNull(badResult);
    }));
});
describe("configIsTrue", function () {
    const cases = {
        "missing": {
            expected: null,
        },
        "true": {
            value: "true",
            expected: true,
        },
        "false": {
            value: "false",
            expected: false,
        },
        "yes": {
            value: "yes",
            expected: true,
        },
        "on": {
            value: "on",
            expected: true,
        },
    };
    Object.keys(cases).forEach(caseName => {
        const c = cases[caseName];
        it(caseName, co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            if ("value" in c) {
                const configPath = path.join(repo.path(), "config");
                yield fs.appendFile(configPath, `\
[foo]
        bar = ${c.value}
`);
            }
            const result = yield ConfigUtil.configIsTrue(repo, "foo.bar");
            assert.equal(result, c.expected);
        }));
    });
});

describe("defaultSignature", function () {
    it("works", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        const actual = yield ConfigUtil.defaultSignature(repo);
        const sig = yield repo.defaultSignature();
        assert.equal(actual.toString(), sig.toString());
    }));

});

["America/New_York", "UTC", "Asia/Tokyo"].forEach(function (tz) {
    describe("defaultSignature tz handling " + tz, function() {
        let env;
        before(function() {
            env = process.env;
            process.env.TZ = tz;
        });

        it("correctly sets the TZ offset", co.wrap(function *() {
            const repo = yield TestUtil.createSimpleRepository();
            const sig = yield ConfigUtil.defaultSignature(repo);
            const time = sig.when();

            const dtOffset = new Date().getTimezoneOffset();
            assert.equal(time.offset(), -dtOffset);
            assert.equal(time.sign(), dtOffset > 0 ? "-" : "+");
        }));

        after(function (){
            process.env = env;
        });
    });
});
});
