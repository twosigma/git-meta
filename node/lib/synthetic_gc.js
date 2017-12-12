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


function* removeSyntheticRef(repo, commit) {
    const refPath = SyntheticBranchUtil.getSyntheticBranchForCommit(commit);

    if (SIMULATION) {
        console.log("Removing ref: " + refPath);
        return;
    }
    
    return yield GitUtil.removeRemoteRef(repo, refPath);
}

// Go through the parents of `commit` and remove synthetic reference recusively 
// if they satisfy `isDeletable`. 
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

    // Clean up all redundant 
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

    // Clean up all refs that satisfy `isOldCommit`, but not part of `roots`.
function* cleanUpOldRefs(repo, roots, isOldCommit) {

   for (let subName in roots) {
       const subRepo = yield SubmoduleUtil.getRepo(repo, subName);
      
       const reservedCommits = roots[subName];

       let rawShaSubRoots = Array.from(reservedCommits).map(function(commit) {
                            return commit.sha();
                        });

       let references = yield getSyntheticRefs(subRepo);

       // filter out all the references from rootA
       references = references.filter(refVal => 
                                      !rawShaSubRoots.includes(refVal)); 


       // filter out all the references younger than 6 months
       let refsToDelete = [];
       for (let ref in references) {
           // could not figure out how to call generators withing filter 
           // properly, so cant be fancy
           const actualCommit = yield subRepo.getCommit(references[ref]);
           if (isOldCommit(actualCommit)) {
               refsToDelete.push(actualCommit);
           }
       }

        
       yield* refsToDelete.map(value => removeSyntheticRef(subRepo, value));
   }
}

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

// Fetch all important refs from out repo.
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
    let classBroots = {}; // root that can go anyway, like users branches

    const submodules = yield SubmoduleUtil.getSubmoduleNames(repo);

    const refs = yield repo.getReferenceNames(NodeGit.Reference.TYPE.LISTALL);
    for (let ref in refs) {
        ref = refs[ref];
        const refHeadCommit = yield repo.getReferenceCommit(ref);

        const tree = yield refHeadCommit.getTree();

        // This could have been fancy if we were running gc per meta change
        //const submodules = yield SubmoduleUtil.getSubmoduleChanges(repo,
        //                                                      refHeadCommit);

        yield submodules.map(function*(subName) {
            const subRepo = yield SubmoduleUtil.getRepo(repo, subName);
            const subSha = yield tree.entryByPath(subName);
            const subCommit = yield subRepo.getCommit(subSha.sha());

            if (IMPORTANT_REFS.includes(ref)) {
                if (!(subName in classAroots)) {
                    classAroots[subName] = new Set();
                }
                classAroots[subName].add(subCommit);
            } else {
                if (!(subName in classBroots)) {
                    classBroots[subName] = new Set();
                }
                classBroots[subName].add(subCommit);
            }
        });
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
