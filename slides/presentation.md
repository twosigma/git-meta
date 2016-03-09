layout: true
class: center, middle, inverse
name: big-slide

---

template: big-slide

# Slim Internals and Demo

How does slim work, and how does it compare to VATS?

---

layout: false

# Overview

- implementation

--

- architectural/design differences with VATS

--

- demo

--

- about this presentation

---

template: big-slide

# Implementation

language and technology behind slim

---

## Python

I wrote the first version of Slim in Python.  I quickly became frustrated with
the available Python bindings for Git.  Several were available, but all had
problems:

--

- [Pygit2](http://www.pygit2.org) -- python bindings to libgit2.  Incomplete
  and poorly documented.

- [GitPython](http://gitpython.readthedocs.org/en/stable/) -- python wrapper
  around the git executable.  More complete and well-documented than some, but
  lacking many submodule operations and suboptimal due to need to launch a
  process for every operation.

- [Dulwich](https://www.dulwich.io) -- direct python implementation of Git
  commands.  Incomplete and probably slower than even GitPython as all
  operations are implemented in Python.

---

## JavaScript

Knowing node.js has been receiving a lot of activity, I looked at the available
JavaScript bindings and found [nodegit](https://github.com/nodegit/nodegit).
These bindings and the node.js platform have several advantages:

--

- nodegit is an almost 100% complete binding for libgit2

--

- nodegit is well-documented

--

- nodegit is under active development with almost twice as many commits as any
  of its Python counterparts despite being younger

--

- the nodegit APIs are fully *asynchronous* -- its creators have done the hard
  part of writing multi-threaded code so that your JavaScript programs can be
  single-threaded and still get the benefits of parallel operations

---

## JavaScript

Performance is an important consideration for this project, which may need to
operate across large numbers of repositories; in the long-term, native code
might be the right choice.  For now, however, node.js is a reasonable
candidate:

--

- Aside from nodegit itself, node.js has a culture of providing non-blocking,
  asynchronous operations.

--

- At risk of inciting a language war, the v8 engine is nearly an order of
  magnitude faster than any Python interpreter.

--

- JavaScript is evolving rapidly.  Generators, added in ES6, make writing
  asynchronous code easy:

```javascript
// Get some data from a server

const result = yield server.sendRequest({ operation: "give-me-data"});

// Parallel operations

const results = yield [ server.sendRequest({ operation: result.foo}),
                        server.sendRequest({ operation: result.bar})];
```

---

template: big-slide

# Architectural Differences with VATS

Differences between Hg and Git, plus the desire to model a truly distributed
version control system, create some differences in the semantics of similar
Slim and VATS operations.

--

The intention of this section is to highlight how these differences directly
affect architectural and implementation concerns in Slim and VATS.  There are
many other (often subtle) differences between Git and Hg that we will not
cover; [this Stack Overflow
article](http://stackoverflow.com/questions/1598759/git-and-mercurial-compare-and-contrast)
provides a good explanation.

---

layout: false
.left-column[
## Git/Hg Differences
### Branches
]
.right-column[

- Git branches are local entities.  A branch in your local repository has no
  tie to any remote (e.g., server-side) branches and exists in a local
  namespace.  For example, you can push a local branch to a branch in an
  upstream repository with a different name:

```bash
git push origin foo:bar
```

- Git branches are just pointers to commits; they can be deleted at any time.
  The commits to which a branch points have no back-references to the branch on
  which they were created.

- There is no concept of "multiple heads" in Git branches.  A branch points to
  exactly one commit.  The "force push" operation moves a branch to point to a
  commit that does not contain the previous commit in its history; this
  operation is highly discouraged on collaborative branches.
]

---

.left-column[
## Git/Hg Differences
### Branches
### Tags
]
.right-column[
As you are probably aware, tags in Hg are stored in a versioned, `.hgtags`
file.

Tags in Git are essentially branches that don't move.  I expect Git tags (which
may be permanently deleted like branches) to perform well enough that an
external representation for them will not be necessary.
]

---

.left-column[
## Git/Hg Differences
### Branches
### Tags
### Staging
]
.right-column[
Git provides a concept of *staging* wherein files are explicitly added to the
*index* before they are committed, e.g.:
```bash
$ echo bar >> foo
$ git commit -m "foo"
On branch master
Changes not staged for commit:
        modified:   foo

no changes added to commit
```
oops
```bash
$ git add foo
$ git commit -m "foo"
[master 9bd3ed6] foo
 1 file changed, 1 insertion(+)
```
Slim needs to support the concept of staging, including an `add` command and a
`-a` option for the `commit` command to auto-stage modified files.
]
---

.left-column[
## Git/Hg Differences
### Branches
### Tags
### Staging
### History
]
.right-column[
Rewriting local history is a common, accepted (expected) practice in Git.  Slim
will need to directly support:

- `reset` -- force HEAD to point to a different commit

- `commit --amend` -- replace the last commit

- `rebase` -- general command for rewriting history, e.g.:
    - to avoid unnecessary merge commits
    - to remove extraneous local commits
    - shape local history into a meaningful format before pushing
    - `rebase -i` in particular is a powerful tool
]

---

.left-column[
## Meta-Repo
### Structure
]
.right-column[
Fundamentally, Slim and VATS have the same model: a meta-repository tracks
commits in sub-repositories.  Due to different implementations, the resulting
structure in the two models differs:

- Rather than living in an, e.g., `.vats` directory, the Slim meta-repository
  appears to "contain" the sub-repositories.

- The sub-repository information lives with other Git meta-information in the
  `.git` directory.

- The Slim meta-repository does not contain other meta-information such as
  `pending_reviews`.

- Because the Slim meta-repository is a "first-class" repository, it is
  possible for users to add arbitrary meta-information to their own Slim
  meta-repositories; Slim operations such as `commit`, `push`, etc., gracefully
  handle such files.
]

---

.left-column[
## Meta-Repo
### Structure
### Commits in VATS
]
.right-column[
In VATS, commits to the meta-repository are an implementation detail created
implicitly immediately prior to a push.  This behavior has implications:

- The meta-repository is not a first-class citizen; users do not manipulate it.
- History of the meta-repository is not generally useful to users.
- The local repository is not a peer: history does not exist except when being
  packaged to deliver to "the" remote.
]

---

.left-column[
## Meta-Repo
### Structure
### Commits in VATS
### Commits in SLIM
]
.right-column[
In Slim, the meta-repository is a first-class citizen; local repositories are
true peers in the DVCS sense:

- History in the meta-repository is created and manipulated by users.
  The meta-repository history is *meaningful*.
- History in the meta-repository is *addressable*.  How can you perform
  operations, e.g., `cherry-pick` on past history without being able to address
  the commits?
- Cross-repository operations, e.g. `commit`, `rebase`, etc. explicitly
  operate on the meta-repository.
- Each (local) repository contains its own definitive history of the world;
  pushing changes is a non-mutating operation.  E.g., what happens if you try
  to switch branches in VATS with local, un-pushed changes?
- Operations on the meta-repo are cheap, i.e., no need to do a temporary clone
  to perform pushes.
]

---

## The `include` Command

The `include` command adds a new reference to a repository to a Slim
meta-repository.

Slim cannot create new upstream repositories.  The process to create an
upstream repository is not an inherent feature of Git and is coupled to
specific Git hosting technology, e.g.: Github (Enterprise or public), Gitosis,
Gitolite, Gitlab, etc.

???

Run the setup script:
```bash
include/include.sh
cd include-demo/meta
```

Then include a couple of repos:

```bash
sl include ../x x
sl include ../y y
```

Show them there...  Maybe see if anyone is interested in seeing how the
submodules are set up.  Show the `git` status and maybe then commit the
changes.

```bash
sl commit -m "added x and y"
```

Show that `x` and `y` are on the branch `my-branch`.

---

## Setup: the `clone`, `open`, and `close` Commands.

The `clone` command does what you would expect: it creates a copy of a
repository, locally.

The `open` and `close` commands hide and show sub-repositories.  `open` makes a
sub-repository visible, locally; `close` removes a sub-repository so that it is
not locally visible.

???

Run the setup script:

```bash
setup/setup.sh
```

Clone `meta`:
```bash
sl clone meta my-clone
```

Run `ls` to see that `x` and `y` are present but empty.  Run `open` and `close`
on `x` to show it appear and disappear.

---

## The `branch` Command

The `branch` operation creates a branch in the meta repo and in all visible
sub-repos in the local repository in which it is run.

???
Run the branch demo setup here:

```bash
branch/branch.sh
```
This command sets up, in a directory named `branch-demo`:

- `meta` -- the meta-repo
- `meta/x`
- `meta/y`

Then run the branch command:

```bash
sl branch foo
```

Then inspect the meta-repo and sub-repos to see that there is a branch named
`foo`.  Offer to pull up code if requested.

---

## The `status` Command

The `status` command displays information about the state of the
meta-repository and visible sub-repositories.

???

Run the setup:

```bash
status/status.sh
```

Then run `sl status` to see no changes.  Be sure to show a few things:

- new file
- modified file
- staged file
- wrong branch

---

## The `commit` Command

The `commit` operation creates a commit in all visible repositories with
modification *and the meta-repository*.

By default, `commit` operates only on changes staged to the index; with the
`-a` option it will automatically stage changes for modified files.

???

Run the setup

```bash
commit/commit.sh
```

Show that commit at this point doesn't do anything useful:

```bash
sl commit -m "a new commit"
```

Touch a couple of files, then show that still nothing to commit.  Show
`sl status`

Then run `commit` with the `-a` parameter and make an actual commit.

```bash
sl commit -a -m "a new commit"
```

Go into the repos and run `tig`.

---

## The `checkout` Command

The `checkout` command switches the meta-repository and all visible
repositories to a branch specified to the command; it will optionally allow,
require, or disallow the creation of branches as controlled with the `-c`
parameter.

After a successful `checkout`, the meta-repository and all sub-repositories are
on the specified branch.

???

Run the setup

```bash
checkout/checkout.sh
```

Show that we're on `master` then run

```bash
sl checkout my-feature
```

---

## The `push` Command

The Git `push` command uploads commits to a remote repository, adjusting a
*target* branch in that repository to point to the same commit as a *source*
branch in the local repository.

--

Slim `push` performs the same operation across repositories; it validates the
consistency of your local repositories and performs a Git `push`
on each visible sub-repository.  When the sub-repository pushes have finished
it executes a `push` on the meta-repository.

--

Recall that Git does not have the concept of multiple heads: each branch points
to exactly one commit.

--

A `push` that would create multiple heads in Hg --
the commit being pushed does not contain as an ancestor the current HEAD of the
target branch -- is considered to be a history-rewriting operation.

--

Git clients (including Slim) will not attempt such a `push` unless the
`--force` option is provided, and even then it is common for Git servers to
disallow "force pushes" on collaborative branches (especially `master`).

---

## The `pull` Command Considered Harmful

In theory, the `pull` command in Git is the moral inverse of of `push`: remote
commits are downloaded and a local branch is adjusted to reference them.  In
practice, it's quite a bit different.  By default, the Git `pull` operation,
e.g:

```bash
$ git pull origin master
```

Is the equivalent of two more primitive operations used together:

```bash
# fetch commits from the remote named 'origin'
$ git fetch origin

# merge the 'master' branch from 'origin' into the current branch
$ git merge origin/master
```
--

In practice, this is almost always the wrong behavior.  The above `merge`
command will (except in certain circumstances) create a *merge commit*
indicating that the upstream changes were merged into your local changes.

--

It is considered un-hygienic to have a history in which the main-line of
development is merged into a user's local branch.  Such a history begins to
have the look of spaghetti, confusing users and tools that rely on the "left"
line being the "main" line.  The system used by my previous team would reject
attempts to push this type of history.

---

## Pull Example

Given the following histories on the upstream and local `master` branches (top
commits are more recent):

    orgin/master      master
        C               D
        |               |
        B               B
        |               |
        A               A
`git pull origin master` will leave the local `master` branch with this
history:

    M
    |\
    D C
    | |
    B B
    | |
    A A
Where `M` is a merge commit.

In real life, there might be a substantial amount of upstream work where `C`
is.  This history is like saying: "Hey world, you're good to go now; I finally
integrated your work into my branch."

---

## Enter the `rebase` Command

Experienced users will invoke `pull` with the `--rebase` option, which is the
equivalent of:

```bash
$ git fetch origin
$ git rebase origin/master
```

A full discussion of the `rebase` command is beyond the scope of this
presentation (and maybe beyond my skills to explain).  In this specific case,
it instructs Git to rewrite local changes onto the head of `origin/master`,
yielding:

    D
    |
    C
    |
    B
    |
    A
This history is highly preferable.  Not only does it avoid creating a
misleading history, it omits the merge commit completely.  In general, merge
commits created when pulling remote changes are pure noise: the world doesn't
care when or how often you integrate upstream commits onto your local branch.

---

## Slim `pull`

The Slim `pull` command is implemented in terms of `git rebase`, but it's more
complicated than what you could easily implement running the commands by hand.
Basically, the algorithm is roughly:

1. If the local meta-repository is unchanged (i.e., its head is an ancestor of
   the head of the remote meta-repository), do nothing.
2. Otherwise, rebase the meta-repository.
3. If a conflict is encountered for a sub-repository, i.e., both the remote
   repository and the local repository have commits in that sub-repository,
   rebase the sub-repository on top of the commit made in the remote.

The result is that the local meta-repository and visible sub-repositories have
the same commits with the same mappings between them (there doesn't need to be
a one-to-one mapping), but the commits have been rewritten on top of any
upstream changes.

???

if that doesn't make sense, volunteer to draw a diagram

---

## Slum `push` and `pull` Demo

Let's say you have a repository with some commits ready to be pushed.

???

Run the demo:
```bash
push-pull/push-pull.sh
cd push-pull-demo
```

show that there are changes in `x`; make a commit:

```bash
$ sl commit -am "added stuff to 'foo'"
```

--

You attempt to push some changes, but get an error because there are other
upstream changes.

```bash
$ sl push
```

???
Should see an error about non-fastforwardable changes.  You can show
`origin/master` in the meta repo and x

--

So you have to first pull:

```bash
$ sl pull
```

???

Show that we now have our change rewritten on top of the upstream changes

--

Then you can push.

```bash
$ sl push
```

???

Show result of subsequent pushes and pulls.

---

## The `cherry-pick` Command

The `cherry-pick` command is used to take a rewrite a specific commit on the
head of the current branch.  It is different from a merge in that:

- The history of the cherry-picked commit is not added to the current branch.
- The resulting commit has a new id -- it must since it may have a different
  history.

--

This command is especially useful, for example, when a fix that has been
applied to a development branch (usually, `master`) needs to be applied to a
more stable branch without pulling in its history (that may contain unstable
changes).

???

Run the setup command:

```bash
cherry/cherry.sh
```

We're doing to do this a few times:

- cherry-pick from a branch: `sl cherry-pick other`
- cherry-pick from a commit (look at SHA of other's head)
- auto-open:

```bash
sl close x
sl cherry-pick other
```

then show `x` existing

---

## The `merge` Command

The `merge` command merges changes as described by the commit specified in the
*meta-repository*:

- changed files in the meta-repo are merged
- changes detected in sub-repos are merged in the respective sub-repos

???

Demo:

```bash
merge/merge.sh
```

then the command:

```bash
sl merge other
```

show a couple of things:

- merging a change that adds a new repo
- merging when one of the targets isn't visible
