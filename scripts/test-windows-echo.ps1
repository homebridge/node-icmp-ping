# Run the production fallback under a real standard-user token on a disposable
# GitHub Windows runner. Never accepts an elevated/raw-capable test as coverage.
$ErrorActionPreference = 'Stop'
$account = 'icmp_echo_ci'
$root = Join-Path $env:PUBLIC ('icmp-echo-' + [guid]::NewGuid().ToString('N'))
$password = 'Ic9!' + [guid]::NewGuid().ToString('N')
$created = $false
$process = $null
try {
    $build = & cargo test --locked --no-run --message-format=json
    if ($LASTEXITCODE -ne 0) { throw 'Native test build failed' }
    $executables = @($build | ForEach-Object {
        try { $entry = $_ | ConvertFrom-Json } catch { return }
        if ($entry.reason -eq 'compiler-artifact' -and $entry.profile.test -and $entry.executable) { $entry.executable }
    })
    if ($executables.Count -ne 1) { throw "Expected one native test executable, got $($executables.Count)" }
    New-Item -ItemType Directory -Path $root | Out-Null
    Copy-Item $executables[0] (Join-Path $root 'echo-tests.exe')
    New-LocalUser -Name $account -Password (ConvertTo-SecureString $password -AsPlainText -Force) -AccountNeverExpires | Out-Null
    $created = $true
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $account
    & icacls $root /grant "${account}:(OI)(CI)M" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not grant test directory access' }
    @'
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
try {
    whoami /all | Out-File identity.txt
    & .\echo-tests.exe windows::tests::windows_unprivileged_echo --ignored --exact --nocapture --test-threads=1 *> result.txt
    $code = $LASTEXITCODE
    if ($code -eq 0) {
        & .\echo-tests.exe windows::tests::real_handle_cleanup_on_api_error --exact --nocapture --test-threads=1 *>> result.txt
        $code = $LASTEXITCODE
    }
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'exit.txt'), [string]$code)
} catch {
    $_ | Out-File result.txt -Append
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'exit.txt'), '1')
}
'@ | Set-Content (Join-Path $root 'run.ps1')
    $credential = [PSCredential]::new("$env:COMPUTERNAME\$account", (ConvertTo-SecureString $password -AsPlainText -Force))
    $process = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -Credential $credential -LoadUserProfile -WorkingDirectory $root -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$root\run.ps1`"" -PassThru
    if (!$process.WaitForExit(180000)) { throw 'Standard-user test process exceeded three minutes' }
    Write-Host "Standard-user process exit: $($process.ExitCode)"
    if (Test-Path "$root\identity.txt") { Get-Content "$root\identity.txt" }
    if (Test-Path "$root\result.txt") { Get-Content "$root\result.txt" }
    if (!(Test-Path "$root\exit.txt")) { throw 'Standard-user integration test did not complete' }
    if ((Get-Content "$root\exit.txt").Trim() -ne '0') { throw 'Standard-user integration test failed' }
} finally {
    if ($process -and !$process.HasExited) { $process.Kill($true); $process.WaitForExit() }
    if ($created) { Remove-LocalUser -Name $account }
    if (Test-Path $root) { Remove-Item $root -Recurse -Force }
}
