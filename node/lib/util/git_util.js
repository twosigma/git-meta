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
 * This module contains common git utility methods that require NodeGit.
 * Otherwise, put them in git_util_fast to optimize their load time.
 */

const assert       = require("chai").assert;
const ChildProcess = require("child-process-promise");
const co           = require("co");
const colors       = require("colors");
const fs           = require("fs-promise");
const NodeGit      = require("nodegit");
const path         = require("path");

const ConfigUtil          = require("./config_util");
const Hook                = require("./hook");
const ForcePushSpec       = require("./force_push_spec");
const GitUtilFast         = require("./git_util_fast");
const SyntheticBranchUtil = require("./synthetic_branch_util");
const UserError           = require("./user_error");

const EXEC_BUFFER = 1024*1024*100;

/**
 * Create a branch having the specified `branchName` in the specified `repo`
 * pointing to the current head.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String} branchName
 * @return {NodeGit.Branch}
 */
exports.createBranchFromHead = co.wrap(function *(repo, branchName) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(branchName);

    const head = yield repo.getHeadCommit();
    return yield repo.createBranch(branchName,
                                   head,
                                   0);
});

/**
 * Return the branch having the specified local `branchName` in the specified
 * `repo`, or null if `repo` does not contain a branch with that name.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String} branchName
 * @return {NodeGit.Reference|null}
 */
exports.findBranch = co.wrap(function *(repo, branchName) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(branchName);

    try {
        return yield repo.getBranch(branchName);
    }
    catch (e) {
        return null;
    }
});

/**
 * Return the tracking information for the specified `branch`, or null if it
 * has none.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Reference} branch
 * @return {Object|null}
 * @return {String|null} return.remoteName
 * @return {String|null} return.pushRemoteName
 * @return {String} return.branchName
 */
exports.getTrackingInfo = co.wrap(function *(repo, branch) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(branch, NodeGit.Reference);
    if (!branch.isBranch()) {
        return null;
    }
    let upstream;
    try {
        upstream = yield NodeGit.Branch.upstream(branch);
    }
    catch (e) {
        // No way to check for this other than to catch.
        return null;
    }
    const name = upstream.shorthand();
    const parts = name.split("/");
    const config = yield repo.config();

    // Try to read a 'pushRemote' for the branch.

    let pushRemote = yield ConfigUtil.getConfigString(
                                     config,
                                    `branch.${branch.shorthand()}.pushRemote`);

    // If no 'pushRemote', try to read a 'pushDefault' for the repo.

    if (null === pushRemote) {
        pushRemote = yield ConfigUtil.getConfigString(config,
                                                      "remote.pushDefault");
    }

    if (1 === parts.length) {
        return {
            branchName: parts[0],
            remoteName: null,
            pushRemoteName: pushRemote,
        };
    }
    const remoteName = parts.shift();
    return {
        branchName: parts.join("/"),
        remoteName: remoteName,
        pushRemoteName: pushRemote || remoteName,
    };
});

/**
 * If the current branch branch in the specified `repo` tracks another branch,
 * return its name (qualified by $remote-name if it's tracking a remote
 * branch), or return null if it tracks no branch.
 *
 * @param {NodeGit.Repository} repo
 * @return {String|null}
 */
exports.getCurrentTrackingBranchName = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const head = yield repo.head();
    const tracking = yield exports.getTrackingInfo(repo, head);
    if (null === tracking) {
        return null;                                                  // RETURN
    }
    if (null === tracking.remoteName) {
        return tracking.branchName;                                   // RETURN
    }
    return `${tracking.remoteName}/${tracking.branchName}`;
});

/**
 * Return the remote associated with the upstream reference of the specified
 * `branch` in the specified `repo`.
 *
 * @param {NodeGit.Repo}      repo
 * @param {NodeGit.Reference} branch
 * @return {NodeGit.Remote|null}
 */
