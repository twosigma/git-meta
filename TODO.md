# Various things TODO:
- obviously, add more commands
- move validation logic into the command modules
- much more extensive command validation: I do not ever want to see a script
  stack due to knowable error conditions (e.g., invalid branch name)
- elmininate dependencies on static information (e.g., CWD) from utility
  components
- write unit tests
- generally, check for state of repositories (merging, etc.) before doing
  operations... also bare repos, "unborn" repos, etc.
- use rebase status of meta-repo to track rebases
- add `slim rebase` continue, abort, etc.
- progress meters for remote operations (fetch, include, open, pull, etc.)
  - I've done a lot of this work on the 'working-on-progress-bars' branch, but
    it's dependent on the nodegit issues listed below
- I believe it may be possible to factor out some of the logic between rebase,
  cherry-pick, and merge.
- status doesn't show new submodules, or when new submodules have new info

## Testing/cleanup effort

- Write tests for all methods.
- Add assertions for preconditions to methods, particularly argument types.
- Eliminate calls to `exit` except for in the main modules.  Change calls
  to `exit` into `UserError` exceptions; document this in method contracts.
- get mocha to show stack traces on failures

# Open Issues to Watch

## Progress on fetches

https://github.com/nodegit/nodegit/issues/919

Currently, nodegit calls back on each object that is downloaded; this causes an
amount of overhead that is prohibitive.

## Nodegit keeps process running

https://github.com/nodegit/nodegit/issues/920
