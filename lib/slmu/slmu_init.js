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
 * * Neither the name of slim nor the names of its
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

/**
 * This module contains methods for initializing repositories.
 */

const co = require("co");
const NodeGit = require("nodegit");
const fs = require("fs-promise");
const path = require("path");

/**
 * Initialize a new repository in the optionally specified `directory` if
 * provided, or in the current working directory if it is not.
 *
 * @async
 * @param {String} [directory]
 * @return {NodeGit.Repository}
 */
exports.init = co.wrap(function *(directory) {
    if (null === directory) {
        directory = process.cwd();
    }

    // We're going to make an initial commit with a README.md file, partially
    // because it's a "good thing" but also because the
    // `NodeGit.Submodule.addSetup` command fails when not on a commit (i.e.,
    // in a repo with no commits).

    const repo = yield NodeGit.Repository.init(directory, 0);

    const README = "README.md";
    yield fs.writeFile(path.join(directory, README), "# SLIM file\n");
    const index = yield repo.index();
    index.addByPath(README);
    index.write();
    const id = yield index.writeTree();
    const sig = repo.defaultSignature();
    return yield repo.createCommit("HEAD", sig, sig, "first commit", id, []);
});
