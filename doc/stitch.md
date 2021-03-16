<!--
    Copyright (c) 2021, Two Sigma Open Source
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

The stitcher stitches a git-meta repository into a single unified
repository (perhaps leaving behind some submodules, depending on
configuration).

# Motivation

You might want this because you are migrating away from git-meta.  Or
you might just want a unified repo to power code search or code review
tooling.

There's also a destitched, which reverses the process.  Of course,
that's a little trickier: if you create a new subdirectory which
itself contains two subdirectories, how many sub*modules* do you
create?

# An implementation note

The most efficient repository layout that we have yet discovered for
stitching has three repositories:
1. just the meta objects
2. just the submodule objects
3. the stitched commits, which has objects/info/alternates pointed at
(1) and (2).

This makes fetches from the meta repo faster, without making other
fetches slower.

If you can managed to remove the alternates for meta commits during
pushes from the local unity repo to a remote one, that's even faster.

The configuration variable gitmeta.stitchSubmodulesRepository can hold
the path to the submodule-only repo; if it's present, the stitcher
assumes that the alternates configuration is set up correctly.

We have not yet considered the efficiency of destitching, and it does
not support this configuration variable.