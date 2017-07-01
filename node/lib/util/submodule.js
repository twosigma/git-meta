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
 * This module defines the `Submodule` value-semantic type.
 */

/**
 * @class Submodule
 *
 * This class represents the state of a submodule.
 */
class Submodule {

    /**
     * Create a new `Submodule` object.
     *
     * @param {String} url
     * @param {String} sha
     */
    constructor(url, sha) {
        this.d_url = url;
        this.d_sha = sha;
    }

    /**
     * @property {String} url current URL of this `Submodule`
     */
    get url() {
        return this.d_url;
    }

    /**
     * @property {String} sha current SHA of this `Submodule`
     */
    get sha() {
        return this.d_sha;
    }

    /**
     * Return true if the specified `other` and this object have the same
     * value.  Two `Submodule` objects have the same value if their `url` and
     * `sha` properties are the same.
     *
     * @param {Submodule} other
     * @return {Boolean}
     */
    equal(other) {
        assert.instanceOf(other, Submodule);
        return this.d_url === other.d_url && this.d_sha === other.d_sha;
    }
}

module.exports = Submodule;
