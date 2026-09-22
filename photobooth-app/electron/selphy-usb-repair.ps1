# PhotoBooth SELPHY CP1500 USB repair.
# Other devices (MI_01, USB class FF) is a vendor interface — not the printer.
# Printing uses MI_00 + usbprint.sys + USB00x. Windows 11 often overlays a broken
# Microsoft IPP Class Driver queue ("Driver error") and Protected Print Mode.
param(
  [ValidateSet('Probe', 'Repair', 'RegisterTask')]
  [string]$Action = 'Probe'
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$VidPid = 'VID_04A9&PID_3302'
$TaskName = 'PhotoBoothSelphyUsbRepair'
$UsbprintInf = 'C:\Windows\INF\usbprint.inf'
$QueueName = 'Canon SELPHY CP1500'

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 8
  [Console]::Out.WriteLine($json)
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-SelphyNodes {
  @(Get-PnpDevice | Where-Object {
      $_.InstanceId -match 'VID_04A9&PID_3302' -or
      ([string]$_.FriendlyName -match 'SELPHY')
    })
}

function Test-NodeLive($n) {
  if (-not $n) { return $false }
  if ($n.Present) { return $true }
  $st = [string]$n.Status
  $pb = [string]$n.Problem
  return ($st -eq 'Error' -or $st -eq 'OK' -or $pb -match 'FAILED_INSTALL')
}

function Get-UsbPrintPort {
  @(Get-PrinterPort | Where-Object { $_.Name -match '^USB\d+$' }) | Select-Object -First 1
}

function Disable-ProtectedPrintMode {
  $steps = New-Object System.Collections.Generic.List[string]
  $wpp = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Printers\WPP'
  New-Item -Path $wpp -Force | Out-Null
  New-ItemProperty -Path $wpp -Name 'WindowsProtectedPrintMode' -PropertyType DWord -Value 0 -Force | Out-Null
  New-ItemProperty -Path $wpp -Name 'EnabledBy' -PropertyType DWord -Value 0 -Force | Out-Null
  Remove-ItemProperty -Path $wpp -Name 'WindowsProtectedPrintGroupPolicyState' -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $wpp -Name 'WindowsProtectedPrintOobeConfigComplete' -ErrorAction SilentlyContinue
  $print = 'HKLM:\SYSTEM\CurrentControlSet\Control\Print'
  if (Test-Path $print) {
    New-ItemProperty -Path $print -Name 'WindowsProtectedPrintState' -PropertyType DWord -Value 0 -Force | Out-Null
  }
  $steps.Add('disable-wpp')
  return $steps
}

function Invoke-ForceUsbprint([string]$hardwareId) {
  $code = @"
using System;
using System.Runtime.InteropServices;
public static class PbNewDev {
  [DllImport("newdev.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool UpdateDriverForPlugAndPlayDevices(
    IntPtr hwndParent,
    string HardwareId,
    string FullInfPath,
    uint InstallFlags,
    out bool bRebootRequired);
}
"@
  try {
    if (-not ([System.Management.Automation.PSTypeName]'PbNewDev').Type) {
      Add-Type -TypeDefinition $code -ErrorAction Stop
    }
  } catch {}
  $reboot = $false
  $ok = $false
  try {
    $ok = [PbNewDev]::UpdateDriverForPlugAndPlayDevices([IntPtr]::Zero, $hardwareId, $UsbprintInf, 1, [ref]$reboot)
  } catch {
    $ok = $false
  }
  return $ok
}

function Get-Probe {
  $nodes = Get-SelphyNodes
  $live = @($nodes | Where-Object { Test-NodeLive $_ })
  $other = @($live | Where-Object {
      $class = [string]$_.Class
      $id = [string]$_.InstanceId
      ($id -match 'MI_01' -and ($class -eq '' -or $class -eq 'Unknown')) -or
      ([string]$_.Problem -match 'FAILED_INSTALL')
    })
  $usbPrint = @($live | Where-Object {
      [string]$_.Service -eq 'usbprint' -or
      [string]$_.Description -match 'USB Printing Support' -or
      ([string]$_.InstanceId -match 'MI_00' -and $_.Status -eq 'OK')
    })
  $queue = $null
  try {
    $queue = @(Get-Printer | Where-Object { $_.Name -match 'SELPHY|Canon' -and $_.PortName -match '^USB' } | Select-Object -First 1)[0]
  } catch {}
  $port = Get-UsbPrintPort
  $wpp = 0
  try {
    $wpp = [int](Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Print' -Name 'WindowsProtectedPrintState' -ErrorAction SilentlyContinue).WindowsProtectedPrintState
  } catch { $wpp = 0 }
  $ipp = $false
  if ($queue) { $ipp = [bool]([string]$queue.DriverName -match 'IPP') }
  $connected = [bool]($live.Count -gt 0 -or $queue -or $port)
  $needsRepair = $connected -and (
    $usbPrint.Count -eq 0 -or
    -not $queue -or
    $wpp -ne 0
  )
  [pscustomobject]@{
    present         = $connected
    code28          = [bool]($other.Count -gt 0)
    otherDevices    = [bool]($other.Count -gt 0)
    usbPrintOk      = [bool]($usbPrint.Count -gt 0)
    needsRepair     = [bool]$needsRepair
    instanceIds     = @($other | ForEach-Object { $_.InstanceId })
    queueName       = $(if ($queue) { [string]$queue.Name } else { $null })
    queueDriver     = $(if ($queue) { [string]$queue.DriverName } else { $null })
    queuePort       = $(if ($queue) { [string]$queue.PortName } else { $(if ($port) { $port.Name } else { $null }) })
    usesIppDriver   = $ipp
    wppEnabled      = [bool]($wpp -ne 0)
    admin           = Test-Admin
  }
}

function Restart-SpoolerSafe {
  try {
    Stop-Service -Name Spooler -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Start-Service -Name Spooler -ErrorAction SilentlyContinue
    return $true
  } catch {
    return $false
  }
}

function Remove-SelphyQueuesAndPorts {
  $steps = New-Object System.Collections.Generic.List[string]
  $queues = @(Get-Printer | Where-Object {
      $_.Name -match 'SELPHY' -or
      ($_.Name -match 'Canon' -and $_.PortName -match '^USB')
    })
  foreach ($q in $queues) {
    try {
      Get-PrintJob -PrinterName $q.Name -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-PrintJob -PrinterName $q.Name -ID $_.Id -ErrorAction SilentlyContinue
      }
      Remove-Printer -Name $q.Name -ErrorAction Stop
      $steps.Add("remove-queue:$($q.Name)")
    } catch {
      $steps.Add("remove-queue-failed:$($q.Name)")
    }
  }
  $ports = @(Get-PrinterPort | Where-Object {
      $_.Name -match '^USB\d+$' -and ([string]$_.Description -match 'SELPHY|Canon')
    })
  foreach ($port in $ports) {
    try {
      Remove-PrinterPort -Name $port.Name -ErrorAction Stop
      $steps.Add("remove-port:$($port.Name)")
    } catch {
      $steps.Add("remove-port-failed:$($port.Name)")
    }
  }
  $regPrinters = 'HKLM:\SYSTEM\CurrentControlSet\Control\Print\Printers'
  if (Test-Path $regPrinters) {
    Get-ChildItem $regPrinters -ErrorAction SilentlyContinue | Where-Object {
      $_.PSChildName -match 'SELPHY'
    } | ForEach-Object {
      Remove-Item -LiteralPath $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
      $steps.Add("remove-reg:$($_.PSChildName)")
    }
  }
  return $steps
}

function Remove-SelphyFailedDevices {
  $steps = New-Object System.Collections.Generic.List[string]
  $nodes = @(Get-PnpDevice | Where-Object {
      $_.InstanceId -match 'VID_04A9&PID_3302' -and (
        [string]$_.InstanceId -match 'MI_01' -or
        [string]$_.InstanceId -match 'PI_01' -or
        [string]$_.Class -eq 'PrintQueue' -or
        [string]$_.Problem -match 'FAILED_INSTALL'
      )
    })
  foreach ($n in $nodes) {
    $id = [string]$n.InstanceId
    if ($id -notmatch 'VID_04A9&PID_3302') { continue }
    if ($id -match 'MI_00') { continue }
    & pnputil.exe /remove-device $id /force | Out-Null
    $steps.Add('remove-pnp')
  }
  return $steps
}

function Invoke-Repair {
  $before = Get-Probe
  if (-not $before.present) {
    return [pscustomobject]@{
      ok = $false; repaired = $false; reason = 'printer-not-present'
      needsReboot = $false; probe = $before; steps = @()
    }
  }
  if (-not (Test-Admin)) {
    return [pscustomobject]@{
      ok = $false; repaired = $false; reason = 'access-denied'
      needsReboot = $false; probe = $before; steps = @(); exitCode = 5
    }
  }

  $steps = New-Object System.Collections.Generic.List[string]
  foreach ($s in (Disable-ProtectedPrintMode)) { $steps.Add($s) }

  [void](Restart-SpoolerSafe)
  foreach ($s in (Remove-SelphyQueuesAndPorts)) { $steps.Add($s) }
  Stop-Service -Name Spooler -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  $regPrinters = 'HKLM:\SYSTEM\CurrentControlSet\Control\Print\Printers'
  if (Test-Path $regPrinters) {
    Get-ChildItem $regPrinters -ErrorAction SilentlyContinue | Where-Object {
      $_.PSChildName -match 'SELPHY'
    } | ForEach-Object {
      Remove-Item -LiteralPath $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
      $steps.Add("remove-reg-stopped:$($_.PSChildName)")
    }
  }
  Start-Service -Name Spooler -ErrorAction SilentlyContinue
  $steps.Add('spooler-cleared')

  foreach ($s in (Remove-SelphyFailedDevices)) { $steps.Add($s) }

  if (Test-Path -LiteralPath $UsbprintInf) {
    & pnputil.exe /add-driver $UsbprintInf /install | Out-Null
    $steps.Add('add-usbprint')
    [void](Invoke-ForceUsbprint 'USB\VID_04A9&PID_3302&MI_00')
    [void](Invoke-ForceUsbprint 'USB\Class_07')
    $steps.Add('force-usbprint-mi00')
  }

  & pnputil.exe /scan-devices | Out-Null
  $steps.Add('scan')
  Start-Sleep -Seconds 5

  $portName = $null
  $p = Get-UsbPrintPort
  if ($p) { $portName = [string]$p.Name }

  $afterScan = Get-Probe
  if (-not $afterScan.queueName) {
    if (-not $portName) {
      $p2 = Get-UsbPrintPort
      if ($p2) { $portName = [string]$p2.Name }
    }
    if ($portName) {
      $driver = 'Microsoft IPP Class Driver'
      $have = @(Get-PrinterDriver | Where-Object { $_.Name -eq $driver })
      if ($have.Count -gt 0) {
        try {
          Add-Printer -Name $QueueName -DriverName $driver -PortName $portName -ErrorAction Stop
          $steps.Add("add-queue:$portName")
        } catch {
          $steps.Add('add-queue-failed')
        }
      } else {
        $steps.Add('ipp-driver-missing')
      }
    } else {
      $steps.Add('no-usb-port')
    }
  }

  $leftover = @(Get-PnpDevice | Where-Object {
      $_.InstanceId -match 'VID_04A9&PID_3302&MI_01' -and (
        [string]$_.Problem -match 'FAILED_INSTALL' -or -not $_.Class
      )
    })
  foreach ($n in $leftover) {
    & pnputil.exe /disable-device $n.InstanceId /force | Out-Null
    $steps.Add('disable-other-devices-mi01')
  }

  & pnputil.exe /scan-devices | Out-Null
  Start-Sleep -Seconds 2
  $after = Get-Probe
  $ok = [bool]($after.usbPrintOk -and $after.queueName -and $after.queuePort -match '^USB')
  [pscustomobject]@{
    ok          = $ok
    repaired    = $true
    reason      = $(if ($ok) { 'ok' } else { 'still-broken' })
    needsReboot = [bool](-not $ok)
    probe       = $after
    steps       = @($steps)
  }
}

function Register-RepairTask {
  $destDir = Join-Path $env:ProgramData 'PhotoBooth'
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  $dest = Join-Path $destDir 'selphy-usb-repair.ps1'
  Copy-Item -LiteralPath $PSCommandPath -Destination $dest -Force
  $tr = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $dest + '" -Action Repair'
  $ok = $false
  & schtasks.exe /Create /TN $TaskName /TR $tr /SC ONSTART /RL HIGHEST /F /RU SYSTEM | Out-Null
  if ($LASTEXITCODE -eq 0) { $ok = $true }
  if (-not $ok) {
    & schtasks.exe /Create /TN $TaskName /TR $tr /SC ONSTART /RL HIGHEST /F | Out-Null
    if ($LASTEXITCODE -eq 0) { $ok = $true }
  }
  [pscustomobject]@{ taskRegistered = $ok; scriptPath = $dest; taskName = $TaskName }
}

switch ($Action) {
  'Probe' {
    Write-Result (Get-Probe)
  }
  'Repair' {
    $r = Invoke-Repair
    Write-Result $r
    if ($r.reason -eq 'access-denied') { exit 5 }
    if (-not $r.ok -and $r.reason -eq 'still-broken') { exit 2 }
  }
  'RegisterTask' {
    if (-not (Test-Admin)) {
      Write-Result @{ ok = $false; reason = 'access-denied'; taskRegistered = $false }
      exit 5
    }
    $reg = Register-RepairTask
    $fix = Invoke-Repair
    Write-Result ([pscustomobject]@{
        ok             = [bool]($reg.taskRegistered -and $fix.ok)
        reason         = $fix.reason
        repaired       = $fix.repaired
        needsReboot    = $fix.needsReboot
        taskRegistered = $reg.taskRegistered
        scriptPath     = $reg.scriptPath
        probe          = $fix.probe
        steps          = $fix.steps
      })
  }
}
