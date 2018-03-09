/*
 * Copyright (c) 2018, Two Sigma Open Source
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * * Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * * Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * * Neither the name of git-meta nor the names of its
 *   contributors may be used to endorse or promote products derived from
 *   this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */
"use strict";
const assert  = require("chai").assert;
const co      = require("co");
const NodeGit = require("nodegit");

/**
 * @class ConflictEntry
 * This class represents a part of a conflict.
 */
class ConflictEntry {
    /**
     * @constructor
     * Create a new `ConflictEntry` having the specified `mode` and `id`.
     *
     * @param {Number} mode
     * @param {String} id
     */
    constructor(mode, id) {
        assert.isNumber(mode);
        assert.isString(id);
        this.d_mode = mode;
        this.d_id = id;
        Object.freeze(this);
    }

    /**
     * @property {Number} mode
     * the type of entry to create, determining if it is a file, commit, etc.
     */
    get mode() {
        return this.d_mode;
    }

    /**
     * @property {String} id
     * the id of the entry to create, e.g., commit SHA or blob hash
     */
    get id() {
        return this.d_id;
    }
}

exports.ConflictEntry = ConflictEntry;

/**
 * @class Conflict
 * This class represents a conflict in its three parts.
 */
class Conflict {
    constructor(ancestor, our, their) {
        if (null !== ancestor) {
            assert.instanceOf(ancestor, ConflictEntry);
        }
        if (null !== our) {
            assert.instanceOf(our, ConflictEntry);
        }
        if (null !== their) {
            assert.instanceOf(their, ConflictEntry);
        }
        this.d_ancestor = ancestor;
        this.d_our = our;
        this.d_their = their;
        Object.freeze(this);
    }

    get ancestor() {
        return this.d_ancestor;
    }

    get our() {
        return this.d_our;
    }

    get their() {
        return this.d_their;
    }
}

exports.Conflict = Conflict;

/**
 * Create the specified `conflict` in the specified `index` at the specified
 * `path`.  Note that this method does not flush the index to disk.
 *
 * @param {NodeGit.Index} index
 * @param {String}        path
 * @param {Conflict}      conflict
 */
exports.addConflict = co.wrap(function *(index, path, conflict) {
    assert.instanceOf(index, NodeGit.Index);
    assert.isString(path);
    assert.instanceOf(conflict, Conflict);

    function makeEntry(entry) {
        if (null === entry) {
            return null;                                              // RETURN
        }
        const result = new NodeGit.IndexEntry();
        result.path = path;
        result.mode = entry.mode;
        result.id = NodeGit.Oid.fromString(entry.id);
        return result;
    }

    const ancestorEntry = makeEntry(conflict.ancestor);
    const ourEntry = makeEntry(conflict.our);
    const theirEntry = makeEntry(conflict.their);
    yield index.conflictAdd(ancestorEntry, ourEntry, theirEntry);
});
