Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue

$backendPids = (Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique
if ($backendPids) { Stop-Process -Id $backendPids -Force }


Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue
