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

const assert       = require("chai").assert;
const co           = require("co");
const NodeGit      = require("nodegit");
const UserError    = require("../../lib/util/user_error");

/**
 * This module contains methods for interacting with git configuration entries.
 */

/**
 * Return the string in the specified `config` for the specified `key`, or null
 * if `key` does not exist in `config`.
 *
 * @param {NodeGit.Config} config
 * @param {String}         key
 * @return {String|null}
 */
exports.getConfigString = co.wrap(function *(config, key) {
    assert.instanceOf(config, NodeGit.Config);
    assert.isString(key);

    try {
        return yield config.getStringBuf(key);
    }
    catch (e) {
        // Unfortunately, no other way to handle a missing config entry
    }
    return null;
});

/**
 * Returns whether a config variable is, according to git's reckoning,
 * true.  That is, it's set to 'true', 'yes', or 'on'.  If the variable is not
 * set at all, return null.
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit} configVar
 * @return {Bool|null}
 * @throws if the configuration variable doesn't exist
 */
exports.configIsTrue = co.wrap(function*(repo, configVar) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(configVar);

    const config = yield repo.config();
    const configured = yield exports.getConfigString(config, configVar);
    if (null === configured) {
        return configured;                                            // RETURN
    }
    return configured === "true" || configured === "yes" ||
            configured === "on";
});


/**
 * Returns the default Signature for a repo.  Replaces repo.defaultSignature,
 * which occasionally returns unknown@example.com for unknown reasons.
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit} configVar
 * @return {Bool|null}
 * @throws if the configuration variable doesn't exist
*/
exports.defaultSignature = co.wrap(function*(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const config = yield repo.config();
    const email = yield exports.getConfigString(config, "user.email");
    const name = yield exports.getConfigString(config, "user.name");
    if (name && email) {
        const now = new Date();
        const tz = now.getTimezoneOffset();
        // libgit's timezone offset convention is inverted from JS.
        return NodeGit.Signature.create(name, email, now.getTime() / 1000, -tz);
    }
    throw new UserError("Git config vars user.email and user.name are unset");
});

