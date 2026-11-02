param([string]$BindAddress = '127.0.0.1', [int]$Port = 8787)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:PHEME_BIND = $BindAddress
$env:PHEME_PORT = "$Port"
node (Join-Path $PSScriptRoot 'dist/broker.js')
