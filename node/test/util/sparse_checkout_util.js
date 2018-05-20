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

const assert = require("chai").assert;
const co     = require("co");
const path   = require("path");

const SparseCheckoutUtil = require("../../lib/util/sparse_checkout_util");
const TestUtil           = require("../../lib/util/test_util");

describe("SparseCheckoutUtil", function () {
describe("getSparseCheckoutPath", function () {
    it("breathing", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        const result = SparseCheckoutUtil.getSparseCheckoutPath(repo);
        assert.equal(result,
                     path.join(repo.path(), "info", "sparse-checkout"));
    }));
});
describe("inSparseMode", function () {
    it("nothing configured", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        const result = yield SparseCheckoutUtil.inSparseMode(repo);
        assert.equal(result, false);
    }));
    it("configured", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        const config = yield repo.config();
        yield config.setString("core.sparsecheckout", "true");
        const result = yield SparseCheckoutUtil.inSparseMode(repo);
        assert.equal(result, true);
    }));
});
describe("setSparseMode", function () {
    it("breathing test", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        yield SparseCheckoutUtil.setSparseMode(repo);
        const isSet = yield SparseCheckoutUtil.inSparseMode(repo);
        assert.equal(isSet, true);
        const content = SparseCheckoutUtil.readSparseCheckout(repo);
        assert.equal(content, ".gitmodules\n");
    }));
});
describe("readSparseCheckout", function () {
    it("doesn't exist", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        const result = SparseCheckoutUtil.readSparseCheckout(repo);
        assert.equal(result, "");
    }));
    it("exists", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        yield SparseCheckoutUtil.setSparseMode(repo);
        const result = SparseCheckoutUtil.readSparseCheckout(repo);
        assert.equal(result, ".gitmodules\n");
    }));
});
describe("addToSparseCheckoutFile", function () {
    it("breathing", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        yield SparseCheckoutUtil.setSparseMode(repo);
        yield SparseCheckoutUtil.addToSparseCheckoutFile(repo, "foo");
        const result = SparseCheckoutUtil.readSparseCheckout(repo);
        assert.equal(result, ".gitmodules\nfoo\n");
    }));
});
describe("removeFromSparseCheckoutFile", function () {
    it("nothing to remove", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        yield SparseCheckoutUtil.setSparseMode(repo);
        SparseCheckoutUtil.removeFromSparseCheckoutFile(repo, ["foo"]);
        const result = SparseCheckoutUtil.readSparseCheckout(repo);
        assert.equal(result, ".gitmodules\n");
    }));
    it("remove one", co.wrap(function *() {
        const repo = yield TestUtil.createSimpleRepository();
        yield SparseCheckoutUtil.setSparseMode(repo);
        yield SparseCheckoutUtil.addToSparseCheckoutFile(repo, "foo");
        SparseCheckoutUtil.removeFromSparseCheckoutFile(repo, ["foo"]);
        const result = SparseCheckoutUtil.readSparseCheckout(repo);
        assert.equal(result, ".gitmodules\n");
    }));
});
});
