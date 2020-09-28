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
 * This module contains methods for doing checkouts.
 */
const assert  = require("chai").assert;
const co      = require("co");
const colors  = require("colors");
const NodeGit = require("nodegit");

const DoWorkQueue        = require("../util/do_work_queue");
const GitUtil            = require("./git_util");
const Reset              = require("./reset");
const RepoStatus         = require("./repo_status");
const SparseCheckoutUtil = require("./sparse_checkout_util");
const StatusUtil         = require("./status_util");
const SubmoduleFetcher   = require("./submodule_fetcher");
const SubmoduleUtil      = require("./submodule_util");
const UserError          = require("./user_error");

/**
 * If the specified `name` matches the tracking branch for one and only one
 * remote in the specified `repo`, return that remote; otherwise, return null.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             name
 * @return {NodeGit.Remote|null}
 */
exports.findTrackingBranch = co.wrap(function *(repo, name) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(name);
    let result = null;
    const refs = yield repo.getReferenceNames(NodeGit.Reference.TYPE.ALL);
    const matcher = new RegExp(`^refs/remotes/(.*)/${name}$`);
    for (let i = 0; i < refs.length; ++i) {
        const refName = refs[i];
        const match = matcher.exec(refName);
        if (null !== match) {
            if (null !== result) {
                // We have a match but it's not unique.

                return null;                                          // RETURN
            }
            result = match[1];
        }
    }
    return result;
});

/**
 * Return a map of submodule repos and commit objects in the specified meta
 * `repo` to be used when checking out on the specified `commit`.  Note that
 * this cache will contain entries only for submodules that need to be checked
 * out -- the ones that are both open and also exist on `commit`.
 *
 * @param {NodeGit.Repository} repo
 * @param {Object}             changes  map from name to `SubmoduleChange`
 * @return {Object}            map from name to { repo, [commit] }
 */
const loadSubmodulesToCheckout = co.wrap(function *(repo, changes) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isObject(changes);

    const openSet = new Set(yield SubmoduleUtil.listOpenSubmodules(repo));
    const toLoad = Object.keys(changes).filter(name => openSet.has(name));
    const result = {};
    const head = yield repo.getHeadCommit();
    const subFetcher = new SubmoduleFetcher(repo, head);
    const doSub = co.wrap(function *(name) {
        const subRepo = yield SubmoduleUtil.getRepo(repo, name);
        const sha = changes[name].newSha;
        if (null !== sha) {
            yield subFetcher.fetchSha(subRepo, name, sha);
            const commit = yield subRepo.getCommit(sha);
            result[name] = { repo: subRepo, commit: commit };
        }
    });
    yield DoWorkQueue.doInParallel(toLoad, doSub);
    return result;
});

/**
 * Return a list of errors that would be encountered if a non-force attempt was
 * made to check out the specified `submodules` in the specified `metaRepo`.
 *
 * TODO: consider exposing this and testing it separately
 *
 * @param {NodeGit.Repository} 
 * @param {Object}             submodules   map from name to {repo, commit}
 * @return {String []}                      list of errors
 */
const dryRun = co.wrap(function *(metaRepo, submodules) {
    assert.instanceOf(metaRepo, NodeGit.Repository);
    assert.isObject(submodules);

    let errors = [];

    // Check for new commits in submodules

    const status = yield StatusUtil.getRepoStatus(metaRepo);
    const subs = status.submodules;
    Object.keys(submodules).forEach(name => {
        const sub = subs[name];
        const commit = sub.commit;
        const index = sub.index;
        const wd = sub.workdir;
        const SAME = RepoStatus.Submodule.COMMIT_RELATION.SAME;
        const newSha = submodules[name].commit.id().tostrS();

        if (null !== wd) {

            // Check to see if there are new commits on both index and HEAD
            // of workdir.  If this is the case, we cannot checkout the
            // submodule without changing its state.

            if (wd.relation !== SAME && index.relation !== SAME) {
                errors.push(`
Submodule ${colors.yellow(name)} has new commits in index and HEAD.`);
                return;                                           // RETURN
            }

            // New commit in HEAD but not same as commit we're checking
            // out.

            if (wd.status.headCommit !== commit.sha &&
                wd.status.headCommit !== newSha) {
                errors.push(`
Submodule ${colors.yellow(name)} has a new commit.`);
                return;                                           // RETURN
            }
        }
    });

    // Try the submodules; store the opened repos and loaded commits for
    // use in the actual checkout later.

    const dryRunSub = co.wrap(function *(name) {
        const sub = submodules[name];
        const repo = sub.repo;
        const commit = sub.commit;
        try {
            yield NodeGit.Checkout.tree(repo, commit, {
                checkoutStrategy: NodeGit.Checkout.STRATEGY.NONE,
            });
        }
        catch(e) {
            errors.push(`\
Unable to checkout submodule ${colors.yellow(name)}: ${e.message}.`);
        }
    });
    yield DoWorkQueue.doInParallel(Object.keys(submodules), dryRunSub);
    return errors;
});

