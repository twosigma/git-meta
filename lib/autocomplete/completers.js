#!/usr/bin/env node
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
 * This module contains default completers for common use cases such as 
 * branch names.
 */

const assert  = require("chai").assert;
const co      = require("co");
const NodeGit = require("nodegit");

const GitUtil    = require("./../metau/metau_gitutil");
const TestUtil   = require("./../metau/metau_testutil");

/**
 * Each completer will take in the current repo, prefix (what has been 
 * entered so far) and return an array of possible results.
 * 
 * @async
 * @param {String}             prefix
 * @return {String []}
 */
exports.branch = co.wrap(function *(prefix) {
    const repo = yield GitUtil.getCurrentRepo();
	const refs = yield repo.getReferenceNames(NodeGit.Reference.TYPE.LISTALL);
	const options = [];
	for (let i = 0; i < refs.length; ++i) {
        const refName = refs[i];
        const ref = yield NodeGit.Reference.lookup(repo, refName);
        if (ref.isBranch()) {
        	options.push(ref.shorthand());
        }
    }
	return options.filter(name => name.indexOf(prefix) > -1);
});
