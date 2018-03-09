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

/**
 * This module defines the `CherryPick` value-semantic type.
 */

/**
 * @class CherryPick
 *
 * This class represents an in-progress cherry-pick.
 */
class CherryPick {
    /**
     * Create a new `CherryPick` object.
     *
     * @param {String} originalHead
     * @param {String} picked
     */
    constructor(originalHead, picked) {
        assert.isString(originalHead);
        assert.isString(picked);
        this.d_originalHead = originalHead;
        this.d_picked = picked;
        Object.freeze(this);
    }

    /**
     * @property {String} originalHead  head commit when cherry-pick started
     */
    get originalHead() {
        return this.d_originalHead;
    }

    /**
     * @property {String} picked  sha of commit being cherry-picked
     */
    get picked() {
        return this.d_picked;
    }

    /**
     * Return true if the specified `rhs` represents the same value as this
     * `CherryPick` object and false otherwise.  Two `CherryPick` objects
     * represent the same value if they have the same `originalHead` and
     * `picked` properties.
     *
     * @param {CherryPick} rhs
     * @return {Bool}
     */
    equal(rhs) {
        assert.instanceOf(rhs, CherryPick);
        return this.d_originalHead === rhs.d_originalHead &&
            this.d_picked === rhs.d_picked;
    }
}

CherryPick.prototype.toString = function () {
    return `CherryPick(originalHead=${this.d_originalHead}, \
picked=${this.d_picked})`;
};

module.exports = CherryPick;
