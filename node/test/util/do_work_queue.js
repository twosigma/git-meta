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

const DoWorkQueue = require("../../lib/util/do_work_queue");

function waitSomeTime(time) {
    return new Promise(callback => {
        setTimeout(callback, time);
    });
}

describe("DoWorkQueue", function () {
    it("breathing", co.wrap(function *() {
        let work = [];
        let expected = [];
        const NUM_TO_DO = 323;
        for (let i = 0; i < NUM_TO_DO; ++i) {
            work.push(i);
            expected.push(i * 2);
        }
        function getWork(i, index) {
            assert.equal(i, index);
            return co(function *() {
                yield waitSomeTime((i % 10));
                return i * 2;
            });
        }
        const result = yield DoWorkQueue.doInParallel(work, getWork);
        assert.equal(result.length, NUM_TO_DO);
        assert.deepEqual(result, expected);
    }));

    it("max one", co.wrap(function *() {
        let work = [];
        let expected = [];
        const NUM_TO_DO = 60;
        let inProgress = false;
        for (let i = 0; i < NUM_TO_DO; ++i) {
            work.push(i);
            expected.push(i * 2);
        }
        function getWork(i, index) {
            assert.equal(i, index);
            return co(function *() {
                assert(!inProgress, "multiple in progress!");
                inProgress = true;
                yield waitSomeTime(i % 10);
                inProgress = false;
                return i * 2;
            });
        }
        const result = yield DoWorkQueue.doInParallel(work,
                                                      getWork,
                                                      {limit: 1});
        assert.equal(result.length, NUM_TO_DO);
        assert.deepEqual(result, expected);
    }));

    it("sub work failure", co.wrap(function *() {
        let work = ["success", "fail"];
        function getWork(name, index) {
            if ("fail" === name) {
                throw new Error("deliberate error");
            }
            return waitSomeTime(index);
        }
        try {
            yield DoWorkQueue.doInParallel(
                work,
                getWork,
                {limit: 1, failMsg: "getWork failed"}
            );
            assert.fail("should have failed");
        } catch (error) {
            assert.equal("deliberate error", error.message);
        }
    }));
});
