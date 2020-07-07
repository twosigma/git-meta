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

/**
 * Call the specified `getWork` function to create a promise to do work for
 * each element in the specified `queue`, limiting the amount of parallel work
 * to the optionally specified `options.limit`, if provided, or 20 otherwise.  
 * Return an array containing the result of the work *in the order that it was
 * received*, which may not be the same as the order in which the work was
 * completed. If `options.failMsg` is provided, it will print an error message
 * with element name if the work of the element fails.
 *
 * @async
 * @param {Array}                  queue
 * @param {(_, Number) => Promise} getWork
 * @param {Object}                 [options]
 * @param {Number}                 options.limit
 * @param {String}                 options.failMsg
 */
exports.doInParallel = co.wrap(function *(queue, getWork, options) {
    assert.isArray(queue);
    assert.isFunction(getWork);
    let limit = 20;
    if (options && options.limit) {
        assert.isNumber(options.limit);
        limit = options.limit;
    }
    let failMsg = "";
    if (options && options.failMsg) {
        assert.isString(options.failMsg);
        failMsg = options.failMsg;
    }


    const total = queue.length;
    const result = new Array(total);
    let next = 0;

    const doWork = co.wrap(function *() {
        while (next !== total) {
            const current = next++;
            try {
                const currentResult = yield getWork(queue[current], current);
                result[current] = currentResult;
            } catch(err) {
                if (failMsg) {
                    console.log(
                        `'${queue[current]}': ${failMsg}`
                    );
                }
                throw err;
            }
        }
    });

    // Do the work.  Create an array of `MAX_WORK` items and yield on it.

    let work = [];

    // Somewhat-arbitrarily chosen limit on parallel work.  I pick this number
    // as it is probably high enough to get most possible benefit from
    // parallelism while being low enough to avoid hitting resources limits.

    for (let i = 0; i < limit; ++i) {
        work.push(doWork());
    }
    yield work;
    return result;
});