exports.getRemoteForBranch = co.wrap(function *(repo, branch) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(branch, NodeGit.Reference);
    const trackingInfo = yield exports.getTrackingInfo(repo, branch);
    if (null === trackingInfo || null === trackingInfo.remoteName) {
        return null;
    }
    let upstream;
    try {
        upstream = yield NodeGit.Branch.upstream(branch);
    }
    catch (e) {
        // No way to check for this other than to catch.
        return null;
    }
    return yield NodeGit.Remote.lookup(repo, trackingInfo.remoteName);
});

/**
 * Return true if the specified `repo` has a remote with the specified `name`
 * and false otherwise.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             name
 * @return {Boolean}
 */
exports.isValidRemoteName = co.wrap(function *(repo, name) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(name);

    const remotes = yield repo.getRemoteNames();
    return remotes.find(x => x === name) !== undefined;
});

/**
 * Return the URL for the specified `remote` in the specified `repo`, resolving
 * it to an actual path if necessary.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Remote}     remote
 * @return {String}
 */
exports.getRemoteUrl = co.wrap(function *(repo, remote) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(remote, NodeGit.Remote);
    const url = remote.url();
    if (url.startsWith(".")) {
        const resolved = path.resolve(repo.workdir(), url);
        return yield fs.realpath(resolved);                           // RETURN
    }
    return url;
});

/**
 * Return the URL for the remote from which to fetch submodule refs in the
 * specified `repo`, or null if no remote can be found.  If `repo` has a
 * current branch, and that branch has an upstream, return the URL for the
 * remote of that upstream; otherwise, if there is a remote named "origin",
 * return the URL for that remote; otherwise, return null.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @return {String|null}
 */
exports.getOriginUrl = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    const helper = co.wrap(function *() {
        let currentBranch = null;
        try {
            currentBranch = yield repo.getCurrentBranch();
        }
        catch (e) {
            // this can fail, e.g., if the repo is empty
        }
        if (null !== currentBranch) {
            const fromBranch = yield exports.getRemoteForBranch(repo,
                                                                currentBranch);
            if (null !== fromBranch) {
                return fromBranch;
            }
        }
        try {
            return yield repo.getRemote("origin");
        }
        catch (e) {
            return null;
        }
    });
    const remote = yield helper();

    if (null !== remote) {
        return exports.getRemoteUrl(repo, remote);
    }
    return null;
});

/**
 * Return the remote branch having the specified local `branchName` in the
 * remote having the specified `remoteName` in the specified `repo`, or null if
 * no such branch exists.  The behavior is undefined unless 'remoteName' refers
 * to a remote in 'repo'.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             remoteName
 * @param {String}             branchName
 * @return {NodeGit.Reference|null}
 */
exports.findRemoteBranch = co.wrap(function *(repo, remoteName, branchName) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(remoteName);
    assert.isString(branchName);

    // TODO: need to find a way to avoid a linear search of branch names.

    const shorthand = remoteName + "/" + branchName;
    return yield exports.findBranch(repo, shorthand);
});

/**
 * Return the current repository (as located from the current working
 * directory) or throw a `UserError` exception if no git repository can be
 * located from the current directory.
 *
 * @async
 * @return {NodeGit.Repository}
 */
exports.getCurrentRepo = function () {
    const path = GitUtilFast.getRootGitDirectory();
    if (null === path) {
        throw new UserError(
            `Could not find Git directory from ${colors.red(process.cwd())}.`);
    }
    return NodeGit.Repository.open(path);
};

/**
 * Push the specified `source` branch in the specified `repo` to the specified
 * `target` branch in the specified `remote` repository.  Return null if the
 * push succeeded and string containing an error message if the push failed.
 * Attempt to allow a non-ffwd push if the specified `force` is `true`.
 * If `quiet` is true, and push was successful, silence console output.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             remote
 * @param {String}             source
 * @param {String}             target
 * @param {ForcePushSpec}      force
 * @param {Boolean}            [quiet]
 * @return {String} [return]
 */
