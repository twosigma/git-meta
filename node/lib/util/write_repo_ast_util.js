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

const RepoAST             = require("../util/repo_ast");
const RepoASTUtil         = require("../util/repo_ast_util");
const SubmoduleConfigUtil = require("../util/submodule_config_util");
const TestUtil            = require("../util/test_util");

                         // Begin module-local methods

/**
 * Exec the specified `command` and return the result, omitting the "\n" at the
 * end.
 * @async
 * @private
 * @param {String} command
 * @return {String}
 */
const doExec = co.wrap(function *(command) {
    try {
        const result = yield exec(command);
        return result.stdout.split("\n")[0];
    }
    catch (e) {
        throw e;
    }
});

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
const hashObject = co.wrap(function *(repo, data) {
    const db = yield repo.odb();
    const BLOB = 3;
    const res = yield db.write(data, data.length, BLOB);
    return res.tostrS();
});

/**
 * Create and return the id of a `NodeGit.Tree` containing the contents of the
 * specified `flatTree` in the specified `repo`.  Use the specified
 * `getSubmoduleSha` to obtain the sha for any submodule commits.
 *
 * @private
 * @async
 * @param {NodeGit.Repo}     repo
 * @param {Object}           flatTree maps path to data or `RepoAST.Submodule`
 * @param {(sha) => Promise} getSubmoduleSha
 * @return {String}
 */
