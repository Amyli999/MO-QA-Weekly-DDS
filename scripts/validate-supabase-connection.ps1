$ErrorActionPreference = 'Stop'

$configPath = Join-Path $PSScriptRoot '..\cloud-config.js'
if (-not (Test-Path $configPath)) {
    throw "cloud-config.js not found at $configPath"
}

$configText = Get-Content -Path $configPath -Raw
$baseUrlMatch = [regex]::Match($configText, "baseUrl:\s*'([^']+)'")
$anonKeyMatch = [regex]::Match($configText, "anonKey:\s*'([^']+)'")
$requireAuthMatch = [regex]::Match($configText, "requireAuth:\s*(true|false)")

if (-not $baseUrlMatch.Success -or -not $anonKeyMatch.Success) {
    throw 'Failed to parse Supabase baseUrl or anonKey from cloud-config.js'
}

$baseUrl = $baseUrlMatch.Groups[1].Value.TrimEnd('/')
$anonKey = $anonKeyMatch.Groups[1].Value
$requireAuth = $requireAuthMatch.Success -and $requireAuthMatch.Groups[1].Value -eq 'true'

function Test-SupabaseEndpoint {
    param(
        [string]$Name,
        [string]$Url,
        [hashtable]$Headers
    )

    try {
        $response = Invoke-WebRequest -Uri $Url -Headers $Headers -Method Get -UseBasicParsing
        [pscustomobject]@{
            Endpoint = $Name
            Url = $Url
            Status = [int]$response.StatusCode
            Reachable = $true
            Expected = if ($requireAuth) { '200 or 401' } else { '200' }
            Notes = 'HTTP request completed successfully.'
        }
    } catch {
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
            [pscustomobject]@{
                Endpoint = $Name
                Url = $Url
                Status = $statusCode
                Reachable = $true
                Expected = if ($requireAuth) { '200 or 401' } else { '200' }
                Notes = if ($statusCode -eq 401 -and $requireAuth) {
                    'Endpoint is reachable. 401 is expected here because the project requires an authenticated session.'
                } else {
                    $_.Exception.Message
                }
            }
        } else {
            [pscustomobject]@{
                Endpoint = $Name
                Url = $Url
                Status = $null
                Reachable = $false
                Expected = if ($requireAuth) { '200 or 401' } else { '200' }
                Notes = $_.Exception.Message
            }
        }
    }
}

$headers = @{
    apikey = $anonKey
    Authorization = "Bearer $anonKey"
}

$results = @(
    Test-SupabaseEndpoint -Name 'REST root' -Url "$baseUrl/rest/v1/" -Headers $headers
    Test-SupabaseEndpoint -Name 'Auth settings' -Url "$baseUrl/auth/v1/settings" -Headers @{}
)

Write-Output "Supabase baseUrl: $baseUrl"
Write-Output "requireAuth: $requireAuth"
$results | Format-Table -AutoSize | Out-String -Width 220