/**
 * Checkout the specified `commit` in the specified `metaRepo`, and update all
 * open submodules to be on the indicated commit, fetching it if necessary.
 * Throw a `UserError` if one of the submodules or the meta-repo cannot be
 * checked out.  On successful checkout, leave HEAD detached.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 * @param {Boolean}            force
 */
exports.checkoutCommit = co.wrap(function *(repo, commit, force) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    assert.isBoolean(force);

    const head = yield repo.getHeadCommit();
    const changes = yield SubmoduleUtil.getSubmoduleChanges(repo,
                                                            commit,
                                                            head,
                                                            false);
    const subs = yield loadSubmodulesToCheckout(repo, changes);

    // If we're not forcing the commit, attempt a dry run and fail if it
    // doesn't pass.

    if (!force) {
        const errors = yield dryRun(repo, subs);

        // Throw an error if any dry-runs failed.

        if (0 !== errors.length) {
            throw new UserError(errors.join("\n"));
        }
    }

    const index = yield repo.index();
    yield Reset.resetMetaRepo(repo, index, commit, changes, false);
    repo.setHeadDetached(commit);

    const doCheckout = co.wrap(function *(name) {
        const sub = subs[name];
        const commit = sub.commit;
        const repo = sub.repo;
        const strategy = force ?
            NodeGit.Checkout.STRATEGY.FORCE :
            NodeGit.Checkout.STRATEGY.SAFE;
        yield NodeGit.Checkout.tree(repo, commit, {
            checkoutStrategy: strategy,
        });
        repo.setHeadDetached(commit);
    });
    yield DoWorkQueue.doInParallel(Object.keys(subs), doCheckout);
    yield SparseCheckoutUtil.setSparseBitsAndWriteIndex(repo, index);
});

/**
 * Return an object describing the remote and branch name of the specified
 * `trackingBranch` if it is valid in the specified `repo`, or throw a
 * `UserError` if it is not.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             trackingBranch
 * @return {Object}
 * @return {String} return.remoteName
 * @return {String} return.branchName
 */
exports.validateTrackingBranch = co.wrap(function *(repo, trackingBranch) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(trackingBranch);
    const parts = trackingBranch.split("/");
    if (2 !== parts.length) {
        throw new UserError(
            `Invalid tracking branch ${colors.red(trackingBranch)}`);
    }
    const remoteName = parts[0];
    const branchName = parts[1];
    if (!(yield GitUtil.isValidRemoteName(repo, remoteName))) {
        throw new UserError(
            `Invalid remote name ${colors.red(remoteName)}`);
    }
    if (null === (yield GitUtil.findBranch(repo, trackingBranch))) {
        throw new UserError(`\
There is no branch ${colors.red(branchName)} for remote \
${colors.yellow(remoteName)}`);
    }
    return {
        remoteName: remoteName,
        branchName: branchName,
    };
});

/**
 * Return an object describing what operation to perform in the specified
 * `repo` based on the optionally specified `committish`, the optionally
 * specified `newBranch` name, and the specified `track` flag.  Throw a
 * `UserError` if the arguments provided are not valid within `repo`.
 *
 * The behavior required by Git is otherwise far too baroque to write a
 * meaningful contract; look at the code and/or the test driver.
 *
 * @param {NodeGit.Repository} repo
 * @param {String|null}        committish
 * @param {String|null}        newBranch
 * @param {Boolean}            track
 * @param {Array<String>|null}      files
 * @return {Object}
 * @return {NodeGit.Commit}      return.commit           to check out
 * @return {Object|null}         return.newBranch        to create
 * @return {String}              return.newBranch.name
 * @return {Object|null}         return.newBranch.tracking
 * @return {String|null}         return.newBranch.tracking.remoteName
 * @return {String}              return.newBranch.tracking.branchName
 * @return {String|null}         return.switchBranch     to make current
 * @return {Array<String>}       return.resolvedPaths    to check out
 */