exports.push = co.wrap(function *(repo, remote, source, target, force, quiet) {
    // TODO: this is an awful hack because I can't yet figure out how to get
    // nodegit to work with kerberos.  For now, will shell out and use the
    // 'git' command.

    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(remote);
    assert.isString(source);
    assert.isString(target);
    assert.instanceOf(force, ForcePushSpec);

    if (undefined === quiet) {
        quiet = false;
    }
    else {
        assert.isBoolean(quiet);
    }

    let forceStr = force ? force.toString() : "";

    const { execString, environ } = (() => {
        if (repo.workdir()) {
            return {
                execString: `\
git -C '${repo.workdir()}' push ${forceStr} ${remote} ${source}:${target}`,
                environ: Object.assign({}, process.env)
            };
        }

        // Hack: set a fake work-tree because the repo's core.worktree might
        // be set to a directory that, due to sparseness, doesn't exist, and
        // git push has a bug which requires it to have a worktree.
        return {
            execString: `\
git -C '${repo.path()}' push ${forceStr} ${remote} ${source}:${target}`,
            environ: Object.assign(
                {},
                process.env,
                { GIT_WORK_TREE: repo.path() }
            )
        };
    })();

    try {
        let result = yield ChildProcess.exec(execString, {
            env : environ,
            maxBuffer: EXEC_BUFFER
        });
        if (result.error &&
            result.stderr.indexOf("reference already exists") !== -1) {
            // GitLab has a race condition that somehow causes this to
            // happen spuriously -- let's retry.
            result = yield ChildProcess.exec(execString, {
                env : environ,
                maxBuffer: EXEC_BUFFER
            });
        }
        if (result.error || !quiet) {
            if (result.stdout) {
                console.log(result.stdout);
            }
            if (result.stderr) {
                console.error(result.stderr);
            }
        }
        return null;
    }
    catch (e) {
        return e.message;
    }
});

/**
 * Return the name of the current branch in the specified `repo` or null if
 * there is no current branch.
 *
 * @param {NodeGit.Repository} repo
 */
exports.getCurrentBranchName = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);

    if (!repo.isEmpty() && 1 !== repo.headDetached()) {
        let branch;
        try {
            branch = yield repo.getCurrentBranch();
        } catch (e) {
            // TODO: raise an issue with libgit2.  If your repository is in a
            // newly initialized state, but not fully empty (e.g., it has
            // configured remotes), this method throws an exception:
            // "reference 'refs/heads/master' not found".  Either it should
            // return null or `isEmpty` should return true.
            return null;
        }
        return branch.shorthand();
    }
    return null;
});

/**
 * Return the commit for the specified `commitish` in the specified `repo` or
 * null if `commitish` cannot be resolved.  Generally, `commitish` may be the
 * name of a branch or a partial commit SHA.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             commitish
 * @return {NodeGit.AnnotatedCommit|null}
 */
exports.resolveCommitish = co.wrap(function *(repo, commitish) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(commitish);

    try {
        return yield NodeGit.AnnotatedCommit.fromRevspec(repo, commitish);
    }
    catch (e) {
        return null;
    }
});

/**
 * Return a git note for the specified commit and ref, or null if the
 * commit has no note on that ref.
 *
 * @param {NodeGit.Repository} repo
 * @param {String}             notesRef
 * @param {String|NodeGit.Oid} oid
 * @return {NodeGit.Note|null}
 */
exports.readNote = co.wrap(function *(repo, notesRef, oid) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(notesRef);
    assert(typeof(oid) === "string" || oid instanceof NodeGit.Oid);

    try {
        return yield NodeGit.Note.read(repo, notesRef, oid);
    }
    catch (e) {
        return null;
    }
});

/**
 * Return a shortened version of the specified `sha`, or `sha` if it is already
 * short enough.
 *
 * @param {String} sha
 * @return {String}
 */
