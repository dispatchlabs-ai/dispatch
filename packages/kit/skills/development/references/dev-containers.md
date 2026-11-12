# Dev Container guidance

Read this only when the target uses or requests Dev Containers. Use a standard repository-owned definition, normally `.devcontainer/devcontainer.json`; respect an existing supported location. Create a missing definition only when authorized, repair observed failures, and preserve a working setup rather than replacing it unnecessarily.

The project supplies its runtimes, locked dependencies, required services and setup/start commands. Harness-specific agent and inspection tools belong in reusable Dev Container Features, not a universal project image tied to one agent.

Build and start through standard Dev Container tooling. Verify project setup, the applicable build and a representative application or package use case inside the environment. Repair demonstrated failures and report concrete blockers or unverified paths; writing configuration alone does not establish readiness.

The runner controls isolation, mounts, networking and credential access; the definition alone is not a security boundary. Use development or synthetic data, keep secrets outside images and Git, and avoid dependencies on a particular person's home directory or machine configuration.
