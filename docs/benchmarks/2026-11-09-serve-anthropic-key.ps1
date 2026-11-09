[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$DpapiFile,
    [Parameter(Mandatory = $true)][string]$PipeName,
    [Parameter(Mandatory = $true)][string]$StopFile,
    [ValidateRange(10, 86400)][int]$MaxLifetimeSeconds = 3600,
    [ValidateRange(2, 64)][int]$Instances = 16
)

# Windows-only credential transport. The input is ConvertFrom-SecureString's
# default Windows DPAPI ciphertext, encoded as UTF-8 text. There is deliberately
# no plaintext input mode and no fallback credential file.
$ErrorActionPreference = 'Stop'
$stage = 'validate'
$service = $null
$secure = $null
$ready = $false
$exitCode = 1
$stopReason = 'startup-failed'
$startedAt = [DateTime]::UtcNow

try {
    if (-not $IsWindows) { throw 'windows_required' }
    if ($PipeName -notmatch '^klypix-benchmark-api-[A-Za-z0-9-]{16,96}$') { throw 'invalid_pipe_name' }
    if (-not [IO.Path]::IsPathFullyQualified($DpapiFile) -or -not [IO.Path]::IsPathFullyQualified($StopFile)) { throw 'absolute_paths_required' }
    if (-not [IO.File]::Exists($DpapiFile)) { throw 'encrypted_store_missing' }
    if ([IO.File]::Exists($StopFile)) { throw 'stop_file_already_exists' }

    $stage = 'compile'
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public sealed class KlypixApiKeyPipeService : IDisposable
{
    private readonly string name;
    private readonly int instances;
    private readonly SecurityIdentifier currentUser;
    private readonly byte[] payload;
    private readonly CancellationTokenSource stop = new CancellationTokenSource();
    private readonly ConcurrentDictionary<int, NamedPipeServerStream> active = new ConcurrentDictionary<int, NamedPipeServerStream>();
    private Task[] loops = Array.Empty<Task>();
    private int nextHandleId;
    private int stopped;
    private long connections;
    private long writesCompleted;
    private long clientDisconnects;
    private long aclChecks;
    private string fatalCode;

    public bool OwnerMatchesCurrentUser { get; private set; } = true;
    public bool OnlyCurrentUserAllowAces { get; private set; } = true;
    public bool CurrentUserHasFullControl { get; private set; } = true;
    public bool NoInheritedAllowAces { get; private set; } = true;
    public bool AllDaclsProtected { get; private set; } = true;
    public bool BuffersCleared { get; private set; }
    public long Connections => Interlocked.Read(ref connections);
    public long WritesCompleted => Interlocked.Read(ref writesCompleted);
    public long ClientDisconnects => Interlocked.Read(ref clientDisconnects);
    public long AclChecks => Interlocked.Read(ref aclChecks);
    public int ActiveInstances => active.Count;
    public int UnfinishedLoops => loops.Count(task => !task.IsCompleted);
    public string FatalCode => fatalCode;
    public bool IsComplete => loops.Length > 0 && loops.All(task => task.IsCompleted);

    public KlypixApiKeyPipeService(SecureString secret, string pipeName, int instanceCount)
    {
        name = pipeName;
        instances = instanceCount;
        currentUser = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("windows_user_unavailable");
        payload = BuildPayload(secret);
    }

    private static byte[] BuildPayload(SecureString secret)
    {
        IntPtr pointer = IntPtr.Zero;
        try {
            pointer = Marshal.SecureStringToBSTR(secret);
            int length = Marshal.ReadInt32(pointer, -4) / 2;
            if (length < 24 || length > 512) throw new InvalidOperationException("unsupported_api_key_shape");
            const string expectedPrefix = "sk-ant-";
            for (int index = 0; index < length; index++) {
                char value = (char)(ushort)Marshal.ReadInt16(pointer, index * 2);
                bool allowed = (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z')
                    || (value >= '0' && value <= '9') || value == '-' || value == '_';
                if (!allowed || (index < expectedPrefix.Length && value != expectedPrefix[index]))
                    throw new InvalidOperationException("unsupported_api_key_shape");
            }
            byte[] prefix = Encoding.ASCII.GetBytes("ANTHROPIC_API_KEY=");
            byte[] bytes = new byte[prefix.Length + length + 1];
            Buffer.BlockCopy(prefix, 0, bytes, 0, prefix.Length);
            for (int index = 0; index < length; index++) bytes[prefix.Length + index] = (byte)Marshal.ReadInt16(pointer, index * 2);
            bytes[bytes.Length - 1] = (byte)'\n';
            return bytes;
        } finally {
            if (pointer != IntPtr.Zero) Marshal.ZeroFreeBSTR(pointer);
        }
    }

    private NamedPipeServerStream CreatePipe()
    {
        var pipe = new NamedPipeServerStream(name, PipeDirection.Out, NamedPipeServerStream.MaxAllowedServerInstances,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        try {
            PipeSecurity security = PipesAclExtensions.GetAccessControl(pipe);
            bool ownerMatches = security.GetOwner(typeof(SecurityIdentifier)).Equals(currentUser);
            var rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<PipeAccessRule>().ToArray();
            var allow = rules.Where(rule => rule.AccessControlType == AccessControlType.Allow).ToArray();
            bool onlyCurrent = allow.Length == 1 && allow.All(rule => rule.IdentityReference.Equals(currentUser));
            bool fullControl = allow.Length == 1 && (allow[0].PipeAccessRights & PipeAccessRights.FullControl) == PipeAccessRights.FullControl;
            bool noInherited = allow.All(rule => !rule.IsInherited);
            if (!ownerMatches || !onlyCurrent || !fullControl || !noInherited)
                throw new InvalidOperationException("named_pipe_acl_verification_failed");
            OwnerMatchesCurrentUser &= ownerMatches;
            OnlyCurrentUserAllowAces &= onlyCurrent;
            CurrentUserHasFullControl &= fullControl;
            NoInheritedAllowAces &= noInherited;
            AllDaclsProtected &= security.AreAccessRulesProtected;
            Interlocked.Increment(ref aclChecks);
            return pipe;
        } catch {
            pipe.Dispose();
            throw;
        }
    }

    public void Start()
    {
        if (loops.Length != 0) throw new InvalidOperationException("service_already_started");
        var prepared = new List<NamedPipeServerStream>();
        try {
            // Construct and validate the whole waiting pool before reporting ready.
            for (int index = 0; index < instances; index++) prepared.Add(CreatePipe());
            loops = prepared.Select(pipe => RunLoop(pipe)).ToArray();
        } catch {
            foreach (var pipe in prepared) pipe.Dispose();
            Stop(5000);
            throw;
        }
    }

    private async Task RunLoop(NamedPipeServerStream first)
    {
        NamedPipeServerStream pipe = first;
        while (!stop.IsCancellationRequested) {
            int id = Interlocked.Increment(ref nextHandleId);
            active[id] = pipe;
            try {
                await pipe.WaitForConnectionAsync(stop.Token).ConfigureAwait(false);
                Interlocked.Increment(ref connections);
                // existsSync/stat clients may close without reading. A broken
                // connection is expected and never logs the payload or exception.
                await pipe.WriteAsync(payload.AsMemory(), stop.Token).ConfigureAwait(false);
                await pipe.FlushAsync(stop.Token).ConfigureAwait(false);
                Interlocked.Increment(ref writesCompleted);
            } catch (OperationCanceledException) when (stop.IsCancellationRequested) {
            } catch (ObjectDisposedException) when (stop.IsCancellationRequested) {
            } catch (IOException) {
                Interlocked.Increment(ref clientDisconnects);
            } catch {
                Interlocked.CompareExchange(ref fatalCode, "pipe_service_failed", null);
                stop.Cancel();
            } finally {
                active.TryRemove(id, out _);
                pipe.Dispose();
            }
            if (stop.IsCancellationRequested) break;
            try { pipe = CreatePipe(); }
            catch {
                Interlocked.CompareExchange(ref fatalCode, "pipe_instance_recreation_failed", null);
                stop.Cancel();
                break;
            }
        }
        pipe.Dispose();
    }

    public void Stop(int timeoutMilliseconds)
    {
        if (Interlocked.Exchange(ref stopped, 1) != 0) return;
        stop.Cancel();
        foreach (var pipe in active.Values) pipe.Dispose();
        try { Task.WhenAll(loops).Wait(timeoutMilliseconds); } catch { }
        Array.Clear(payload, 0, payload.Length);
        BuffersCleared = true;
    }

    public void Dispose() { Stop(5000); }
}
'@ -ErrorAction Stop

    $stage = 'decrypt'
    $ciphertext = [IO.File]::ReadAllText($DpapiFile, [Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($ciphertext)) { throw 'encrypted_store_empty' }
    $secure = ConvertTo-SecureString -String $ciphertext.Trim() -ErrorAction Stop
    $ciphertext = $null
    try { $service = [KlypixApiKeyPipeService]::new($secure, $PipeName, $Instances) }
    finally { if ($null -ne $secure) { $secure.Dispose(); $secure = $null } }

    $stage = 'start'
    $service.Start()
    $ready = $true
    [ordered]@{
        type = 'ready'
        pipePath = '\\.\pipe\' + $PipeName
        pid = $PID
        currentUserOnly = $true
        instances = $Instances
        credentialFormat = 'Windows CurrentUser DPAPI ConvertFrom-SecureString text'
        payloadFormat = 'dotenv'
        plaintextCredentialFilesCreated = $false
        acl = [ordered]@{
            checkedInstances = $service.AclChecks
            ownerMatchesCurrentUser = $service.OwnerMatchesCurrentUser
            onlyCurrentUserAllowAces = $service.OnlyCurrentUserAllowAces
            currentUserHasFullControl = $service.CurrentUserHasFullControl
            noInheritedAllowAces = $service.NoInheritedAllowAces
            areAccessRulesProtected = $service.AllDaclsProtected
        }
        startedAt = $startedAt.ToString('o')
    } | ConvertTo-Json -Compress -Depth 5

    $stage = 'serve'
    $deadline = $startedAt.AddSeconds($MaxLifetimeSeconds)
    while (-not $service.IsComplete) {
        if ([IO.File]::Exists($StopFile)) { $stopReason = 'stop-file'; break }
        if ([DateTime]::UtcNow -ge $deadline) { $stopReason = 'max-lifetime'; break }
        Start-Sleep -Milliseconds 200
    }
    if ($service.IsComplete -and $stopReason -eq 'startup-failed') { $stopReason = 'service-ended' }
    $service.Stop(5000)
    if ($null -ne $service.FatalCode -or $service.UnfinishedLoops -gt 0 -or $service.ActiveInstances -gt 0) {
        $exitCode = 1
    } else { $exitCode = 0 }
} catch {
    # Do not emit exception text: parser/crypto errors must never echo an input.
    [ordered]@{ type = 'error'; stage = $stage; code = 'secure_pipe_helper_failed'; pid = $PID } | ConvertTo-Json -Compress
    $stopReason = 'error'
    $exitCode = 1
} finally {
    if ($null -ne $secure) { $secure.Dispose() }
    if ($null -ne $service) {
        $service.Stop(5000)
        [ordered]@{
            type = 'stopped'
            reason = $stopReason
            readyWasReported = $ready
            connections = $service.Connections
            writesCompleted = $service.WritesCompleted
            clientDisconnects = $service.ClientDisconnects
            aclChecks = $service.AclChecks
            activeInstances = $service.ActiveInstances
            unfinishedLoops = $service.UnfinishedLoops
            buffersCleared = $service.BuffersCleared
            fatalCode = $service.FatalCode
            elapsedMs = [math]::Round(([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
        } | ConvertTo-Json -Compress
        $service.Dispose()
    }
}
exit $exitCode
