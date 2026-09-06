param(
  [string]$ExeName = 'Bongo Cat Mver.exe',
  [string]$Dir = (Join-Path $env:TEMP 'daniya-pet')
)
$ErrorActionPreference = 'Stop'
$ProcName = $ExeName -replace '\.exe$', ''

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$EventsPath = Join-Path $Dir 'events.jsonl'
$CmdPath = Join-Path $Dir 'cmd.json'

function Append-Event($obj) {
  # PS5.1 的 Add-Content -Encoding UTF8 建文件时会写 BOM，破坏 JSONL 首行解析；改用 AppendAllText（UTF-8 无 BOM，与下方 C# 钩子写入一致）
  try { [System.IO.File]::AppendAllText($EventsPath, ($obj | ConvertTo-Json -Compress) + "`n") } catch { }
}

function Get-PetHwnd {
  $p = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) { $p.Refresh(); return $p.MainWindowHandle }
  return [IntPtr]::Zero
}

# ---- Win32 互操作（钩子回调全部为纯 C#，不回调 PowerShell，避免 runspace 问题）----
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
public class PetHook {
  public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
  [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool GetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, out uint TokenInformation, uint TokenInformationLength, out uint ReturnLength);

  public static IntPtr TargetHwnd = IntPtr.Zero;
  public static string EventsPath = "";
  public static long LastClickTick = 0;

  public static IntPtr MouseCallback(int nCode, IntPtr wParam, IntPtr lParam) {
    try {
      if (nCode >= 0 && wParam == (IntPtr)0x0201 && TargetHwnd != IntPtr.Zero) {
        RECT r;
        if (GetWindowRect(TargetHwnd, out r)) {
          MSLLHOOKSTRUCT s = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
          if (s.pt.x >= r.Left && s.pt.x < r.Right && s.pt.y >= r.Top && s.pt.y < r.Bottom) {
            long now = DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond;
            if (now - LastClickTick > 800) {
              LastClickTick = now;
              File.AppendAllText(EventsPath, "{\"type\":\"pet-click\",\"x\":" + s.pt.x + ",\"y\":" + s.pt.y + "}\n");
            }
          }
        }
      }
    } catch { }
    return CallNextHookEx(hHook, nCode, wParam, lParam);
  }
  public static IntPtr hHook = IntPtr.Zero;
}
"@

# ---- 提权检测与自举 ----
$selfElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
function Test-PetElevated {
  $p = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $p) { return $false }
  try {
    # 0x1000 = PROCESS_QUERY_LIMITED_INFORMATION：0x0400 对提权桌宠必被拒（提前 return $false，检测永远失效）
    $h = [PetHook]::OpenProcess(0x1000, $false, $p.Id)
    if ($h -eq [IntPtr]::Zero) { return $false }
    $tok = [IntPtr]::Zero
    if (-not [PetHook]::OpenProcessToken($h, 0x0008, [ref]$tok)) { [PetHook]::CloseHandle($h); return $false }
    # 简报原代码只判断 token 是否打开成功（任何可访问进程都为真，导致非提权桌宠也弹 UAC）；
    # 改为查询 TokenElevation(20) 判断真正的管理员身份
    $elev = [uint32]0; $rl = [uint32]0
    $ok = [PetHook]::GetTokenInformation($tok, 20, [ref]$elev, 4, [ref]$rl)
    [PetHook]::CloseHandle($tok) | Out-Null
    [PetHook]::CloseHandle($h)
    return ($ok -and $elev -ne 0)
  } catch { return $false }
}

if ((Test-PetElevated) -and -not $selfElevated) {
  $vbs = (Join-Path $env:TEMP 'daniya-pet-elevate.vbs') -replace '/', '\'
  $argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -ExeName `"$ExeName`" -Dir `"$Dir`""
  $vbsContent = "Set UAC = CreateObject(`"Shell.Application`")`nUAC.ShellExecute `"$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`", `"$argLine`", `"`", `"runas`", 0"
  Set-Content -Path $vbs -Value $vbsContent -Encoding Default
  & wscript.exe $vbs
  Remove-Item $vbs -ErrorAction SilentlyContinue
  exit 0
}

# ---- 初始化 C# 钩子状态 ----
[PetHook]::EventsPath = $EventsPath
[PetHook]::LastClickTick = 0

Add-Type -AssemblyName System.Windows.Forms
$delegate = [Delegate]::CreateDelegate([PetHook+HookProc], [PetHook], 'MouseCallback')   # 保持引用，防 GC（PS5.1 无法直接把 PSMethod 转委托，改用 CreateDelegate，回调仍为纯 C#）
$hook = [PetHook]::SetWindowsHookEx(14, $delegate, [IntPtr]::Zero, 0)
if ($hook -eq [IntPtr]::Zero) { Append-Event @{ type='error'; error='hook install failed' }; exit 1 }
[PetHook]::hHook = $hook

function Send-PetKeys([int[]]$Mods, [int]$Key) {
  $hwnd = Get-PetHwnd
  if ($hwnd -eq [IntPtr]::Zero) { return }
  [PetHook]::ShowWindow($hwnd, 5) | Out-Null          # SW_SHOW
  [PetHook]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 100
  foreach ($m in $Mods) { [PetHook]::keybd_event($m, 0, 0, [UIntPtr]::Zero) }
  Start-Sleep -Milliseconds 50
  [PetHook]::keybd_event($Key, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [PetHook]::keybd_event($Key, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 50
  foreach ($m in $Mods) { [PetHook]::keybd_event($m, 0, 2, [UIntPtr]::Zero) }
}

$lastHwnd = [IntPtr]::Zero

# 定时器1：每 2 秒刷新桌宠窗口句柄并向主进程报告
$t1 = New-Object System.Windows.Forms.Timer
$t1.Interval = 2000
$t1.Add_Tick({
  $hwnd = Get-PetHwnd
  if ($hwnd -ne [PetHook]::TargetHwnd) {
    [PetHook]::TargetHwnd = $hwnd
    if ($hwnd -ne [IntPtr]::Zero) {
      $r = New-Object PetHook+RECT
      if ([PetHook]::GetWindowRect($hwnd, [ref]$r)) {
        Append-Event @{ type='window'; rect=@{ x=$r.Left; y=$r.Top; w=($r.Right-$r.Left); h=($r.Bottom-$r.Top) } }
      }
    } else {
      Append-Event @{ type='window'; gone=$true }
    }
  }
})

# 定时器2：每 100ms 轮询命令文件（避免管道线程问题）
$t2 = New-Object System.Windows.Forms.Timer
$t2.Interval = 100
$t2.Add_Tick({
  try {
    if (Test-Path $CmdPath) {
      $cmd = Get-Content $CmdPath -Raw -Encoding UTF8 | ConvertFrom-Json
      Remove-Item $CmdPath -Force -ErrorAction SilentlyContinue
      switch ($cmd.cmd) {
        'ping'   { Append-Event @{ type='pong' } }
        'keys'   { Send-PetKeys @($cmd.mods) ([int]$cmd.key) }
        'shutdown' {
          Append-Event @{ type='stopped' }
          [PetHook]::UnhookWindowsHookEx($hook) | Out-Null
          $t1.Stop(); $t2.Stop()
          [System.Windows.Forms.Application]::Exit()
        }
      }
    }
  } catch { }
})

$t1.Start(); $t2.Start()
Append-Event @{ type='ready' }
[System.Windows.Forms.Application]::Run()