exports.shortSha = function (sha) {
    assert.isString(sha);
    return sha.substr(0, 6);
};

/**
 * Fetch the remote having the specified `remoteName in the specified `repo`.
 * Throw a `UserError` object if the repository cannot be fetched.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             remoteName
 */
exports.fetch = co.wrap(function *(repo, remoteName) {
    // TODO: this is an awful hack because I can't yet figure out how to get
    // nodegit to work with kerberos.  For now, will shell out and use the
    // 'git' command.

    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(remoteName);

    const execString = `git -C '${repo.path()}' fetch -q '${remoteName}'`;
    try {
        return yield ChildProcess.exec(execString, {
            maxBuffer: EXEC_BUFFER
        });
    }
    catch (e) {
        throw new UserError(e.message);
    }
});

/**
 * Fetch the specified `branch` in the remote having the specified `remoteName
 * in the specified `repo`.  Throw a `UserError` object if the repository
 * cannot be fetched.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             remoteName
 * @param {String}             branch
 */
exports.fetchBranch = co.wrap(function *(repo, remoteName, branch) {
    // TODO: this is an awful hack because I can't yet figure out how to get
    // nodegit to work with kerberos.  For now, will shell out and use the
    // 'git' command.

    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(remoteName);
    assert.isString(branch);

    const execString = `\
git -C '${repo.path()}' fetch -q '${remoteName}' '${branch}'`;
    try {
        return yield ChildProcess.exec(execString, {
            maxBuffer: EXEC_BUFFER
        });
    }
    catch (e) {
        throw new UserError(e.message);
    }
});

/**
 * Fetch the specified `sha` from the specified `url` into the specified
 * `repo`, if it does not already exist in `repo`; return true if a fetch
 * happened and false if the commit already existed in `repo`.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             url
 * @param {String}             sha
 * @return {Bool}
 */
exports.fetchSha = co.wrap(function *(repo, url, sha, prefix) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(url);
    assert.isString(sha);
    if (prefix === undefined) {
        prefix = "";
    }

    // First, try to get the commit.  If we succeed, no need to fetch.

    try {
        yield repo.getCommit(sha);
        return false;                                                 // RETURN
    }
    catch (e) {
    }

    const refPrefix = `${SyntheticBranchUtil.SYNTHETIC_BRANCH_BASE}${prefix}`;
    let negotiationTip = "";
    let negotiationAlgorithm = "";
    if (prefix) {
        const refCountCommand = `git -C '${repo.path()}' for-each-ref \
--count 1 ${refPrefix}`;
        let result = yield ChildProcess.exec(refCountCommand);
        const anyRefs = !!result.stdout.trim();
        if (anyRefs) {
            negotiationTip = `--negotiation-tip '${refPrefix}*'`;
        } else {
            // If there are no existing refs, negotiation-tip will be ignored.
            // In this case, we would still prefer not to negotiate
            negotiationAlgorithm = "-c fetch.negotiationAlgorithm=noop";
        }
    }

    const execString = `git -C '${repo.path()}' ${negotiationAlgorithm} fetch \
 -q '${url}' ${negotiationTip} ${sha}:${refPrefix}${sha}`;
    try {
        yield ChildProcess.exec(execString, {
            maxBuffer: EXEC_BUFFER
        });
        yield repo.getCommit(sha);
    }
    catch (e) {
        throw new UserError(e.message, UserError.CODES.FETCH_ERROR);
    }
    return true;
});

/**
 * Return true if the specified `source` commit is up-to-date with the
 * specified `target` commit in the specified `repo`.  A commit is up-to-date
 * with `target` if it is the same commit, or if it is descended from `target`.
 *
 * @private
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             source
 * @param {String}             target
 * @return {Boolean}
 */
exports.isUpToDate = co.wrap(function *(repo, source, target) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(source);
    assert.isString(target);
    if (source === target) {
        return true;                                                  // RETURN
    }
    return yield NodeGit.Graph.descendantOf(repo, source, target);
});

