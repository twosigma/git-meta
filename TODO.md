# Various things TODO:
- obiously, add more commands
- move validation logic into the command modules
- much more extensive command validation: I do not ever want to see a script
  stack due to knowable error conditions (e.g., invalid branch name)
- elmininate dependencies on static information (e.g., CWD) from utility
  components
- write unit tests
- turn this into a proper NPM module and doc dependencies
- generally, check for state of repositories (merging, etc.) before doing
  operations... also bare repos, "unborn" repos, etc.
- use rebase status of meta-repo to track rebases
- add `slim rebase` continue, abort, etc.
- progress meters for remote operations (fetch, include, open, pull, etc.)