const makeTree = co.wrap(function *(repo, flatTree, getSubmoduleSha) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isObject(flatTree);
    assert.isFunction(getSubmoduleSha);

    // Strategy for making a tree:
    // - take the flat data in `flatTree` and turn it into a hierarchy with
    //   `buildDirectoryTree`
    // - calculate contents of `.gitmodules` file and add to tree
    // - invoke `writeHierarchy` to generate tree id, it will add a line for
    //   each entry:
    // ` - for a file, hash its contents and add a `blob` line
    //   - for a submodule, add a line indicating its sha
    //   - for a subtree, recurse and add a line with subtree id

    const writeHierarchy = co.wrap(function *(hierarchy) {

        let treeData = "";

        function addToTree(fileType, dataType, id, path) {
            if ("" !== treeData) {
                treeData += "\n";
            }
            treeData += `${fileType} ${dataType} ${id}\t${path}`;
        }

        for (let path in hierarchy) {
            const change = hierarchy[path];
            if (change instanceof RepoAST.Submodule) {
                const newSha = yield getSubmoduleSha(change.sha);
                addToTree("160000", "commit", newSha, path);
            }
            else if ("string" === typeof change) {
                // A string indicates files data.

                const id = yield hashObject(repo, change);
                addToTree("100644", "blob", id, path);
            }
            else {
                // If it's not a submodule or a file, it must be a subtree.

                const subTreeId = yield writeHierarchy(change);
                addToTree("040000", "tree", subTreeId, path);
            }
        }

        // If no data, make an empty tree
        if ("" === treeData ) {
            const builder = yield NodeGit.Treebuilder.create(repo, null);
            const treeObj = builder.write();
            return treeObj.tostrS();                                  // RETURN
        }
        const tempDir = yield TestUtil.makeTempDir();
        const tempPath = path.join(tempDir, "treeData");
        yield fs.writeFile(tempPath, treeData);
        const makeTreeExecString = `\
cd ${repo.path()}
cat '${tempPath}' | git mktree
`;
        return yield doExec(makeTreeExecString);
    });

    let gitModulesData = "";

    // Pre-process submodules to get shas and the data for the .gitmodules
    // file.

    for (let path in flatTree) {
        const data = flatTree[path];
        if (data instanceof RepoAST.Submodule) {
            const modulesStr = `\
[submodule "${path}"]
\tpath = ${path}
\turl = ${data.url}
`;
            gitModulesData += modulesStr;
        }
    }

    const directoryTree = exports.buildDirectoryTree(flatTree);
    assert.notProperty(directoryTree,
                       SubmoduleConfigUtil.modulesFileName,
                       "no explicit changes to the git modules file");

    if ("" !== gitModulesData) {
        directoryTree[SubmoduleConfigUtil.modulesFileName] = gitModulesData;
    }

    return yield writeHierarchy(directoryTree);
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
 * Write the specified `commits` map into the specified `repo`.  Return maps
 * from old commit to new and new commit to old.
 *
 * @private
 * @async
 * @param {NodeGit.Repository} repo
 * @param {Object}             commits   id to `RepoAST.Commit`
 * @return {Object}
 * @return {Object} return.oldToNew  maps original to generated commit id
 * @return {Object} return.newToOld  maps generated to original commit id
 */
const writeCommits = co.wrap(function *(repo, commits) {
    let oldCommitMap = {};  // from old to new sha
    let newCommitMap = {};  // from new to old sha
    let renderCache = {};   // used to render commits

    const sig = repo.defaultSignature();

    let commitObjs = {};  // map from new id to `Commit` object

    const writeCommit = co.wrap(function *(sha) {
        // TODO: extend libgit2 and nodegit to allow submoduel manipulations to
        // `TreeBuilder`.  For now, we will do this ourselves using the `git`
        // commandline tool.
        //
        // - First, we calculate the tree describred by the commit at `sha`.
        // - Then, we build a string that describes that as if it were output
        //   by `ls-tree`.
        // - Next, we invoke `git-mktree` to create a tree id
        // - finally, we invoke `git-commit-tree` to create the commit.

        // Bail out if already written.

        if (sha in oldCommitMap) {
            return oldCommitMap[sha];
        }

        // Recursively get commit ids for parents.

        const commit = commits[sha];
        const parents = commit.parents;

        let newParents = [];  // Array of commit IDs
        for (let i = 0; i < parents.length; ++i) {
            let parentSha = yield writeCommit(parents[i]);
            newParents.push(commitObjs[parentSha]);
        }

        // Calculate the tree.  `tree` describes the directory tree specified
        // by the commit at `sha`.

        const tree = RepoAST.renderCommit(renderCache, commits, sha);
        const treeId = yield makeTree(repo, tree, writeCommit);
        const treeObj = yield repo.getTree(treeId);

        // Make a commit from the tree.

        const commitId = yield NodeGit.Commit.create(repo,
                                                     0,
                                                     sig,
                                                     sig,
                                                     0,
                                                     commit.message,
                                                     treeObj,
                                                     newParents.length,
                                                     newParents);
        const commitSha = commitId.tostrS();
        oldCommitMap[sha] = commitSha;
        newCommitMap[commitSha] = sha;
        commitObjs[commitSha] = (yield repo.getCommit(commitSha));
        return commitSha;
    });

    for (let sha in commits) {
        yield writeCommit(sha);
    }

    return { oldToNew: oldCommitMap, newToOld: newCommitMap };
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
 */
const configureRepo = co.wrap(function *(repo, ast, commitMap) {
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

    if (ast.isBare()) {
        if (null !== ast.currentBranchName) {
            repo.setHead("refs/heads/" + ast.currentBranchName);
        }
    }
    else if (null !== ast.currentBranchName) {
        const currentBranch =
                   yield repo.getBranch("refs/heads/" + ast.currentBranchName);
        yield repo.checkoutBranch(currentBranch);
    }
    else {
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

    if (null !== ast.head) {
        // Set up the index.  We render the current commit and apply the index
        // on top of it.

        const tree =
                   yield RepoAST.renderIndex(ast.commits, ast.head, ast.index);
        const treeId = yield makeTree(repo, tree, co.wrap(function *(sha) {
            return yield Promise.resolve(commitMap[sha]);
        }));

        const index = yield repo.index();
        const treeObj = yield repo.getTree(treeId);
        yield index.readTree(treeObj);
        yield index.write();

        // Update the workdir to be up-to-date with index.


        // TODO: Firgure out if this can be done with NodeGit; extend if
        // not.  I didn't see anything about `clean` and `Checkout.index`
        // didn't seem to work..

        const checkoutIndexStr = `\
cd ${repo.workdir()}
git clean -f -d
git checkout-index -a -f
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
 * Return a nested tree mapping the flat structure in the specified `flatTree`,
 * which consists of a map of paths to values, into a hierarchical structure
 * beginning at the root.  For example, if the input is:
 *     { "a/b/c": 2, "a/b/d": 3}
 * the output will be:
 *     { a : { b: { c: 2, d: 3} } }
 *
 * @param {Object} flatTree
 * @return {Object}
 */
exports.buildDirectoryTree = function (flatTree) {
    let result = {};
    for (let path in flatTree) {
        const paths = path.split("/");
        let tree = result;

        // Navigate/build the tree until there is only one path left in paths,
        // then write the entry.

        for (let i = 0; i + 1 < paths.length; ++i) {
            const nextPath = paths[i];
            if (nextPath in tree) {
                tree = tree[nextPath];
                assert.isObject(tree, `for path ${path}`);
            }
            else {
                const nextTree = {};
                tree[nextPath] = nextTree;
                tree = nextTree;
            }
        }
        const leafPath = paths[paths.length - 1];
        assert.notProperty(tree, leafPath, `duplicate entry for ${path}`);
        tree[leafPath] = flatTree[path];
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

    const repo = yield NodeGit.Repository.init(path, ast.isBare() ? 1 : 0);

    yield configRepo(repo);

    const commits = yield writeCommits(repo, ast.commits);
    const resultRepo = yield configureRepo(repo, ast, commits.oldToNew);
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
 * @return {Object} return.repos       map from name to `NodeGit.Repository`
 * @return {Object} return.commitMap   map from new to old commit IDs
 * @return {Object} return.urlMap      map from url to name
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

    const commitMaps = yield writeCommits(commitRepo, commits);

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
        yield configureRepo(repo, ast, commitMaps.oldToNew);
        const cleanupString = `\
cd ${repo.path()}
git -c gc.reflogExpire=0 -c gc.reflogExpireUnreachable=0 \
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
            bare: ast.isBare() ? 1 : 0
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
                                                                repo.workdir(),
                                                                subName,
                                                                sub.url);
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

    return {
        repos: resultRepos,
        commitMap: commitMaps.newToOld,
        urlMap: urlMap,
    };
});

