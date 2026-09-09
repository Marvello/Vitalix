fastlane documentation
----

# Installation

Make sure you have the latest version of the Xcode command line tools installed:

```sh
xcode-select --install
```

For _fastlane_ installation instructions, see [Installing _fastlane_](https://docs.fastlane.tools/#installing-fastlane)

# Available Actions

## Android

### android test

```sh
[bundle exec] fastlane android test
```

Runs all the tests

### android beta

```sh
[bundle exec] fastlane android beta
```

Submit a new Beta Build to Zealot. Bumps the beta version in version.properties (versionCode +1, versionName per bump:major|minor|patch, default patch), builds assembleBetaRelease, uploads to Zealot, then commits the version bump. Example: fastlane android beta bump:minor

### android production

```sh
[bundle exec] fastlane android production
```

Deploy a new production version to Zealot. Bumps the production version in version.properties (versionCode +1, versionName per bump:major|minor|patch, default patch), builds assembleProductionRelease, uploads to Zealot, then commits the version bump. Example: fastlane android production bump:major

----

This README.md is auto-generated and will be re-generated every time [_fastlane_](https://fastlane.tools) is run.

More information about _fastlane_ can be found on [fastlane.tools](https://fastlane.tools).

The documentation of _fastlane_ can be found on [docs.fastlane.tools](https://docs.fastlane.tools).
