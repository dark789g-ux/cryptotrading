param(
    [Parameter(Mandatory=$true)]
    [string]$Url,
    [string]$Selector,
    [int]$MaxLength = 50000
)

$ErrorActionPreference = "Stop"

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 30 -Headers @{
        "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        "Accept-Language" = "zh-CN,zh;q=0.9,en;q=0.8"
    }

    $html = $response.Content

    if ($Selector) {
        $pattern = "(?s)<$Selector\b[^>]*>.*?</$Selector>"
        $reMatches = [regex]::Matches($html, $pattern)
        if ($reMatches.Count -gt 0) {
            $parts = @()
            foreach ($m in $reMatches) { $parts += $m.Value }
            $html = $parts -join "`n"
        } else {
            Write-Host "WARNING: Selector '$Selector' not found, returning full page"
        }
    }

    $text = $html -replace "(?s)<script\b[^>]*>.*?</script>", ""
    $text = $text -replace "(?s)<style\b[^>]*>.*?</style>", ""
    $text = $text -replace "(?s)<!--.*?-->", ""
    $text = $text -replace "(?i)<br\s*/?>", "`n"
    $text = $text -replace "(?i)</p>", "`n"
    $text = $text -replace "(?i)</div>", "`n"
    $text = $text -replace "(?i)</li>", "`n"
    $text = $text -replace "(?i)</tr>", "`n"
    $text = $text -replace "(?i)</h[1-6]>", "`n"
    $text = $text -replace "(?i)<th[^>]*>", "`t"
    $text = $text -replace "(?i)<td[^>]*>", "`t"
    $text = $text -replace "<[^>]+>", ""
    $text = [System.Net.WebUtility]::HtmlDecode($text)
    $text = $text -replace "(\r?\n){3,}", "`n`n"
    $text = $text.Trim()

    if ($text.Length -gt $MaxLength) {
        $text = $text.Substring(0, $MaxLength) + "`n... [truncated, total $($text.Length) chars]"
    }

    Write-Output $text

} catch {
    Write-Error "Fetch failed: $($_.Exception.Message)"
    exit 1
}