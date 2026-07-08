# Брендированная графика NSIS-инсталлятора для приложений Nexalix Labs.
# Переиспользуемо всей линейкой: -AppName задаёт слово в stacked-lockup.
#   tools\make-installer-art.ps1                          # agora -> src-tauri\installer
#   tools\make-installer-art.ps1 -AppName translate -OutDir ..\translate\src-tauri\installer
# Логические размеры MUI: sidebar 164x314 (welcome/finish), header 150x57.
# Отдаём BMP в $Px раз больше — MUI (FitControl) ужимает под контрол, и на
# HiDPI картинка остаётся чёткой вместо растянутой в мыло. 24bpp без альфы.
# Рисуем в $SS-кратном размере и даунскейлим — без лесенок.
param(
    [string]$AppName = "agora",
    [string]$OutDir = (Join-Path $PSScriptRoot '..\src-tauri\installer'),
    [int]$Px = 3
)

Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$SS = 8  # суперсэмплинг (относительно логического размера)
$accent = [System.Drawing.Color]::FromArgb(0, 152, 234)
$white  = [System.Drawing.Color]::FromArgb(245, 247, 250)

# Знак Nexalix (треугольник + 3 узла) с центром (cx,cy) и масштабом scale.
function Draw-Mark($g, $cx, $cy, $scale, $ink, [bool]$glow) {
    function P($x, $y) { New-Object System.Drawing.PointF(([float]($cx + ($x - 16.0) * $scale)), ([float]($cy + ($y - 16.2) * $scale))) }
    $A = P 9 9; $B = P 23 11; $C = P 13 23
    if ($glow) {
        $glowR = [float]($scale * 6)
        $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
        $gp.AddEllipse($C.X - $glowR, $C.Y - $glowR, $glowR * 2, $glowR * 2)
        $pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($gp)
        $pgb.CenterColor = [System.Drawing.Color]::FromArgb(150, 0, 152, 234)
        $pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 0, 152, 234))
        $g.FillPath($pgb, $gp)
    }
    $pen = New-Object System.Drawing.Pen($ink, [float](1.5 * $scale))
    $pen.LineJoin = 'Round'; $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
    $tri = New-Object System.Drawing.Drawing2D.GraphicsPath
    $tri.AddLine($A, $B); $tri.AddLine($B, $C); $tri.CloseFigure()
    $g.DrawPath($pen, $tri)
    $rNode = [float](2.3 * $scale); $rAcc = [float](2.7 * $scale)
    $brI = New-Object System.Drawing.SolidBrush($ink)
    $brA = New-Object System.Drawing.SolidBrush($accent)
    function Dot($pt, $r, $b) { $g.FillEllipse($b, ($pt.X - $r), ($pt.Y - $r), ($r * 2), ($r * 2)) }
    Dot $A $rNode $brI; Dot $B $rNode $brI; Dot $C $rAcc $brA
}

# Рисует в SS-кратном размере и сохраняет даунскейл в 24bpp BMP.
function Save-Downscaled($draw, $w, $h, $path) {
    $big = New-Object System.Drawing.Bitmap(($w * $SS), ($h * $SS), [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($big)
    $g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'
    $g.TextRenderingHint = 'AntiAliasGridFit'
    $g.ScaleTransform($SS, $SS)
    & $draw $g
    $g.Dispose()

    $out = New-Object System.Drawing.Bitmap(($w * $Px), ($h * $Px), [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $og = [System.Drawing.Graphics]::FromImage($out)
    $og.InterpolationMode = 'HighQualityBicubic'
    $og.DrawImage($big, (New-Object System.Drawing.Rectangle(0, 0, ($w * $Px), ($h * $Px))))
    $og.Dispose(); $big.Dispose()
    $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $out.Dispose()
}

# ---------- SIDEBAR 164x314 ----------
$sw = 164; $sh = 314
Save-Downscaled {
    param($g)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $sw, $sh)
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(26, 34, 48), [System.Drawing.Color]::FromArgb(9, 12, 17), 90)
    $g.FillRectangle($grad, $rect)
    # акцентная полоса справа
    $g.FillRectangle((New-Object System.Drawing.SolidBrush($accent)), ($sw - 3), 0, 3, $sh)

    Draw-Mark $g 82 104 3.0 $white $true

    # Канонический stacked-lockup (logo-agora.html · lk-stack):
    #   слово приложения — fg, Inter/Segoe 600 −0.02em;
    #   "NEXALIX" — приглушённая mono-капитель с разрядкой. Акцент — только на ноде.
    $subtle = [System.Drawing.Color]::FromArgb(86, 92, 102)
    $fT = New-Object System.Drawing.Font('Segoe UI Semibold', 26, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $fN = New-Object System.Drawing.Font('Consolas', 11, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'
    $g.DrawString($AppName, $fT, (New-Object System.Drawing.SolidBrush($white)), (New-Object System.Drawing.RectangleF(0, 188, $sw, 36)), $sf)
    $g.DrawString('N E X A L I X', $fN, (New-Object System.Drawing.SolidBrush($subtle)), (New-Object System.Drawing.RectangleF(0, 228, $sw, 20)), $sf)
} $sw $sh (Join-Path $OutDir 'sidebar.bmp')

# ---------- HEADER 150x57 (белый фон под MUI-полосу, знак справа) ----------
$hw = 150; $hh = 57
Save-Downscaled {
    param($g)
    $g.Clear([System.Drawing.Color]::White)
    Draw-Mark $g 122 28 1.45 ([System.Drawing.Color]::FromArgb(20, 27, 38)) $false
} $hw $hh (Join-Path $OutDir 'header.bmp')

Write-Output "installer art ($AppName) -> $OutDir (sidebar.bmp 164x314, header.bmp 150x57)"
