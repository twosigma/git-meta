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
const NodeGit  = require("nodegit");

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

        // Calculate the tree.
        // `tree` describes the directory tree specified by the commit at
        // `sha`.

        const tree = RepoAST.renderCommit(renderCache, commits, sha);

        // Build the tree file; build the `.gitmodules` file as submodules are
        // seen.

        let gitModulesData = "";
        let treeData = "";

        function addToTree(fileType, dataType, id, path) {
            if ("" !== treeData) {
                treeData += "\n";
            }
            treeData += `${fileType} ${dataType} ${id}\t${path}`;
        }

        const addFile = co.wrap(function *(path, data) {
            const id = yield hashObject(repo, data);
            addToTree("100644", "blob", id, path);
        });

        for (let path in tree) {
            const change = tree[path];
            if (change instanceof RepoAST.Submodule) {
                const modulesStr = `\
[submodule "${path}"]
\tpath = ${path}
\turl = ${change.url}
`;
                const newSha = yield writeCommit(change.sha);
                gitModulesData += modulesStr;
                addToTree("160000", "commit", newSha, path);
            }
            else {
                yield addFile(path, change);
            }
        }

        if ("" !== gitModulesData) {
            yield addFile(SubmoduleConfigUtil.modulesFileName, gitModulesData);
        }

        const makeTreeExecString = `\
cd ${repo.path()}
echo '${treeData}' | git mktree
`;
        const treeId = yield doExec(makeTreeExecString);

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

    // Have to do this detach before you clear out branches or it recreates the
    // master branch, for some reason.

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

    if (null === ast.head) {
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

    return repo;
});


/**
 * Return a map from submodule name to url at the specified `commit` in the
 * specified `repo`.
 *
 * @private
 * @async
 * @param {NodeGit.Commit} commit
 * @return {Object} map from name to url
 */
const getSubmodules = co.wrap(function *(repo, commit) {
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
    const loadCommit = co.wrap(function *(id) {
        assert.instanceOf(id, NodeGit.Oid);
        const revwalk = repo.createRevWalk();
        revwalk.push(id);
        const ids = yield revwalk.fastWalk(1000000);
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
            const submodules = yield getSubmodules(repo, commit);
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

            const parents = yield commit.getParents(100000);
            const parentShas = parents.map(p => p.id().tostrS());
            commits[commitStr] = new RepoAST.Commit({
                parents: parentShas,
                changes: changes,
            });
        }));
        yield commitLoaders;
    });
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
    let branchName = null;
    let headCommitId = null;
    if (!repo.headDetached()) {
        const branch = yield repo.getCurrentBranch();
        branchName = branch.shorthand();
    }
    if (!repo.isBare()) {
        const headCommit = yield repo.getHeadCommit();
        yield loadCommit(headCommit.id());
        headCommitId = headCommit.id().tostrS();
    }
    let remoteObjs = {};
    for (let remoteName in remoteMap) {
        const remote = remoteMap[remoteName];
        remoteObjs[remoteName] = new RepoAST.Remote(remote.url, {
            branches: remote.branches
        });
    }
    return new RepoAST({
        commits: commits,
        branches: branchTargets,
        head: headCommitId,
        currentBranchName: branchName,
        remotes: remoteObjs,
    });
});

/**
 * Create a repository having the state described by the specified `ast` to the
 * specified `path`.  Return the newly created repository and a map from the
 * commit IDs in `ast` to the actual commit IDs created.
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

    const repo = yield NodeGit.Repository.init(path,
                                               null === ast.head ? 1 : 0);

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
        Object.assign(commits, repos[repoName].commits);
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

    // Now generate the actual repos.

    let resultRepos = {};
    for (let repoName in repos) {

        const path = repoPaths[repoName];
        const repo = yield NodeGit.Clone.clone(commitRepo.workdir(), path, {
            bare: (null === repos[repoName].head) ? 1 : 0
        });

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
        const resultRepo = yield configureRepo(repo,
                                               repos[repoName],
                                               commitMaps.oldToNew);
        resultRepos[repoName] = resultRepo;
    }
    return {
        repos: resultRepos,
        commitMap: commitMaps.newToOld,
        urlMap: urlMap,
    };
});

