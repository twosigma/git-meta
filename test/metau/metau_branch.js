/*
 * Copyright (c) 2016, Two Sigma Open Source
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
const co 	  = require("co");

const Branch  		= require("../../lib/metau/metau_branch");
const GitUtil 		= require("../../lib/metau/metau_gitutil");
const Include 		= require("../../lib/metau/metau_include");
const SubmoduleUtil	= require("../../lib/metau/metau_submoduleutil");
const TestUtil 		= require("../../lib/metau/metau_testutil");
const UserError 	= require("../../lib/metau/metau_usererror");

describe("metau_branch", function () {

	describe("createBranch", function () {

		describe("when the branch does not exist in meta or sub-repos", 
			function () {
			
			after(TestUtil.cleanup);

			it("should pass", co.wrap(function *() {

				const repo = yield TestUtil.createSimpleRepository();

				const subrepo = yield TestUtil.createSimpleRepository();
				const path = "subrepo";
				yield Include.include(repo, subrepo.workdir(), path);

				// Create the branches

				const branchName = "branch";
				yield Branch.createBranch(repo, branchName, false);

				// Confirm meta repo has the new branch

				const metaBranch = yield GitUtil.findBranch(repo, branchName);
				assert.equal(branchName, metaBranch.shorthand());

				// Confirm the sub repo has the new branch

				const subBranch = yield GitUtil.findBranch(repo, branchName);
				assert.equal(branchName, subBranch.shorthand());
			}));
		});

		describe("when the branch does exist in a meta-repo", function () {
			after(TestUtil.cleanup);

			let repo, branchName;
			beforeEach(co.wrap(function *() {

				// Create a repository with a sub-repo

				repo = yield TestUtil.createSimpleRepository();
				const subrepo = yield TestUtil.createSimpleRepository();
				const path = "subrepo";
				yield Include.include(repo, subrepo.workdir(), path);

				// Create a branch in meta-repo

				branchName = "branch";
				yield GitUtil.createBranchFromHead(repo, branchName);
			}));

			it("should fail", co.wrap(function *() {

				// Attempt to create branch and ensure error was thrown

				try {
					yield Branch.createBranch(repo, branchName, false);
					assert(false, "didn't throw error");
				}
				catch (e) {
					assert.instanceOf(e, UserError);
				}

				// Confirm the sub-repo does not have the branch

				const submodules = yield SubmoduleUtil.getSubmoduleRepos(repo);
				const subBranch = 
					yield GitUtil.findBranch(submodules[0].repo, branchName);
				assert.equal(null, subBranch);

			}));

			it("should create the branch in sub-repos with --any", 
				co.wrap(function *() {

				// Attempt to create branch using git-meta and ensure
				// error was thrown

				yield Branch.createBranch(repo, branchName, true);

				// Confirm the sub-repo has the branch

				const submodules = yield SubmoduleUtil.getSubmoduleRepos(repo);
				const subBranch = 
					yield GitUtil.findBranch(submodules[0].repo, branchName);
				assert.equal(branchName, subBranch.shorthand());
			}));
		});
		
		describe("when the branch does exist in a sub-repo", function () {
			after(TestUtil.cleanup);

			let repo, branchName;
			beforeEach(co.wrap(function *() {

				// Create a repository with two sub-repos

				repo = yield TestUtil.createSimpleRepository();
				const subrepo = yield TestUtil.createSimpleRepository(),
					  subrepo2 = yield TestUtil.createSimpleRepository();
				const path = "subrepo",
					  path2 = "subrepo2";
				yield Include.include(repo, subrepo.workdir(), path);
				yield Include.include(repo, subrepo2.workdir(), path2);

				// Create a branch in the first sub-repo

				const submodules = yield SubmoduleUtil.getSubmoduleRepos(repo);
				const firstSubRepo = submodules[0].repo;
				branchName = "branch";
				yield GitUtil.createBranchFromHead(firstSubRepo, branchName);
			}));

			it("should fail", co.wrap(function *() {

				// Attempt to create branch and ensure error was thrown

				try {
					yield Branch.createBranch(repo, branchName, false);
					assert(false, "didn't throw error");
				}
				catch (e) {
					assert.instanceOf(e, UserError);
				}

				// Confirm meta-repo does not have the new branch

				const metaBranch = yield GitUtil.findBranch(repo, branchName);
				assert.equal(null, metaBranch);

				const submodules = yield SubmoduleUtil.getSubmoduleRepos(repo);
				const firstSubRepo = submodules[0].repo;
				const secondSubRepo = submodules[1].repo;

				// Confirm the first sub-repo still has the new branch

				const subBranch = 
					yield GitUtil.findBranch(firstSubRepo, branchName);
				assert.equal(branchName, subBranch.shorthand());

				// Confirm the second sub-repo does not have the new branch

				const subBranch2 = 
					yield GitUtil.findBranch(secondSubRepo, branchName);
				assert.equal(null, subBranch2);

			}));

			it("should create the branches in each repository with --any", 
				co.wrap(function *() {

				yield Branch.createBranch(repo, branchName, true);

				// Confirm meta-repo has the new branch

				const metaBranch = yield GitUtil.findBranch(repo, branchName);
				assert.equal(branchName, metaBranch.shorthand());

				const submodules = yield SubmoduleUtil.getSubmoduleRepos(repo);
				const firstSubRepo = submodules[0].repo;
				const secondSubRepo = submodules[1].repo;

				// Confirm the first sub-repo still has the new branch

				const subBranch = 
					yield GitUtil.findBranch(firstSubRepo, branchName);
				assert.equal(branchName, subBranch.shorthand());

				// Confirm the second sub-repo has the new branch

				const subBranch2 = 
					yield GitUtil.findBranch(secondSubRepo, branchName);
				assert.equal(branchName, subBranch2.shorthand());
			}));
		});
	});

	describe("deleteBranch", function () {

		describe("when the branch exists in meta-repo and all sub-repos", 
			function () {
			
			after(TestUtil.cleanup);

			let repo, branchName;
			beforeEach(co.wrap(function *() {
				// Create a repository with two sub-repos

				repo = yield TestUtil.createSimpleRepository();
				const subrepo = yield TestUtil.createSimpleRepository(),
					  subrepo2 = yield TestUtil.createSimpleRepository();
				const path = "subrepo",
					  path2 = "subrepo2";
				yield Include.include(repo, subrepo.workdir(), path);
				yield Include.include(repo, subrepo2.workdir(), path2);

				// Create a branch in the meta-repo

				branchName = "branch";
				yield GitUtil.createBranchFromHead(repo, branchName);

				// Create the branch in each of the sub-repos

				const submodules = yield SubmoduleUtil.getSubmoduleRepos(repo);
				yield submodules.map(
					sub => GitUtil.createBranchFromHead(sub.repo, branchName)
				);
			}));

			it("should pass", co.wrap(function *() {

				yield Branch.deleteBranch(repo, branchName, false);

				// Confirm meta-repo does not have the branch

				const metaBranch = yield GitUtil.findBranch(repo, branchName);
				assert.equal(null, metaBranch);

				// Confirm each sub-repo does not have the branch

				const submodules = yield SubmoduleUtil.getSubmoduleRepos(repo);
				const subBranches = yield submodules.map(
					sub => GitUtil.findBranch(sub.repo, branchName)
				);
				for (const i in subBranches) {
					assert.equal(null, subBranches[i]);
				}
			}));

			it("should fail if it is the active branch", co.wrap(function *() {
				// Set branch as active branch

				const metaBranch = yield GitUtil.findBranch(repo, branchName);
				yield repo.setHead(metaBranch.name());

				// Attempt to delete the branch

				try {
					yield Branch.deleteBranch(repo, branchName, false);
					assert(false, "didn't throw error");
				}
				catch (e) {
					assert.instanceOf(e, UserError);
				}

				// Confirm meta-repo still has the branch

				assert.equal(branchName, metaBranch.shorthand());

				// Confirm each sub-repo has the branch

				const submodules = yield SubmoduleUtil.getSubmoduleRepos(repo);
				const subBranches = yield submodules.map(
					sub => GitUtil.findBranch(sub.repo, branchName)
				);
				for (const i in subBranches) {
					assert.equal(branchName, subBranches[i].shorthand());
				}
			}));
		});

		describe("when the branch does not exist in meta-repo", function () {
			after(TestUtil.cleanup);

			let repo, branchName;
			beforeEach(co.wrap(function *() {
				// Create a repository with two sub-repos

				repo = yield TestUtil.createSimpleRepository();
				const subrepo = yield TestUtil.createSimpleRepository(),
					  subrepo2 = yield TestUtil.createSimpleRepository();
				const path = "subrepo",
					  path2 = "subrepo2";
				yield Include.include(repo, subrepo.workdir(), path);
				yield Include.include(repo, subrepo2.workdir(), path2);

				// Create the branch in each of the sub-repos

				branchName = "branch";
				const submodules = yield SubmoduleUtil.getSubmoduleRepos(repo);
				yield submodules.map(
					sub => GitUtil.createBranchFromHead(sub.repo, branchName)
				);
			}));

			it("should fail", co.wrap(function *() {
				try {
					yield Branch.deleteBranch(repo, branchName, false);
					assert(false, "didn't throw error");
				}
				catch (e) {
					assert.instanceOf(e, UserError);
				}

				// Confirm each sub-repo still has the branch

				const submodules = yield SubmoduleUtil.getSubmoduleRepos(repo);
				const subBranches = yield submodules.map(
					sub => GitUtil.findBranch(sub.repo, branchName)
				);
				for (const i in subBranches) {
					assert.equal(branchName, subBranches[i].shorthand());
				}
			}));

			it("should delete the sub-repo branches with --any", 
				co.wrap(function *() {

				yield Branch.deleteBranch(repo, branchName, true);

				// Confirm each sub-repo does not have the branch

				const submodules = yield SubmoduleUtil.getSubmoduleRepos(repo);
				const subBranches = yield submodules.map(
					sub => GitUtil.findBranch(sub.repo, branchName)
				);
				for (const i in subBranches) {
					assert.equal(null, subBranches[i]);
				}
			}));
		});

		describe("when the branch does not exist in sub-repo", function () {
			after(TestUtil.cleanup);

			let repo, branchName;
			beforeEach(co.wrap(function *() {
				// Create a repository with two sub-repos

				repo = yield TestUtil.createSimpleRepository();
				const subrepo = yield TestUtil.createSimpleRepository(),
					  subrepo2 = yield TestUtil.createSimpleRepository();
				const path = "subrepo",
					  path2 = "subrepo2";
				yield Include.include(repo, subrepo.workdir(), path);
				yield Include.include(repo, subrepo2.workdir(), path2);

				// Create a branch in the meta-repo

				branchName = "branch";
				yield GitUtil.createBranchFromHead(repo, branchName);
			}));

			it("should fail", co.wrap(function *() {
				try {
					yield Branch.deleteBranch(repo, branchName, false);
					assert(false, "didn't throw error");
				}
				catch (e) {
					assert.instanceOf(e, UserError);
				}

				// Confirm meta-repo still does have the branch

				const metaBranch = yield GitUtil.findBranch(repo, branchName);
				assert.equal(branchName, metaBranch.shorthand());
			}));

			it("should delete the meta-repo branch with --any", 
				co.wrap(function *() {
					
				yield Branch.deleteBranch(repo, branchName, true);

				// Confirm meta-repo does not have the branch

				const metaBranch = yield GitUtil.findBranch(repo, branchName);
				assert.equal(null, metaBranch);
			}));
		});
	});
});
