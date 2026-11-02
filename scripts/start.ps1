# -Prebuilt:用已经打包好的页面(desktop\dist,由 vite preview 提供),不起开发服务器。免安装包用它
# -Headless:只起后端 API,不起前端页面。后台定时任务照样按点跑(盘中快照、收盘取数都不需要浏览器),
#           适合「关掉浏览器也让它在后台记录」;要调界面时另开一个普通窗口
# -NoOpen:启动后不自动打开浏览器
# -Port / -ApiPort:页面 / 本机 API 端口。默认 5940 / 8770(orchestrator/src/brand.ts 的 UI_PORT / API_PORT,和 Vibe Research 的 5930 / 8765 错开)，被占用或被系统保留时自动换一个空闲的；指定了就只用它
param([switch]$Prebuilt, [switch]$Headless, [switch]$NoOpen, [int]$Port = 0, [int]$ApiPort = 0)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if ($Prebuilt -and $Headless) {
  throw "-Prebuilt 是「用打包好的页面提供界面」,-Headless 是「不起界面」,两个放在一起没有意义。二选一。"
}
# 设置 Agnes AI API Key（从 WorkBuddy models.json 读取）
if (-not $env:AGNES_API_KEY) {
  try {
    $modelsJson = Get-Content "$env:USERPROFILE\.workbuddy\models.json" -Raw -ErrorAction Stop | ConvertFrom-Json
    $agnesModel = $modelsJson | Where-Object { $_.id -eq "custom-local:agnes-2.5-flash" } | Select-Object -First 1
    if ($agnesModel) { $env:AGNES_API_KEY = $agnesModel.apiKey }
  } catch {}
}
# Node 运行时预检:版本不够或构建未启用 TypeScript 支持时给出指引,而不是 ERR_UNKNOWN_FILE_EXTENSION(#38)
& node (Join-Path $root "scripts\check-node.mjs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($Prebuilt -and -not (Test-Path (Join-Path $root "desktop\dist\index.html"))) {
  throw "缺少打包好的页面(desktop\dist)。先在 desktop 目录运行 npm run build,或去掉 -Prebuilt。"
}
# 选端口(规则见 orchestrator\src\startup_ports.ts):全部写在 stdout,说明是 [start] 开头的行,成功时最后一行是 {"ui":..,"api":..}
$portArgs = @()
if ($Port) { $portArgs += @("--port", "$Port") }
if ($ApiPort) { $portArgs += @("--api-port", "$ApiPort") }
$chosen = @(& node (Join-Path $root "orchestrator\src\startup_ports.ts") @portArgs)
$portCode = $LASTEXITCODE
$chosen | Where-Object { "$_".StartsWith("[start]") } | ForEach-Object { Write-Host $_ }
if ($portCode -ne 0) { exit $portCode }
$last = if ($chosen.Count) { "$($chosen[-1])" } else { "" }
if (-not $last.StartsWith("{")) { throw "没拿到端口选择结果(orchestrator\src\startup_ports.ts 没有输出)。" }
$ports = $last | ConvertFrom-Json
$uiPortChosen = [int]$ports.ui
$apiPortChosen = [int]$ports.api
# 页面服务器(Vite)按这两个变量监听和转发 /api;就绪检查和 API 拼推送链接也用它们。
# 退出时还原:在自己的 PowerShell 窗口里直接运行本脚本时,不能把这次选的端口留给下一次(下一次会被当成「指定了端口」)
$prevUiPort = $env:VRA_UI_PORT
$prevApiPort = $env:VRA_API_PORT
$env:VRA_UI_PORT = "$uiPortChosen"
$env:VRA_API_PORT = "$apiPortChosen"
$uiUrl = "http://127.0.0.1:$uiPortChosen"
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$api = $null
$ui = $null

# 🔴 不用 Start-Process 拉进程。
#    PowerShell 5.1 的 Start-Process 会把 $env: 整个复制进一个**大小写不敏感**的字典,
#    环境里只要同时存在 https_proxy 与 HTTPS_PROXY(仅大小写不同,某些客户端/脚本会这么设),
#    它就直接抛「参数集不兼容」然后整个脚本退出 —— 表现为双击 start.cmd 一闪而过、什么都没起。
#    [System.Diagnostics.Process]::Start 走的是 CreateProcess,子进程原生继承父进程环境块,
#    不构造那个字典,也就没有这个撞键问题。
function Start-ManagedProcess([string]$FileName, [string]$Arguments, [string]$WorkingDirectory) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FileName
  $psi.Arguments = $Arguments
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  # 不重定向:子进程沿用当前控制台,日志照旧打在这个窗口里
  $psi.CreateNoWindow = $false
  return [System.Diagnostics.Process]::Start($psi)
}

