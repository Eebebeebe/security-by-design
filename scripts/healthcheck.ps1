# Windows-Variante von scripts/healthcheck.sh.  Ausgabe HEALTHY / UNHEALTHY, Exit-Code 0 / 1.
#   .\scripts\healthcheck.ps1
#   .\scripts\healthcheck.ps1 -Url https://shop.example.org
param([string]$Url = $(if ($env:HEALTHCHECK_URL) { $env:HEALTHCHECK_URL } else { 'http://127.0.0.1:3000' }))
$Url = $Url.TrimEnd('/')

try {
    Invoke-WebRequest -Uri "$Url/healthz" -TimeoutSec 4 -UseBasicParsing | Out-Null
} catch {
    Write-Output "UNHEALTHY: Anwendung unter $Url nicht erreichbar (Prozess/Container läuft nicht oder Port falsch)"
    exit 1
}

# HttpClient statt Invoke-WebRequest: liefert den Body auch bei 503 zuverlässig (PS 5.1 und 7).
Add-Type -AssemblyName System.Net.Http
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromSeconds(4)
try {
    $res = $client.GetAsync("$Url/readyz").GetAwaiter().GetResult()
    $code = [int]$res.StatusCode
    $body = $res.Content.ReadAsStringAsync().GetAwaiter().GetResult()
} catch {
    Write-Output "UNHEALTHY: /readyz nicht abrufbar ($($_.Exception.Message))"
    exit 1
} finally {
    $client.Dispose()
}

$report = $null
try { $report = $body | ConvertFrom-Json } catch { }

if ($code -eq 200 -and $report.status -eq 'healthy') {
    Write-Output "HEALTHY: $body"
    exit 0
}
$reasons = @()
if ($report.checks.database -eq 'down') { $reasons += 'Datenbank nicht erreichbar' }
if ($report.checks.migrations -eq 'pending') { $reasons += 'Datenbankschema veraltet (Migrationen fehlen)' }
if ($reasons.Count -eq 0) { $reasons += "HTTP ${code}: $body" }
Write-Output ("UNHEALTHY: " + ($reasons -join '; '))
exit 1
