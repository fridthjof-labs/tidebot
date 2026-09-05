# Changelog

## [0.4.2](https://github.com/fridthjof-labs/tidebot/compare/v0.4.1...v0.4.2) (2026-09-05)


### Bug Fixes

* make public Tidebot adoption reproducible ([#56](https://github.com/fridthjof-labs/tidebot/issues/56)) ([1f158e1](https://github.com/fridthjof-labs/tidebot/commit/1f158e12b41ae88161feca2103af4d5501e768ec))
* **plan:** mention the merged pull request's author on the apply comment ([#54](https://github.com/fridthjof-labs/tidebot/issues/54)) ([d8d5c85](https://github.com/fridthjof-labs/tidebot/commit/d8d5c85e97e96873d3fa23c74c230af609cac446))
* **tide:** stop treating mergeable_state=unstable as a merge blocker ([#55](https://github.com/fridthjof-labs/tidebot/issues/55)) ([6bfc0f4](https://github.com/fridthjof-labs/tidebot/commit/6bfc0f4da536526549858e609b42351b78cbb4a1))

## [0.4.1](https://github.com/fridthjof-labs/tidebot/compare/v0.4.0...v0.4.1) (2026-09-04)


### Bug Fixes

* **tide:** resolve pull requests from the head commit on workflow_run ([#52](https://github.com/fridthjof-labs/tidebot/issues/52)) ([cb07d77](https://github.com/fridthjof-labs/tidebot/commit/cb07d7744dceee7429eb75dc438375ab18eb8608))

## [0.4.0](https://github.com/fridthjof-labs/tidebot/compare/v0.3.0...v0.4.0) (2026-09-02)


### Features

* switch /rebase to signed rebase for this repository ([#47](https://github.com/fridthjof-labs/tidebot/issues/47)) ([cf13728](https://github.com/fridthjof-labs/tidebot/commit/cf13728cdfee37741f90617aa8a84cc1cabe46c5))


### Bug Fixes

* **cli:** report an installation's repository selection in app show ([#42](https://github.com/fridthjof-labs/tidebot/issues/42)) ([d32aba8](https://github.com/fridthjof-labs/tidebot/commit/d32aba8c4ac6dc60e48de8a6c8d13243b5871497))
* **rebase:** start the signed-rebase workflow with the bot's own token ([#48](https://github.com/fridthjof-labs/tidebot/issues/48)) ([4c19b09](https://github.com/fridthjof-labs/tidebot/commit/4c19b09bad9a9da62c5c826712c49e7cde0a1b9c))


### Documentation

* the signing account can be your own ([#49](https://github.com/fridthjof-labs/tidebot/issues/49)) ([56493b5](https://github.com/fridthjof-labs/tidebot/commit/56493b5430e5e0d8e9f0b7e1b27d4631cc8325f3))

## [0.3.0](https://github.com/fridthjof-labs/tidebot/compare/v0.2.1...v0.3.0) (2026-09-02)


### Features

* **cli:** register any GitHub App from a manifest file ([#33](https://github.com/fridthjof-labs/tidebot/issues/33)) ([c69e5db](https://github.com/fridthjof-labs/tidebot/commit/c69e5dbfe0f531a531e51757471ae7ac59b9b09e))


### Bug Fixes

* **cli:** omit hook_attributes for an App with no webhook ([#35](https://github.com/fridthjof-labs/tidebot/issues/35)) ([a65bcaf](https://github.com/fridthjof-labs/tidebot/commit/a65bcaf7a379f3332458870dd56cb73c676dbf36))
* **cli:** say the right thing after registering an App from a manifest ([#36](https://github.com/fridthjof-labs/tidebot/issues/36)) ([55c4522](https://github.com/fridthjof-labs/tidebot/commit/55c45227b6dff7938793b4491cf9ae17bd6fcf1a))

## [0.2.1](https://github.com/fridthjof-labs/tidebot/compare/v0.2.0...v0.2.1) (2026-09-01)


### Bug Fixes

* report a finished pull request, and the apply jobs left out ([#30](https://github.com/fridthjof-labs/tidebot/issues/30)) ([f7b0fcc](https://github.com/fridthjof-labs/tidebot/commit/f7b0fcc4939ae327ea80317e569a7ed2970b6518))

## [0.2.0](https://github.com/fridthjof-labs/tidebot/compare/v0.1.7...v0.2.0) (2026-09-01)


### Features

* rebuild the pull request status surfaces ([#27](https://github.com/fridthjof-labs/tidebot/issues/27)) ([e9bb733](https://github.com/fridthjof-labs/tidebot/commit/e9bb73394800e67a0080551f61e1722a8b234729))

## [0.1.7](https://github.com/fridthjof-labs/tidebot/compare/v0.1.6...v0.1.7) (2026-08-29)


### Bug Fixes

* **ci:** cut the release tag after a Tidebot merge ([#25](https://github.com/fridthjof-labs/tidebot/issues/25)) ([6fea7d8](https://github.com/fridthjof-labs/tidebot/commit/6fea7d8dcb1faf91fcc3201b538f31635c0be845))

## [0.1.6](https://github.com/fridthjof-labs/tidebot/compare/v0.1.5...v0.1.6) (2026-08-28)


### Bug Fixes

* verify collaborator permission for commands ([#23](https://github.com/fridthjof-labs/tidebot/issues/23)) ([1ce7a4f](https://github.com/fridthjof-labs/tidebot/commit/1ce7a4fd51a640d7a7d7179f6b0c2cc746e56901))

## [0.1.5](https://github.com/fridthjof-labs/tidebot/compare/v0.1.4...v0.1.5) (2026-08-28)


### Bug Fixes

* support canonical Actions and Worker runtimes ([#19](https://github.com/fridthjof-labs/tidebot/issues/19)) ([7353f45](https://github.com/fridthjof-labs/tidebot/commit/7353f45f6d4c32c84918e280523ccc3ab265ee28))

## [0.1.4](https://github.com/fridthjof-labs/tidebot/compare/v0.1.3...v0.1.4) (2026-08-28)


### Bug Fixes

* unblock generated pull requests ([#20](https://github.com/fridthjof-labs/tidebot/issues/20)) ([8bcacd1](https://github.com/fridthjof-labs/tidebot/commit/8bcacd18699758a11918c28d85a71ff7b719c55c))

## [0.1.3](https://github.com/fridthjof-labs/tidebot/compare/v0.1.2...v0.1.3) (2026-08-28)


### Bug Fixes

* recheck PRs after workflows ([#17](https://github.com/fridthjof-labs/tidebot/issues/17)) ([c7b0810](https://github.com/fridthjof-labs/tidebot/commit/c7b0810d8888affba551258761e4bf67c47be665))

## [0.1.2](https://github.com/fridthjof-labs/tidebot/compare/v0.1.1...v0.1.2) (2026-08-28)


### Bug Fixes

* ship the Actions runtime cleanly ([#14](https://github.com/fridthjof-labs/tidebot/issues/14)) ([923f4dc](https://github.com/fridthjof-labs/tidebot/commit/923f4dc999ea787c51af65dc106377e34e68f2a6))

## [0.1.1](https://github.com/fridthjof-labs/tidebot/compare/v0.1.0...v0.1.1) (2026-08-28)


### Bug Fixes

* accept plan workflow configuration ([#11](https://github.com/fridthjof-labs/tidebot/issues/11)) ([776f504](https://github.com/fridthjof-labs/tidebot/commit/776f504d032653924b36d3bd9f32ff2281cb1c5c))
* use API check-run names ([#12](https://github.com/fridthjof-labs/tidebot/issues/12)) ([efe3113](https://github.com/fridthjof-labs/tidebot/commit/efe311352b7fe19aa3abacc96c18d5f0733e99fc))


### Documentation

* expose public project links ([#9](https://github.com/fridthjof-labs/tidebot/issues/9)) ([3a85be4](https://github.com/fridthjof-labs/tidebot/commit/3a85be4e03de9b0e8a5bc3dd7cf85c42480f0c9c))
