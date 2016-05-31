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
 * @module {RepoASTIOUtil}
 *
 * This module contains utilities for reading and writing `RepoAST` objects out
 * of and into `NodeGit.Repository` objects.
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
 * Exec the specified `string` and return the result, omitting the "\n" at the
 * end.
 * @async
 * @private
 * @param {String} string
 * @return {String}
 */
const doExec = co.wrap(function *(string) {
    const result = yield exec(string);
    return result.stdout.split("\n")[0];
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
        const makeTreeExecString = `\
cd ${repo.path()}
echo '${treeData}' | git mktree
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
            newParents.push(NodeGit.Oid.fromString(parentSha));
        }

        // Calculate the tree.  `tree` describes the directory tree specified
        // by the commit at `sha`.

        const tree = RepoAST.renderCommit(renderCache, commits, sha);
        const treeId = yield makeTree(repo, tree, writeCommit);

        let makeCommitString = `\
cd ${repo.path()}
git commit-tree -m commit ${treeId}`;
        if (0 !== newParents.length) {
            makeCommitString += ` -p ${newParents[0]}`;
        }
        const commitId = yield doExec(makeCommitString);
        oldCommitMap[sha] = commitId;
        newCommitMap[commitId] = sha;
        return commitId;
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

    // Handle remotes.

    for (let remoteName in ast.remotes) {
        const remote = ast.remotes[remoteName];
        NodeGit.Remote.create(repo, remoteName, remote.url);

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

    if (null !== ast.head) {
        // Set up the index.  We render the current commit and apply the index
        // on top of it.

        const tree = RepoAST.renderIndex(ast.commits, ast.head, ast.index);
        const treeId = yield makeTree(repo, tree, co.wrap(function *(sha) {
            return yield Promise.resolve(commitMap[sha]);
        }));

        const index = yield repo.index();
        const treeObj = yield repo.getTree(treeId);
        index.readTree(treeObj);
        index.write();

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
                yield fs.writeFile(absPath, change);
            }
        }
    }

    return repo;
});


/**
 * Return a map from submodule name to url at the specified `commit` in the
 * specified `repo`.
 *
 * @private
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Commit}     commit
 * @return {Object} map from name to url
 */
const getSubmodulesFromCommit = co.wrap(function *(repo, commit) {
    const tree = yield commit.getTree();
    let entry;
    try {
        entry = yield tree.entryByPath(SubmoduleConfigUtil.modulesFileName);
    }
    catch (e) {
        // No modules file.
        return {};
    }
    const oid = entry.oid();
    const blob = yield repo.getBlob(oid);
    const data = blob.toString();
    return  SubmoduleConfigUtil.parseSubmoduleConfig(data);
});

/**
 * Return a map from submodule name to url in the specified `repo`.
 *
 * @private
 * @async
 * @param {NodeGit.Repository} repo
 * @param {NodeGit.Index}      index
 * @return {Object} map from name to url
 */
const getSubmodulesFromIndex = co.wrap(function *(repo, index) {
    const entry = index.getByPath(SubmoduleConfigUtil.modulesFileName);
    if (undefined === entry) {
        return {};                                                    // RETURN
    }
    const oid = entry.id;
    const blob = yield repo.getBlob(oid);
    const data = blob.toString();
    return  SubmoduleConfigUtil.parseSubmoduleConfig(data);
});

                          // End modue-local methods

/**
 * Return a representation of the specified `repo` encoded in an `AST` object.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @return {RepoAST}
 */
exports.readRAST = co.wrap(function *(repo) {
    // We're going to list all the branches in `repo`, and walk each of their
    // histories to generate a complete set of commits.

    assert.instanceOf(repo, NodeGit.Repository);
    const branches = yield repo.getReferences(NodeGit.Reference.TYPE.LISTALL);
    let commits = {};
    let branchTargets = {};

    // Load up the remotes.

    const remotes = yield NodeGit.Remote.list(repo);
    let remoteMap = {};
    for (let i = 0; i < remotes.length; ++i) {
        const remoteName = remotes[i];
        const remote = yield NodeGit.Remote.lookup(repo, remoteName);
        remoteMap[remoteName] = {
            url: remote.url(),
            branches: {},
        };
    }

    // For various operations where `NodeGit` can return arrays, it requires a
    // maximum count size; I think it sets up a pre-allocated buffer.  I'm
    // picking a fairly arbitrary, but probably large enough, number for this.

    const MAX_IDS = 1000000;

    // Load all the commits.

    const loadCommit = co.wrap(function *(id) {
        assert.instanceOf(id, NodeGit.Oid);
        const revwalk = repo.createRevWalk();
        revwalk.push(id);
        const ids = yield revwalk.fastWalk(MAX_IDS);
        const commitLoaders = ids.map(co.wrap(function *(commitId) {

            const commitStr = commitId.tostrS();

            // Don't load already loaded commits

            if (commitStr in commits) {
                return;                                               // RETURN
            }

            let changes = {};

            // Put a placeholder in the `commits` map to prevent duplicate
            // processing of a commit.

            commits[commitStr] = true;

            // Loop through all the diffs for the commit and read the value of
            // each changed file.  Special action must be taken for submodules.
            // We will first load up a list of them from the `.gitmodules` file
            // in the specified commit (if it exists) and that is how we will
            // be able to identify changed paths as being submodules.

            const commit = yield repo.getCommit(commitId);
            const submodules = yield getSubmodulesFromCommit(repo, commit);
            const diffs = yield commit.getDiff();
            const differs = diffs.map(co.wrap(function *(diff) {
                for (let i = 0; i < diff.numDeltas(); ++i) {
                    const delta = diff.getDelta(i);
                    const path = delta.newFile().path();

                    // We ignore the `.gitmodules` file.  Changes to it are an
                    // implementation detail and will be reflected in changes
                    // to submodule paths.

                    if (SubmoduleConfigUtil.modulesFileName === path) {
                        continue;
                    }
                    const DELETED = 2;
                    if (DELETED === delta.status()) {
                        changes[path] = null;
                    }
                    else if (path in submodules) {
                        const url = submodules[path];
                        const entry = yield commit.getEntry(path);
                        const sha = entry.sha();
                        changes[path] = new RepoAST.Submodule(url, sha);
                    }
                    else {
                        const entry = yield commit.getEntry(path);
                        const blob = yield entry.getBlob();
                        changes[path] = blob.toString();
                    }
                }
            }));
            yield differs;

            // Now get a list of parent commits.  We don't need to process them
            // (recursively) because the `ids` returned by `fastwalk` contains
            // all commits in the branch's history.

            const parents = yield commit.getParents(MAX_IDS);
            const parentShas = parents.map(p => p.id().tostrS());
            commits[commitStr] = new RepoAST.Commit({
                parents: parentShas,
                changes: changes,
            });
        }));
        yield commitLoaders;
    });

    // List all the branches.

    const branchListers = branches.map(co.wrap(function *(branch) {
        const id = branch.target();

        // If it's not a remote or a local branch, skip it.

        if (branch.isRemote()) {
            const shorthand = branch.shorthand();
            const slash = shorthand.indexOf("/");
            const remoteName = shorthand.substr(0, slash);
            const branchNameStart = slash + 1;
            const branchName = shorthand.substr(branchNameStart);
            remoteMap[remoteName].branches[branchName] = id.tostrS();
        }
        else if (branch.isBranch()) {
            branchTargets[branch.shorthand()] = id.tostrS();
        }
        else {
            return;                                                   // RETURN
        }
        yield loadCommit(id);
    }));
    yield branchListers;

    // Handle current branch.

    let branchName = null;
    let headCommitId = null;
    if (!repo.headDetached()) {
        const branch = yield repo.getCurrentBranch();
        branchName = branch.shorthand();
    }

    // If the repo isn't bare, process the index, HEAD, and workdir.

    let index = {};
    let workdir = {};
    if (!repo.isBare()) {
        const headCommit = yield repo.getHeadCommit();
        yield loadCommit(headCommit.id());
        headCommitId = headCommit.id().tostrS();

        // Process index and workdir changes.

        const repoIndex = yield repo.index();
        const submodules = yield getSubmodulesFromIndex(repo, repoIndex);

        const STATUS = NodeGit.Status.STATUS;

        const stats = yield repo.getStatusExt();
        for (let i = 0; i < stats.length; ++i) {
            const stat = stats[i].statusBit();
            const filePath = stats[i].path();

            // skip the modules file

            if (SubmoduleConfigUtil.modulesFileName === filePath) {
                continue;
            }

            // Check index.

            if (stat & STATUS.INDEX_DELETED) {
                index[filePath] = null;
            }
            else if (stat & STATUS.INDEX_NEW || stat & STATUS.INDEX_MODIFIED) {

                // If the path indicates a submodule, we have to load its sha
                // separately, and use the url from the modules file.

                if (filePath in submodules) {
                    const url = submodules[filePath];
                    const entry = repoIndex.getByPath(filePath);
                    const sha = entry.id.tostrS();
                    index[filePath] = new RepoAST.Submodule(url, sha);
                }
                else {

                    // Otherwise, read the blob for the file from the index.

                    const entry = repoIndex.getByPath(filePath, -1);
                    const oid = entry.id;
                    const blob = yield repo.getBlob(oid);
                    const data = blob.toString();
                    index[filePath] = data;
                }
            }
            // Check workdir

            if (stat & STATUS.WT_DELETED) {
                workdir[filePath] = null;
            }
            else if (stat & STATUS.WT_NEW || stat & STATUS.WT_MODIFIED) {
                if (!(filePath in submodules)) {
                    const absPath = path.join(repo.workdir(), filePath);
                    const data = yield fs.readFile(absPath, {
                        encoding: "utf8"
                    });
                    workdir[filePath] = data;
                }
            }
        }
    }

    // Now we can actually build the remote objects.

    let remoteObjs = {};
    for (let remoteName in remoteMap) {
        const remote = remoteMap[remoteName];
        remoteObjs[remoteName] = new RepoAST.Remote(remote.url, {
            branches: remote.branches
        });
    }

    // Lastly, load up submodules.

    let openSubmodules = {};

    const subNames = yield repo.getSubmoduleNames();
    for (let i = 0; i < subNames.length; ++i) {
        const subName = subNames[i];
        const status = yield NodeGit.Submodule.status(repo, subName, 0);
        const WD_UNINITIALIZED = (1 << 7);  // means "closed"
        if (!(status & WD_UNINITIALIZED)) {
            const sub = yield NodeGit.Submodule.lookup(repo, subName);
            const subRepo = yield sub.open();
            const subAST = yield exports.readRAST(subRepo);
            openSubmodules[subName] = subAST;
        }
    }

    return new RepoAST({
        commits: commits,
        branches: branchTargets,
        head: headCommitId,
        currentBranchName: branchName,
        remotes: remoteObjs,
        index: index,
        workdir: workdir,
        openSubmodules: openSubmodules,
    });
});

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

    const commits = yield writeCommits(repo, ast.commits);
    const resultRepo = yield configureRepo(repo, ast, commits.oldToNew);
    return {
        repo: resultRepo,
        commitMap: commits.newToOld,
        oldCommitMap: commits.oldToNew,
    };
});

/**
 * Write the repositories described in the specified `repos` map to a temporary
 * path.  Return a map from repo name to `NodeGit.Repository` objects, a map
 * from the newly-generated commit IDs to the original IDs in the ASTs, and a
 * map from repo urls to their names.
 *
 * @async
 * @param {Object} repos
 * @return {Object}
 * @return {Object} return.repos       map from name to `NodeGit.Repository`
 * @return {Object} return.commitMap   map from new to old commit IDs
 * @return {Object} return.urlMap      map from url to name
 */
exports.writeMultiRAST = co.wrap(function *(repos) {
    // This operation is complicated by the need to have a single commit ID
    // universe.  To make it work, we will use foul trickery:
    //   - create a single "commit" repo to which we will write all commits
    //   - when writing the actual repos, start them out as clones from the
    //     commit repo
    //   - but immediately remove the origin
    //   - then set up branches, remotes, HEAD, etc. as usual.

    assert.isObject(repos);

    repos = Object.assign({}, repos);  // make a copy

    // create a path for each repo

    let repoPaths = {};
    let urlMap = {};
    for (let repoName in repos) {
        const path = yield TestUtil.makeTempDir();
        repoPaths[repoName] = path;
        urlMap[path] = repoName;
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
        return yield configureRepo(repo, ast, commitMaps.oldToNew);
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
        yield writeRepo(repo, ast, repoPath);
        resultRepos[repoName] = repo;

        let index = null;

        // Render open submodules.

        for (let subName in ast.openSubmodules) {

            if (null === index) {
                index = RepoAST.renderIndex(ast.commits, ast.head, ast.index);
            }
            const sub = index[subName];
            const openSubAST = ast.openSubmodules[subName];

            // First, write git link file.

            const subDir = path.join(repoPath, subName);
            const subGitLink = path.join(subDir, ".git");

            // The link file needs a relative path reference back to the
            // location of the repository for this repo; that reference will
            // need more ".." ups depending on how deep it is in the hierarchy.

            const depth = subName.split("/").length;
            let dots = "";
            for (let i = 0; i < depth; ++i) {
                dots += "../";
            }
            yield fs.writeFile(subGitLink,
                               `gitdir: ${dots}.git/modules/${subName}\n`);

            // Next, update the `.git/config` file.

            const configPath = path.join(repoPath, ".git", "config");
            yield fs.appendFile(configPath, `\
[submodule "${subName}"]
\turl = ${sub.url}
`);

            // Initialize the repo in the modules directory, but we don't
            // configure it here.  We need this directory to have the contents
            // of a `.git` directory without being bare, so we'll start it in a
            // temporary location then move it.

            const subRepoDir = path.join(repoPath, ".git", "modules", subName);
            mkdirp.sync(subRepoDir);
            yield fs.rmdir(subRepoDir);  // kill the leaf, we'll rename to it
            const tempDir = yield TestUtil.makeTempDir();
            yield NodeGit.Clone.clone(commitRepo.workdir(), tempDir);
            const tempGitDir = path.join(tempDir, ".git");
            yield fs.rename(tempGitDir, subRepoDir);

            // Configure the repo where it is rooted so that the workdir files
            // are in the right place.

            const subObj = yield NodeGit.Submodule.lookup(repo, subName);
            const subRepo = yield subObj.open();
            yield writeRepo(subRepo, openSubAST, subRepoDir);
        }
    }

    return {
        repos: resultRepos,
        commitMap: commitMaps.newToOld,
        urlMap: urlMap,
    };
});

