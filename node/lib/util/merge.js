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

const assert  = require("chai").assert;

/**
 * This module defines the `Merge` value-semantic type.
 */

/**
 * @class Merge
 *
 * This class represents the state of a merge.
 */
class Merge {

    /**
     * Create a new `Merge` object.
     *
     * @param {String} message
     * @param {String} originalHead
     * @param {String} mergeHead
     */
    constructor(message, originalHead, mergeHead) {
        assert.isString(message);
        assert.isString(originalHead);
        assert.isString(mergeHead);

        this.d_message = message;
        this.d_originalHead = originalHead;
        this.d_mergeHead = mergeHead;
        Object.freeze(this);
    }

    /**
     * @property {String} message  commit message started with the merge
     */
    get message() {
        return this.d_message;
    }

    /**
     * @property {String} originalHead  HEAD commit when merge started
     */
    get originalHead() {
        return this.d_originalHead;
    }

    /**
     * @property {String} mergeHead  target commit of merge
     */
    get mergeHead() {
        return this.d_mergeHead;
    }
}

module.exports = Merge;
