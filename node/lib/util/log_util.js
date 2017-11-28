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

const assert  = require("chai").assert;
const co      = require("co");
const NodeGit = require("nodegit");

const SubmoduleFetcher = require("./submodule_fetcher");

/**
 * Return most reset ancestor of the specified `metaCommit` in the specified
 * meta `repo` that introduces the specified `subCommit` in the submodule
 * having the specified `submoduleName`, or null if no such commit exists.  Use
 * the specified `subRepo` to resolve submodule commits and check for
 * ancestor/descendant relations.  Use the specified `subFetcher` to retrieve
 * submodule commits.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             metaCommit
 * @param {String}             subCommit
 * @param {String}             submoduleName
 * @param {NodeGit.Repository} subRepo
 * @param {SubmoduleFetcher}   subFetcher
 * @return {NodeGit.Commit|null}
 */
exports.findMetaCommit = co.wrap(function *(repo,
                                            metaCommit,
                                            subCommit,
                                            submoduleName,
                                            subRepo,
                                            subFetcher) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(metaCommit, NodeGit.Commit);
    assert.instanceOf(subCommit, NodeGit.Commit);
    assert.isString(submoduleName);
    assert.instanceOf(subRepo, NodeGit.Repository);
    assert.instanceOf(subFetcher, SubmoduleFetcher);

    // First, resolve the committishes and throw if they cannot be resolved.

    const subSha = subCommit.id().tostrS();

    // While a recursive solution would be very simple, I'm afraid we'd
    // overflow (v8 does not support tail call optimization at the moment).
    // Furthermore, we need to do a breadth-first-search: we don't want to
    // search the entire left side of a merge commit before checking the right.
    //
    // Strategy: walk back, starting from `metaCommit`, return the first
    // commit where the sha for our submodule references (directly or
    // indirectly) `subCommit`, but its parents don't.

    let   toCheck = [metaCommit];   // commits left to check
    const checked = new Set();      // SHAs checked
    const existsInSha = new Map();  // repo sha to bool if target included
    const isDescended = new Map();  // cache of descendant check

    const doesExistInCommit = co.wrap(function *(commit) {
        const sha = commit.id().tostrS();
        if (existsInSha.has(sha)) {
            return existsInSha.get(sha);
        }
        let result;

        // Check to see if the repo references `subSha` directly, or one of
        // its descendants.

        const tree = yield commit.getTree();
        let subShaForCommit;
        try {
            subShaForCommit = (yield tree.entryByPath(submoduleName)).sha();
        }
        catch (e) {
            // Submodule doesn't exist in this commit; stop checking earlier
            // commits.

            result = false;
        }
        if (undefined !== subShaForCommit) {
            if (subShaForCommit === subSha) {
                result = true;
            }
            else {
                // Check to see if the commit  we're looking for is descended
                // from the current commit.  First, look in the cache.

                if (isDescended.has(subShaForCommit)) {
                    result = isDescended.get(subShaForCommit);
                }
                else {
                    // Ensure that the commit we're checking against is
                    // present; we can't do a descendant check otherwise.

                    yield subFetcher.fetchSha(subRepo,
                                              submoduleName,
                                              subShaForCommit);
                    result = (yield NodeGit.Graph.descendantOf(
                                       subRepo,
                                       NodeGit.Oid.fromString(subShaForCommit),
                                       subCommit.id())) !== 0;
                    isDescended.set(subShaForCommit, result);
                }
            }
        }
        existsInSha.set(sha, result);
        return result;
    });

    while (0 !== toCheck.length) {

        // This could be slow (O(N^2)) w.r.t. the number of commits in the
        // repository if the repository is "insane" -- e.g., one commit with
        // all other commits as direct parents.  For normal structions I expect
        // `toCheck` to rarely exceed length of 10.  If we determine this to be
        // a bottleneck, we can adopt a third-party deque library.

        const commit = toCheck.shift();
        const sha = commit.id().tostrS();
        // Bail if we've already checked this one.

        if (checked.has(sha)) {
            continue;                                               // CONTINUE
        }
        checked.add(sha);

        const MAX_PARENTS = 500000;  // arbitrary limit
        const parents = yield commit.getParents(MAX_PARENTS);


        const existsHere = yield doesExistInCommit(commit);

        toCheck = toCheck.concat(parents);

        // Bail if the commit doesn't here.

        if (!existsHere) {
            continue;                                               // CONTINUE
        }

        // If the commit isn't referenced in any parent, this one is the
        // winner.

        let notInParents = true;
        for (let i = 0; notInParents && i < parents.length; ++i) {
            notInParents = !(yield doesExistInCommit(parents[i]));
        }

        if (notInParents) {
            return sha;                                               // RETURN
        }
    }
    return null;
});
