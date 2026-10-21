# Native Windows operation

The runner works directly in Windows with Node.js and the built-in Windows
PowerShell 5.1. Applications use the same runner and credential APIs. The
[scaffold walkthrough](https://github.com/dispatchlabs-ai/agent-scaffold/blob/main/examples/dispatch/docs/setup.md)
uses `npm.cmd` in PowerShell so the normal script policy need not change.
Users do not configure ACLs, elevate a terminal, install a compiler or use WSL.

## Private files

`private-state.ts` selects the Windows bridge before opening SQLite. New
directories and the database are created with the current user's explicit owner
and protected DACL. Directories grant that user full control with object/container
inheritance, so newly created SQLite sidecars and status files stay private.
Existing database, sidecar and status paths are checked and repaired under the
runner's owner lock. Original file contents are retained.

The bridge opens the exact endpoint with `FILE_FLAG_OPEN_REPARSE_POINT`, checks
its type, link count, owner and local volume, writes its DACL through the handle,
and reads it back before succeeding. The handle excludes delete sharing while
these operations run. Its `MAXIMUM_ALLOWED` access prevents `SetSecurityInfo`
from propagating changes to unchecked existing descendants. Explicit extended
drive paths preserve long names without legacy .NET normalization; ambiguous
trailing-dot/space components are rejected. Local ACL-capable volumes such as
NTFS are required; network drives are rejected because SQLite WAL is local.

An elevated Windows process can create files owned by the Administrators group.
Such a file is adopted only if its DACL already grants full control exclusively
to this exact user. Other foreign owners are rejected. Privileged administrators,
same-account code, trusted ancestors and prior copies remain outside this
permission boundary. Application definitions and dependencies must be trusted.

Credential configuration uses the same private Windows ACLs. Saved source
metadata is checked before use; failed validation does not execute a helper or
select another credential source. Native values live in Windows Credential
Manager; see [credentials](credentials.md) for its separate boundary.

## Built-in bridge

The package includes its reviewed PowerShell sources under `native/`. Node starts
the system executable directly, without a profile or command shell. The process
uses its own execution policy; no user/machine policy is changed. The built-in
.NET compiler loads fixed API declarations, not project-controlled source.
Credential values use stdin and captured stdout; native errors are withheld.
An enterprise policy that disables the required Windows features is still
respected and produces an error rather than unprotected storage.

The implementation follows Microsoft's contracts for
[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew),
[CreateDirectoryW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createdirectoryw),
[SetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo)
and [Credential Manager](https://learn.microsoft.com/en-us/windows/win32/api/wincred/).
The [SQLite WAL documentation](https://www.sqlite.org/wal.html) describes its
local-filesystem requirement.

## Qualification

Platform observations are recorded with the published runner snapshot and the
scaffold changelog. A successful build alone does not qualify installation,
Credential Manager, private storage or interactive terminal behavior.
