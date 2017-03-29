# User Guide for `git-meta`

The `git-meta` plugin facilitates implementing a *mono-repo* in terms of a Git
*meta-repo* and its associated *sub-repos*.  It is a command-line extension of
Git that allows normal Git operations to be performed on a meta-repo as if it
were a single mono-repo rather than a collection of (potentially closed)
submodules.  See the [architecture](./architecture.md) document for more
detail and definition of these terms.

In this document we first describe the underlying mission and philosophy of
git-meta.  Then, we explore the types of functionality it offers.  Next, we
describe the client-side model that git-meta uses to map a logical mono-repo
onto a meta-repo with its sub-repos.  Finally, we provide a mini-tutorial with
basic usage scenarios.

## Mission

We intend for git-meta to be _sugar_ that makes it *easy*, but not *possible*
to use a mono-repo: all operations necessary for mono-repo workflows can be
performed (perhaps inconveniently) with "plain" Git.  Some related
requirements:

1. git-meta does not need new meta information unknown to Git to describe the
   state of a repository.
1. A repository that is in a valid state according to Git is understandable to
   git-meta.
1. A repository that is in a valid state according to git-meta is in a valid
   state according to Git.
1. Operations performed by git-meta can be rewritten as git operations.

## Functionality

The functionality of git-meta can be decomposed into four categories:

1. _new behavior_ -- required for implementation of the mono-repo
1. _submodule boundary erasure_ -- to eliminate the boundaries between
   submodules and provide for seamless interaction with the (checked out
   portions of a) mono-repo tree
1. _better submodule interactions_ -- where existing Git commands, while
   technically correct,  are counter-intuitive when used with submodules in the
   context of a mono-repo
1. _workarounds_ -- for Git commands that are broken or scale poorly with large
   numbers of submodules

We provide more examples of these categories below.  The long-term plan is to
upstream (into Git and libgit2) changes to make the latter two categories
unnecessary.

### New Behavior

Interacting with a mono-repo (as discussed in the
[architecture](./architecture.md) document) imposes two client-side
requirements:

1. When pushing changes, synthetic-meta-refs must be pushed into each affected
   submodule before pushing the connecting meta-repo commit.
2. Shas must be fetched on-demand for open submodules during many operations,
   such as when HEAD is changed in the meta repo.

For the first requirement, we provide `git meta push`:

```bash
$ git meta push origin master:master
```

If you had changes to the currently checked-out branch in repository `x`, you
do this by hand:

```bash
$ cd x
$ git push origin $(git rev-parse HEAD):refs/commits/$(git rev-parse HEAD)
$ cd ..
$ git push origin master
```

