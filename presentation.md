layout: true
class: center, middle, inverse
name: big-slide

---

template: big-slide
# Git-meta
large-scale distributed source control made easy

.footnote[Go directly to [project site](https://github.com/twosigma/git-meta)]

---

template: big-slide

# Motivation

Your developers have fallen in love with distributed version control systems,
such as Git. Now you have many repositories (10s, 100s, 1000s) where you used
to have one.

How do you bring them back together again?

---

layout: false

.left-column[
## Motivation
### Why many repos?
]
.right-column[

Large software systems are decomposed into multiple repositories for a variety
of reasons:

- __Performance__ --  version control systems scale poorly in many ways: due to
  the number of commits, the number of files, the size of the data, etc.

- __Access Control__ -- repositories are the most common unit at which users
  are granted the ability to, e.g., approve pull requests

- __Physicallity__ -- a system may be composed of repositories served by
  physically separate servers, for example: internal and external github
  instances.

- __Culture__ -- people like creating topic-specific repositories
]

---

layout: false
.left-column[

## Motivation
### Why many repos?
### How do we bring them together?
]
.right-column[

Ideally, we would like to be able to treat a set of repositories as
if they were a single repository, providing the ability to:

- create a reference that describes the state of all repositories

- address such references using branches and tags

- make atomic (across all repositories) commits

- selectively choose subsets of all repositories to clone locally

- use standard repositories operations (e.g.: `rebase`, `pull`, `push`) across
  multiple repositories
]

---

layout: false
.left-column[
## Motivation
### Why many repos?
### How do we bring them together?
### Use Existing Solution?
]
.right-column[

Before starting on Git-meta, I investigated several existing tools:

- [Gitslave](http://gitslave.sourceforge.net)

- [myrepos](https://myrepos.branchable.com)

- [Android Repo](https://source.android.com/source/using-repo.html)

- [gclient](http://dev.chromium.org/developers/how-tos/depottools#TOC-gclient)

- [Git subtrees](https://git-scm.com/book/en/v1/Git-Tools-Subtree-Merging)

- [Git submodules](https://git-scm.com/docs/git-submodule)

]

---
.left-column[
## Motivation
### Why many repos?
### How do we bring them together?
### Use Existing Solution?
]
.right-column[

All of these tools overlap with the problems Git-meta is trying to solve, but
none of them are sufficient:

- most don't provide a way to reference the state of all repositories
  (Gitslave, Android Repo, Myrepos)

- some require a custom server (Android Repo)

- many are strongly focused on supporting a specific software platform (Android
  Repo, gclient)

- doesn't fully solve the scaling issue (Git subtrees)

- prohibitively difficult to use (Git submodules)

]

---

template: big-slide

## Conclusion: build Git-meta using Git submodules

Git submodules provide minimal functionality; what they do offer is difficult
to use.  However, they do give sufficient, core operations from which we can
achieve our goals.

I will package the Git-meta project as the `git-meta` command, e.g.:

```bash
$ git meta merge my-branch
```

With the intention of contributing it to Git, possibly folded into the existing
`submodule` command.

---

template: big-slide

## Architecture Overview

---

layout: false

.left-column[
## Architecture
### Principles
]
.right-column[
- A Git-meta repository (or *meta-repository*) contains pointers to
  *sub-repositories*.

- Each pointer indicates a repository URL and commit.

- The pointers are implemented using Git submodules.

- Git-meta does not need any meta-information not provided directly by Git.

- All Git-meta operations can be implemented in terms of basic Git operations.

- Git-meta is a *distributed* version control system.  State changes happen
  locally.  Repositories -- including meta-repositories -- are equals.

- Git-meta requires no server-side technology; it is implemented entirely in
  terms of Git operations.
]

---

.left-column[
## Architecture
### Principles
### The Git-meta meta-repository
]
.right-column[
- Git-meta requires a meta-repository to hold submodules.

- Git-meta does not require any specific files or structure for the
  meta-repository; any repository is a valid Git-meta repository.

- The user may add arbitrary files to a Git-meta meta-repository.  A team may
  want to place system-wide configuration files in the meta-repository, for
  example.
]

---

.left-column[
## Architecture
### Principles
### The Git-meta meta-repository
### Sub-repositories
]
.right-column[
- Each sub-repository is a submodule in the meta-repository.

- Each commit in the meta-repository indicates, for each sub-repository:
    - a URL
    - a commit

- A sub-repository may be *open* or *closed*.

- Open sub-repositories have been cloned locally and will be operated on by
  many Git-meta operations.

- Closed sub-repositories have not been cloned locally and are ignored by most
  Git-meta commands.

- A newly cloned meta-repository has no open sub-repositories.
]

---

.left-column[
## Architecture
### Principles
### The Git-meta meta-repository
### Sub-repositories
### Commands
]
.right-column[
- generally implement same commands as Git but across sub-repositories, e.g.:
  `branch`, `merge`, `rebase`, `commit`, etc.

- most cross-repository commands apply to only open repositories

- additional commands for adding and removing sub-repositories

- additional commands to control visibility of sub-repositories
]
