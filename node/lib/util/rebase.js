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

const assert  = require("chai").assert;

/**
 * This module defines the `Rebase` value-semantic type.
 */

/**
 * @class Rebase
 *
 * This class represents the state of a rebase.
 */
class Rebase {

    /**
     * Create a new `Rebase` object.
     *
     * @param {String} headName
     * @param {String} originalHead
     * @param {String} onto
     */
    constructor(headName, originalHead, onto) {
        assert.isString(headName);
        assert.isString(originalHead);
        assert.isString(onto);
        this.d_headName = headName;
        this.d_originalHead = originalHead;
        this.d_onto = onto;
        Object.freeze(this);
    }

    /**
     * @property {String} headName name of head when rebase started
     */
    get headName() {
        return this.d_headName;
    }

    /**
     * @property {String} originalHead commit on head when started
     */
    get originalHead() {
        return this.d_originalHead;
    }

    /**
     * @property {String} onto commit rebasing onto
     */
    get onto() {
        return this.d_onto;
    }
}

module.exports = Rebase;
