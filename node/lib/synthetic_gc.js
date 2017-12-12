#! /usr/bin/env node

"use strict";

const assert  = require("chai").assert;
const co = require("co");
const NodeGit = require("nodegit");
const SyntheticBranchUtil = require("./util/synthetic_branch_util");
const GitUtil = require("./util/git_util");
const SubmoduleUtil = require("./util/submodule_util");
const ArgumentParser = require("argparse").ArgumentParser;

const SYNTHETIC_BRANCH_BASE = "refs/commits/";

let SIMULATION = true; // dont' actually delete refs, just output

let visited = {}; // visited commmits.

/**
 * Parse command line options.
 *
 * @return {Object}
 */
function parseOptions() {
    let parser = new ArgumentParser({
        version: "0.1",
        addHelp:true,
        description: `Old synthetic refs removal. By default removes all 
           synthetic refs that are older than 6 moths.` 
    });

    parser.addArgument(
        [ "-d", "--date" ],
        { help: `Date to use as a threshold for removing old synthetic 
            refs.[6 month default]` }
    );

    parser.addArgument(
        [ "-f", "--force" ],
        {
            help: `Actually remove synthetic refs. By Default we only list what 
                refs we are about to remove.`,
            action: "storeTrue",
            defaultValue: false,
        }
    );
    
    return parser.parseArgs();
}

/**
 * Remove synthetic ref corresponding to specified `commit` in the specified
 * `repo`.
 *
 * @param {NodeGit.Repo}   repo
 * @param {NodeGit.Commit} commit
 */
function* removeSyntheticRef(repo, commit) {
    const refPath = SyntheticBranchUtil.getSyntheticBranchForCommit(commit);

    if (SIMULATION) {
        console.log("Removing ref: " + refPath);
        return;
    }
    
    return yield GitUtil.removeRemoteRef(repo, refPath);
}

/**
 * Go through the parents of `commit` of the specified `repo` and remove
 * synthetic reference recusively if they satisfy `isDeletable` and not part of
 * `existingReferences`. 
 *
 * @param {NodeGit.Repo}   repo
 * @param {NodeGit.Commit} commit
 * @param {Function}       isDeletable 
 * @param {String[]}       existingReferences
 */
function* recursiveSyntheticRefRemoval(repo, commit, isDeletable, 
                                       existingReferences) { 

    assert.instanceOf(repo, NodeGit.Repository);
    assert.instanceOf(commit, NodeGit.Commit);

    if (commit.parentcount() === 0) {
        return;
    }

    const parents = yield commit.getParents(commit.parentcount());
    yield parents.map(function *(parent) {
        if (parent in visited) {
            return;
        }
        visited[parent] = 1;

        if (isDeletable(parent) && existingReferences.includes(parent.sha())) {
            yield removeSyntheticRef(repo, parent);
        }
        return yield *recursiveSyntheticRefRemoval(repo, parent, isDeletable, 
                                                   existingReferences);
    });

    return;
}

/**
 * Return all available synthetic refs within specifed `subRepo`.
 *
 * @param {NodeGit.Repo}   subRepo
 * @return {String[]}
 */
function* getSyntheticRefs(subRepo) {

    const syntheticRefExtractor = function(value) {
          if (value && value.includes(SYNTHETIC_BRANCH_BASE) ) {
              return value.split("\t")[0];
          }
          return null;
    };

    let references = yield GitUtil.getRefs(subRepo);

    return references.map(syntheticRefExtractor).filter(commit => commit);
}

/**
 * Delete all redundant synthetic refs within specified 'repo' satisfying
 * `predicate` by recursively iterating over parents of the specified `roots`. 
 *
 * Synthetic ref is considered to be redundant if its commit is reachable from
 * descendant who is guaranteed to be around - i.e part of a persistent roots
 * ('roots' here).
 *
 * @param {NodeGit.Repo}   repo
 * @param {Object[]}       roots
 * @param {Function}       predicate
 */