/**
 * Set the HEAD of the specified `repo` to the specified `commit` and force the
 * contents to match it.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 */
exports.setHeadHard = co.wrap(function *(repo, commit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);

    const headId = yield repo.getHeadCommit();
    let oldHead;
    if (headId === null) {
        oldHead = "0000000000000000000000000000000000000000";
    } else {
        oldHead = headId.id().tostrS();
    }
    const newHead = commit.sha();

    yield NodeGit.Checkout.tree(repo, commit, {
        checkoutStrategy: NodeGit.Checkout.STRATEGY.FORCE,
    });
    repo.setHeadDetached(commit);
    yield Hook.execHook(repo, "post-checkout", [oldHead, newHead, "1"]);
});

/**
 * @class {Refspec}
 *
 * This class represents the definition of a refspec.
 */
class Refspec {
    /**
     * Create a new `Refspec` object.
     *
     * @param {Boolean} force whether or not the refspec begins with +
     * @param {String} src
     * @param {String} dst
     * @constructor
     */
    constructor(force, src, dst) {
        assert.isBoolean(force);
        assert.isString(src);
        assert.isString(dst);
        this.d_force = force;
        this.d_src = src;
        this.d_dst = dst;
    }

    /**
     * @property {Boolean} update ref even if it isn’t a fast-forward
     */
    get force() {
        return this.d_force;
    }

    /**
     * @property {String}
     */
    get src() {
        return this.d_src;
    }

    /**
     * @property {String}
     */
    get dst() {
        return this.d_dst;
    }
}

/**
 * Create a new `Refspec` object from a string.
 *
 * @param {String} str
 */
exports.parseRefspec = function(str) {
    assert.isString(str);

    let force = false;

    if (0 === str.indexOf("+")) {
        force = true;
        str = str.replace(/^\+/, "");
    }

    const objs = str.split(":");
    if (1 === objs.length) {
        return new Refspec(force, objs[0], objs[0]);
    }
    else if (2 === objs.length && "" !== objs[1]) {
        return new Refspec(force, objs[0], objs[1]);
    }

    throw new UserError("Refspec must match the format <src>:<dest>.");
};

/**
 * Resolve the specified `filename` against the specified `cwd` and return the
 * relative value for that resulting path to the specified `workdir`.  Throw a
 * `UserError` if the path lies outside `workdir` or does not refer to a file
 * in `workdir`.  Note that if `filename` resolves to `workdir`, the result is
 * `""`.
 *
 * @param {String} workdir
 * @param {String} cwd
 * @param {String} dir
 * @return {String}
 */
exports.resolveRelativePath = function (workdir, cwd, filename) {
    assert.isString(workdir);
    assert.isString(cwd);
    assert.isString(filename);

    if (filename === "") {
        throw new UserError(`Empty path`);
    }
    const absPath = path.resolve(cwd, filename);
    const relPath = path.relative(workdir, absPath);
    if ("" !== relPath && "." === relPath[0]) {
        throw new UserError(`${colors.red(filename)} is outside the workdir.`);
    }
    return relPath;
};

/*
 * Return the editor command to use for the specified `repo`.
 *
 * @param {NodeGit.Repository} repo
 * @return {String}
 */
exports.getEditorCommand = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);
    // TODO: libgit2 doesn't implement the equivalent of `git var` (or if it
    // does I can't see where), so rather than code this myself I shell out to
    // `git`.

    const result =
             yield ChildProcess.exec(`git -C '${repo.path()}' var GIT_EDITOR`,
                                     {maxBuffer: EXEC_BUFFER});
    return result.stdout.split("\n")[0];
});

/**
 * Return the raw result of invoking the configured editor for the specified
 * `repo` with a file containing the specified `initialContents`.  Note that
 * the result may include `initialContents`; this method does not process the
 * result in any way.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             initialContents
 * @return {String}
 */
