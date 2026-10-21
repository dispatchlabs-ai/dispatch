$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8, $false)
    $writer = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $utf8)

    # Compile only fixed code, before reading the secret from the private pipe.
    # CREDENTIALW layout and API contract: https://learn.microsoft.com/windows/win32/api/wincred/
    Microsoft.PowerShell.Utility\Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class DispatchWindowsCredentials {
    const uint Generic = 1;
    const uint PersistLocalMachine = 2;
    const int NotFound = 1168;
    const int MaximumBlobBytes = 2560;
    static readonly Encoding BlobEncoding = new UnicodeEncoding(false, false, true);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Credential {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CredWriteW(ref Credential credential, uint flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CredDeleteW(string target, uint type, uint flags);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    static extern void CredFree(IntPtr credential);

    static void ValidateTarget(string target) {
        if (String.IsNullOrEmpty(target) || target.Length > 32767 || target.IndexOf('\0') >= 0)
            throw new ArgumentException("Invalid credential target.");
    }

    public static string Read(string target) {
        ValidateTarget(target);
        IntPtr pointer;
        if (!CredReadW(target, Generic, 0, out pointer)) {
            int error = Marshal.GetLastWin32Error();
            if (error == NotFound) return null;
            throw new Win32Exception(error);
        }
        try {
            Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            if (credential.CredentialBlobSize > MaximumBlobBytes || credential.CredentialBlobSize % 2 != 0)
                throw new InvalidOperationException("Invalid credential encoding.");
            byte[] blob = new byte[credential.CredentialBlobSize];
            try {
                if (blob.Length > 0) Marshal.Copy(credential.CredentialBlob, blob, 0, blob.Length);
                return BlobEncoding.GetString(blob);
            } finally {
                Array.Clear(blob, 0, blob.Length);
                if (blob.Length > 0) Marshal.Copy(blob, 0, credential.CredentialBlob, blob.Length);
            }
        } finally {
            CredFree(pointer);
        }
    }

    public static void Write(string target, string account, string value) {
        ValidateTarget(target);
        if (account == null || account.Length > 513 || account.IndexOf('\0') >= 0 || value == null)
            throw new ArgumentException("Invalid credential input.");
        byte[] blob = BlobEncoding.GetBytes(value);
        IntPtr pointer = IntPtr.Zero;
        try {
            if (blob.Length > MaximumBlobBytes) throw new ArgumentException("Credential value is too long.");
            pointer = Marshal.AllocCoTaskMem(blob.Length);
            if (blob.Length > 0) Marshal.Copy(blob, 0, pointer, blob.Length);
            Credential credential = new Credential {
                Type = Generic,
                TargetName = target,
                CredentialBlobSize = (uint)blob.Length,
                CredentialBlob = pointer,
                Persist = PersistLocalMachine,
                UserName = account
            };
            if (!CredWriteW(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally {
            Array.Clear(blob, 0, blob.Length);
            if (pointer != IntPtr.Zero) {
                if (blob.Length > 0) Marshal.Copy(blob, 0, pointer, blob.Length);
                Marshal.FreeCoTaskMem(pointer);
            }
        }
    }

    public static bool Delete(string target) {
        ValidateTarget(target);
        if (CredDeleteW(target, Generic, 0)) return true;
        int error = Marshal.GetLastWin32Error();
        if (error == NotFound) return false;
        throw new Win32Exception(error);
    }
}
'@

    $request = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject ($reader.ReadToEnd())
    $result = switch ($request.operation) {
        'read' { [DispatchWindowsCredentials]::Read($request.target) }
        'write' { [DispatchWindowsCredentials]::Write($request.target, $request.account, $request.value); $true }
        'delete' { [DispatchWindowsCredentials]::Delete($request.target) }
        default { throw 'Invalid credential operation.' }
    }
    # PowerShell 5.1 emits nothing for a null input, so encode missing entries explicitly.
    $json = if ($null -eq $result) { 'null' } else { Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $result -Compress }
    $writer.Write($json)
    $writer.Flush()
} catch {
    [Console]::Error.WriteLine('Windows Credential Manager operation failed.')
    exit 1
}