exports.deriveCheckoutOperation = co.wrap(function *(repo,
                                                     committish,
                                                     newBranch,
                                                     track,
                                                     files) {
    assert.instanceOf(repo, NodeGit.Repository);
    if (null !== committish) {
        assert.isString(committish);
    }
    if (null !== newBranch) {
        assert.isString(newBranch);
    }
    if (null === files || undefined === files) {
        files = [];
    } else {
        assert.isArray(files);
    }
    assert.isBoolean(track);

    const result = {
        commit: null,
        newBranch: null,
        switchBranch: null,
        resolvedPaths: null,
        checkoutFromIndex: false
    };

    const ensureBranchDoesntExist = co.wrap(function *(name) {
        if (null !== (yield GitUtil.findBranch(repo, name))) {
            throw new UserError(`\
A branch named ${colors.red(name)} already exists.`);
        }
    });

    let committishBranch = null;  // the branch corresponding to checkout

    // First, resolve information about `committish`.

    if (null !== committish && null === newBranch && track) {
        // The first of many special cases: the `track` option is used, but
        // we're not making a new branch and do have a target committish.  If
        // `committish` is exactly a remote branch, then we'll specify an
        // operation equivalent to `checkout -b <name> -t <origin>/<name>`,
        // where `committish` is exactly `<origin>/<name>`.

        const tracking = yield exports.validateTrackingBranch(repo,
                                                              committish);
        yield ensureBranchDoesntExist(tracking.branchName);
        result.newBranch = {
            name: tracking.branchName,
            tracking: tracking,
        };
        const branch = yield GitUtil.findRemoteBranch(repo,
                                                      tracking.remoteName,
                                                      tracking.branchName);
        const commit = yield repo.getCommit(branch.target());
        result.commit = commit;
        result.switchBranch = tracking.branchName;
        return result;                                                // RETURN
    }
    else if (null === newBranch && track) {
        throw new UserError(`--track needs branch name`);
    }

    if (null !== committish) {
        // Now, we have a committish to resolve.

        let annotated = yield GitUtil.resolveCommitish(repo, committish);
        if (null === annotated) {

            // If we are not explicitly setting up a tracking branch nor
            // explicitly creating a new branch, we may implicitly do both
            // when `committish` is not directly resolveable, but does match a
            // single remote tracking branch.

            if (null === newBranch && files.length === 0) {
                const remote = yield exports.findTrackingBranch(repo,
                                                                committish);
                if (null !== remote) {
                    // We have a match to a remote; need to look up the commit.

                    const branch = yield GitUtil.findRemoteBranch(repo,
                                                                  remote,
                                                                  committish);
                    const id = branch.target();
                    result.commit = yield repo.getCommit(id);
                    result.newBranch = {
                        name: committish,
                        tracking: {
                            remoteName: remote,
                            branchName: committish,
                        },
                    };
                    result.switchBranch = committish;
                    if (null === result.commit) {
                        throw new UserError(`\
Could not resolve ${colors.red(committish)} as a branch or commit.`);
                    }
                }
            }
            if (null === annotated && !result.newBranch) {
                // If we didn't resolve anything from `committish`, try it
                // as a file.
                files.splice(0, 0, committish);
                result.checkoutFromIndex = true;
            }
        }
        else {
            const commit = yield repo.getCommit(annotated.id());
            result.commit = commit;

            // Check to see if the commit refers to a branch name.  You would
            // think that 'findBranch' would return only branches, but it also
            // returns 'FETCH_HEAD', which is *not a branch*.  "HEAD",
            // unfortunately, claims to be a branch, and must be special-cased.

            if ("HEAD" !== committish) {
                const branch = yield GitUtil.findBranch(repo, committish);
                if (null !== branch &&
                    (branch.isBranch() || branch.isRemote())) {
                    committishBranch = branch;
                    if(!branch.isRemote()) {
                        result.switchBranch = committish;
                    }
                }
            }
        }
    }
    else {
        if (files.length === 0) {
            // If we're implicitly using HEAD, see if it's on a branch
            // and record that branch's name.

            const head = yield repo.head();
            if (head.isBranch()) {
                committishBranch = head;
            }
        }
    }

    if (files.length !== 0) {
        const indexSubNames = yield SubmoduleUtil.getSubmoduleNames(
            repo);
        const openSubmodules = yield SubmoduleUtil.listOpenSubmodules(
            repo);

        const workdir = repo.workdir();
        const cwd = process.cwd();

        const absfiles = files.map(filename =>
                                   GitUtil.resolveRelativePath(workdir, cwd,
                                                               filename));

        result.resolvedPaths = SubmoduleUtil.resolvePaths(
            absfiles, indexSubNames, openSubmodules, true);

        if (null === result.commit) {
            result.checkoutFromIndex = true;
        }

        return result;
    }


    if (null !== newBranch) {
        // If we have a `newBranch`, we need to make sure it doesn't already
        // exist.

        yield ensureBranchDoesntExist(newBranch);

        // Now, if we're supposed to set up tracking, validate that the
        // committish is a branch.  If it's a tracking branch, then parse the
        // parts.

        let tracking = null;
        if (track) {
            // Set up tracking information of `track` is set.

            if (null === committishBranch) {
                throw new UserError(`\
Cannot setup tracking information; starting point is not a branch.`);
            }

            // If the branch is remote, set up remote tracking information,
            // otherwise leave the remote name 'null';

            if (committishBranch.isRemote()) {
                const parts = committishBranch.shorthand().split(/\/(.+)/);
                tracking = {
                    remoteName: parts[0],
                    branchName: parts[1],
                };
            }
            else {
                tracking = {
                    remoteName: null,
                    branchName: committishBranch.shorthand(),
                };
            }
        }

        result.newBranch = {
            name: newBranch,
            tracking: tracking,
        };
        result.switchBranch = newBranch;
    }
    return result;
});