exports.editMessage = co.wrap(function *(repo, initialContents,
                                         runEditor, runHooks) {
    const messagePath = path.join(repo.path(), "COMMIT_EDITMSG");
    yield fs.writeFile(messagePath, initialContents);
    if (runEditor) {
        const editorCommand = yield exports.getEditorCommand(repo);

        // TODO: if we ever need this to work on Windows, we'll need to do
        // something else.  The `ChildProcess.exec` method doesn't provide for a
        // way to auto-redirect stdio or I'd use it.

        try {
            const args = ["-c", `${editorCommand} '${messagePath}'`];
            yield ChildProcess.spawn("/bin/sh", args, {
                                         stdio: "inherit",
                                     });
        } catch(e) {
            throw new UserError(
                `There was a problem with the editor '${editorCommand}'.
Please supply the message using the -m option.`);
        }

    }

    if (runHooks && (yield Hook.hasHook(repo, "commit-msg"))) {
        const isOk = yield Hook.execHook(repo, "commit-msg", [messagePath]);

        if (!isOk) {
            // hooks are responsible for printing their own message
            throw new UserError("");
        }
    }

    return yield fs.readFile(messagePath, "utf8");
});

/**
 * Return true if the specified `line` is a comment and false otherwise.  A
 * line is a comment if the first non-whitespace character it contains is a
 * '#'.
 *
 * @param {String} line
 * @return {Boolean}
 */
exports.isComment = function (line) {
    assert.isString(line);
    return /^\s*#/.test(line);
};

/**
 * Return true if the specified `line` contains only whitespace characters and
 * false otherwise.
 *
 * @param {String} line
 * @return {Boolean
 */
exports.isBlank = function (line) {
    assert.isString(line);
    return /^\s*$/.test(line);
};

/**
 * Return the text contained in the specified array of `lines` after removing
 * all comment (i.e., those whose first non-whitespace character is a '#') and
 * leading and trailing blank (i.e., those containing only whitespace) lines.
 *
 * @param {String[]} lines
 * @return {String}
 */
exports.stripMessageLines = function (lines) {
    assert.isArray(lines);
    // First, remove all lines that are comments.

    const noComments = lines.filter(line => !exports.isComment(line));

    // Next, find the first and last lines in 'noComments' that contain
    // content, i.e., non-blank lines.

    let firstContent;
    let lastContent;
    for (let i = 0; i < noComments.length; ++i) {
        if (!exports.isBlank(noComments[i])) {
            firstContent =
                undefined === firstContent ? i : Math.min(i, firstContent);
            lastContent =
                undefined === lastContent ? i : Math.max(i, lastContent);
        }
    }
    if (undefined === firstContent) {
        return "";
    }

    // Now, return the result of splicing out the leading and trailing blank
    // lines.

    return noComments.slice(firstContent, lastContent + 1).join("\n") + "\n";
};

/**
 * Return the specified `message` with all comment lines removed (i.e., lines
 * where the first non-whitepsace character is a '#'), and all leading and
 * trailing blank (i.e., those containing only whitespace) lines removed.  Note
 * that any result that is not "" is terminated by a newline.
 *
 * @param {String} message
 * @return {String}
 */
exports.stripMessage = function (message) {
    assert.isString(message);
    const lines = message.split("\n");
    return exports.stripMessageLines(lines);
};

/**
 * Return the (left) parent `NodeGit.Commit` object for the specified `commit`
 * in the specified `repo`, or null if `commit` has no parent.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit} commit
 * @return {NodeGit.Commit|null}
 */
exports.getParentCommit = co.wrap(function *(repo, commit) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    if (0 === commit.parentcount()) {
        return null;                                                  // RETURN
    }
    const parentId = commit.parentId(0);
    return  yield repo.getCommit(parentId);
});

