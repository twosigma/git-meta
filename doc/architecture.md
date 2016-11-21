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

    * Neither the name of git-meta nor the names of its
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

# Overview

This document describes the design of git-meta.  First, we provide motivation
by describing the term *mono-repo*, explaining what makes mono-repos an
attractive strategy for source code management, and why they are not found in
most organizations. We also explore some open source projects that are in this
space.  In short, the first section should explain why git-meta is needed.

Next, we present the architecture for implementing a mono-repo using Git
submodules.  We describe the overall repository structure, commits, forking,
refs, and the client-side representation.

Then, we present an earlier, more-intuitive architecture.  Seeing how our
strategy evolved from this approach is illustrative, and helps to understand
some of the less-intuitive design choices.

Next, we provide an analysis of the performance of a mono-repo.  We show how
the performance of a mono-repo can remain mostly constant as it grows, ages,
and supports more developers.

Finally, we provide an overview of the actual software provided by this
project: generally server-side hooks and maintenance utilities, and the
`git-meta` plugin itself.

# Mono-repo

## What is a mono-repo?

A mono-repo is a repository containing all of the source for an organization.
It presents source in a single, hierarchical directory structure. A mono-repo
supports standard operations such as atomic commits and merges across the code
it contains.

Critically, in order to host all source for an organization, the performance of
a mono-repo must not degrade as it grows in terms of:

- history (number of commits)
- amount of code (number of files and bytes)
- number of developers

## What are the advantages of a mono-repo?

The alternative to a mono-repo is for an organization to decompose its source
into multiple repositories.  In comparison to a multi-repo strategy,
a mono-repo provides the following advantages:

- Atomic changes can be made across the organization's code.
- The history of the of an organization's source is described in a mono-repo.
  With multiple repositories, it is impossible to present a unified history.
- Because all source is described in one history, archaeological operations
  such as `bisect` are easily supported.
- Source in the organization is easy to find.
- The use of a mono-repo encourages an organization to standardize on tools,
  e.g.: build and test.  When an organization has unrelated repositories that
  integrate at the binary level, its teams are more likely to adopt divergent
  build and test tools.
- The use of a mono-repo makes it easier to validate cross-organization builds
  and tests.

To summarize, the use of a single (mono) repository encourages collaboration
across an organization.  The use of multiple, unrelated, team-oriented
repositories encourages the use of divergent tooling and silos.

## Why doesn't everyone have a mono-repo?

Most organizations do not have a mono-repo because existing DVCS systems (e.g.,
Git and Mercurial) suffer performance degradation as the size of the repository
and the number of users increase.  Over time, basic operations such as `git
status`, `git fetch`, etc. become slow enough that developers, given the
opportunity, will begin splitting code into multiple repositories.

We discuss the architecture of git-meta in more detail in the next section, but
essentially it provides a way to use standard Git operations across many
repositories.  Before starting on git-meta, we did investigate several existing
products that take a similar approach:

- [Gitslave](http://gitslave.sourceforge.net)
- [myrepos](https://myrepos.branchable.com)
- [Android Repo](https://source.android.com/source/using-repo.html)
- [gclient](http://dev.chromium.org/developers/how-tos/depottools#TOC-gclient)
- [Git subtrees](https://git-scm.com/book/en/v1/Git-Tools-Subtree-Merging)
- [Git submodules](https://git-scm.com/docs/git-submodule)

All of these tools overlap with the problems git-meta is trying to solve, but
none of them are sufficient:

- most don't provide a way to reference the state of all repositories
  (Gitslave, Android Repo, Myrepos)
- some require a custom server (Android Repo)
- many are strongly focused on supporting a specific software platform (Android
  Repo, gclient)
- doesn't fully solve the scaling issue (Git subtrees)
- prohibitively difficult to use (Git submodules)
- lack scalable collaboration (e.g., pull request) strategies

Git submodules come the closest: they do provide the technical ability to solve
the problem, but are very difficult to use and lack some of the desired
features.  With git-meta, we build on top of Git submodules to provide the
desired functionality leveraging existing Git commands.

# Git-meta Architecture

In this section we lay out the architecture for git-meta.  First, we discuss
the basic structure of a mono-repo, defining the two types of repositories:
*meta* and *sub*.  Then, we describe what a commit looks like in a mono-repo.
Next, we describe the client-side rendering of a mono-repo, i.e., what a cloned
mono-repo looks like.  Finally, we explain how refs (e.g., branches and tags)
work in a mono-repo.

## Repository Structure

Git-meta creates a logical mono-repo out of multiple *sub-repositories* (a.k.a.
sub-repo) by tying them together in a *meta-repository* (a.k.a. meta-repo) with
Git submodules.  Recall that a Git submodule consists of the following:

1. a path at which to root the submodule in the referencing (meta) repository
1. the url of the referenced (sub) repository
1. the id of the "current" commit in the referenced (sub) repository

Thus, a meta-repo presents the entire source structure in a rooted directory
tree, and the state of the meta-repo unambiguously describes the complete
state of all sub-repos, i.e., the mono-repo:

```
'------------------------------------------------------------------------`
|                                                                        |
|  '-----------------------`                                             |
|  | meta-repo  |          |                                             |
|  | *master    | foo/bar--|---------> [a1   http://foo-bar.git]         |
|  | [m1]       | foo/baz--|---------> [b1   http://foo-baz.git]         |
|  |            |     zam--|---------> [c1   http://zam.git]             |
|  |            |          |                                             |
|  `-----------------------,                                             |
|                                                                        |
`------------------------------------------------------------------------,
```

This meta-repo, for instance, has the `master` branch checked out on commit
`m1`.  It references three sub-repos, rooted at: `foo/bar`, `foo/baz`, and
`zam`.  The sub-repo rooted at `foo/bar` lives in the url "http://foo-bar.git",
and is currently on commit `a1`.  In future diagrams we'll use a more compact
representation:

```
'---------------------------`
| meta-repo  |              |
| *master    | foo/bar [a1] |
| [m1]       | foo/baz [b1] |
|            |     zam [c1] |
|            |              |
`---------------------------,
```

Note that git-meta allows users to put arbitrary files in the meta-repo (e.g.,
global configuration data), but for simplicity we ignore them in the rest of
this document.

## Commits

Commits in sub-repos do not directly affect the state of the mono-repo.
Updating the mono-repo usually requires at least two commits: (1) a commit in
one or more sub-repos and (2) a commit in the meta-repo.  Say, for example,
that we make changes to the `foo/bar` and `foo/baz` repositories, updating
their HEADs to point to `a2` and `b2`, respectively.

Our mono-repo has not yet been affected, and if you were to make a clone of the
meta-repo in this condition, you would see the same state diagrammed
previously.  To update the mono-repo, a commit must be made in the meta-repo,
changing the mono-repo to look like, e.g.:

```
'-------------------------------`
| meta-repo  |                  |
| *master    | foo/bar [a2->a1] |
| [m2->m1]   | foo/baz [b2->b1] |
|            |     zam [c1]     |
|            |                  |
`-------------------------------,
```

## Client-side Representation

A mono-repo consists of a meta-repo and some number of sub-repos.  To clone a
mono-repo, one creates a clone of the meta-repo with `git clone`.  In a cloned,
checked-out mono-repo, a given sub-repo is either *open* or *closed*.  An open
sub-repo has been cloned and checked out, having a working tree rooted at its
configured path under the meta-repo.  For a closed sub-repo, its configured
path exists but is empty, and the remote that backs it has generally not been
cloned.

All sub-repos are closed in a freshly-cloned mono-repo.  A developer will open
sub-repos as needed.  In a properly configured (i.e., decomposed) mono-repo,
most developers will need to clone only a tiny subset of the total history and
code contained in the mono-repo.

```
'---------------------`
| meta-repo  |        |
| *master    | a [a1] |
| [m1]       | b [b1] |
|            |        |
`---------------------,
```

Say that a user clones the repo above, where both `a` and `b` have trees with a
single file, `README.md`, in their commits `a1` and `b1`, respectively.

```bash
$ git clone http://meta-repo
$ cd meta-repo
$ ls a
$ ls b
```

Now we open `b`:

```bash
$ git meta open b
$ ls a
$ ls b
README.md
```

## Forking

It is possible to use git-meta with a single meta-repo namespace, but we
strongly recommend the use of a name-partitioning strategy, a.k.a. forking.
Forking may be generally be implemented either via [Git
namespaces](https://git-scm.com/docs/gitnamespaces) or a
hosting-solution-specific forking mechanism.  Without forking, every user will
receive every branch in existence on every fetch and clone, causing significant
performance problems, especially over time.

We fork only the meta-repo.  That is, for a given mono-repo, there may be any
number of peer forks of the meta-repo on the back-end (though policy will
generally designate that some meta-repos are special), but only one instance of
each sub-repo:

```
'-----------` '-----------`
|     a     | |     b     |
`-----------, `-----------,
   ^     ^      ^      ^
   |     |     /       |
   |     |    /        |
   |      `--.---.     |
   |     .--/    |     |
'--|-----|--` '--|-----|--`
|  a     b  | |  a     b  |
| - - - - - | | - - - - - |
| jill/meta | | bill/meta |
`-----------, `-----------,
```

Any clone of any meta-repo (even a local one) will still reference the same
canonical sub-repos.  Thus, a mono-repo is not truly distributed like single
Git repositories.  We consider this to be acceptable for the following reasons:

- Mono-repos are designed to facilitate source management in large
  organizations, which generally nominate canonical repositories for
  integration anyway.
- The individual repos of which they are composed are still normal,
  distributed, Git repos (e.g., two distinct mono-repos may contain sub-repos
  with the same histories).
- As described in the section on our "naive architecture", workflows
  involving forked sub-repos have significant drawbacks.
- One of the main benefits of DVCSs -- the ability to have a first-class
  development experience without network connectivity to the server -- is still
  possible.

## Refs

This section describes how refs are managed in a mono-repo.  First, we briefly
explain our high-level branching and tagging strategy.  Then, we define
synthetic-meta-refs and discuss how they fit into git-meta workflows.  Finally,
we present two variations on synthetic-meta-refs to help illustrate how the
concept evolved; one of these variations, *mega-refs*, may prove necessary for
old version of Git.

## Branches and Tags

In git-meta, branches and tags are applied only to meta-repos.  Because each
commit in a meta-repo unambiguously describes the state of all sub-repos, it is
unnecessary to apply branches and tags to sup-repos.  Furthermore, as described
in the "Naive Architecture" section below, schemes relying on sub-repo branches
proved to be impractical.

Therefore, ref names in git-meta always refer to refs in the meta-repo.
Branches and tags in sub-repos are ignored by git-meta -- by server-side checks
and by the client-side `git-meta` plugin.  You may choose to create branches or
tags in sub-repos (for example, to mirror significant branches and tags in a
meta-repo), but they will not affect git-meta.  The git-meta plugin does not
push branches or tags in sub-repos when, e.g. the `git meta push` command is
used.

## Synthetic-meta-refs

In this section we describe synthetic-meta-refs.  First, we provide a
definition for the term.  Then, we describe the role of synthetic-meta-refs in
the architecture of a mono-repo.  Next, we describe how synthetic-meta-refs are
used when pushing a ref to a mono-repo.  Finally, we explain the implications
of this strategy on client-side checkouts.

### Definition

A synthetic-meta-ref is a ref in a sub-repo whose name includes the commit ID
of the commit to which it points, such as:
`refs/meta/929e8afc03fef8d64249ad189341a4e8889561d7`.  The term is derived from
the fact that such a ref is:

1. _synthetic_ -- generated by a tool
1. _meta_ -- identifying a commit in a sub-repo that is (directly or
   indirectly) referenced by a commit in the meta-repo
1. _ref_ -- just a ref, not a branch or tag

### Architectural Role

A mono-repo has two invariants with respect to synthetic-meta-refs:

1. Every synthetic-meta-ref must point to the commit identified by its name.
1. Every commit in a sub-repo that is identified by a commit in any meta-repo
   must be reachable by a synthetic-meta-ref.

Some mono-repos in valid states:

```
'-------------------`  '-------------------`
| meta-repo         |  |         a         |
| - - - - - - - - - |  | - - - - - - - - - |
|  master  | a [a1] |  | refs/meta/a1 [a1] |
`-------------------,  `-------------------,

The 'master' branch in the meta-repo indicates commit 'a1' for repo 'a' and a
valid synthetic-meta-ref exists.
```

```
'-------------------`  '-------------------`
| meta-repo         |  |         a         |
| - - - - - - - - - |  | - - - - - - - - - |
|  master  | a [a1] |  | refs/meta/a1 [a1] |
| - - - - -+- - - - |  | refs/meta/ab [ab] |
|  release | a [ab] |  `-------------------,
`-------------------,

The meta-repo has another branch, 'release', indicating commit 'ab' in 'a',
which also has a valid synthetic-meta-ref.
```

```
'-----------------------`  '-------------------`
| meta-repo             |  |         a         |
| - - - - - - - - - - - |  | - - - - - - - - - |
|  master  | a [a1]     |  | refs/meta/a2 [a2] |
| - - - - -+- - - - - - |  `-------------------,
|  release | a [a2->a1] |
`-----------------------,

Same as above except that 'release' points to a commit, 'a2', derived from
'a1'.  Since 'a1' is reachable from 'a2', we do not need a synthetic-meta-ref
for 'a1'.
```

A few mono-repos in invalid states:

```
'-------------------`  '-------------------`
| meta-repo         |  |         a         |
| - - - - - - - - - |  | - - - - - - - - - |
|  master  | a [a1] |  | refs/meta/a1 [a2] |
`-------------------,  `-------------------,

The synthetic-meta-ref for 'a1' does not point to 'a1'.
```

```
'-------------------`  '-------------------`
| meta-repo         |  |         a         |
| - - - - - - - - - |  | - - - - - - - - - |
|  master  | a [a1] |  | refs/meta/ab [ab] |
`-------------------,  `-------------------,

No synthetic-meta-ref for commit 'a1'.
```

```
'-----------------------`  '-------------------`
| meta-repo             |  |         a         |
| - - - - - - - - - - - |  | - - - - - - - - - |
|  master  | a [a1]     |  | refs/meta/a1 [a1] |
| - - - - -+- - - - - - |  `-------------------,
|  release | a [a2->a1] |
`-----------------------,

Missing synthetic-meta-ref for 'a2', which is not reachable from 'a1'.
```

Note that we provide tools (described in more detail below) to enforce these
invariants.

The first invariant provides for sanity: we know what a synthetic-meta-ref is
pointing to from its name, and for the ability to use synthetic-meta-refs as
*push targets*.  Because a synthetic-meta-ref (if it exists) must point to the
commit identified in its name, we are always guaranteed to be able to push one
(though the push may prove unnecessary if the ref already exists).

The second invariant protects necessary (because they are referenced from
meta-repos) sub-repo commits from garbage collection.  Note that it does imply
some bookkeeping, for which we provide additional tools:

- to remove redundant synthetic-meta-refs (i.e., if a descendant of the commit
  referenced by the synthetic-meta-ref also has a synthetic-meta-ref) to
  minimize the number of refs
- to remove unneeded synthetic refs, i.e., those identifying commits no longer
  identified by any meta-repo commits

### Pushing meta-repo refs

Before pushing one or more commits to a meta-repo ref, clients of git-meta are
required to have already pushed a synthetic-meta-ref for each commit in each
sub-repo referenced by these meta-repo commits.  Clients may make reasonable
guesses about which synthetic-meta-refs need to be created based on which
meta-repo commits they are pushing -- should these assumptions prove wrong the
push will be rejected.

We provide the `git meta push` command to facilitate the creation of
synthetic-meta-refs.  Given the following local and remote repos:

```
local
'---------------------------------`
| meta-repo  |                    |
| *master    | a *master [a2->a1] |
| [m2->m1]   | b *master [b2->b1] |
`---------------------------------,

remote
'---------------------`  '--------------`  '--------------`
| meta-repo  |        |  | a            |  | b            |
| master     | a [a1] |  | refs/meta/a1 |  | refs/meta/b1 |
| [m1]       | b [b1] |  |  [a1]        |  |  [b1]        |
`---------------------,  `--------------,  `--------------,
```
Where we have new commits, `a2` and `b2` in repos `a` and `b`, respectively,
and a new meta-repo commit, `m2` that references them.  Note that `a1` and `b1`
have appropriate synthetic-meta-refs 

After invoking `git meta push`, the remote repos would look like:

```
'---------------------`  '--------------`  '--------------`
| meta-repo  |        |  | a            |  | b            |
| master     | a [a2] |  | refs/meta/a1 |  | refs/meta/b1 |
| [m2]       | b [b2] |  |  [a1]        |  |  [b1]        |
`---------------------,  | refs/meta/a2 |  | refs/meta/b2 |
                         |  [a2]        |  |  [b2]        |
                         `--------------,  `--------------,
```
Note that `git meta push` created meta-refs in the sub-repos for the new
commits before it updated the meta-repo.  If the process had been interrupted,
for example, after pushing `refs/meta/a2` but before pushing `refs/meta/b2`,
the mono-repo would still be in a valid state.  If no meta-repo commit ever
referenced `a2`, the synthetic-meta-ref `refs/meta/a2` would eventually be
cleand up.

### Client-side access to sub-repo commits

Since synthetic-meta-refs are not branches or tags, they are not fetched
automatically when a sub-repo is cloned or fetched.  This behavior is by
design: fetching every commit that is in-flight in an organization may be
prohibitive.  However, we must fetch the commits as they are needed.  We rely
on the relatively recent facility provided by Git to directly fetch a commit by
its sha1.  Our `git-meta` plugin performs this fetch as needed, for example,
when:

- opening a sub-repo
- checking out a new branch
- merging a branch
- performing a rebase

## Variations

We evaluated two possible variants on synthetic-meta-refs:

#### A synthetic-meta-ref for every commit

As it is not possible to directly fetch a commit by its sha1 in older versions
of Git, our first proposal for synthetic-meta-refs had the invariant that every
commit in a sub-repo that is directly referenced by a commit in any meta-repo
fork have a synthetic-meta-ref associated with it.

This invariant would have been expensive to satisfy on the client.  We don't
generally know which commits have meta-refs associated with them, and even if
we did, there might be cases where we would genuinely need to create large
numbers of them: such as when importing an existing repository.

Some of the cost might have been reduced by generating the refs in server-side
hooks, but we have otherwise been able to restrict our server-side hooks to
read-only operations.

#### Mega-ref

Another strategy would be to maintain a *mega-ref* in each sub-repo.  The
mega-ref is a ref through which all the commits in a sub-repo identified by all
commits in all meta-repos can be reached.  Whenever a synthetic-meta-ref is
pushed to a sub-repo, the mega-ref is rewritten to have the commit identified
by the new synthetic-meta-ref if it does not already contain that commit in its
history.  The downside of this approach is that the mega-ref references all
commits, probably many more than what is needed at any given time.

# Naive Architecture

In this section we describer the basic model we had in mind when we started
git-meta.  First, we provide an overview of the original architecture.  Then,
we describe a series of problems that arise from this architecture.  Finally,
we draw conclusions by this exercise and connect them to our final design
choices.

## Overview

One of the principles behind git-meta is to diverge as little as possible from
"normal" Git.  We want to use vanilla Git commands where possible, and we
wanted to preserve the basic decentralized model of Git.  We believed we could
achieve our goals mostly by making submodules work "better", e.g., by
providing submodule-aware `merge` and `rebase` operations.

With branching, for example, we expected to synchronize branches among the
meta-repo and its open sub-repos such that (when using our tools) they would
always be on the same checked-out branch:

```
local
'-----------------------------`
| meta-repo  |                |
| *master    | a *master [a1] |
| [m1]       | b *master [b1] |
`-----------------------------,
```

Similarly, a `git meta push` would be like a submodule-aware push operation.
We would first push the ref with that name from open sub-repos, then from the
meta-repo:

```
local
'---------------------------------`
| meta-repo  |                    |
| *master    | a *master [a2->a1] |
| [m2->m1]   | b *master [b2->b1] |
`---------------------------------,

remote
'---------------------`  '--------`  '--------`
| meta-repo  |        |  | a      |  | b      |
| master     | a [a1] |  | master |  | master |
| [m1]       | b [b2] |  | [a1]   |  | [b1]   |
`---------------------,  `--------,  `--------,
```

```bash
$ cd meta-repo
$ cd a
$ git push origin master
$ cd ../b
$ git push origin master
$ cd ..
$ git push origin master
```

When landing pull-requests or doing other server-side validations, we would
check that for a given meta-repo branch, we had corresponding valid sub-repo
branches of the same name.

```
local
'---------------------------------`
| meta-repo  |                    |
| master     | a *master [a2->a1] |
| [m2->m1]   | b *master [b2->b1] |
`---------------------------------,

remote
'---------------------`  '--------`  '--------`
| meta-repo  |        |  | a      |  | b      |
| master     | a [a1] |  | master |  | master |
| [m1]       | b [b2] |  | [a1]   |  | [b1]   |
`---------------------,  `--------,  `--------,
```

```bash
$ cd meta-repo
$ git push origin master
error: master ref in sub-repo a does not point to commit a2
error: master ref in sub-repo b does not point to commit b2
```

Sub-repo forking would follow meta-repo forking.  We created the term *orchard*
to describe a meta-repo and its associated collection of sub-repo forks.  When
a user "forked" an orchard, it would create a new, _peer_ orchard, modeling the
peer-to-peer aspects of normal Git repositories.  A project named "foo" might
have an orchard configured as:

```
'---------------------`  '--------`  '--------`
| foo/meta-repo       |  | foo/a  |  | foo/b  |
| master     | a [a1] |  | master |  | master |
| [m1]       | b [b2] |  | [a1]   |  | [b1]   |
`---------------------,  `--------,  `--------,
```

If Jill were to fork foo, the result would be:

```
'---------------------`  '--------`  '--------`
| jill/meta-repo      |  | jill/a |  | jill/b |
| master     | a [a1] |  | master |  | master |
| [m1]       | b [b2] |  | [a1]   |  | [b1]   |
`---------------------,  `--------,  `--------,
```

Unfortunately, while this model was intuitive, it created several intractable
problems:

## Race conditions on collaboration branches

Git does not provide for atomic cross-repository operations.  So, as described
above, our plan had been to implement push such that we updated affected
sub-repo branches first, then the meta-repo branch.  Furthermore, we would
provide server-side validation to reject attempts to update a meta-repo branch
to a commit contradicting the state of the corresponding sub-repo branch.

Unfortunately, this strategy suffers from a potential race condition that could
put a branch in the meta-repo into a state such that it could no longer be
updated.  For example, lets say Bob and Jill both have unrelated changes to
repos `a` and `b`:

```
Bob's local                       Jill's local
'-------------------------`       '-------------------------`
| meta-repo  |            |       | meta-repo  |            |
| master     | a [a2->a1] |       | master     | a [a3->a1] |
| [m2->m1]   | b [b2->b1] |       | [m3->m1]   | b [b3->b1] |
`-------------------------,       `-------------------------,

remote
'---------------------`  '--------`  '--------`
| meta-repo  |        |  | a      |  | b      |
| master     | a [a1] |  | master |  | master |
| [m1]       | b [b2] |  | [a1]   |  | [b1]   |
`---------------------,  `--------,  `--------,
```

If Bob pushes first, the result will be the state described in the previous
diagram.  If Jill pushes after Bob, her sub-repo pushes (neither of which are
fast-forwardable) will fail, and her meta-repo push will be rejected (though
her client should not attempt it anyway).  This is the expected scenario.  But
what if they go at the same time? Say that Bob's push to `a` and Jill's push to
`b` succeed, while Bob's push to `b`, and Jill's push to `a` fail:

```
Bob's local                       Jill's local
'-------------------------`       '-------------------------`
| meta-repo  |            |       | meta-repo  |            |
| master     | a [a2->a1] |       | master     | a [a3->a1] |
| [m2->m1]   | b [b2->b1] |       | [m3->m1]   | b [b3->b1] |
`-------------------------,       `-------------------------,

remote
'---------------------`  '----------`  '----------`
| meta-repo  |        |  | a        |  | b        |
| master     | a [a1] |  | master   |  | master   |
| [m2->m1]   | b [b2] |  | [a2->a1] |  | [b3->b1] |
`---------------------,  `----------,  `----------,
```

Now, the remote meta-repo is technically in a valid state: users can clone it
and checkout, and all is good.  However, neither Bob, nor Jill, nor anyone else
will be able to push a new change without addressing the situation by hand;
most likely, they will need an expert to rectify the situation.

We explored some options to address this, such as pushing branches in order,
but they all fell short.  In fact, this situation does not require a race: if a
user simply aborts the overall push after some sub-repo branches have been
updated but before the meta-repo has been, a similar state will be achieved.

## Force Pushing

Force-pushing in sub-modules can easily cause meta-repo commits to become
invalid by making it impossible to fetch the sub-repo commits they reference,
and eventually allowing them to be garbage collected.  While we expect
"important" branches to be protected against force-pushing, it's a very common
and useful practice in general, even on branches used for collaboration.

```
'---------------------`  '----------`
| meta-repo  |        |  | a        |
| master     | a [a2] |  | master   |
| [m1]       |        |  | [a2->a1] |
`---------------------,  `----------,
```

```bash
git push -f a-origin a1:master
```

```
'---------------------`  '----------`
| meta-repo  |        |  | a        |
| master     | a [a2] |  | master   |
| [m1]       |        |  | [a1]     |
`---------------------,  `----------,
```

## Fork Frenzy

Generating a new repository for each sub-repo when a forked orchard is created
could be expensive if the number of sub-repos is large.   Furthermore, what
happens when new sub-repos are added? Take the earlier example:

```
'---------------------`  '--------`  '--------`
| foo/meta-repo       |  | foo/a  |  | foo/b  |
| master     | a [a1] |  | master |  | master |
| [m1]       | b [b2] |  | [a1]   |  | [b1]   |
`---------------------,  `--------,  `--------,

'---------------------`  '--------`  '--------`
| jill/meta-repo      |  | jill/a |  | jill/b |
| master     | a [a1] |  | master |  | master |
| [m1]       | b [b2] |  | [a1]   |  | [b1]   |
`---------------------,  `--------,  `--------,
```

Now, if a new repository, `c`, is added we have:

```
'---------------------`  '--------`  '--------` '--------`
| foo/meta-repo       |  | foo/a  |  | foo/b  | | foo/c  |
| master     | a [a1] |  | master |  | master | | master |
| [m1]       | b [b2] |  | [a1]   |  | [b1]   | | [b1]   |
`---------------------,  `--------,  `--------, `--------,

'---------------------`  '--------`  '--------`
| jill/meta-repo      |  | jill/a |  | jill/b |
| master     | a [a1] |  | master |  | master |
| [m1]       | b [b2] |  | [a1]   |  | [b1]   |
`---------------------,  `--------,  `--------,
```

We could have an automated task that would detect the creation of new
repositories and auto-fork them, but when?  To allow for collaboration, we
would most likely need to perform the auto-fork whenever a new repository is
created, likely a very expensive operation for a potentially speculative
operation.  The existence of these forks could be confusing, at best, if the
when repositories are abandoned.  At the very least, we have created a new
concept -- a set of related orchards -- that undermines our peer-to-peer model.

## Remote Frenzy

As is normal in Git, different forks are handled locally through remotes.  Bob,
for example, might have an origin for the "main" meta-repo and one for Jill's
fork.  The following diagram indicates that Bob has added Jill's fork under the
origin named "jill", and has pointed his checked-out `master` branch at the
same commit as her `master` branch: `j2`.

```
'-------------`
| meta-repo   |
| - - - - - - |
| origin      |
|   master    |
|    [m1]     |
| jill        |
|   master    |
|    [j2->m1] |
| - - - - - - |
| *master     |
|   [j2]      |
`-------------,
```

If Bob attempts to open the submodule `a` in the normal manner, he will get an
error such as:

```bash
$ cd meta
$ git submodule update --init a
fatal: reference is not a tree: j2
Unable to checkout 'j2' in submodule path
'a'
```

This error happens because the default behavior of `submodule update --init` is
to fetch refs from the url with which that submodule was created: there can be
only one such origin.  As will be seen later, working effectively with
submodules requires much tooling support, so we can easily add our own `open`
operation that will configure submodules with all known origins (and fetch them
all), e.g.:

```bash
$ git meta open a
```

```
'----------------------------`
| meta-repo   | a            |
| - - - - - - | - - - - - - -|
| origin      | origin       |
|   master    |  master      |
|    [m1]     |   [a1]       |
| jill        | jill         |
|   master    |  master      |
|    [j2->m1] |   [ja2->a1]  |
| - - - - - - | - - - - - -  |
| *master     | *master      |
|   [j2]      |   [ja2]      |
`----------------------------,
```

We would also need to add our own versions of commands for, e.g., adding,
removing, and fetching remotes that would add, remove, and fetch the same
remotes in open sub-repos.  Unfortunately, besides being complex, this solution
has serious drawbacks:

- Users may reasonably desire to manipulate remotes using straight Git,
  bypassing our tools, invalidating our invariants, and creating difficult to
  diagnose and repair situations.
- Developers will naturally add remotes for the forks of other developers that
  they collaborate with.  The requirement to fetch every remote in every
  sub-repo (even if done in parallel) could cause performance problems.
- Even using our tools as designed, developers may easily create invalid,
  difficult-to-recover-from situations.  For example, if a developer makes a
  local branch from a remote branch, then removes the remote from which that
  branch came, they may not be able to find the needed commits when opening
  sub-repos:

```
'-------------`
| meta-repo   |
| - - - - - - |
| origin      |
|   master    |
|    [m1]     |
| jill        |
|   master    |
|    [j2->m1] |
| - - - - - - |
| *master     |
|   [j2]      |
`-------------,
```

```bash
$ git meta remote rm jill
```

```
'-------------`
| meta-repo   |
| - - - - - - |
| origin      |
|   master    |
|    [m1]     |
| - - - - - - |
| *master     |
|   [j2]      |
`-------------,
```

Now even `git meta open` will be unable to initialize the submodule `a` because
Bob's `master` branch references a commit in it that cannot be found; we no
longer have any knowledge that Jill's fork exists.

## Conclusions

1. It is not generally possible to synchronize or validate updates to a ref
   with the same name across many repositories.  Therefore, we treat ref names
   in only meta-repos as significant; git-meta does not push branches or tags
   in sub-repos.
1. We use symbolic-meta-refs as push-targets in sub-repos; as the contents of a
   symbolic-meta-ref are immutable (a given symbolic-meta-ref can point to only
   one commit), we are always guaranteed to be able to update them when needed.
1. Forking sub-repos is potentially expensive, an probably impractical on the
   server-side, and creates many complications on the client-side.  Therefore,
   we allow forking of only meta-repos; each sub-repo has a single namespace
   for the entire mono-repo.
1. However, since git-meta does not push branch or tag names to sub-repos, and
   synthetic-meta-branches are plain refs that must be explicitly fetched,
   there will not be a problem with name-explosion in sub-repos.

# Performance

At a minimum, users working in a mono-repo must download the meta-repo and all
sub-repos containing code that they require to work.

There is a commit in the meta-repo for every change made in the organization,
so the number of commits in the history of the meta-repo may be very large.
However, the information contained in each commit is relatively small,
generally indicating only changes to submodule pointers (shallow cloning could
be used to further improve performance).  Furthermore, the on-disk (checked
out) rendering of the meta-repo is also small, being only a file indicating the
state of each sub-repo, and growing only as sub-repos are added.  Therefore,
the cost of cloning and checking out a meta-repo will be relatively cheap, and
scale slowly with the addition of new code -- especially compared with the cost
of doing the same operations in a single (physical) repository.

Most other operations such as `checkout`, `commit`, `merge`, `status`, etc.
increase in cost with the number of files in open repositories on disk.
Therefore, the performance of a mono-repo will generally be determined by how
many files developers need to have on disk to do their work; this number can be
minimized through several strategies:

- decomposing large large sub-repos into multiple sub-repos as they become
  overly large
- minimizing dependencies -- if an organization's software is a giant
  interdependent ball, its developers may need most of its code on disk to work
- eliminate the need to open dependent sub-repos -- typically, a developer
  needs to open sub-repos that the need to (a) change, or (b) are build
  dependencies of sub-repos they need to change.  While outside the scope of
  git-meta, we are developing a proposal to address this case and will link to
  it here when ready.

# Tools

We provide three types of tools:

1. the `git-meta` plugin to simplify client-side operations such as
   cross-repository merges
2. push validation tools to preserve mono-repo invariants
3. maintenance scripts

## The git-meta plugin

## Push validation

## Maintenance