/**
 * In the following order, in the specified `repo`, for the options which are
 * non-null:
 * - check out the specified `commit`
 * - create the specified `newBranch.name` from HEAD
 * - configure the new branch to have the specified `newBranch.tracking`
 *   tracking branch
 * - make the specified `switchBranch` the current branch
 * - overwrite local changes if `true === force`
 *
 * @param {NodeGit.repository}  repo
 * @param {NodeGit.Commit|null} commit
 * @param {Object|null}         newBranch
 * @param {String}              newBranch.name
 * @param {Object|null}         newBranch.tracking
 * @param {String|null}         newBranch.tracking.remoteName
 * @param {String}              newBranch.tracking.branchName
 * @param {String|null}         switchBranch
 * @param {Boolean}             force
 */
exports.executeCheckout = co.wrap(function *(repo,
                                             commit,
                                             newBranch,
                                             switchBranch,
                                             force) {
    assert.instanceOf(repo, NodeGit.Repository);
    if (null !== commit) {
        assert.instanceOf(commit, NodeGit.Commit);
    }
    if (null !== newBranch) {
        assert.isObject(newBranch);
        assert.isString(newBranch.name);
        if (null !== newBranch.tracking) {
            assert.isObject(newBranch.tracking);
            if (null !== newBranch.tracking.remoteName) {
                assert.isString(newBranch.tracking.remoteName);
            }
            assert.isString(newBranch.tracking.branchName);
        }
    }
    if (null !== switchBranch) {
        assert.isString(switchBranch);
    }
    assert.isBoolean(force);

    // attempt the checkout first.

    if (null !== commit) {
        yield exports.checkoutCommit(repo, commit, force);
    }
    if (null !== newBranch) {
        const name = newBranch.name;
        const branch = yield GitUtil.createBranchFromHead(repo, name);
        const tracking = newBranch.tracking;
        if (null !== tracking) {
            const trackingName = tracking.branchName;
            const remote = tracking.remoteName;
            let trackingBranchName;
            if (null !== remote) {
                trackingBranchName = `${remote}/${trackingName}`;
            }
            else {
                trackingBranchName = trackingName;
            }
            yield NodeGit.Branch.setUpstream(branch, trackingBranchName);
        }
    }
    if (null !== switchBranch) {
        yield repo.setHead(`refs/heads/${switchBranch}`);
    }
});