/**
 * Returns the URL for the specified remote.  If the remote is already
 * a URL, it is returned unmodified.
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String} remoteName
 * @return String
 * @throws if there's no such named remote
*/
exports.getUrlFromRemoteName = co.wrap(function *(repo, remoteName) {
    if (remoteName.startsWith("http:") || remoteName.startsWith("https:") ||
        remoteName.includes("@")) {
        return remoteName;
    } else {
        let remote;
        try {
            remote = yield repo.getRemote(remoteName);
        }
        catch (e) {
            throw new UserError(`No remote named ${colors.red(remoteName)}.`);
        }
        return yield exports.getRemoteUrl(repo, remote);
    }
});

/**
 * Return the merge base between the specifed `x` and `y` commits in the
 * specified `repo`, or null if there is no base.
 *
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     x
 * @param {NodeGit.Commit}     y
 * @return {NodeGit.Commit|null}
 */
exports.getMergeBase = co.wrap(function *(repo, x, y) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(x, NodeGit.Commit);
    assert.instanceOf(y, NodeGit.Commit);

    let baseId;
    try {
        baseId = yield NodeGit.Merge.base(repo, x.id(), y.id());
    } catch (e) {
        // only way to detect lack of base
        return null;
    }
    return yield repo.getCommit(baseId);
});

/*
 * Update the HEAD of of the specified `repo` to point to the specified
 * `commit`.  If HEAD points to a branch, update that branch to point to
 * `commit` as well, and supply the specified `reason` for the reflog.
 *
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 * @param {String}             reason
 */
exports.updateHead = co.wrap(function *(repo, commit, reason) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);
    assert.isString(reason);

    if (repo.headDetached()) {
        repo.setHeadDetached(commit.id());
    } else {
        const headRef = yield repo.head();
        yield headRef.setTarget(commit, reason);
    }
});

/*
 * Write the specified `data` to the specified `repo` and return its hash
 * value.
 *
 * @async
 * @private
 * @param {NodeGit.Repository} repo
 * @param {String}             data
 * @return {String}
 */
exports.hashObject = co.wrap(function *(repo, data) {
    const BLOB = 3;
    const db = yield repo.odb();
    const res = yield db.write(data, data.length, BLOB);
    return res;
});

/**
 * You would like to use NodeGit.Merge.bases, but unfortunately,
 * https://github.com/nodegit/nodegit/issues/1231
 * @async
 */
exports.mergeBases = co.wrap(function *(repo, commit1, commit2) {
    const id1 = commit1.id().tostrS();
    const id2 = commit2.id().tostrS();
    const execString = `\
git -C '${repo.path()}' merge-base ${id1} ${id2}`;
    const result = yield ChildProcess.exec(execString, {
        maxBuffer: EXEC_BUFFER
    });
    if (result.error) {
        throw new UserError("Couldn't run git merge-base: " +
                            result.stderr);
    }
    return result.stdout.split("\n").filter(x => x);
});

/**
 * Return the `Reference` object having the specified `name` in the specified
 * `repo`, or null if no such reference exists.
 */
exports.getReference = co.wrap(function *(repo, name) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(name);

    try {
        return yield NodeGit.Reference.lookup(repo, name);
    } catch (e) {
        // only way to tell `name` doesn't exist.
    }
    return null;
});

/**
 * Read an index file, and overwrite an in-memory index with its contents.
 *
 * @param {NodeGit.Index} index
 * @param {String|undefined} path if set, whence to read the index
 */
exports.overwriteIndexFromFile = co.wrap(function*(index, path) {
    assert.instanceOf(index, NodeGit.Index);
    assert.isString(path);

    // TODO: in theory, it might be possible to just check the checksum
    // on the index to avoid reloading it in the common case where nothing
    // has changed.
    const newIndex = yield NodeGit.Index.open(path);
    yield index.removeAll();
    for (const e of newIndex.entries()) {
        yield index.add(e);
    }
});


// This is documented as oid.isZero() but that doesn't actually work.
exports.isZero = function(oid) {
    return oid.tostrS() === "0000000000000000000000000000000000000000";
};
