param([Parameter(Mandatory = $true)][string]$Payload)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Use file handles for identity checks and ACL writes. An endpoint must never be
# followed as a junction/symlink or have another hard-link name changed with it.
# PowerShell 5.1 and its built-in .NET compiler are present on supported Windows.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class DispatchPrivatePaths {
    const uint MaximumAllowed = 0x02000000;
    const uint ShareReadWrite = 3;
    const uint OpenReparsePoint = 0x00200000;
    const uint BackupSemantics = 0x02000000;
    const uint DirectoryAttribute = 0x10;
    const uint ReparseAttribute = 0x400;
    const uint OwnerInformation = 1;
    const uint DaclInformation = 4;
    const uint ProtectedDacl = 0x80000000;
    const int FileAllAccess = 0x1f01ff;

    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes {
        public int Length;
        public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct FileInformation {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, AccessTime, WriteTime;
        public uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, ref SecurityAttributes security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CreateDirectoryW(string path, ref SecurityAttributes security);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);
    [DllImport("kernel32.dll")]
    static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    static extern uint SetSecurityInfo(SafeFileHandle handle, int type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr memory);

    static RawSecurityDescriptor ReadSecurity(SafeFileHandle handle) {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint result = GetSecurityInfo(handle, 1, OwnerInformation | DaclInformation, out owner, out group, out dacl, out sacl, out descriptor);
        if (result != 0) throw new Win32Exception((int)result);
        try {
            byte[] bytes = new byte[GetSecurityDescriptorLength(descriptor)];
            Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            return new RawSecurityDescriptor(bytes, 0);
        } finally { LocalFree(descriptor); }
    }

    static bool PrivateAcl(RawSecurityDescriptor security, SecurityIdentifier user, bool directory, bool protectedAcl) {
        if (security.DiscretionaryAcl == null || security.DiscretionaryAcl.Count != 1) return false;
        if (protectedAcl && (security.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0) return false;
        CommonAce ace = security.DiscretionaryAcl[0] as CommonAce;
        AceFlags inheritance = directory ? AceFlags.ObjectInherit | AceFlags.ContainerInherit : AceFlags.None;
        return ace != null && ace.AceQualifier == AceQualifier.AccessAllowed && !ace.IsCallback
            && ace.SecurityIdentifier.Equals(user) && ace.AccessMask == FileAllAccess
            && (ace.AceFlags & ~AceFlags.Inherited) == inheritance;
    }

    static void CreateParents(string path, ref SecurityAttributes security) {
        if (CreateDirectoryW(path, ref security)) return;
        int error = Marshal.GetLastWin32Error();
        if (error == 183) return;
        if (error != 3) throw new Win32Exception(error);
        int separator = path.LastIndexOf('\\');
        if (separator < 6 || path.Length <= 7) throw new IOException("Missing parent directory.");
        string parent = path.Substring(0, separator == 6 ? 7 : separator);
        CreateParents(parent, ref security);
        if (!CreateDirectoryW(path, ref security) && Marshal.GetLastWin32Error() != 183) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public static void Protect(string path, bool directory, bool create, bool verify) {
        if (path.StartsWith(@"\\?\")) path = path.Substring(4);
        path = path.Replace('/', '\\');
        // Win32 normalization and Node's extended paths must name the same
        // object. Do not silently trim a literal trailing dot/space component.
        foreach (string part in path.Split('\\', '/')) {
            if (part.EndsWith(".") || part.EndsWith(" ")) throw new IOException("Use ordinary Windows folder names.");
        }
        if (path.Length < 3 || !Char.IsLetter(path[0]) || path[1] != ':' || path[2] != '\\'
            || path.Substring(2).Contains(":")) throw new IOException("Use a local Windows drive.");
        if (path.Length > 3) path = path.TrimEnd('\\');
        // Node has already resolved the absolute path. Keep its exact spelling;
        // legacy .NET path normalization has different length/name semantics.
        path = @"\\?\" + path;
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
            SecurityIdentifier user = identity.User;
            RawSecurityDescriptor desired = new RawSecurityDescriptor("O:" + user.Value + "D:P(A;" + (directory ? "OICI" : "") + ";FA;;;" + user.Value + ")");
            byte[] descriptor = new byte[desired.BinaryLength];
            desired.GetBinaryForm(descriptor, 0);
            GCHandle pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
            try {
                SecurityAttributes security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = pinned.AddrOfPinnedObject() };
                if (directory && create) CreateParents(path, ref security);
                // MAXIMUM_ALLOWED intentionally prevents SetSecurityInfo from
                // propagating ACL changes to unvalidated existing descendants.
                // New files still inherit this directory's private ACL.
                using (SafeFileHandle handle = CreateFileW(path, MaximumAllowed, ShareReadWrite, ref security,
                    !directory && create ? 4u : 3u, OpenReparsePoint | BackupSemantics, IntPtr.Zero)) {
                    if (handle.IsInvalid) {
                        int error = Marshal.GetLastWin32Error();
                        if (!create && (error == 2 || error == 3)) return;
                        throw new Win32Exception(error);
                    }
                    FileInformation info;
                    if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    if (GetFileType(handle) != 1 || (info.Attributes & ReparseAttribute) != 0
                        || ((info.Attributes & DirectoryAttribute) != 0) != directory || (!directory && info.Links != 1))
                        throw new IOException("Expected an ordinary directory or single-link file.");
                    // Volume GUID names identify local volumes; SMB/mapped
                    // network drives cannot provide them (SQLite WAL is local).
                    StringBuilder finalPath = new StringBuilder(32768);
                    uint length = GetFinalPathNameByHandleW(handle, finalPath, (uint)finalPath.Capacity, 1);
                    if (length == 0 || length >= finalPath.Capacity || !finalPath.ToString().StartsWith(@"\\?\Volume{"))
                        throw new IOException("Use a local Windows volume.");
                    RawSecurityDescriptor previous = ReadSecurity(handle);
                    bool own = previous.Owner != null && previous.Owner.Equals(user);
                    if (verify) {
                        if (!own || !PrivateAcl(previous, user, directory, true)) throw new IOException("Expected private user-owned settings.");
                        return;
                    }
                    // Elevated programs may create files owned by their default
                    // Administrators token owner. Adopt only ones already private
                    // to this exact user, never arbitrary group-owned content.
                    if (!own && !(previous.Owner != null && previous.Owner.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid)
                        && PrivateAcl(previous, user, directory, false))) throw new IOException("The current user must own local state.");
                    byte[] acl = new byte[desired.DiscretionaryAcl.BinaryLength];
                    desired.DiscretionaryAcl.GetBinaryForm(acl, 0);
                    byte[] sid = new byte[user.BinaryLength];
                    user.GetBinaryForm(sid, 0);
                    GCHandle aclPin = GCHandle.Alloc(acl, GCHandleType.Pinned);
                    GCHandle sidPin = GCHandle.Alloc(sid, GCHandleType.Pinned);
                    try {
                        uint result = SetSecurityInfo(handle, 1, DaclInformation | ProtectedDacl | (own ? 0u : OwnerInformation),
                            own ? IntPtr.Zero : sidPin.AddrOfPinnedObject(), IntPtr.Zero, aclPin.AddrOfPinnedObject(), IntPtr.Zero);
                        if (result != 0) throw new Win32Exception((int)result);
                    } finally { sidPin.Free(); aclPin.Free(); }
                    RawSecurityDescriptor final = ReadSecurity(handle);
                    if (final.Owner == null || !final.Owner.Equals(user) || !PrivateAcl(final, user, directory, true))
                        throw new IOException("Private Windows permissions could not be verified.");
                }
            } finally { pinned.Free(); }
        }
    }
}
'@

$paths = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
foreach ($entry in $paths) {
    [DispatchPrivatePaths]::Protect($entry.path, [bool]$entry.directory, [bool]$entry.create, [bool]$entry.verify)
}
