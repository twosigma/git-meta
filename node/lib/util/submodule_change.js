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
 * @class SubmoduleChanges.Change
 *
 * This class represents a sha change to a submodule.
 */
class SubmoduleChange {

    /**
     * Creat a new `Changed` object having the specified `oldSha` and `newSha`
     * values.  The behavior is undefined if `oldSha === newSha`.  Note that a
     * null `oldSha` implies that the submodule was added, a null `newSha`
     * implies that it was removed, and if neither is null, the submodule was
     * changed.
     *
     * @param {String | null} oldSha
     * @param {String | null} newSha
     */
    constructor(oldSha, newSha) {
        assert.notEqual(oldSha, newSha);
        if (null !== oldSha) {
            assert.isString(oldSha);
        }
        if (null !== newSha) {
            assert.isString(newSha);
        }
        this.d_oldSha = oldSha;
        this.d_newSha = newSha;
        Object.freeze(this);
    }

    /**
     * This property represents the previous value of the sha for a submodule
     * change.  If this value is null, then the submodule was added.
     *
     * @property {String | null} oldSha
     */
    get oldSha() {
        return this.d_oldSha;
    }

    /**
     * This property represents the new value of a sha for a submodule.  If it
     * is null, then the submodule was removed.
     *
     * @property {String | null} newSha
     */
    get newSha() {
        return this.d_newSha;
    }
}

module.exports = SubmoduleChange;
