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

const assert = require("chai").assert;

const SequencerState = require("../../lib/util/sequencer_state");

describe("SequencerState", function () {

const TYPE = SequencerState.TYPE;
const CommitAndRef = SequencerState.CommitAndRef;
    describe("CommitAndRef", function () {
        it("breath", function () {
            const withRef = new CommitAndRef("foo", "bar");
            assert.isFrozen(withRef);
            assert.equal(withRef.sha, "foo");
            assert.equal(withRef.ref, "bar");

            const noRef = new CommitAndRef("wee", null);
            assert.equal(noRef.sha, "wee");
            assert.isNull(noRef.ref);
        });
        describe("equal", function () {
            const cases = {
                "same": {
                    lhs: new CommitAndRef("a", "b"),
                    rhs: new CommitAndRef("a", "b"),
                    expected: true,
                },
                "diff sha": {
                    lhs: new CommitAndRef("a", "b"),
                    rhs: new CommitAndRef("b", "b"),
                    expected: false,
                },
                "diff ref": {
                    lhs: new CommitAndRef("a", null),
                    rhs: new CommitAndRef("a", "b"),
                    expected: false,
                },
            };
            Object.keys(cases).forEach(caseName => {
                const c = cases[caseName];
                it(caseName, function () {
                    const result = c.lhs.equal(c.rhs);
                    assert.equal(result, c.expected);
                });
            });
        });
    });
    describe("toString", function () {
        it("with ref", function () {
            const input = new CommitAndRef("foo", "bar");
            const result = "" + input;
            assert.equal(result, "CommitAndRef(sha=foo, ref=bar)");
        });
        it("no ref", function () {
            const input = new CommitAndRef("foo", null);
            const result = "" + input;
            assert.equal(result, "CommitAndRef(sha=foo)");
        });
    });
    it("breathe", function () {
        const original = new CommitAndRef("a", "foo");
        const target = new CommitAndRef("c", "bar");
        const seq = new SequencerState({
            type: TYPE.MERGE,
            originalHead: original,
            target: target,
            commits: ["3"],
            currentCommit: 0,
            message: "meh",
        });
        assert.isFrozen(seq);
        assert.equal(seq.type, TYPE.MERGE);
        assert.deepEqual(seq.originalHead, original);
        assert.deepEqual(seq.target, target);
        assert.deepEqual(seq.commits, ["3"]);
        assert.equal(seq.currentCommit, 0);
        assert.equal(seq.message, "meh");
    });
    describe("equal", function () {
        const cnr0 = new CommitAndRef("a", "foo");
        const cnr1 = new CommitAndRef("b", "foo");
        const cases = {
            "same": {
                lhs: new SequencerState({
                    type: TYPE.MERGE,
                    originalHead: cnr0,
                    target: cnr1,
                    commits: ["1", "2", "3"],
                    currentCommit: 1,
                    message: "moo",
                }),
                rhs: new SequencerState({
                    type: TYPE.MERGE,
                    originalHead: cnr0,
                    target: cnr1,
                    commits: ["1", "2", "3"],
                    currentCommit: 1,
                    message: "moo",
                }),
                expected: true,
            },
            "different type": {
                lhs: new SequencerState({
                    type: TYPE.MERGE,
                    originalHead: cnr0,
                    target: cnr1,
                    commits: ["1", "2", "3"],
                    currentCommit: 1,
                }),
                rhs: new SequencerState({
                    type: TYPE.REBASE,
                    originalHead: cnr0,
                    target: cnr1,
                    commits: ["1", "2", "3"],
                    currentCommit: 1,
                }),
                expected: false,
            },
            "different original head": {
                lhs: new SequencerState({
                    type: TYPE.MERGE,
                    originalHead: cnr1,
                    target: cnr1,
                    commits: ["1", "2", "3"],
                    currentCommit: 1,
                }),
                rhs: new SequencerState({
                    type: TYPE.MERGE,
                    originalHead: cnr0,
                    target: cnr1,
                    commits: ["1", "2", "3"],
                    currentCommit: 1,
                }),
                expected: false,
            },
            "different target": {
                lhs: new SequencerState({
                    type: TYPE.MERGE,
                    originalHead: cnr0,
                    target: cnr1,
                    commits: ["1", "2", "3"],
                    currentCommit: 1,
                }),
                rhs: new SequencerState({
                    type: TYPE.MERGE,
                    originalHead: cnr0,
                    target: cnr0,
                    commits: ["1", "2", "3"],
                    currentCommit: 1,
                }),
                expected: false,
            },
            "different commits": {
                lhs: new SequencerState({
                    type: TYPE.MERGE,
                    originalHead: cnr0,
                    target: cnr1,
                    commits: ["1", "2", "3"],
                    currentCommit: 1,
                }),
                rhs: new SequencerState({
                    type: TYPE.MERGE,
                    originalHead: cnr0,
                    target: cnr1,
                    commits: ["3", "2", "1"],
                    currentCommit: 1,
                }),
                expected: false,
            },
            "different current commit": {
                lhs: new SequencerState({
                    type: TYPE.MERGE,
                    originalHead: cnr0,
                    target: cnr1,
                    commits: ["1", "2", "3"],
                    currentCommit: 0,
                }),
                rhs: new SequencerState({
                    type: TYPE.MERGE,
                    originalHead: cnr0,
                    target: cnr1,
                    commits: ["1", "2", "3"],
                    currentCommit: 1,
                }),
                expected: false,
            },
            "different message": {
                lhs: new SequencerState({
                    type: TYPE.MERGE,
                    originalHead: cnr0,
                    target: cnr1,
                    commits: ["1", "2", "3"],
                    currentCommit: 1,
                    message: "ooo",
                }),
                rhs: new SequencerState({
                    type: TYPE.MERGE,
                    originalHead: cnr0,
                    target: cnr1,
                    commits: ["1", "2", "3"],
                    currentCommit: 1,
                    message: "moo",
                }),
                expected: false,
            },
        };
        Object.keys(cases).forEach(caseName => {
            const c = cases[caseName];
            it(caseName, function () {
                const result = c.lhs.equal(c.rhs);
                assert.equal(result, c.expected);
            });
        });
    });
    it("copy", function () {
        const s0 = new SequencerState({
            type: TYPE.CHERRY_PICK,
            originalHead: new CommitAndRef("1", "2"),
            target: new CommitAndRef("a", "b"),
            currentCommit: 0,
            commits: ["a"],
            message: "yo",
        });
        const s1 = new SequencerState({
            type: TYPE.MERGE,
            originalHead: new CommitAndRef("u", "v"),
            target: new CommitAndRef("8", "8"),
            currentCommit: 1,
            commits: ["1", "3"],
            message: "there",
        });
        const defaults = s0.copy();
        assert.deepEqual(defaults, s0);
        const overridden = s0.copy({
            type: s1.type,
            originalHead: s1.originalHead,
            target: s1.target,
            commits: s1.commits,
            currentCommit: s1.currentCommit,
            message: s1.message,
        });
        assert.deepEqual(overridden, s1);
    });
    it("toString", function () {
        const input = new SequencerState({
            type: TYPE.REBASE,
            originalHead: new CommitAndRef("a", null),
            target: new CommitAndRef("b", null),
            commits: ["1"],
            currentCommit: 0,
            message: "meh",
        });
        const result = "" + input;
        assert.equal(result,
                     `\
SequencerState(type=REBASE, originalHead=CommitAndRef(sha=a), \
target=CommitAndRef(sha=b), commits=["1"], currentCommit=0, msg=meh)`);
    });
});
