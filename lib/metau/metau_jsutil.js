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

/**
 * This module contains simple JavaScript utilities.
 */

const assert = require("chai").assert;

/**
 * Return true if the specified `x` has the same value as the specified `y`.
 * `x` and `y` are considered to have the same value if they have the same set
 * of keys, and for each key, `k`, `true === compare(x[k], y[k])`.
 *
 * @private
 * @param {Object} x map to undefined type
 * @param {Object} y map to undefined type
 * @param {Function} compare
 */
exports.compareMaps = function (x, y, compare) {
    assert.isObject(x);
    assert.isObject(y);
    assert.isFunction(compare);

    // Check to see if everything in 'x' compares equal with those in 'y'.

    for (let k in x) {
        if (!(k in y)) {
            return false;
        }
        if (!compare(x[k], y[k])) {
            return false;
        }
    }

    // Verify that everything in 'y' exists in 'x'.

    for (let k in y) {
        if (!(k in x)) {
            return false;
        }
    }

    // Now we know that everything in 'x' is in 'y' and compares equal
    // according to 'compare`.
    return true;
};
