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

<p align="center">
<img src="/doc/git-meta-logo.png" width="600">
</p>

[![Build Status](https://travis-ci.org/twosigma/git-meta.svg?branch=master)](https://travis-ci.org/twosigma/git-meta)

# What is git-meta?

Git-meta allows developers to work with extremely large codebases --
performance only degrades very slowly when physical size, number of
files, number of contributors increases, or the depth of history grows.
You can use granular ACLs with git-meta to help refine the scope of work.
Users only need to clone the subsets of the code that they need, yet they
can still make atomic commits across the entire codebase.  Development and
collaboration are done mostly using normal Git commands; we provide a Git
plug-in for ease-of-use.

## A little more detail

Git-meta both describes an architecture and provides a set of tools to
facilitate the implementation of a *mono-repo* and attendant workflows.  Aside
from the ability to install the tools provided in this repository, git-meta
requires only Git.  Git-meta is not tied to any specific Git hosting solution,
and does not provide operations that are hosting-solution-specific, such as the
ability to create new (server-side) repositories.

A detailed description of the architecture of Git-meta is provided in
[doc/architecture.md](doc/architecture.md).

# Getting Started

## Installation

To install the git-meta plugin:

```bash
$ git clone https://github.com/twosigma/git-meta.git
$ cd git-meta/node
$ npm install -g
```

## Quick Start / Basic Usage

### Clone

Clone your organization's meta-repository as you normally would with Git:

```bash
$ git clone http://example.com/my-meta-repo.git meta
$ cd meta
````

At this point, your working directory is likely full of empty directories where
sub-repos are mounted.  Open the one(s) you're interested in working on and
create out a feature branch to work on:

```bash
$ git meta open my-repo
$ git meta checkout -b my-feature
```

Now, change a file:

```bash
$ cd my-repo
$ echo "new work" >> some-file
```

Make a commit:

```bash
$ git meta commit -a -m "I made a change."
```

And push your change back upstream:

```bash
$ git meta push origin my-feature
```

# Documentation

## User Guide

Run `git meta --help` to see information about git-meta commands, or see the
user guide at [doc/user-guide.md](doc/user-guide.md) for more information.

## Administration

To learn how to set up and maintain a mono-repo using git-meta, please see:
[doc/administration.md](doc/administration.md).

## Architecture

A detailed description of the architecture of Git meta is provided in
[doc/architecture.md](doc/architecture.md).

