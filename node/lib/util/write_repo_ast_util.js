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
 * @module {WriteRepoASTUtil}
 *
 * This module contains utilities for writing `RepoAST` objects out into
 * `NodeGit.Repository` objects.
 */

const assert   = require("chai").assert;
const co       = require("co");
const exec     = require("child-process-promise").exec;
const fs       = require("fs-promise");
const mkdirp   = require("mkdirp");
const NodeGit  = require("nodegit");
const path     = require("path");

const ConfigUtil          = require("./config_util");
const ConflictUtil        = require("./conflict_util");
const DoWorkQueue         = require("./do_work_queue");
const GitUtil             = require("./git_util");
const RebaseFileUtil      = require("./rebase_file_util");
const RepoAST             = require("./repo_ast");
const RepoASTUtil         = require("./repo_ast_util");
const SequencerStateUtil  = require("./sequencer_state_util");
const SparseCheckoutUtil  = require("./sparse_checkout_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const TestUtil            = require("./test_util");
const TreeUtil            = require("./tree_util");

const FILEMODE = NodeGit.TreeEntry.FILEMODE;

                         // Begin module-local methods

/**
 * Configure the specified `repo` to have settings needed by git-meta tests.
 *
 * @param {NodeGit.Repository}
 */
const configRepo = co.wrap(function *(repo) {
    assert.instanceOf(repo, NodeGit.Repository);
    const config = yield repo.config();
    yield config.setString("uploadpack.allowReachableSHA1InWant", "true");
});

/**
 * Return the tree and a map of associated subtrees corresponding to the
 * specified `changes` in the specified `repo`, and based on the optionally
 * specified `parent`.  Use the specified `shaMap` to resolve logical shas to
 * actual written shas (such as for submodule heads).
 *
 * @async
 * @param {NodeGit.Repository}    repo
 * @param {Object}                shaMap maps logical to physical ID
 * @param {Object}                changes map of changes
 * @param {Object}                [parent]
 * @param {NodeGit.Tree}          parent.tree       generated tree object
 * @param {Object}                parent.submodules name to url
 * @return {Object}
 * @return {Object}       return.submodules
 * @return {NodeGit.Tree} return.tree
 */
const writeTree = co.wrap(function *(repo,
                                     shaMap,
                                     changes,
                                     parent) {
    let parentTree = null;      // base root
    const submodules = {};      // all submodule entries, including children

    // If `parent` is provided, copy values into the above structures.

    if (undefined !== parent) {
        parentTree = parent.tree;
        Object.assign(submodules, parent.submodules);
    }

    const wereSubs = 0 !== Object.keys(submodules).length;

    const pathToChange = {}; // name to `TreeUtil.Change`

    for (let filename in changes) {
        const entry = changes[filename];

        if (entry instanceof RepoAST.Conflict) {
            // Skip conflicts
            continue;                                               // CONTINUE
        }

        let isSubmodule = false;

        if (null === entry) {
            // Null means the entry was deleted.

            pathToChange[filename] = null;
        }
        else if (entry instanceof RepoAST.File) {
            const id =
                     (yield GitUtil.hashObject(repo, entry.contents)).tostrS();
            const mode =
                      entry.isExecutable ? FILEMODE.EXECUTABLE : FILEMODE.BLOB;
            pathToChange[filename] = new TreeUtil.Change(id, mode);
        }
        else if (entry instanceof RepoAST.Submodule) {
            // For submodules, we must map the logical sha it contains to the
            // actual sha that was written for the submodule commit.

            if(null !== entry.sha) {
                const id = shaMap[entry.sha];
                pathToChange[filename] = new TreeUtil.Change(id,
                                                             FILEMODE.COMMIT);
            }
            submodules[filename] = entry.url;
            isSubmodule = true;
        }
        if (!isSubmodule) {
            // In case this entry was previously a submodule, we have to remove
            // it from the submodule list.

            delete submodules[filename];  // can not be a submodule
        }
    }

    // If this is a "root" tree, and there are submodules, we must write the
    // `.gitmodules` file.

    const subNames = Object.keys(submodules).sort();
    if (0 !== subNames.length) {
        let data = "";
        for (let i = 0; i < subNames.length; ++i) {
            const filename = subNames[i];
            const url = submodules[filename];
            data += `\
[submodule "${filename}"]
\tpath = ${filename}
\turl = ${url}
`;
        }
        const dataId = (yield GitUtil.hashObject(repo, data)).tostrS();
        pathToChange[SubmoduleConfigUtil.modulesFileName] =
                                    new TreeUtil.Change(dataId, FILEMODE.BLOB);
    }
    else if (wereSubs) {
        pathToChange[SubmoduleConfigUtil.modulesFileName] = null;
    }

    const newTree = yield TreeUtil.writeTree(repo, parentTree, pathToChange);
    return {
        tree: newTree,
        submodules: submodules,
    };
});

/**
 * Write the commits having the specified `shas` from the specified `commits`
 * map into the specified `repo`.  Read and write logical to physical sha
 * mappings to and from the specified `oldCommitMap`.  Use the specifeid
 * `treeCache` to store computed directory structures and trees.  Return a map
 * from new (physical) sha from the original (logical) sha of the commits
 * written.
 *
 * @async
 * @param {Object} oldCommitMap old to new sha, read/write
 * @param {Object} treeCache  cache of generated commit trees
 * @param {NodeGit.Repository} repo
 * @param {Object}             commits sha to `RepoAST.Commit`
 * @param {String[]}           shas    array of shas to write
 * @return {Object} maps generated to original commit id
 */
exports.writeCommits = co.wrap(function *(oldCommitMap,
                                          treeCache,
                                          repo,
                                          commits,
                                          shas) {
    assert.isObject(oldCommitMap);
    assert.isObject(treeCache);
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isObject(commits);
    assert.isArray(shas);

    let newCommitMap = {};  // from new to old sha

    const sig = yield ConfigUtil.defaultSignature(repo);

    const commitObjs = {};  // map from new id to `Commit` object

    const writeCommit = co.wrap(function *(sha) {
        const commit = commits[sha];
        const parents = commit.parents;

        // Get commit objects for parents.

        let parentTrees;
        let newParents = [];  // Array of commit IDs
        for (let i = 0; i < parents.length; ++i) {
            const parent = parents[i];
            if (0 === i) {
                parentTrees = treeCache[parent];
            }
            const parentSha = oldCommitMap[parent];
            const parentCommit = yield repo.getCommit(parentSha);
            newParents.push(parentCommit);
        }

        // Calculate the tree.  `trees` describes the directory tree specified
        // by the commit at `sha` and has caches for subtrees and submodules.

        const trees = yield writeTree(repo,
                                      oldCommitMap,
                                      commit.changes,
                                      parentTrees);

        // Store the returned tree information for potential use by descendants
        // of this commit.

        treeCache[sha] = trees;

        // Make a commit from the tree.

        const commitId = yield NodeGit.Commit.create(repo,
                                                     0,
                                                     sig,
                                                     sig,
                                                     0,
                                                     commit.message,
                                                     trees.tree,
                                                     newParents.length,
                                                     newParents);
        const commitSha = commitId.tostrS();

        // Store bi-directional mappings between generated and logical sha.

        oldCommitMap[sha] = commitSha;
        newCommitMap[commitSha] = sha;
        commitObjs[commitSha] = (yield repo.getCommit(commitSha));
        return commitSha;
    });

    // Calculate the groups of commits that can be computed in parallel.

    const commitsByLevel = exports.levelizeCommitTrees(commits, shas);

    for (let i = 0; i < commitsByLevel.length; ++i) {
        const level = commitsByLevel[i];
        yield DoWorkQueue.doInParallel(level, writeCommit);
    }
    return newCommitMap;
});

/**
 * Write all of the specified `commits` into the specified `repo`.
 *
 * @async
 * @private
 * @param {NodeGit.Repository} repo
 * @param {Object}             commits sha to `RepoAST.Commit`
 * @param {Object}             treeCache
 * @return {Object}
 * @return {Object} return.oldToNew  maps original to generated commit id
 * @return {Object} return.newToOld  maps generated to original commit id
 */
const writeAllCommits = co.wrap(function *(repo, commits, treeCache) {
    const oldCommitMap = {};
    const newIds = yield exports.writeCommits(oldCommitMap,
                                              treeCache,
                                              repo,
                                              commits,
                                              Object.keys(commits));
    return {
        newToOld: newIds,
        oldToNew: oldCommitMap,
    };
});

/**
 * Configure the specified `repo` to have the state described in the specified
 * `ast`.  Use the specified `commitMap` to map commit IDs in `ast`.  Return
 * the resulting `NodeGit.Repository` object, which may not be `repo`, but will
 * be at the same location as `repo` was.
 *
 * @private
 * @async
 * @param {NodeGit.Repository} repo
 * @param {RepoAST}            ast
 * @param {Object}             commitMap  old to new id
 * @param {Object}             treeCache  map of tree entries
 */
const configureRepo = co.wrap(function *(repo, ast, commitMap, treeCache) {
    const makeConflictEntry = co.wrap(function *(data) {
        assert.instanceOf(repo, NodeGit.Repository);
        if (null === data) {
            return null;
        }
        if (data instanceof RepoAST.Submodule) {
            //TODO: some day support putting conflicts in the .gitmodules file.
            assert.equal("",
                         data.url,
                         "submodule conflicts must have empty URL");
            const sha = commitMap[data.sha];
            return new ConflictUtil.ConflictEntry(FILEMODE.COMMIT, sha);
        }
        const id = yield GitUtil.hashObject(repo, data.contents);
        const mode = data.isExecutable ? FILEMODE.EXECUTABLE : FILEMODE.BLOB;
        return new ConflictUtil.ConflictEntry(mode, id.tostrS());
    });

    const makeRef = co.wrap(function *(name, commit) {
        const newSha = commitMap[commit];
        const newId = NodeGit.Oid.fromString(newSha);
        return yield NodeGit.Reference.create(repo,
                                              name,
                                              newId,
                                              0,
                                              "made ref");
    });

    let newHeadSha = null;
    if (null !== ast.head) {
        newHeadSha = commitMap[ast.head];
    }

    // Then create the refs

    for (let ref in ast.refs) {
        yield makeRef("refs/" + ref, ast.refs[ref]);
    }

    // Handle remotes.

    for (let remoteName in ast.remotes) {
        const remote = ast.remotes[remoteName];
        yield NodeGit.Remote.create(repo, remoteName, remote.url);

        // Explicitly create the desired refs for the remote.

        for (let branchName in remote.branches) {
            yield makeRef(`refs/remotes/${remoteName}/${branchName}`,
                          remote.branches[branchName]);
        }
    }

    // Then create the branches we want.

    for (let branch in ast.branches) {
        const astBranch = ast.branches[branch];
        const ref = yield makeRef("refs/heads/" + branch, astBranch.sha);
        if (null !== astBranch.tracking) {
            yield NodeGit.Branch.setUpstream(ref, astBranch.tracking);
        }
    }

    // Deal with bare repos.

    if (ast.bare) {
        if (null !== ast.currentBranchName) {
            yield repo.setHead("refs/heads/" + ast.currentBranchName);
        }
        else {
            repo.setHeadDetached(newHeadSha);
        }
    }
    else if (null !== ast.currentBranchName || null !== ast.head) {
        // If we use NodeGit to checkout, it will not respect the
        // sparse-checkout settings.

        if (null === ast.currentBranchName) {
            repo.detachHead();
        }

        const toCheckout = ast.currentBranchName || newHeadSha;
        const checkoutStr = `\
git -C '${repo.workdir()}' checkout ${toCheckout}
`;
        try {
            yield exec(checkoutStr);
        } catch (e) {
            // This can fail if there is no .gitmodules file to checkout and
            // it's sparse.  Git will complain that it cannot do the checkout
            // because the worktree is empty.
        }
    }

    const notes = ast.notes;
    const sig = yield ConfigUtil.defaultSignature(repo);
    for (let notesRef in notes) {
        const commits = notes[notesRef];
        for (let commit in commits) {
            const message = commits[commit];
            yield NodeGit.Note.create(repo, notesRef, sig, sig,
                                      commitMap[commit], message, 0);
        }
    }

    if (!ast.bare) {

        let indexHead = ast.head;

        // Set up a rebase if there is one, this has to come right before
        // setting up the workdir, otherwise the rebase won't be allowed to
        // start.

        if (null !== ast.rebase) {
            const rebase = ast.rebase;
            const originalSha = commitMap[rebase.originalHead];
            const ontoSha = commitMap[rebase.onto];
            const original = yield NodeGit.AnnotatedCommit.lookup(repo,
                                                                  originalSha);
            const onto = yield NodeGit.AnnotatedCommit.lookup(repo, ontoSha);

            // `init` creates the rebase, but it's not actually started (some
            // files are not made) until the first call to `next`.

            const rb  =
                   yield NodeGit.Rebase.init(repo, original, onto, null, null);
            yield rb.next();
            const gitDir = repo.path();
            const rbDir = yield RebaseFileUtil.findRebasingDir(gitDir);
            const headNamePath = path.join(gitDir,
                                           rbDir,
                                           RebaseFileUtil.headFileName);
            yield fs.writeFile(headNamePath, rebase.headName + "\n");

            // Starting a rebase will change the HEAD  If we render the index
            // against `ast.head`, it will be incorrect; we must adjust so that
            // we render against the new head, `onto`.

            indexHead = rebase.onto;
        }

        // Write out sequencer state if there is one.
        const sequencer = ast.sequencerState;
        if (null !== sequencer) {
            const mapped = SequencerStateUtil.mapCommits(sequencer, commitMap);
            yield SequencerStateUtil.writeSequencerState(repo.path(), mapped);
        }

        // Set up the index.  We render the current commit and apply the index
        // on top of it.

        let indexParent;
        if (null !== indexHead) {
            indexParent = treeCache[indexHead];
        }
        const trees = yield writeTree(repo,
                                      commitMap,
                                      ast.index,
                                      indexParent);
        const index = yield repo.index();
        const treeObj = trees.tree;
        yield index.readTree(treeObj);
        for (let filename in ast.index) {
            const data = ast.index[filename];
            if (data instanceof RepoAST.Conflict) {
                const ancestor = yield makeConflictEntry(data.ancestor);
                const our = yield makeConflictEntry(data.our);
                const their = yield makeConflictEntry(data.their);
                const conflict = new ConflictUtil.Conflict(ancestor,
                                                           our,
                                                           their);
                yield ConflictUtil.addConflict(index, filename, conflict);
            }
        }

        yield index.write();

        // TODO: Firgure out if this can be done with NodeGit; extend if
        // not.  I didn't see anything about `clean` and `Checkout.index`
        // didn't seem to work..

        let checkoutStr;
        if (ast.sparse) {
            const index = yield repo.index();
            if (index.getByPath(".gitmodules")) {
                checkoutStr = `
git -C '${repo.workdir()}' checkout-index -f .gitmodules`;
            } else {
                checkoutStr = "";
            }
        } else {
            checkoutStr = `git -C '${repo.workdir()}' checkout-index -f -a`;
        }
        const checkoutIndexStr = `\
git -C '${repo.workdir()}' checkout --
git -C '${repo.workdir()}' clean -f -d
${checkoutStr}
`;
        yield exec(checkoutIndexStr);

        // Now apply changes to the workdir.

        const workdir = ast.workdir;
        for (let filePath in workdir) {
            const change = workdir[filePath];
            const absPath = path.join(repo.workdir(), filePath);
            if (null === change) {
                yield fs.unlink(absPath);
            }
            else {
                const dirname = path.dirname(absPath);
                mkdirp.sync(dirname);
                yield fs.writeFile(absPath, change.contents);
                if (change.isExecutable) {
                    yield fs.chmod(absPath, "755");
                }
            }
        }
    }

    return repo;
});

                          // End modue-local methods

/**
 * Return an array of arrays of commit shas such that the trees of the commits
 * identified in an array depend only on the commits in previous arrays.  The
 * tree of one commit depends on another commit (i.e., cannot be created until
 * that commit exists) if it has a submodule sha referencing that commit.
 * Until the commit is created, we do not know what its actual sha will be.
 *
 * @param {Object} commits map from sha to `RepoAST.Commit`.
 * @return {Array} array of arrays of shas
 */
exports.levelizeCommitTrees = function (commits, shas) {
    assert.isObject(commits);
    assert.isArray(shas);

    const includedShas = new Set(shas);

    let result = [];
    const commitLevels = {};  // from sha to number

    function computeCommitLevel(sha) {
        if (sha in commitLevels) {
            return commitLevels[sha];
        }
        const commit = commits[sha];
        const changes = commit.changes;
        let level = 0;

        // If this commit has a change that references another commit via a
        // submodule sha, it must have a level at least one greater than that
        // commit, if it is also in the set of shas being levelized.

        for (let path in changes) {
            const change = changes[path];
            if (change instanceof RepoAST.Submodule) {
                if (includedShas.has(change.sha)) {
                    level = Math.max(computeCommitLevel(change.sha) + 1,
                                     level);
                }
            }
        }

        // Similarly, with parents, a commit's level must be greater than that
        // of parents that are included.

        const parents = commit.parents;
        for (let i = 0; i < parents.length; ++i) {
            const parent = parents[i];
            if (includedShas.has(parent)) {
                level = Math.max(level, computeCommitLevel(parent) + 1);
            }
        }
        commitLevels[sha] = level;
        if (result.length === level) {
            result.push([]);
        }
        result[level].push(sha);
        return level;
    }

    for (let i = 0; i < shas.length; ++i) {
        computeCommitLevel(shas[i]);
    }

    return result;
};

/**
 * Create a repository having the state described by the specified `ast` to the
 * specified `path`.  Return the newly created repository and a map from the
 * commit IDs in `ast` to the actual commit IDs created.  The behavior is
 * undefined if `ast` specifies any open submodules.
 *
 * @async
 * @param {RepoAST} ast
 * @param {String}  path
 * @return {Object}
 * @return {NodeGit.Repository} return.repo
 * @return {Object}             return.commitMap map from new ID to input ID
 * @return {Object}             return.oldCommitMap  from input ID to new ID
 */
exports.writeRAST = co.wrap(function *(ast, path) {
    // TODO: just doing basic operations as needed, known not done:
    // 1. merge commits (i.e., with multiple parents)

    assert.instanceOf(ast, RepoAST);
    assert.isString(path);
    assert.deepEqual(ast.openSubmodules, {}, "open submodules not supported");

    const repo = yield NodeGit.Repository.init(path, ast.bare ? 1 : 0);

    if (ast.sparse) {
        yield SparseCheckoutUtil.setSparseMode(repo);
    }

    yield configRepo(repo);

    const treeCache = {};
    const commits = yield writeAllCommits(repo, ast.commits, treeCache);
    const resultRepo = yield configureRepo(repo,
                                           ast,
                                           commits.oldToNew,
                                           treeCache);

    return {
        repo: resultRepo,
        commitMap: commits.newToOld,
        oldCommitMap: commits.oldToNew,
    };
});

/**
 * Return all the `Commit` objects in the specified `repos`.
 *
 * @param {Object} name to `RepoAST`
 * @return {Object} sha to `Commit`
 */
function listCommits(repos) {
    const commits = {};
    for (let repoName in repos) {
        const repo = repos[repoName];
        Object.assign(commits, RepoASTUtil.listCommits(repo));
    }
    return commits;
}

/**
 * Write the repositories described in the specified `repos` map to a the
 * specified `rootDirectory`.  Return a map from repo name to
 * `NodeGit.Repository` objects, a map from the newly-generated commit IDs to
 * the original IDs in the ASTs, and a map from repo urls to their names.
 *
 * @async
 * @param {Object} repos
 * @param {String} rootDirectory
 * @return {Object}
 * @return {Object} return.repos        map from name to `NodeGit.Repository`
 * @return {Object} return.commitMap    map from new to old commit IDs
 * @return {Object} return.reverseCommitMap   map from old to new commit IDs
 * @return {Object} return.urlMap       map from new url to old name
 * @return {Object} return.reverseUrlMap map from old url to new name
 */
exports.writeMultiRAST = co.wrap(function *(repos, rootDirectory) {
    // This operation is complicated by the need to have a single commit ID
    // universe.  To make it work, we will use foul trickery:
    //   - create a single "commit" repo to which we will write all commits
    //   - when writing the actual repos, start them out as clones from the
    //     commit repo
    //   - but immediately remove the origin
    //   - then set up branches, remotes, HEAD, etc. as usual.

    assert.isObject(repos);
    assert.isString(rootDirectory);

    rootDirectory = yield fs.realpath(rootDirectory);

    repos = Object.assign({}, repos);  // make a copy

    // create a path for each repo

    let repoPaths = {};
    let urlMap = {};
    for (let repoName in repos) {
        const repoPath = path.join(rootDirectory, repoName);
        repoPaths[repoName] = repoPath;
        urlMap[repoPath] = repoName;
    }

    // First, collect all the commits:

    let commits = listCommits(repos);

    // Make an id map so that we can rewrite just URLs

    const map = {};
    for (let sha in commits) {
        map[sha] = sha;
    }

    // Now, rewrite all the repo ASTs to have the right urls.

    for (let repoName in repos) {
        const repoAST = repos[repoName];
        repos[repoName] =
                        RepoASTUtil.mapCommitsAndUrls(repoAST, map, repoPaths);
    }

    // Re-list commits now that URLs are updated.

    commits = listCommits(repos);

    const commitRepoPath = yield TestUtil.makeTempDir();
    const commitRepo = yield NodeGit.Repository.init(commitRepoPath, 0);

    // Write them:

    const treeCache = {};
    const commitMaps = yield writeAllCommits(commitRepo, commits, treeCache);

    // We make a ref for each commit so that it is pulled down correctly.

    for (let id in commits) {
        const newSha = commitMaps.oldToNew[id];
        const newId = NodeGit.Oid.fromString(newSha);
        const name = "refs/heads/" + id;
        yield NodeGit.Reference.create(commitRepo, name, newId, 0, "made ref");
    }

    /**
     * Configure the specified `repo` to have the value of the specified `ast`.
     * The behavior is undefined unless `repo` is a clone of the commit repo.
     *
     * @async
     * @param {NodeGit.Repository} repo
     * @param {RepoAST}            ast
     */

    const writeRepo = co.wrap(function *(repo, ast) {
        assert.instanceOf(ast, RepoAST);

        // Now we should have all the commits from `commitRepo` so delete it
        // and all associated refs.  We have to detach the head or it keeps
        // around the current branch.

        repo.detachHead();

        const refs = yield repo.getReferences();
        for (let i = 0; i < refs.length; ++i) {
            NodeGit.Branch.delete(refs[i]);
        }
        yield NodeGit.Remote.delete(repo, "origin");

        // Then set up the rest of the repository.
        yield configureRepo(repo, ast, commitMaps.oldToNew, treeCache);
        const cleanupString = `\
git -C '${repo.path()}' -c gc.reflogExpire=0 -c gc.reflogExpireUnreachable=0 \
-c gc.rerereresolved=0 -c gc.rerereunresolved=0 \
-c gc.pruneExpire=now gc`;
        yield exec(cleanupString);
    });

    // Now generate the actual repos.

    let resultRepos = {};
    for (let repoName in repos) {
        const ast = repos[repoName];
        const repoPath = repoPaths[repoName];
        const repo = yield NodeGit.Clone.clone(commitRepo.workdir(),
                                               repoPath, {
            bare: ast.bare ? 1 : 0
        });
        if (ast.sparse) {
            yield SparseCheckoutUtil.setSparseMode(repo);
        }
        yield configRepo(repo);
        yield writeRepo(repo, ast, repoPath);
        resultRepos[repoName] = repo;

        let index = null;

        // If the base repo has a remote, read its url.

        const remotes = ast.remotes;
        let originUrl = null;
        if ("origin" in remotes) {
            originUrl = remotes.origin.url;
        }

        // Render open submodules.

        for (let subName in ast.openSubmodules) {

            if (null === index) {
                index =
                   RepoAST.renderIndex(ast.commits, ast.head, ast.index);
            }
            const sub = index[subName];
            const openSubAST = ast.openSubmodules[subName];

            const subRepo = yield SubmoduleConfigUtil.initSubmoduleAndRepo(
                                                                originUrl,
                                                                repo,
                                                                subName,
                                                                sub.url,
                                                                null,
                                                                false);
            // Pull in commits from the commits repo, but remove the remote
            // when done.

            yield NodeGit.Remote.create(subRepo,
                                        "commits",
                                        commitRepo.workdir());
            yield subRepo.fetchAll();
            yield NodeGit.Remote.delete(subRepo, "commits");

            yield writeRepo(subRepo, openSubAST);
        }
    }
    const reverseUrlMap = {};
    Object.keys(urlMap).forEach(url => {
        reverseUrlMap[urlMap[url]] = url;
    });
    return {
        repos: resultRepos,
        commitMap: commitMaps.newToOld,
        reverseCommitMap: commitMaps.oldToNew,
        urlMap: urlMap,
        reverseUrlMap: reverseUrlMap,
    };
});

