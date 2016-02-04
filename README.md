<!--
    Copyright (c) 2016, Two Sigma Open Source
    All rights reserved.

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.

    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.

    * Neither the name of slim nor the names of its
      contributors may be used to endorse or promote products derived from
      this software without specific prior written permission.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
    AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
    IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
    ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
    LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
    CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
    SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
    INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
    CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
    ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
    POSSIBILITY OF SUCH DAMAGE.
-->

# Slim

Efficiently manage a set of repositories as if they were a single repository.

## Installation

    $ git clone https://github.com/twosigma/slim.git
    $ cd slim
    $ npm install -g

## Motivation

Large software systems are often decomposed into many repositories for a
variety of reasons:

- __Performance__ --  version control systems scale poorly in many ways: due to
  the number of commits, the number of files, the size of the data, etc.
- __Access Control__ -- repositories are the most common unit at which users
  are granted the ability to, e.g., approve pull requests
- __Physicallity__ -- a system may be composed of repositories served by
  physically separate servers, for example: internal and external github
  instances.

Unfortunately, a codebase that has been fragmented into multiple repositories
is difficult to manage; many of the benefits of using a version control system
are lost.  Ideally, we would like to be able to treat a set of repositories as
if they were a single repository, providing the ability to:

- create a reference that describes the state of all repositories
- address such references using branches and tags
- make atomic (across all repositories) commits
- selectively choose subsets of all repositories to clone locally
- use standard repositories operations (e.g.: `rebase`, `pull`, `push`) across
  multiple repositories

Additionally, we would like to support these concerns by leveraging existing
repository technologies, and without requiring the installation of new or
custom servers.

## What's Out There?

Before starting on slim, I investigated several existing tools:

[Gitslave](http://gitslave.sourceforge.net)
[myrepos](https://myrepos.branchable.com)
[Android Repo](https://source.android.com/source/using-repo.html)
[gclient](http://dev.chromium.org/developers/how-tos/depottools#TOC-gclient)
[Git subtrees](https://git-scm.com/book/en/v1/Git-Tools-Subtree-Merging)
[Git submodules](https://git-scm.com/docs/git-submodule)

All of these tools overlap with the problems slim is trying to solve, but none
of them are sufficient:

- most don't provide a way to reference the state of all repositories
  (Gitslave, Android Repo, Myrepos)
- some require a custom server (Android Repo)
- many are strongly focused on supporting a specific software platform (Android
  Repo, gclient)
- doesn't fully solve the scaling issue (Git subtrees)
- prohibitively difficult to use (Git submodules)

Git submodules come the closest: they do provide the technical ability to solve
the problem, but are very difficult to use and lack some of the desired
features.  With slim, we will build on top of Git submodules to provide the
desired functionality leveraging existing Git commands.

## Model

Our goal is to allow a related set of *sub-repositories* to be treated as a
single *meta-repository*.  Slim provides this functionality using Git
submodules.  The meta-repository is managed by slim; it is a Git repository
containing a submodule for each sub-repository (and possibly other meta-data).
Each commit in the meta-repository describes an exact state of the world.
Branches and tags in the meta-repository facilitate cross-repository branching
and tagging.

The user may choose which sub-repositories to edit; we refer to repositories
that are locally available as being *visible*.

### Git Is Still There

Slim is a tool that facilitates the use of Git submodules to manage a set of
repositories as if they were a single repository.  Slim strives to be as
easy-to-use as possible, but hiding Git is not a goal.  We understand that many
times you will want to work directly with Git commands.  We will document our
model, invariants, and sub-command implementations so that you will be able to
understand how slim interacts with Git.  Furthermore, slim will provide clear
diagnostics and automatic recovery when it encounters a non-canonical state.

In many cases, slim does provide sub-commands that map directly to Git
sub-commands.  We do this not to hide Git, but to provide the command with a
streamlined set of slim-compatible options and slim-specific documentation.

### Invariants

Slim, attempts to maintain the following invariants:

- Every visible sub-repository is set to the same local branch as the
  meta-repository.

### Vocabulary

*visibility* -- a visible repository is one that has been cloned locally, and
to which slim operations (such as `branch`) will be applied.  The visibility
of a repository is changed through the `open` and `close` commands.
*sub-repository* -- one of the repositories included in a slim repository.
*meta-repository* -- the containing repository managed by slim consisting of a
submodule for each sub-repository

### Sub-Commands

#### `init`

Directly maps to `git init`.

#### `clone`

Directly maps to `git clone`.

#### `include`

Add a sub-repository.

#### `open`

Make a sub-repository visible locally.  Check out a branch having the same name
as the current branch in the meta-repository pointing to the commit id
currently indicated for that sub-repository in the meta-repository's HEAD.

#### `close`

Hide a sub-repository so that it is not visible locally.

#### `branch`

Work with branches in all visible sub-repositories.

#### `commit`

Commit outstanding changes in repos with modifications and meta-repo.

#### `push`

Push commits from visible sub-repos and meta-repo.