function* cleanUpRedundant(repo, roots, predicate) {

   for (let subName in roots) {
       const subRepo = yield SubmoduleUtil.getRepo(repo, subName);

       let existingReferences = yield getSyntheticRefs(subRepo);

       for (let subCommit of roots[subName]) {
           yield recursiveSyntheticRefRemoval(subRepo, subCommit, predicate, 
                                              existingReferences); 
       }
   }
}

/**
 * Delete all synthetic refs within specified `repo` that satisfy `isOldCommit`,
 * that not part of specified `roots`.
 *
 * @param {NodeGit.Repo}   repo
 * @param {Object[]}       roots
 * @param {Function}       isOldCommit 
 */
function* cleanUpOldRefs(repo, roots, isOldCommit) {

   for (let subName in roots) {
       const subRepo = yield SubmoduleUtil.getRepo(repo, subName);
      
       const reservedCommits = roots[subName];

       const rawShaSubRoots = Array.from(reservedCommits).map(function(commit) {
                            return commit.sha();
                        });


       let allRefs = yield getSyntheticRefs(subRepo);

       for (let ref of allRefs) {
           // filter out all the references from rootA
           if (rawShaSubRoots.includes(ref)) {
               continue;
           }

           const actualCommit = yield subRepo.getCommit(ref);
           if (isOldCommit(actualCommit)) {
               yield removeSyntheticRef(subRepo, ref);
           } // if
       } // for
   } // for
} // cleanUpOldRefs

let lessThanDate = function(thresHold) {
    return function(input) {
        return input.date() < thresHold;
    };
};

function getThresholdDate(args) {

    let date = new Date();

    if (args.date !== undefined) {
        date = new Date(args.date);
    } else {
        const THRESHOLD_MONTHS = 6;
        date.setMonth(date.getMonth() - THRESHOLD_MONTHS); 
    }

    console.log("Using: " + date + ", as threshold date.");

    return date;
}

/**
 * Fetch all refs that are considered to be persistent within the specified
 * `repo`. 
 *
 * Return value is a mapping between submodule name and collection of persistent
 * refs within that submodules.
 *
 * @param {NodeGit.Repo}   repo
 * @return {Object[]}      
 */
function* populateRoots(repo) {

    // For now, we are using heads/master as an important root.  
    // `important root` - means the root that most likey be around, so that we 
    // can remove all parent synthetic refs.
    // This is not really necessary, more like optimization, 
    // unless there is an important ref out there that was not updated for so 
    // long.
    const IMPORTANT_REFS = ["refs/heads/master"];

    let classAroots = {}; // roots that we can rely on to be around, master or 
                          // team branches

    const submodules = yield SubmoduleUtil.getSubmoduleNames(repo);

    const refs = yield repo.getReferenceNames(NodeGit.Reference.TYPE.LISTALL);
    for (let ref of refs) {
        const refHeadCommit = yield repo.getReferenceCommit(ref);

        const tree = yield refHeadCommit.getTree();

        for (const subName of submodules) {
            const subRepo = yield SubmoduleUtil.getRepo(repo, subName);
            const subSha = yield tree.entryByPath(subName);
            const subCommit = yield subRepo.getCommit(subSha.sha());

            if (IMPORTANT_REFS.includes(ref)) {
                if (!(subName in classAroots)) {
                    classAroots[subName] = new Set();
                }
                classAroots[subName].add(subCommit);
            } 
        }
    }

    return classAroots;
}

let runIt = co.wrap(function *(args) {

    const repo = yield GitUtil.getCurrentRepo();
    const classAroots = yield populateRoots(repo);

    console.log(`Looking for removal of redundant synthetic refs. (parent refs 
                 of persistent branches).`);
    yield cleanUpRedundant(repo, classAroots, function() { return true; }); 

    console.log("Looking for removal of old synthetic refs.");
    const isOldCommit = lessThanDate(getThresholdDate(args));
    yield cleanUpOldRefs(repo, classAroots, isOldCommit); 
});

const args = parseOptions();

if (args.force) {
    SIMULATION = false;
}

runIt(args);