This operation becomes more burdensome when you have changes to many
repositories (or have forgotten which repositories you've changed).
Furthermore, the git-meta version will push to multiple repositories in
parallel.

For the second requirement, every command provided by git-meta will fetch shas
as necessary.  For example:

```bash
$ git meta checkout your-branch
$ cd x
$ echo README.md
```

The `git meta checkout` command will fetch the commit indicated on the
`your-branch` branch of the meta-repo before attempting to check it out in the
`x` submodule.  You can get this behavior from Git by running:

```bash
$ git checkout your-branch
$ git submodule update
```

But things become trickier with commands such as `cherry-pick` or `merge`,
where the target committish (e.g., the one to be cherry-picked) may need to be
fetched.  Those commands are different in `git meta` in other ways, and we'll
discuss them later.

### Submodule Boundary Erasure

Git submodules allow us to mount many external repositories into a
singly-rooted tree, giving the approximation of a single mono-repo where
selected subtrees are present (open).  Unfortunately, this abstraction is not
well-serviced by most Git commands.  For example, say you have a meta-repo with
a submodule named `x` that contains a file named `README.md`:

```bash
$ echo foo >> x/README.md
```

A naive attempt to stage this change results in error:

```bash
$ git add x/README.md
fatal: Pathspec 'x/README.md' is in submodule 'x'
```

More generally, if you have modifications in many submodules, you can write:

```bash
$ git meta add .
```

staging all modified files in the mono-repo, treating the entire tree as one
repository.  With plain Git, one would need to run `git add` in each submodule
containing changes.  See the next section about the model git-meta uses for
more information about what it means to stage a change to the mono-repo.

The ability to address paths in the tree of the meta-repo as if the were a
single repository (ignoring submodule boundaries) is provided by all git-meta
commands that take paths, such as `reset`, `commit`, `checkout`, etc.

### Better Submodule Interactions

Historically, submodules provide a way for one repository to *reference* (not
contain) another repository, and the entry for a submodule in a Git tree is a
SHA indicating which commit is being referenced in the external repository.
When you attempt to merge two commits containing different SHAs for the same
submodule, Git simply flags the submodule as being conflicted.  This result
makes sense based on the original use for submodules (on one branch we
referenced one version of an external repository, on another branch we
referenced a different version); we need a human to decide which one to use.
While it might make sense to blindly accept a change to a commit that is a
descendant of the original, it probably is not reasonable to e.g., create a
merge commit -- this submodule is an external repository that we may not own.

Unfortunately, this behavior renders Git commands that perform merges:
`cherry-pick`, `merge`, `rebase`, etc. mostly useless when interacting with a
mono-repo.  Instead of triggering a conflict when encountering submodule
differences, we need these commands to:

- `cherry-pick` -- perform a cherry-pick in the submodule
- `merge` -- perform a merge in the submodule
- `rebase` -- rebase submodule commits

Furthermore, it may be necessary to fetch target commits during these
operations.

### Workarounds

Workarounds are direct implementations of existing Git commands that provide no
value other than to work, or to work faster.  One current example is
`git submodule status`, that outputs the status of only a few
submodules per second, making it unusable in repositories containing thousands
of submodules.

## Client-side Model

### Overview

To the greatest extent possible, we want to allow users to treat the
combination of meta-repo + sub-repos as a mono-repo.  The goal is to make it
easier to use the mono-repo, not to hide or "protect" the user from the actual
submodule-based implementation.  We make no attempt to completely wrap the Git
UI, so users will need to interact directly with submodules from time-to-time,
e.g., to address merge conflicts.

Conceptually, we view the entire set of (open) sub-repos as a single
repository, with one...

- ...current branch -- the current branch in the meta-repo
- ...HEAD -- the head of meta-repo
- ...working directory -- the tree of all open sub-repos
- ...index -- the combined indices of all open sub-repos

Some implications:

- Unless explicitly specified (and then only very rarely), "committishes"
  (reference names, SHAs, etc.) provided to git-meta commands are resolved only
  in the meta-repo.
- The HEADs of submodules are adjusted only as a consequence of changing the
  HEAD of the meta-repo.
- Paths in git-meta commands are allowed to refer to any part of the working
  tree, regardless of current working directory.
- The working tree and index of the meta-repo itself are ignored unless the
  user explicitly needs to add files to it. 
- New commits in submodules (not yet reflected in the HEAD of the meta-repo)
  are considered to be staged in the logical index of the mono-repo (and show
  that way in `git meta status`).
- Submodules in submodules are not currently supported, but will be treated by
  git-meta as "normal" Git submodules, not as part of the mono-repo --
  recursive sub-repos would add extra complication to the implementation and
  user model, and are not required to meet the goal of creating a mono-repo.

### Value-added behavior

To support this model, git-meta commands offer the following conveniences not
supported by normal Git commands:

- the ability to operate on the entire mono-repo when the current working
  directory is within a submodule, e.g.:

```bash
$ git meta open my-sub-repo
$ cd my-sub-repo/foo/bar
$ git checkout -b a-new-branch       # makes a branch in the sub-repo
$ git meta checkout -b a-new-branch  # makes a branch in the meta-repo
```

- the ability to target paths within any open submodule regardless of current
  working directory, e.g.:

```bash
$ echo >> sub-repo-x/README.md
$ cd sub-repo-y
$ git meta add ../sub-repo-x/README.md
```

- the ability to target multiple sub-repos in one command:

```bash
$ git meta commit sub-repo-x/README.md sub-repo-y/foo/bar/main.cpp
```

or even by directory tree:

```bash
$ echo "a change" >> my-product/sub-repo-a/README.md
$ echo "another change" >> my-product/sub-repo-b/README.md
$ git meta add my-product
```

- removes the need to explicitly stage and commit updated submodules:

Normally in Git, if you add a commit to a submodule you need to stage the
submodule too:

```bash
$ cd my-sub-repo
$ echo >> foo
$ git commit -m "changed foo" foo
$ cd ..
$ git commit -m "changed my-sub-repo"
On branch master
Changes not staged for commit:
        modified:   my-sub-repo (new commits)

no changes added to commit
```

This process is greatly simplified with git-meta:

```bash
$ echo >> my-sub-repo/foo
$ git meta-commit -m "changed foo" my-sub-repo/foo
```

Even if you want to explicitly make two commits, you do not need to manually
stage the sub-repo:

```bash
$ cd my-sub-repo
$ echo >> foo
$ git commit -m "changed foo" foo
$ git meta commit -m "changed my-sub-repo"
```

## Usage Scenarios

### Creating a meta-repository

A meta-repository doesn't need any special configuration; any Git repository
can get a meta-repository.

### Cloning

We do not provide a git-meta command for cloning as the built-in Git command
does exactly the right thing:

```bash
$ git clone http://example.com/your-meta-repo.git meta
```

### Creating a new sub-repository

Assuming that you are using the omega repository strategy described in the
[architecture](./architecture.md) document, making a new sub-repo is
straightforward:

```bash
$ cd meta
$ git meta new foo/bar
Created new sub-repo foo/bar.  It is currently empty.  Please
stage changes and/or make a commit before finishing with 'git meta commit';
you will not be able to use 'git meta commit' until you do so.
$ touch foo/bar/README.md
$ git meta add .
$ git meta commit -m "added foo/bar"
```

### Submodule Visibility

A freshly-cloned meta-repo is usually empty, containing a tree of empty
sub-directories where submodules are mounted.  The first thing you'll want to
do is to make sub-projects available:

```bash
$ git meta open my-team/my-project
```

You can open a whole tree of sub-repos:

```bash
$ git meta open your-team/
```

There reverse operation is `close`:

```bash
$ git meta close your-team
```

The primary advantage of `git meta open` over `git submodule update --init`
(besides a cleaner syntax) is that it will propagate repository templates into
opened submodules (see `git meta open --help` for more information).  The
`close` command is provided for symmetry.


### Switching Branches

We provide `git meta checkout` to switch branches:

```bash
$ git meta checkout my-feature
```

This command will change the HEAD of the meta-repo and all open sub-repos (or
none at all), but only set the current branch in the meta-repo.  As implied
earlier, git-meta neither reads nor writes to references in sub-repos.  Another
important task provided by this command is that it will automatically fetch
commits in submodules as needed.

The vanilla Git equivalent would be:

```bash
$ git checkout my-feature
$ git submodule update
```

### Making Changes

Use `git meta add` and `git meta commit` as you would the corresponding Git
commands:

```bash
$ echo >> my-sub-repo/README.md
$ git meta commit -a -m "I made a change"
$ touch my-sub-repo/a-new-file
$ git meta add .
$ git meta commit -m "Added a new file"
```

Plain Git:

```bash
$ echo >> my-sub-repo/README.md
$ cd my-sub-repo
$ git commit -a -m "I made a change"
$ cd ..
$ git add my-sub-repo
$ git commit -m "I made a change"
$ touch my-sub-repo/a-new-file
$ cd my-sub-repo
$ git add a-new-file
$ git commit -m "Added a new file"
$ cd ..
$ git add my-sub-repo
$ git commit -m "Added a new file"
```

#### Amending Changes

The `git meta commit --amend` command is used to adjust the most recent commit.
As will be seen below, it handles several different scenarios so that the
mono-repo can be amended like a single repo.

```bash
$ echo >> my-sub-repo/README.md
$ git meta commit -a -m "I made a change"
$ touch my-sub-repo/a-new-file
$ git meta add .
$ git meta commit --amend -m "I made a change"
```

Note that `amend` will operate only if, for each submodule updated in the HEAD
commit of the meta-repo, the following holds:

- the signature of that commit (author and message) in the submodule is the
  same as the signature of the HEAD commit of the meta-repo
- the HEAD of the submodule is the commit indicated in the HEAD commit of the
  meta-repo, i.e., no new commits have been made

The amend commit above could have been done using plain Git:

```bash
$ cd my-sub-repo
$ git commit --amend -m "I made a change"
$ cd ..
$ git add my-sub-repo
$ git commit --amend -m "I made a change"
```

If you have changes in another submodule, the amend operation will generate a
new (i.e., not amended) commit in that submodule:

```bash
$ echo >> sub-repo-a/README.md
$ git meta commit -a -m "updated a README.md"
$ echo >> sub-repo-b/README.md
$ git meta commit -a --amend -m "updated READMEs"
```

is the equivalent of

```bash
$ echo >> sub-repo-a/README.md
$ cd sub-repo-a
$ git commit -a -m "updated a README.md"
$ cd ..
$ git commit -a -m "updated a README.md"
$ echo >> sub-repo-b/README.md
$ cd sub-repo-a
$ git commit --amend -m "updated READMEs"
$ cd ../sub-repo-b
$ git commit -a -m "updated READMEs"
$ cd ..
$ git commit -a -m "updated READMEs"
```

If you undo a change, `git meta commit --amend` will remove the unneeded
(empty) commit:

```bash
$ echo >> sub-repo-a/README.md
$ touch >> sub-repo-b/a-new-file.cpp
$ git meta add .
$ git meta commit -m changes
$ rm sub-repo-b/a-new-file.cpp
$ git meta commit -a --amend -m "fewer changes"
```

with plain Git, the same amend would be done like:

```bash
$ rm sub-repo-b/a-new-file.cpp
$ cd sub-repo-b
$ git commit --amend -m "fewer changes"
$ cd sub-repo-b
$ git reset HEAD^
$ cd ..
$ git commit -a --amend -m "fewer changes"
```

### Pushing Changes

Use `git meta push` as you would `git push`:

```bash
$ git meta push origin my-feature
```

This command pushes *synthetic-meta-refs* for changed sub-repos (see [the
architecture document](./architecture.md) for more information) and the actual
ref for the meta-repo.

In plain Git:

```bash
$ git submodule foreach \
 git push origin $(git rev-parse HEAD):refs/commits/$(git rev-parse HEAD)
$ git push origin my-feature
```

Though this isn't 100% accurate as `git meta push` does not push to `origin`,
but rather to the URL obtained by resolving the URL configured for each
submodule in `.gitmodules` against the URL of the remote being pushed to.

### Getting Updates

We do not provide a `git meta fetch` command (though we might at some point
just so that you can invoke it from anywhere in the tree); calling,
`git fetch` in the meta-repo does exactly the right thing:

```bash
$ git fetch
$ git meta rebase origin/master
```
It's not easy to execute the equivalent of `git meta rebase` with vanilla Git,
as Git has no such concept.  The goal of `git meta rebase` is to reconstruct,
on the target commit, the original commit tree (TODO: create a diagram showing
this operation).  A rough description of the algorithm:

```
for each rebased commit C
    apply the rebase changes of C
    for each submodule change CS introduced by C
        rebase CS in the respective submodule
    create the rebase commit, C` for C
```

We do provide a `pull` command; it currently *requires* the `--rebase` flag as
we consider the default behavior to be generally the wrong behavior.  The
previous to commands are the equivalent of:

```bash
$ git meta pull origin master
```

If you truly want the defaul behavior of `git pull`, you can write:

```bash
$ git fetch
$ git meta merge origin/master
```

The merge is also non-trivial to implement with Git, but easier to describe
(TODO: provide a diagram):

```
apply the changes of the commit to merge, C
for each submodule change CS introduced by C
   merge CS in the respective submodule
create the merge commit in the meta-repo
```

