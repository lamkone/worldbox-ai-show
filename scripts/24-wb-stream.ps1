#requires -Version 7
# 24-wb-stream.ps1 — Stream MJPEG en vivo de la ventana de WorldBox.
#
# Captura la ventana del juego con PrintWindow(PW_RENDERFULLCONTENT), que funciona
# incluso cuando la ventana está tapada por otras, y la sirve como stream MJPEG
# (multipart/x-mixed-replace) que cualquier navegador pinta de forma nativa en un <img>.
#
# Además detecta explosiones (píxeles naranjas) y publica su centroide normalizado
# para que el visor pueda hacer zoom cinematográfico al punto del impacto.
#
# Rutas:
#   GET /stream.mjpg  -> stream en vivo
#   GET /frame.jpg    -> última imagen suelta
#   GET /stats        -> JSON con fps, seq, centroide y potencia de la explosión
#   GET /health       -> "ok"
param(
    [int]$Port = 8767,
    [int]$MaxWidth = 1280,
    [int]$Quality = 78,
    [int]$Fps = 20,
    [string]$ProcessName = 'worldbox',
    # Recorte normalizado (0..1) sobre la ventana capturada: sirve para publicar SOLO
    # el mapa del juego (sin el fondo azul ni el HUD de WorldBox). Por defecto, todo.
    [double]$CropX0 = 0,
    [double]$CropY0 = 0,
    [double]$CropX1 = 1,
    [double]$CropY1 = 1,
    # Auto-recorte: detecta la isla (lo que no es oceano) y publica solo eso.
    # Se recalcula cada ~0,7 s; si la deteccion falla, usa el recorte manual.
    [switch]$AutoCrop
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore -ErrorAction Stop
Add-Type -AssemblyName WindowsBase -ErrorAction Stop

$psHomeDir = Split-Path -Parent (Get-Process -Id $PID).Path

$cs = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

public static class WbStream
{
    // ---------- Win32 ----------
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO pbmi, uint usage, out IntPtr ppvBits, IntPtr hSection, uint offset);

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct BITMAPINFOHEADER {
        public uint biSize; public int biWidth; public int biHeight; public ushort biPlanes; public ushort biBitCount;
        public uint biCompression; public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
        public uint biClrUsed; public uint biClrImportant; }
    [StructLayout(LayoutKind.Sequential)] struct BITMAPINFO { public BITMAPINFOHEADER bmiHeader; public uint bmiColors; }

    // ---------- Estado compartido ----------
    static volatile bool _run;
    static volatile byte[] _latest = new byte[0];
    static volatile int _seq;
    static volatile int _cx = -1, _cy = -1, _power;
    // Detección de explosión: el naranja de fondo (desierto, fuego viejo) es
    // permanente, así que lo que delata una bomba es un PICOTAZO sobre esa línea
    // base, con un núcleo casi blanco. _spike = exceso sobre el fondo; _scx/_scy
    // = centroide de ese pico, que se mantiene ~2,5 s para que el motor no se lo
    // pierda al sondear una vez por segundo.
    static volatile int _spike, _scx = -1, _scy = -1, _base = 200;
    // Pico EN VIVO del frame actual (sin latch): el motor muestrea durante ~2,5 s y
    // se queda con el máximo, que es el verdadero fogonazo. El _spike de arriba se
    // mantiene 2,5 s para clientes que sondean despacio, pero no sirve para buscar
    // el pico porque repite el mismo valor viejo.
    static volatile int _lspike, _lcx = -1, _lcy = -1;
    // Valores CRUDOS (0..10000 del frame COMPLETO) tal como los mide DetectExplosion.
    // La conversión al recorte publicado se hace UNA sola vez por frame en
    // CaptureLoop. Antes se renormalizaban in situ los campos ya publicados y cada
    // frame volvía a transformar el valor transformado: deriva geométrica que
    // acababa sacando el punto del encuadre y la cámara saltaba a otro sitio.
    static int _rcx = -1, _rcy = -1, _rscx = -1, _rscy = -1, _rlcx = -1, _rlcy = -1;
    static long _lastSpikeTicks;
    // cuándo ocurrió el pico (ms Unix), para que el motor sepa si es de ESTA bomba
    // o de una anterior que aún está en la ventana de 2,5 s
    static long _spikeUnixMs;
    // Rejilla de luminancia para detectar el fogonazo por diferencia con el fondo.
    static double[] _bg;
    static bool _bgReady;
    const int GRID_W = 160, GRID_H = 90;
    static double _fps;
    static int _maxW = 1280, _quality = 78, _targetFps = 20, _port = 8767;
    static string _procName = "worldbox";
    // Recorte normalizado del frame antes de publicarlo (0..1). El visor recibe SOLO
    // la zona del mapa; las coordenadas cx/cy se renormalizan a este recorte.
    static double _cx0 = 0, _cy0 = 0, _cx1 = 1, _cy1 = 1;
    // Auto-recorte: detecta la isla (todo lo que no es oceano) y publica solo eso.
    // Evita depender de un zoom/posicion de camara concretos del juego.
    static bool _autoCrop = false;
    static double _ax0 = 0, _ay0 = 0, _ax1 = 0, _ay1 = 0;   // isla detectada (0..1), invalida si _ax1<=_ax0
    static int _aFrame = 0;
    static Thread _capThread, _srvThread;
    static TcpListener _listener;
    static volatile int _hwndFound;
    static volatile string _err = "";
    static readonly object _frameLock = new object();

    public static string Start(int port, int maxW, int quality, int fps, string procName,
                               double cx0, double cy0, double cx1, double cy1, bool autoCrop)
    {
        if (_run) return "already-running";
        _port = port; _maxW = maxW; _quality = quality; _targetFps = Math.Max(1, fps); _procName = procName;
        // Sanea el recorte: dentro de 0..1, con al menos un 5% de ancho/alto.
        _cx0 = Math.Max(0, Math.Min(0.95, cx0));
        _cy0 = Math.Max(0, Math.Min(0.95, cy0));
        _cx1 = Math.Max(_cx0 + 0.05, Math.Min(1, cx1));
        _cy1 = Math.Max(_cy0 + 0.05, Math.Min(1, cy1));
        _autoCrop = autoCrop;
        _ax0 = 0; _ay0 = 0; _ax1 = 0; _ay1 = 0; _aFrame = 0;
        _run = true;

        _listener = new TcpListener(IPAddress.Loopback, _port);
        _listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        _listener.Start(16);

        _capThread = new Thread(CaptureLoop);
        _capThread.IsBackground = true;
        _capThread.Name = "wb-capture";
        _capThread.Start();

        _srvThread = new Thread(ServerLoop);
        _srvThread.IsBackground = true;
        _srvThread.Name = "wb-http";
        _srvThread.Start();

        return "started port=" + _port + " maxW=" + _maxW + " q=" + _quality + " fps=" + _targetFps +
               " crop=" + (autoCrop ? "auto" : (_cx0.ToString("0.###", CultureInfo.InvariantCulture) + "," + _cy0.ToString("0.###", CultureInfo.InvariantCulture) +
               "," + _cx1.ToString("0.###", CultureInfo.InvariantCulture) + "," + _cy1.ToString("0.###", CultureInfo.InvariantCulture)));
    }

    public static void Stop()
    {
        _run = false;
        try { if (_listener != null) _listener.Stop(); } catch { }
    }

    // Pasa una coordenada normalizada (0..10000) del frame completo a coordenadas
    // del recorte publicado. -1 se queda en -1 ("no hay dato").
    static int Renorm(int v, double a, double b)
    {
        if (v < 0) return -1;
        double t = (v / 10000.0 - a) / Math.Max(0.0001, b - a);
        if (t < 0 || t > 1) return -1;
        return (int)Math.Round(t * 10000.0);
    }

    static string Esc(string v)
    {
        if (v == null) return "";
        return v.Replace("\\", "/").Replace("\"", "'").Replace("\n", " ").Replace("\r", " ");
    }

    public static string Stats()
    {
        string crop = _autoCrop
            ? ("auto:" + (_ax1 > _ax0
                ? _ax0.ToString("0.###", CultureInfo.InvariantCulture) + "," + _ay0.ToString("0.###", CultureInfo.InvariantCulture) + "," +
                  _ax1.ToString("0.###", CultureInfo.InvariantCulture) + "," + _ay1.ToString("0.###", CultureInfo.InvariantCulture)
                : "buscando"))
            : (_cx0.ToString("0.###", CultureInfo.InvariantCulture) + "," + _cy0.ToString("0.###", CultureInfo.InvariantCulture) + "," +
               _cx1.ToString("0.###", CultureInfo.InvariantCulture) + "," + _cy1.ToString("0.###", CultureInfo.InvariantCulture));
        string s = string.Format(CultureInfo.InvariantCulture,
            "{{\"fps\":{0:F1},\"seq\":{1},\"cx\":{2},\"cy\":{3},\"power\":{4},\"base\":{5},\"spike\":{6},\"scx\":{7},\"scy\":{8},\"stick\":{9},\"bytes\":{10},\"target\":{11},\"hwnd\":{12},\"err\":\"{13}\",\"lspike\":{14},\"lcx\":{15},\"lcy\":{16},\"crop\":\"{17}\"}}",
            _fps, _seq, _cx, _cy, _power, _base, _spike, _scx, _scy, _spikeUnixMs, _latest.Length, _targetFps, _hwndFound, Esc(_err), _lspike, _lcx, _lcy, Esc(crop));
        return s;
    }

    // ---------- Captura ----------
    static IntPtr FindWindow()
    {
        try
        {
            Process[] ps = Process.GetProcessesByName(_procName);
            foreach (Process p in ps)
            {
                if (p.MainWindowHandle != IntPtr.Zero) return p.MainWindowHandle;
            }
        }
        catch { }
        return IntPtr.Zero;
    }

    // Detecta la isla por componentes conexas: reduce el frame a una rejilla 96x78,
    // marca las celdas que NO son oceano y se queda con el mayor "islote" que no
    // toca el borde (asi se ignora el HUD del juego). El bbox se suaviza contra el
    // anterior para que la camara no tiemble. Corre 1 de cada N frames.
    static byte[] _islaBuf;
    static readonly int ISLA_GW = 96;
    static readonly int ISLA_GH = 78;
    static void DetectIsla(IntPtr bits, int w, int h)
    {
        int stride = w * 4;
        int need = stride * h;
        if (_islaBuf == null || _islaBuf.Length < need) _islaBuf = new byte[need];
        Marshal.Copy(bits, _islaBuf, 0, need);

        int gw = ISLA_GW, gh = ISLA_GH;
        bool[] land = new bool[gw * gh];
        int sx = Math.Max(1, w / gw / 3), sy = Math.Max(1, h / gh / 3);
        for (int gy = 0; gy < gh; gy++)
        {
            int y0 = (int)((gy + 0.5) * h / gh);
            for (int gx = 0; gx < gw; gx++)
            {
                int x0 = (int)((gx + 0.5) * w / gw);
                long sr = 0, sg = 0, sb = 0; int ns = 0;
                for (int dy = -1; dy <= 1; dy++)
                {
                    int y = y0 + dy * sy;
                    if (y < 0 || y >= h) continue;
                    int row = y * stride;
                    for (int dx = -1; dx <= 1; dx++)
                    {
                        int x = x0 + dx * sx;
                        if (x < 0 || x >= w) continue;
                        int i = row + x * 4;
                        sb += _islaBuf[i]; sg += _islaBuf[i + 1]; sr += _islaBuf[i + 2]; ns++;
                    }
                }
                if (ns == 0) continue;
                int rr = (int)(sr / ns), gg = (int)(sg / ns), bb = (int)(sb / ns);
                bool oceano = (bb > rr + 18) && (bb >= gg + 6) && (bb > 40);
                land[gy * gw + gx] = !oceano;
            }
        }

        bool[] seen = new bool[gw * gh];
        int[] cola = new int[gw * gh];
        int bestLen = 0, bx0 = 0, by0 = 0, bx1 = 0, by1 = 0;
        for (int start = 0; start < land.Length; start++)
        {
            if (!land[start] || seen[start]) continue;
            int head = 0, tail = 0;
            cola[tail++] = start; seen[start] = true;
            bool toca = false;
            int minX = gw, maxX = -1, minY = gh, maxY = -1, len = 0;
            while (head < tail)
            {
                int idx = cola[head++];
                int cx = idx % gw, cy = idx / gw;
                len++;
                if (cx <= 1 || cy <= 1 || cx >= gw - 2 || cy >= gh - 2) toca = true;
                if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
                if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
                for (int dy = -1; dy <= 1; dy++)
                {
                    for (int dx = -1; dx <= 1; dx++)
                    {
                        if (dx == 0 && dy == 0) continue;
                        int nx = cx + dx, ny = cy + dy;
                        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
                        int ni = ny * gw + nx;
                        if (land[ni] && !seen[ni]) { seen[ni] = true; cola[tail++] = ni; }
                    }
                }
            }
            if (toca) continue;
            if (len > bestLen) { bestLen = len; bx0 = minX; by0 = minY; bx1 = maxX + 1; by1 = maxY + 1; }
        }
        if (bestLen < 25) return;

        double nx0 = (double)bx0 / gw, ny0 = (double)by0 / gh;
        double nx1 = (double)bx1 / gw, ny1 = (double)by1 / gh;
        // 8% de margen para que se vea algo de oceano alrededor de la isla.
        double mx = (nx1 - nx0) * 0.08, my = (ny1 - ny0) * 0.08;
        nx0 = Math.Max(0, nx0 - mx); ny0 = Math.Max(0, ny0 - my);
        nx1 = Math.Min(1, nx1 + mx); ny1 = Math.Min(1, ny1 + my);
        if (nx1 - nx0 < 0.10 || ny1 - ny0 < 0.10) return;

        if (_ax1 <= _ax0) { _ax0 = nx0; _ay0 = ny0; _ax1 = nx1; _ay1 = ny1; }
        else
        {
            _ax0 = _ax0 * 0.80 + nx0 * 0.20;
            _ay0 = _ay0 * 0.80 + ny0 * 0.20;
            _ax1 = _ax1 * 0.80 + nx1 * 0.20;
            _ay1 = _ay1 * 0.80 + ny1 * 0.20;
        }
    }

    static void CaptureLoop()
    {
        IntPtr hdcMem = IntPtr.Zero, hbmp = IntPtr.Zero, hOld = IntPtr.Zero;
        int allocW = 0, allocH = 0;
        IntPtr bits = IntPtr.Zero;
        long tickWindow = Stopwatch.Frequency;
        int framesInWindow = 0;
        Stopwatch winSw = Stopwatch.StartNew();

        while (_run)
        {
            try
            {
                IntPtr hwnd = FindWindow();
                _hwndFound = (int)hwnd.ToInt64();
                if (hwnd == IntPtr.Zero) { _err = "no-window"; Thread.Sleep(400); continue; }
                if (IsIconic(hwnd)) { ShowWindow(hwnd, 4); _err = "restoring"; Thread.Sleep(300); continue; }
                RECT r;
                if (!GetWindowRect(hwnd, out r)) { Thread.Sleep(200); continue; }
                int w = r.Right - r.Left, h = r.Bottom - r.Top;
                if (w <= 0 || h <= 0) { Thread.Sleep(200); continue; }

                if (hdcMem == IntPtr.Zero || w != allocW || h != allocH)
                {
                    if (hbmp != IntPtr.Zero) { SelectObject(hdcMem, hOld); DeleteObject(hbmp); }
                    if (hdcMem != IntPtr.Zero) DeleteDC(hdcMem);
                    hdcMem = CreateCompatibleDC(IntPtr.Zero);
                    BITMAPINFO bi = new BITMAPINFO();
                    bi.bmiHeader.biSize = 40; bi.bmiHeader.biWidth = w; bi.bmiHeader.biHeight = -h;
                    bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 32; bi.bmiHeader.biCompression = 0;
                    hbmp = CreateDIBSection(hdcMem, ref bi, 0, out bits, IntPtr.Zero, 0);
                    hOld = SelectObject(hdcMem, hbmp);
                    allocW = w; allocH = h;
                }

                Stopwatch sw = Stopwatch.StartNew();
                bool ok = PrintWindow(hwnd, hdcMem, 2); // PW_RENDERFULLCONTENT
                if (!ok) { Thread.Sleep(100); continue; }

                DetectExplosion(bits, w, h);

                // Auto-recorte: recalcula la isla cada 12 frames (~0,7 s) y la suaviza.
                if (_autoCrop && (_aFrame++ % 12) == 0) DetectIsla(bits, w, h);

                // Recorte efectivo: auto si ya hay isla valida; si no, el manual.
                double ex0 = _cx0, ey0 = _cy0, ex1 = _cx1, ey1 = _cy1;
                if (_autoCrop && _ax1 > _ax0) { ex0 = _ax0; ey0 = _ay0; ex1 = _ax1; ey1 = _ay1; }

                // Los centroides se miden en el frame COMPLETO (campos _r*) y se
                // convierten al recorte publicado UNA sola vez por frame. Hacerlo
                // sobre los campos ya publicados era el bug de la cámara: cada
                // frame re-aplicaba la transformación, el valor derivaba hasta
                // salirse del encuadre (Renorm devolvía -1) y el motor acababa
                // apuntando al centro del mapa o a cualquier sitio.
                _cx = Renorm(_rcx, ex0, ex1);
                _cy = Renorm(_rcy, ey0, ey1);
                _scx = Renorm(_rscx, ex0, ex1);
                _scy = Renorm(_rscy, ey0, ey1);
                _lcx = Renorm(_rlcx, ex0, ex1);
                _lcy = Renorm(_rlcy, ey0, ey1);

                BitmapSource src = BitmapSource.Create(w, h, 96, 96, PixelFormats.Bgra32, null, bits, w * h * 4, w * 4);
                if (ex0 > 0 || ey0 > 0 || ex1 < 1 || ey1 < 1)
                {
                    int rx = (int)Math.Round(ex0 * w), ry = (int)Math.Round(ey0 * h);
                    int rw = (int)Math.Round((ex1 - ex0) * w), rh = (int)Math.Round((ey1 - ey0) * h);
                    if (rx < 0) rx = 0; if (ry < 0) ry = 0;
                    if (rx + rw > w) rw = w - rx; if (ry + rh > h) rh = h - ry;
                    if (rw > 0 && rh > 0)
                    {
                        src = new CroppedBitmap(src, new Int32Rect(rx, ry, rw, rh));
                        w = rw; h = rh;
                    }
                }
                if (_maxW > 0 && w > _maxW)
                {
                    double s = (double)_maxW / w;
                    src = new TransformedBitmap(src, new ScaleTransform(s, s));
                }
                src.Freeze();
                JpegBitmapEncoder enc = new JpegBitmapEncoder();
                enc.QualityLevel = _quality;
                enc.Frames.Add(BitmapFrame.Create(src));
                byte[] jpg;
                using (MemoryStream ms = new MemoryStream(220 * 1024))
                {
                    enc.Save(ms);
                    jpg = ms.ToArray();
                }
                _latest = jpg;
                _seq++;
                framesInWindow++;

                if (winSw.Elapsed.TotalSeconds >= 1.0)
                {
                    _fps = framesInWindow / winSw.Elapsed.TotalSeconds;
                    framesInWindow = 0;
                    winSw.Restart();
                }

                int budgetMs = 1000 / _targetFps;
                int used = (int)sw.Elapsed.TotalMilliseconds;
                int sleep = budgetMs - used;
                if (sleep > 0) Thread.Sleep(sleep);
            }
            catch (Exception ex)
            {
                _err = ex.GetType().Name + ": " + ex.Message;
                Thread.Sleep(300);
            }
        }

        if (hbmp != IntPtr.Zero) { SelectObject(hdcMem, hOld); DeleteObject(hbmp); }
        if (hdcMem != IntPtr.Zero) DeleteDC(hdcMem);
    }

    // Detecta el fogonazo de una explosión por DIFERENCIA DE LUMINANCIA contra un
    // fondo que se aprende solo. Filtrar por color no servía: el desierto es
    // naranja todo el rato y el núcleo de la bomba es blanco (se escapaba del
    // filtro). Lo que distingue una bomba es que "de repente hay luz donde no la
    // había", y eso se mide igual con cualquier paleta.
    //
    // _power/_cx/_cy siguen publicando el naranja total (lo usa el visor para el
    // resplandor). _spike/_scx/_scy son el fogonazo: cuántas celdas se han
    // iluminado de golpe y dónde, y se mantienen 2,5 s para que el motor, que
    // sondea a 1 Hz, no se los pierda.
    static void DetectExplosion(IntPtr bits, int w, int h)
    {
        int stride = w * 4;
        byte[] buf = new byte[stride * h];
        Marshal.Copy(bits, buf, 0, buf.Length);

        // --- 1) naranja total (resplandor del visor) ---
        long sx = 0, sy = 0;
        int count = 0;
        int stepX = Math.Max(1, w / 260);
        int stepY = Math.Max(1, h / 210);
        for (int y = 0; y < h; y += stepY)
        {
            int row = y * stride;
            for (int x = 0; x < w; x += stepX)
            {
                int i = row + x * 4;
                byte b = buf[i], g = buf[i + 1], rr = buf[i + 2];
                if (rr > 205 && g > 55 && g < 165 && b < 95) { count++; sx += x; sy += y; }
            }
        }
        _power = count;
        if (count > 40)
        {
            _rcx = (int)((double)sx / count / w * 10000);
            _rcy = (int)((double)sy / count / h * 10000);
        }
        else { _rcx = -1; _rcy = -1; }

        // --- 2) rejilla de luminancia ---
        int n = GRID_W * GRID_H;
        if (_bg == null) { _bg = new double[n]; _bgReady = false; }
        byte[] lum = new byte[n];
        int cw = Math.Max(1, w / GRID_W), ch = Math.Max(1, h / GRID_H);
        for (int gy = 0; gy < GRID_H; gy++)
        {
            int y0 = Math.Min(h - 1, gy * ch);
            int y1 = Math.Min(h - 1, y0 + ch / 2);
            for (int gx = 0; gx < GRID_W; gx++)
            {
                int x0 = Math.Min(w - 1, gx * cw);
                int x1 = Math.Min(w - 1, x0 + cw / 2);
                int i = y0 * stride + x0 * 4;
                int j = y1 * stride + x1 * 4;
                int l1 = (buf[i + 2] * 299 + buf[i + 1] * 587 + buf[i] * 114) / 1000;
                int l2 = (buf[j + 2] * 299 + buf[j + 1] * 587 + buf[j] * 114) / 1000;
                lum[gy * GRID_W + gx] = (byte)((l1 + l2) / 2);
            }
        }

        // --- 3) ¿qué celdas se han iluminado de golpe? ---
        // Dos umbrales: SPIKE_MIN cuenta "algo se ha iluminado" (dispara la cámara)
        // y CORE_MIN marca el núcleo del fogonazo, que es el único que entra en el
        // centroide. Si se promediara todo lo iluminado, los incendios viejos de
        // otras zonas arrastrarían el punto y la cámara enfocaría donde no toca.
        int spike = 0;
        int core = 0;
        long bx = 0, by = 0;
        // centroide de TODO lo iluminado: es el centro del fogonazo cuando el
        // destello es ancho y no tiene núcleo blanco (napalm, explosiones grandes)
        long ax = 0, ay = 0;
        for (int i = 0; i < n; i++)
        {
            int cur = lum[i];
            if (!_bgReady) { _bg[i] = cur; continue; }
            int d = cur - (int)_bg[i];
            if (d > 26)
            {
                spike++;
                ax += (i % GRID_W);
                ay += (i / GRID_W);
                if (d > 70)
                {
                    core++;
                    bx += (i % GRID_W);
                    by += (i / GRID_W);
                }
                // el fuego sostenido acaba entrando en el fondo (si no, la cámara
                // se quedaría clavada toda la partida)
                _bg[i] += 0.02 * d;
            }
            else if (d > -30 && d < 30)
            {
                _bg[i] += 0.015 * d;
            }
        }
        if (!_bgReady) { _bgReady = true; return; }

        _base = count;
        // Pico del frame actual: esto es lo que muestrea el motor para buscar el
        // máximo de la ventana (el latch de abajo se queda pegado al último valor).
        _lspike = spike;
        // Centro del fogonazo: si hay núcleo blanco, el núcleo; si el destello es
        // ancho y débil (napalm), el centroide de todo lo iluminado. Antes, cuando
        // no había núcleo, se conservaba el punto del fogonazo ANTERIOR y el motor
        // apuntaba a la bomba que ya había estallado.
        int px = -1, py = -1;
        if (core > 4)
        {
            px = (int)((double)bx / core / GRID_W * 10000);
            py = (int)((double)by / core / GRID_H * 10000);
        }
        else if (spike > 30 && spike < (int)(n * 0.7))
        {
            // >70% de la rejilla iluminada = flash global (rayo, cambio de luz,
            // ventana), no una bomba: no se publica punto.
            px = (int)((double)ax / spike / GRID_W * 10000);
            py = (int)((double)ay / spike / GRID_H * 10000);
        }
        _rlcx = px; _rlcy = py;
        if (spike > 30)
        {
            _spike = spike;
            if (px >= 0) { _rscx = px; _rscy = py; }
            _lastSpikeTicks = Stopwatch.GetTimestamp();
            _spikeUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }
        else
        {
            long ageMs = (long)((Stopwatch.GetTimestamp() - _lastSpikeTicks) * 1000.0 / Stopwatch.Frequency);
            if (ageMs > 2500) { _spike = 0; }
        }
    }

    // ---------- HTTP ----------
    static void ServerLoop()
    {
        while (_run)
        {
            try
            {
                TcpClient client = _listener.AcceptTcpClient();
                Thread t = new Thread(delegate () { HandleClient(client); });
                t.IsBackground = true;
                t.Start();
            }
            catch { if (!_run) break; Thread.Sleep(100); }
        }
    }

    static void HandleClient(TcpClient client)
    {
        try
        {
            client.NoDelay = true;
            NetworkStream ns = client.GetStream();
            ns.ReadTimeout = 5000;
            string head = ReadHead(ns);
            if (head == null) { client.Close(); return; }
            string first = head.Split('\n')[0];
            string[] parts = first.Split(' ');
            string path = parts.Length >= 2 ? parts[1] : "/";
            int q = path.IndexOf('?');
            if (q >= 0) path = path.Substring(0, q);

            if (path == "/stream.mjpg" || path == "/stream")
            {
                WriteAscii(ns, "HTTP/1.1 200 OK\r\n"
                    + "Content-Type: multipart/x-mixed-replace; boundary=wbframe\r\n"
                    + "Cache-Control: no-store, no-cache, must-revalidate\r\n"
                    + "Pragma: no-cache\r\n"
                    + "Access-Control-Allow-Origin: *\r\n"
                    + "Connection: close\r\n\r\n");
                int lastSeq = -1;
                while (_run && client.Connected)
                {
                    int s = _seq;
                    if (s == lastSeq) { Thread.Sleep(5); continue; }
                    lastSeq = s;
                    byte[] f = _latest;
                    if (f == null || f.Length == 0) { Thread.Sleep(10); continue; }
                    string hdr = "--wbframe\r\nContent-Type: image/jpeg\r\nContent-Length: " + f.Length + "\r\n\r\n";
                    WriteAscii(ns, hdr);
                    ns.Write(f, 0, f.Length);
                    WriteAscii(ns, "\r\n");
                    ns.Flush();
                }
            }
            else if (path == "/frame.jpg" || path == "/frame")
            {
                byte[] f = _latest;
                if (f == null || f.Length == 0)
                {
                    WriteAscii(ns, "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                }
                else
                {
                    WriteAscii(ns, "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: " + f.Length + "\r\nConnection: close\r\n\r\n");
                    ns.Write(f, 0, f.Length);
                    ns.Flush();
                }
            }
            else if (path == "/stats")
            {
                byte[] body = Encoding.UTF8.GetBytes(Stats());
                WriteAscii(ns, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: " + body.Length + "\r\nConnection: close\r\n\r\n");
                ns.Write(body, 0, body.Length);
                ns.Flush();
            }
            else if (path == "/health")
            {
                byte[] body = Encoding.UTF8.GetBytes("ok");
                WriteAscii(ns, "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\n");
                ns.Write(body, 0, body.Length);
                ns.Flush();
            }
            else
            {
                WriteAscii(ns, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            }
            try { client.Close(); } catch { }
        }
        catch
        {
            try { client.Close(); } catch { }
        }
    }

    static string ReadHead(NetworkStream ns)
    {
        MemoryStream ms = new MemoryStream();
        byte[] one = new byte[1];
        int matched = 0;
        while (ms.Length < 8192)
        {
            int n;
            try { n = ns.Read(one, 0, 1); } catch { return null; }
            if (n <= 0) break;
            ms.WriteByte(one[0]);
            if (one[0] == (byte)'\n') matched++;
            else if (one[0] == (byte)'\r') { }
            else matched = 0;
            if (matched >= 2) break;
        }
        if (ms.Length == 0) return null;
        return Encoding.ASCII.GetString(ms.ToArray());
    }

    static void WriteAscii(NetworkStream ns, string s)
    {
        byte[] b = Encoding.ASCII.GetBytes(s);
        ns.Write(b, 0, b.Length);
    }
}
'@

$refDir = Join-Path $psHomeDir 'ref'
function Resolve-Ref([string]$name)
{
    foreach ($base in @($refDir, $psHomeDir))
    {
        $p = Join-Path $base $name
        if (Test-Path $p) { return $p }
    }
    return $null
}

$refs = @(
    [System.Windows.Media.Imaging.BitmapSource].Assembly.Location,
    [System.Windows.Threading.DispatcherObject].Assembly.Location
)
if (Test-Path $refDir)
{
    $refs += Get-ChildItem $refDir -Filter '*.dll' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
}
$refs = $refs | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

Add-Type -TypeDefinition $cs -Language CSharp -ReferencedAssemblies $refs -ErrorAction Stop

Write-Host ([WbStream]::Start($Port, $MaxWidth, $Quality, $Fps, $ProcessName, $CropX0, $CropY0, $CropX1, $CropY1, [bool]$AutoCrop))
Write-Host ("stream: http://localhost:{0}/stream.mjpg" -f $Port)
Write-Host ("stats:  http://localhost:{0}/stats" -f $Port)

try
{
    while ($true)
    {
        Start-Sleep -Seconds 5
        Write-Host ([WbStream]::Stats())
    }
}
finally
{
    [WbStream]::Stop()
}
