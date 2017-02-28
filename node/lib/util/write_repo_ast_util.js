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

const DoWorkQueue         = require("./do_work_queue");
const RebaseFileUtil      = require("./rebase_file_util");
const RepoAST             = require("./repo_ast");
const RepoASTUtil         = require("./repo_ast_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const TestUtil            = require("./test_util");
const TreeUtil            = require("./tree_util");

                         // Begin module-local methods

/**
 * Write the specified `data` to the specified `repo` and return its hash
 * value.
 *
 * @async
 * @private
 * @param {NodeGit.Repository} repo
 * @param {String}             data
 * @return {String}
 */
const hashObject = co.wrap(function *(db, data) {
    const BLOB = 3;
    const res = yield db.write(data, data.length, BLOB);
    return res.tostrS();
});

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
 * actual written shas (such as for submodule heads).  Use the specified `db`
 * to write objects.
 *
 * @async
 * @param {NodeGit.Repository}    repo
 * @param {NodeGit.Odb}           db
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
                                     db,
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

    const FILEMODE = NodeGit.TreeEntry.FILEMODE;
    const wereSubs = 0 !== Object.keys(submodules).length;

    const pathToChange = {}; // name to `TreeUtil.Change`

    for (let filename in changes) {
        const entry = changes[filename];

        let isSubmodule = false;

        if (null === entry) {
            // Null means the entry was deleted.

            pathToChange[filename] = null;
        }
        else if ("string" === typeof entry) {
            // A string is just plain data.

            const id = yield hashObject(db, entry);
            pathToChange[filename] = new TreeUtil.Change(id, FILEMODE.BLOB);
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
        const dataId = yield hashObject(db, data);
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

    const db = yield repo.odb();
    let newCommitMap = {};  // from new to old sha

    const sig = repo.defaultSignature();

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
                                      db,
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
    const makeRef = co.wrap(function *(name, commit) {
        const newSha = commitMap[commit];
        const newId = NodeGit.Oid.fromString(newSha);
        yield NodeGit.Reference.create(repo, name, newId, 0, "made ref");
    });

    let newHeadSha = null;
    if (null !== ast.head) {
        newHeadSha = commitMap[ast.head];
    }

    // Then create the branches we want.

    for (let branch in ast.branches) {
        yield makeRef("refs/heads/" + branch, ast.branches[branch]);
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

    // Deal with bare repos.

    if (ast.bare) {
        if (null !== ast.currentBranchName) {
            repo.setHead("refs/heads/" + ast.currentBranchName);
        }
        else {
            repo.setHeadDetached(newHeadSha);
        }
    }
    else if (null !== ast.currentBranchName) {
        const currentBranch =
                   yield repo.getBranch("refs/heads/" + ast.currentBranchName);
        yield repo.checkoutBranch(currentBranch);
    }
    else if (null !== ast.head) {
        const headCommit = yield repo.getCommit(newHeadSha);
        repo.setHeadDetached(newHeadSha);
        yield NodeGit.Reset.reset(repo, headCommit, NodeGit.Reset.TYPE.HARD);
    }

    const notes = ast.notes;
    const sig = repo.defaultSignature();
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

        // Set up the index.  We render the current commit and apply the index
        // on top of it.

        let indexParent;
        if (null !== indexHead) {
            indexParent = treeCache[indexHead];
        }
        const db = yield repo.odb();
        const trees = yield writeTree(repo,
                                      db,
                                      commitMap,
                                      ast.index,
                                      indexParent);
        const index = yield repo.index();
        const treeObj = trees.tree;
        yield index.readTree(treeObj);
        yield index.write();

        // TODO: Firgure out if this can be done with NodeGit; extend if
        // not.  I didn't see anything about `clean` and `Checkout.index`
        // didn't seem to work..

        const checkoutIndexStr = `\
git -C '${repo.workdir()}' clean -f -d
git -C '${repo.workdir()}' checkout-index -a -f
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
                yield fs.writeFile(absPath, change);
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
        const repoPath = path.join(rootDirectory, repoName, "/");
        repoPaths[repoName] = repoPath;
        urlMap[repoPath] = repoName;
    }

    // Now, rewrite all the repo ASTs to have the right urls.
    for (let repoName in repos) {
        const repoAST = repos[repoName];
        repos[repoName] =
                         RepoASTUtil.mapCommitsAndUrls(repoAST, {}, repoPaths);
    }

    // First, collect all the commits:

    let commits = {};
    for (let repoName in repos) {
        const repo = repos[repoName];
        Object.assign(commits, repo.commits);

        // Also, commits from open submodules.

        for (let subName in repo.openSubmodules) {
            Object.assign(commits, repo.openSubmodules[subName].commits);
        }
    }

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

        const refs = yield repo.getReferences(NodeGit.Reference.TYPE.LISTALL);
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
                   yield RepoAST.renderIndex(ast.commits, ast.head, ast.index);
            }
            const sub = index[subName];
            const openSubAST = ast.openSubmodules[subName];

            const subRepo = yield SubmoduleConfigUtil.initSubmoduleAndRepo(
                                                                originUrl,
                                                                repo,
                                                                subName,
                                                                sub.url,
                                                                null);
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

