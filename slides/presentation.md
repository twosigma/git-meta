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
### Commits
]
.right-column[
In VATS, commits to the meta-repository are an implementation detail created
implicitly immediately prior to a push.  This behavior has implications:

- The meta-repository is not a first-class citizen; users do not manipulate it.
- History of the meta-repository is not generally useful to users.
- The local repository is not a peer: history does not exist except when being
  packaged to deliver to "the" remote.

In Slim, the meta-repository is a first-class citizen; local repositories are
true peers in the DVCS sense:

- History in the meta-repository is created and manipulated by users.
- Cross-repository operations, e.g. `commit`, `rebase`, etc. explicitly
  operate on the meta-repository.
- Each (local) repository contains its own definitive history of the world;
  pushing changes is a non-mutating operation.  E.g., what happens if you try
  to switch branches in VATS with local, un-pushed changes?
- Operations on the meta-repo are cheap, e.g., no need to do a temporary clone
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
