# Upgrade an application

Dispatch is a normal application dependency. Select a new published package
version or immutable release archive, update the application's lockfile, and run
its build and relevant checks. For an application using only Runner:

```sh
npm install https://github.com/dispatchlabs-ai/dispatch/releases/download/v0.16.1/dispatch-runner-0.16.1.tgz
```

Commit the updated `package.json` and `package-lock.json`. For a later release,
substitute its version in the URL; installed library names and application imports
stay the same. Install matching optional channel packages together.

For Nix applications update the pinned Dispatch
input and build the resulting closure.

Stop the application's host through its existing supervisor. Preserve its state
with your normal backup procedure, then restart that host from the new application
build. Clients reconnect; they do not select versions, stop other processes or
launch replacement owners. Runtime updates do not edit agent definitions.

Use a single dependency tree per application. Check the selected release's Pi
version and storage compatibility before opening retained stores; do not point
an older runtime at state it cannot read. Deployment, backups and rollback belong
to the application operator. Dispatch supplies no machine upgrade or migration
machinery. Publishing source does not upgrade any running installation.