function Stop-ProcessTree($Process) {
  if (-not $Process) { return }
  $rootId = [int]$Process.Id
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId)
  $pending = [System.Collections.Generic.Queue[int]]::new()
  $seen = [System.Collections.Generic.HashSet[int]]::new()
  $descendants = [System.Collections.Generic.List[int]]::new()
  $pending.Enqueue($rootId)
  [void]$seen.Add($rootId)
  while ($pending.Count -gt 0) {
    $parentId = $pending.Dequeue()
    foreach ($child in $all) {
      $childId = [int]$child.ProcessId
      if ([int]$child.ParentProcessId -eq $parentId -and $seen.Add($childId)) {
        $descendants.Add($childId)
        $pending.Enqueue($childId)
      }
    }
  }
  # 父进程已退出时 taskkill /PID <parent> /T 找不到树根；
  # CIM 快照里的 ParentProcessId 仍能让我们定位遗留子孙。
  foreach ($targetId in @($descendants | Sort-Object -Descending)) {
    & taskkill.exe /PID $targetId /T /F *> $null
  }
  $Process.Refresh()
  if (-not $Process.HasExited) {
    & taskkill.exe /PID $rootId /T /F *> $null
  }
}
try {
  $api = Start-ManagedProcess $nodeExe "`"orchestrator\src\api.ts`" --port $apiPortChosen --host 127.0.0.1" $root
  if (-not $Headless) {
    # UI 由 Vite 按 VRA_LAN 决定绑定；默认回环，API 的回环绑定不变。打包好的页面由 vite preview 提供，同样只听回环。
    # 直接调 vite 的入口文件而不是 `npm run dev`:npm 是 npm.cmd(批处理),CreateProcess 不能直跑,
    # 得再套一层 cmd.exe —— 多一层就多一层「杀了父进程留下孤儿子进程」的机会。
    $viteArgs = if ($Prebuilt) { "`"node_modules\vite\bin\vite.js`" preview" } else { "`"node_modules\vite\bin\vite.js`"" }
    $ui = Start-ManagedProcess $nodeExe $viteArgs (Join-Path $root "desktop")
  }
  $ready = $false
  # 90 秒:vite 偶尔要重新预打包依赖(30~60 秒),60 秒会把这种情况误判成失败
  $readyDeadline = [DateTime]::UtcNow.AddSeconds(90)
  if (-not $Headless) {
    # 就绪判据会真的等入口模块编译完才放行(见 startup_health.ts),所以先把话说在前面,
    # 否则那几秒黑窗口一样让人以为卡住了
    Write-Host "正在等界面就绪(首次/改动后要编译前端,通常几秒)…"
  }
  while ([DateTime]::UtcNow -lt $readyDeadline) {
    $api.Refresh()
    if ($api.HasExited) { throw "API 启动失败（退出码 $($api.ExitCode)），请检查 $apiPortChosen 端口和产品配置。" }
    if ($ui) {
      $ui.Refresh()
      if ($ui.HasExited) { throw "界面启动失败（退出码 $($ui.ExitCode)）。" }
      # 经界面代理验证后端鉴权；令牌仍只留在本地服务，不传到浏览器或命令参数。
      & node (Join-Path $root "orchestrator\src\startup_health.ts")
    } else {
      # 无界面时没有代理可走,直连 API 验(读 .local/api.token 发 Bearer);令牌同样只留在本机
      & node (Join-Path $root "orchestrator\src\startup_health.ts") --api
    }
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw "启动等待超过 90 秒。请检查上方日志、$apiPortChosen/$uiPortChosen 端口以及产品配置；浏览器尚未打开。" }
  $api.Refresh()
  if ($api.HasExited) { throw "API 启动失败（退出码 $($api.ExitCode)），请检查 $apiPortChosen 端口和产品配置。" }
  if ($Headless) {
    Write-Host "`nVibe AStock 已启动(只跑后端):http://127.0.0.1:$apiPortChosen`n定时任务会按点自己跑,关掉浏览器不影响记录。界面另开一个窗口用 scripts\start.cmd。`n按 Ctrl+C 或关掉这个窗口即退出。"
  } else {
    $ui.Refresh()
    if ($ui.HasExited) { throw "界面启动失败（退出码 $($ui.ExitCode)）。" }
    Write-Host "`nVibe AStock 已启动:$uiUrl`n按 Ctrl+C 或关掉这个窗口即退出。"
    if (-not $NoOpen) { Start-Process $uiUrl }
  }
  while (-not $api.HasExited -and (-not $ui -or -not $ui.HasExited)) {
    Start-Sleep -Milliseconds 250
    $api.Refresh()
    if ($ui) { $ui.Refresh() }
  }
  if ($api.HasExited) { throw "API 已停止（退出码 $($api.ExitCode)）$(if ($Headless) { ",后台记录也跟着停了" } else { "，界面同步关闭" })。" }
  if ($ui -and $ui.HasExited) { throw "界面已提前停止（退出码 $($ui.ExitCode)）。" }
} finally {
  Stop-ProcessTree $ui
  Stop-ProcessTree $api
  if ($null -eq $prevUiPort) { Remove-Item Env:VRA_UI_PORT -ErrorAction SilentlyContinue } else { $env:VRA_UI_PORT = $prevUiPort }
  if ($null -eq $prevApiPort) { Remove-Item Env:VRA_API_PORT -ErrorAction SilentlyContinue } else { $env:VRA_API_PORT = $prevApiPort }
}