function noSuchFileMessage(subName, path) {
    const fn = `${subName}/${path}`;
    return `error: pathspec '${fn}' did not match any file(s) known to git.`;
}

/**
 * Checkout files in submodules.
 *
 * @param {NodeGit.repository} repo
 * @param {Object}             options
 * @param {Object}             options.resolvedPaths -- keys are submodules,
 *                                                      values are files
 * @param {NodeGit.boolean}    options.checkoutFromIndex  Check out from the
                                                          index
 * @param {NodeGit.Commit}     options.commit  If not null, checking out
 *                                             from a commit
 * @param {NodeGit.Stage}      options.stage  If not null, index stage else 0
 */
exports.checkoutFiles = co.wrap(function*(repo, options) {
    assert.instanceOf(repo, NodeGit.Repository);
    const resolvedPaths = options.resolvedPaths;

    // Exception is thrown if we try to get repo info from unopened submodules.
    // TODO: handle other use cases besides when a commit is not specified.
    const openSubmodules = yield SubmoduleUtil.listOpenSubmodules(repo);
    const submodules = Object.keys(resolvedPaths);
    const subNames = null === options.commit ?
        submodules.filter(submodule => openSubmodules.includes(submodule)) :
        submodules;

    let subCommits;
    let stage = 0;
    if (undefined !== options.stage) {
        assert(options.checkoutFromIndex);
        stage = options.stage;
        assert.isNumber(stage);
    }

    if (options.commit) {
        assert.instanceOf(options.commit, NodeGit.Commit);
        assert(!options.checkoutFromIndex);
        const getShas = SubmoduleUtil.getSubmoduleShasForCommit;
        subCommits = yield getShas(repo, subNames, options.commit);
    } else {
        assert(options.checkoutFromIndex);
    }

    const errors = [];
    const submoduleInfo = {};
    const prepSub = co.wrap(function*(subName) {
        const info = {};
        const subRepo = yield SubmoduleUtil.getRepo(repo, subName);
        info.repo = subRepo;

        const paths = resolvedPaths[subName];
        if (options.checkoutFromIndex) {
            const index = yield subRepo.index();
            info.index = index;
            // libgit2 doesn't care if requested paths don't exist,
            // but we do.
            for (const path of paths) {
                if (undefined === index.getByPath(path, stage)) {
                    errors.push(noSuchFileMessage(subName, path));
                }
            }
        } else {
            const subCommit = subCommits[subName];
            const resolvedSubCommit = yield NodeGit.Commit.lookup(subRepo,
                                                                  subCommit);
            info.resolvedSubCommit = resolvedSubCommit;
            // libgit2 doesn't care if requested paths don't exist,
            // but we do.
            const treeId = resolvedSubCommit.treeId();
            const tree = yield NodeGit.Tree.lookup(subRepo, treeId);

            for (const path of paths) {
                const entry = yield tree.entryByPath(path);
                if (null === entry) {
                    errors.push(noSuchFileMessage(subName, path));
                }
            }
        }

        submoduleInfo[subName] = info;
    });

    yield DoWorkQueue.doInParallel(subNames, prepSub);
    if (errors.length !== 0) {
        throw new UserError(errors.join("\n"));
    }

    const checkoutSub = co.wrap(function*(subName) {
        const info = submoduleInfo[subName];
        const subRepo = info.repo;
        const paths = resolvedPaths[subName];

        const opts = new NodeGit.CheckoutOptions();
        opts.checkoutStrategy = NodeGit.Checkout.STRATEGY.FORCE;
        if (paths.length > 0) {
            opts.paths = paths;
        }
        if (options.checkoutFromIndex) {
            yield NodeGit.Checkout.index(subRepo, info.index, opts);
        } else {
            yield NodeGit.Checkout.tree(subRepo, info.resolvedSubCommit, opts);
        }
    });

    yield DoWorkQueue.doInParallel(subNames, checkoutSub);
});
