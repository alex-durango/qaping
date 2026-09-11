// Win32 Raw Input capture and SendInput replay. Compiled by stock PowerShell;
// no driver, Python, package downloads or persistent background service.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public sealed class QapingDesktopInput : NativeWindow {
    // A non-activating status window, mouse-transparent after Start. Kept in
    // the capture so its timing is auditable.
    // https://learn.microsoft.com/windows/win32/winmsg/window-features#layered-windows
    sealed class StatusPanel : Form {
        [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window, int index);
        [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr window, int index, int value);
        readonly Rectangle screen;
        readonly Font headingFont = new Font("Segoe UI", 17, FontStyle.Bold);
        readonly Font detailFont = new Font("Segoe UI", 11);
        readonly Font countFont = new Font("Segoe UI", 40, FontStyle.Bold);
        string heading = "", detail = "", count = "";
        Color accent = Color.FromArgb(194, 242, 133);
        bool compact;
        bool startEnabled;
        Action start;
        string startLabel;
        readonly Rectangle startButton = new Rectangle(20, 68, 260, 48);
        public StatusPanel(IntPtr gameWindow) {
            screen = Screen.FromHandle(gameWindow).WorkingArea;
            Text = "Qaping recording status"; FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
            BackColor = Color.FromArgb(22, 29, 25); ForeColor = Color.White;
            Opacity = .96; DoubleBuffered = true; AutoScaleMode = AutoScaleMode.None;
            SetStatus("Ready", "", "", false, false);
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams {
            get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x00080000 | 0x80; if (!startEnabled) p.ExStyle |= 0x20; return p; }
        }
        public void SetStartEnabled(bool enabled) {
            if (enabled == startEnabled) return;
            startEnabled = enabled;
            if (IsHandleCreated) {
                int style = GetWindowLong(Handle, -20);
                SetWindowLong(Handle, -20, enabled ? style & ~0x20 : style | 0x20);
            }
            Invalidate();
        }
        public void Ready(string mode, Action onStart) {
            start = onStart; startLabel = mode == "record" ? "Start recording" : "Start replay";
            SetStartEnabled(true);
            SetStatus(mode == "record" ? "Qaping: ready to record" : "Qaping: ready to replay",
                "Ready when you are. F9 starts. F8 cancels.", "", false, false);
        }
        protected override void OnMouseUp(MouseEventArgs e) {
            base.OnMouseUp(e);
            if (startEnabled && e.Button == MouseButtons.Left && startButton.Contains(e.Location)) start();
        }
        public void SetStatus(string title, string subtitle, string number, bool small, bool stopped) {
            if (heading == title && detail == subtitle && count == number && compact == small) return;
            heading = title; detail = subtitle; count = number; compact = small;
            accent = stopped ? Color.FromArgb(245, 184, 99) : Color.FromArgb(194, 242, 133);
            Size = small ? new Size(360, 100) : new Size(480, 172);
            Location = small ? new Point(screen.Right - Width - 24, screen.Top + 44)
                : new Point(screen.Left + (screen.Width - Width) / 2, screen.Top + 76);
            Invalidate();
        }
        protected override void OnPaint(PaintEventArgs e) {
            base.OnPaint(e);
            using (var brush = new SolidBrush(accent)) {
                e.Graphics.FillRectangle(brush, 0, 0, 5, Height);
                e.Graphics.DrawString(heading, headingFont, brush, 20, 12);
                if (count.Length > 0) e.Graphics.DrawString(count, countFont, brush, 205, 43);
                if (startEnabled) {
                    e.Graphics.FillRectangle(brush, startButton);
                    e.Graphics.DrawString(startLabel, headingFont, Brushes.Black, 33, 74);
                }
            }
            e.Graphics.DrawString(detail, detailFont, Brushes.White, 20, compact ? 61 : 139);
        }
        protected override void Dispose(bool disposing) {
            if (disposing) { headingFont.Dispose(); detailFont.Dispose(); countFont.Dispose(); }
            base.Dispose(disposing);
        }
    }
    [StructLayout(LayoutKind.Sequential)] struct Device { public ushort page, usage; public uint flags; public IntPtr target; }
    [StructLayout(LayoutKind.Sequential)] struct Header { public uint type, size; public IntPtr device, wParam; }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int dx, dy; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KeyInput { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct Union { [FieldOffset(0)] public MouseInput mouse; [FieldOffset(0)] public KeyInput key; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public Union data; }
    [StructLayout(LayoutKind.Sequential)] struct NativePoint { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct NativeRect { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] struct CursorInfo { public uint size, flags; public IntPtr cursor; public NativePoint point; }
    [DllImport("user32.dll", SetLastError=true)] static extern bool RegisterRawInputDevices(Device[] devices, uint count, uint size);
    [DllImport("user32.dll", SetLastError=true)] static extern uint GetRawInputData(IntPtr handle, uint command, IntPtr data, ref uint size, uint headerSize);
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", SetLastError=true)] static extern bool GetCursorInfo(ref CursorInfo info);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out NativeRect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref NativePoint point);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(NativePoint point);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);
    [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint ms);
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 256 * 1024 * 1024, RecursionLimit = 64 };
    readonly Stopwatch clock = new Stopwatch();
    readonly Dictionary<string, Dictionary<string, object>> held = new Dictionary<string, Dictionary<string, object>>();
    readonly ConcurrentQueue<string> commands = new ConcurrentQueue<string>();
    Process target;
    StatusPanel panel;
    string mode, reason;
    bool active, done, f9Pressed, loaded, captureReady, preparing, pointerMode;
    int maxSeconds, delayMs, next, countdownMs, pendingCountdownMs, lastCountdown = -1;
    double duration, startAt = -1, preparingAt, lastStatusMs = -1000;
    object[] timeline;
    readonly Stopwatch lifetime = Stopwatch.StartNew();
    const uint Marker = 0x51415049;
    static bool Down(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }
    static int Int(Dictionary<string, object> o, string key) { return Convert.ToInt32(o[key]); }
    static string Str(Dictionary<string, object> o, string key) { return (string)o[key]; }
    void Emit(object value) { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); }
    bool Focused() { uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return pid == target.Id; }
    double Now() { return Math.Round(clock.Elapsed.TotalMilliseconds, 3); }
    bool Neutral() {
        for (int k = 1; k < 255; k++) if (k != 0x77 && k != 0x78 && Down(k)) return false;
        return true;
    }
    void Stop(string why) { if (done) return; reason = why; done = true; clock.Stop(); }
    void BeginCountdown(int milliseconds) {
        if (panel != null) panel.SetStartEnabled(false);
        if (!captureReady) {
            preparing = true; pendingCountdownMs = milliseconds;
            preparingAt = lifetime.Elapsed.TotalMilliseconds;
            if (panel != null) panel.SetStatus("Preparing video", "The countdown will begin in a moment. F8 cancels.", "", false, false);
            Emit(new { @event="prepare_capture", mode=mode });
            return;
        }
        startAt = lifetime.Elapsed.TotalMilliseconds + milliseconds;
        lastCountdown = -1;
    }
    void TickCountdown() {
        int seconds = Math.Max(0, (int)Math.Ceiling((startAt - lifetime.Elapsed.TotalMilliseconds) / 1000));
        if (seconds != lastCountdown) {
            lastCountdown = seconds;
            Emit(new { @event="countdown", seconds=seconds, mode=mode });
            if (panel != null) panel.SetStatus(mode == "record" ? "Recording starts in" : "Replay starts in",
                mode == "record" ? "Wait for REC, then resume your game and play." : "Release controls. Wait for REPLAY.", seconds.ToString(), false, false);
        }
        if (lifetime.Elapsed.TotalMilliseconds >= startAt) {
            if (!Focused() || !Neutral()) Stop("start_not_ready"); else Start();
        }
    }
    void UpdateStatus() {
        if (panel == null || !active || lifetime.Elapsed.TotalMilliseconds - lastStatusMs < 100) return;
        lastStatusMs = lifetime.Elapsed.TotalMilliseconds;
        var elapsed = TimeSpan.FromMilliseconds(Now());
        string timer = String.Format("{0:00}:{1:00}", (int)elapsed.TotalMinutes, elapsed.Seconds);
        panel.SetStatus((mode == "record" ? "REC  " : "REPLAY  ") + timer,
            mode == "record" ? "Play normally. F8 stops and saves." : "Automatic replay. F8 stops.", "", true, false);
    }
    void Start() {
        if (!Focused() || !Neutral()) return;
        active = true; clock.Start();
        Emit(new { @event = "started", utc_ms = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
        UpdateStatus();
    }
    void Record(Dictionary<string, object> input) {
        if (!active || done || !Focused()) return;
        if (Str(input, "kind") != "key") input["cursor"] = CaptureCursor();
        string id = Identity(input);
        if (id != null) {
            bool down = (bool)input["down"];
            if (!down && !held.ContainsKey(id)) return;
            if (down) held[id] = input; else held.Remove(id);
        }
        Emit(new { t_ms = Now(), input = input });
    }
    CursorInfo CursorState() {
        var info = new CursorInfo { size = (uint)Marshal.SizeOf(typeof(CursorInfo)) };
        if (!GetCursorInfo(ref info)) throw new Exception("Cannot read menu cursor state");
        return info;
    }
    Rectangle ClientBounds() {
        NativeRect rect; var origin = new NativePoint();
        if (!GetClientRect(target.MainWindowHandle, out rect) || !ClientToScreen(target.MainWindowHandle, ref origin))
            throw new Exception("Cannot read game client area");
        return new Rectangle(origin.x, origin.y, rect.right - rect.left, rect.bottom - rect.top);
    }
    Dictionary<string, object> CaptureCursor() {
        var info = CursorState();
        return CursorPosition((info.flags & 1) != 0, info.point.x, info.point.y, ClientBounds(), pointerMode);
    }
    static Dictionary<string, object> CursorPosition(bool visible, int screenX, int screenY, Rectangle bounds, bool pointerMode) {
        if (!visible && !pointerMode) return null; // automatic mode preserves hidden-camera deltas
        int x = screenX - bounds.Left, y = screenY - bounds.Top;
        if (x < 0 || y < 0 || x >= bounds.Width || y >= bounds.Height)
            throw new Exception("Pointer left the game client area");
        var cursor = new Dictionary<string, object> { {"x", x}, {"y", y}, {"width", bounds.Width}, {"height", bounds.Height} };
        if (pointerMode) {
            cursor["space"] = "client-normalized";
            cursor["u"] = (x + .5) / bounds.Width; cursor["v"] = (y + .5) / bounds.Height;
        }
        return cursor;
    }
    static bool Normalized(Dictionary<string, object> cursor) {
        return cursor.ContainsKey("space") && Str(cursor, "space") == "client-normalized";
    }
    static Point CursorPoint(Dictionary<string, object> cursor, Rectangle client) {
        int width = Int(cursor, "width"), height = Int(cursor, "height");
        int x = Int(cursor, "x"), y = Int(cursor, "y");
        if (width < 1 || height < 1 || x < 0 || y < 0 || x >= width || y >= height || client.Width < 1 || client.Height < 1)
            throw new Exception("Recorded pointer is outside the game client area");
        if (Normalized(cursor)) {
            double u = Convert.ToDouble(cursor["u"]), v = Convert.ToDouble(cursor["v"]);
            if (Double.IsNaN(u) || Double.IsNaN(v) || Math.Abs(u - (x + .5) / width) > 1e-9 || Math.Abs(v - (y + .5) / height) > 1e-9)
                throw new Exception("Invalid normalized pointer position");
            if (Math.Abs((double)client.Width * height / (client.Height * (double)width) - 1) > .01)
                throw new Exception("Game aspect ratio differs from recording; restore the same proportions before replay");
            x = Math.Min(client.Width - 1, (int)Math.Floor(u * client.Width));
            y = Math.Min(client.Height - 1, (int)Math.Floor(v * client.Height));
        } else if (client.Width != width || client.Height != height)
            throw new Exception("Game client size differs from recording; restore the recorded window size");
        return new Point(client.Left + x, client.Top + y);
    }
    // Pixel-center normalization avoids desktop acceleration and supports a
    // moved window / negative monitor origin. Pointer mode scales the client;
    // legacy menu samples require the original client size.
    // https://learn.microsoft.com/windows/win32/api/winuser/ns-winuser-mouseinput
    static Input EncodeCursor(Input input, Dictionary<string, object> cursor, Rectangle client, Rectangle desktop) {
        var point = CursorPoint(cursor, client);
        if (!desktop.Contains(point)) throw new Exception("Recorded menu cursor is outside the current desktop");
        input.data.mouse.dx = Math.Min(65535, (int)Math.Floor((point.X - desktop.Left + .5) * 65536 / desktop.Width));
        input.data.mouse.dy = Math.Min(65535, (int)Math.Floor((point.Y - desktop.Top + .5) * 65536 / desktop.Height));
        input.data.mouse.flags |= 0xe001; // MOVE | NOCOALESCE | VIRTUALDESK | ABSOLUTE
        return input;
    }
    static string Identity(Dictionary<string, object> e) {
        string kind = Str(e, "kind");
        if (kind == "key") return "k" + e["scan"] + ":" + e["extended"];
        if (kind == "button") return "b" + e["button"];
        return null;
    }
    static Dictionary<string, object> Event(string kind) { return new Dictionary<string, object> { {"kind", kind} }; }
    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x00ff && mode == "record" && active && !done) {
            try { ReadRaw(m.LParam); } catch (Exception ex) { Emit(new { @event="error", message=ex.Message }); Stop("input_error"); }
        }
        base.WndProc(ref m);
    }
    void ReadRaw(IntPtr handle) {
        if (!Focused()) { Stop("focus_lost"); return; }
        uint size = 0, hs = (uint)Marshal.SizeOf(typeof(Header));
        if (GetRawInputData(handle, 0x10000003, IntPtr.Zero, ref size, hs) == uint.MaxValue) throw new Exception("GetRawInputData size failed");
        IntPtr buffer = Marshal.AllocHGlobal((int)size);
        try {
            if (GetRawInputData(handle, 0x10000003, buffer, ref size, hs) != size) throw new Exception("GetRawInputData failed");
            Header h = (Header)Marshal.PtrToStructure(buffer, typeof(Header));
            // Synthetic legacy input has no physical device. Never label it as
            // a physical recording, including this feeder's own SendInput.
            if (h.device == IntPtr.Zero) return;
            IntPtr p = IntPtr.Add(buffer, (int)hs);
            if (h.type == 1) {
                int scan = (ushort)Marshal.ReadInt16(p, 0), flags = (ushort)Marshal.ReadInt16(p, 2), vk = (ushort)Marshal.ReadInt16(p, 6);
                if (vk == 255 || vk == 0x77 || vk == 0x78) return;
                if (vk == 0x5b || vk == 0x5c) { Stop("reserved_key"); return; }
                if ((flags & 4) != 0 || scan < 1 || scan > 127) throw new Exception("Unsupported E1 or unmapped keyboard scan code");
                var e = Event("key"); e["scan"] = scan; e["extended"] = (flags & 2) != 0; e["down"] = (flags & 1) == 0; Record(e);
            } else if (h.type == 0) {
                int flags = (ushort)Marshal.ReadInt16(p, 0), buttons = (ushort)Marshal.ReadInt16(p, 4);
                if ((flags & 1) != 0) throw new Exception("Absolute pointing devices are unsupported; use a relative mouse");
                int dx = Marshal.ReadInt32(p, 12), dy = Marshal.ReadInt32(p, 16);
                if (dx != 0 || dy != 0) { var e = Event("move"); e["dx"] = dx; e["dy"] = dy; Record(e); }
                string[] names = { "left", "right", "middle", "x1", "x2" };
                for (int i = 0; i < names.Length; i++) for (int up = 0; up < 2; up++) if ((buttons & (1 << (i * 2 + up))) != 0) {
                    var e = Event("button"); e["button"] = names[i]; e["down"] = up == 0; Record(e);
                }
                for (int i = 0; i < 2; i++) if ((buttons & (0x400 << i)) != 0) {
                    var e = Event("wheel"); e["axis"] = i == 0 ? "vertical" : "horizontal"; e["delta"] = (int)Marshal.ReadInt16(p, 6); Record(e);
                }
            }
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static Input Encode(Dictionary<string, object> e) {
        Input input = new Input();
        string kind = Str(e, "kind");
        input.data.mouse.extra = new UIntPtr(Marker);
        if (kind == "key") {
            input.type = 1;
            input.data.key = new KeyInput { scan = (ushort)Int(e, "scan"), flags = 8u | ((bool)e["extended"] ? 1u : 0u) | ((bool)e["down"] ? 0u : 2u), extra = new UIntPtr(Marker) };
        } else if (kind == "move") {
            input.data.mouse.dx = Int(e, "dx"); input.data.mouse.dy = Int(e, "dy"); input.data.mouse.flags = 0x2001; // MOVE | NOCOALESCE
        } else if (kind == "wheel") {
            input.data.mouse.flags = Str(e, "axis") == "vertical" ? 0x800u : 0x1000u;
            input.data.mouse.data = unchecked((uint)Int(e, "delta"));
        } else if (kind == "button") {
            string b = Str(e, "button"); bool down = (bool)e["down"];
            switch (b) {
                case "left": input.data.mouse.flags = down ? 2u : 4u; break;
                case "right": input.data.mouse.flags = down ? 8u : 16u; break;
                case "middle": input.data.mouse.flags = down ? 32u : 64u; break;
                case "x1": case "x2": input.data.mouse.flags = down ? 0x80u : 0x100u; input.data.mouse.data = b == "x1" ? 1u : 2u; break;
                default: throw new Exception("Unsupported mouse button");
            }
        } else throw new Exception("Unsupported input kind");
        return input;
    }
    void Inject(Dictionary<string, object> e) {
        if (!Focused()) { Stop("focus_lost"); return; }
        Input input = Encode(e);
        object cursor;
        if (e.TryGetValue("cursor", out cursor) && cursor != null) {
            var state = CursorState();
            var c = (Dictionary<string, object>)cursor;
            if ((state.flags & 1) == 0 && !Normalized(c)) throw new Exception("Recorded menu cursor is visible but the game cursor is hidden");
            var client = ClientBounds();
            var point = CursorPoint(c, client);
            var positioned = EncodeCursor(Encode(EventMove()), c, client, SystemInformation.VirtualScreen);
            uint owner;
            GetWindowThreadProcessId(WindowFromPoint(new NativePoint { x=point.X, y=point.Y }), out owner);
            if (owner != target.Id) throw new Exception("Recorded menu point is covered by another window");
            if (Str(e, "kind") == "move") input = positioned;
            else if (state.point.x != point.X || state.point.y != point.Y) {
                // Some games resolve a button against their last processed move.
                // Position first; a combined MOVE+DOWN can click the old control.
                if (SendInput(1, new Input[] { positioned }, Marshal.SizeOf(typeof(Input))) != 1) throw new Exception("SendInput refused menu positioning");
                Thread.Sleep(35);
                if (!Focused() || Down(0x77)) { Stop(Down(0x77) ? "operator" : "focus_lost"); return; }
                GetWindowThreadProcessId(WindowFromPoint(new NativePoint { x=point.X, y=point.Y }), out owner);
                if (owner != target.Id || ClientBounds() != client) throw new Exception("Game menu changed during cursor positioning");
            }
        }
        if (SendInput(1, new Input[] { input }, Marshal.SizeOf(typeof(Input))) != 1) throw new Exception("SendInput refused input (check target integrity level)");
        string id = Identity(e);
        if (id != null) { if ((bool)e["down"]) held[id] = e; else held.Remove(id); }
    }
    static Dictionary<string, object> EventMove() {
        return new Dictionary<string, object> { {"kind", "move"}, {"dx", 0}, {"dy", 0} };
    }
    void ReleaseAll() {
        if (mode != "replay") return;
        foreach (var value in held.Values) {
            var e = new Dictionary<string, object>(value); e["down"] = false;
            if (SendInput(1, new Input[] { Encode(e) }, Marshal.SizeOf(typeof(Input))) != 1)
                Emit(new { @event="error", message="Could not release a held input" });
        }
        held.Clear();
    }
    void Command(string line) {
        if (line == "__EOF__") { Stop("parent_closed"); return; }
        var c = json.Deserialize<Dictionary<string, object>>(line);
        string op = Str(c, "op");
        if (op == "stop") { Stop("operator"); return; }
        if (op == "capture_failed") { Stop("capture_error"); return; }
        if (op == "capture_ready" && preparing) { captureReady = true; preparing = false; BeginCountdown(pendingCountdownMs); return; }
        if (op == "start" && !active && !preparing && startAt < 0 && (mode == "record" || loaded)) { BeginCountdown(countdownMs); return; }
        if (op != "play" || mode != "replay" || loaded) throw new Exception("Unexpected input command");
        timeline = ((ArrayList)c["timeline"]).ToArray(); duration = Convert.ToDouble(c["duration_ms"]); loaded = true;
        if (delayMs >= 0) BeginCountdown(delayMs);
        Emit(new { @event="armed", mode=mode });
    }
    void Loop() {
        while (!done) {
            Application.DoEvents();
            string line;
            while (!done && commands.TryDequeue(out line)) Command(line);
            if (done) break;
            if (target.HasExited) { Stop("game_exit"); break; }
            if ((GetAsyncKeyState(0x77) & 0x8001) != 0) { Stop("operator"); break; }
            if (active) {
                if (!Focused()) { Stop("focus_lost"); break; }
                if (clock.Elapsed.TotalSeconds >= maxSeconds) { Stop("budget"); break; }
                UpdateStatus();
                if (mode == "replay") {
                    while (next < timeline.Length && !done) {
                        var e = (Dictionary<string, object>)timeline[next];
                        if (Convert.ToDouble(e["t_ms"]) > clock.Elapsed.TotalMilliseconds) break;
                        if (Down(0x77)) { Stop("operator"); break; }
                        Inject((Dictionary<string, object>)e["input"]);
                        if (done) break;
                        Emit(new { @event="sent", seq=next, at_ms=Now() }); next++;
                    }
                    if (!done && next == timeline.Length && clock.Elapsed.TotalMilliseconds >= duration) Stop("script_end");
                }
            } else if (mode == "record" || loaded) {
                if (preparing) {
                    if (lifetime.Elapsed.TotalMilliseconds - preparingAt > 15000) Stop("capture_error");
                } else if (startAt >= 0) TickCountdown();
                else {
                    short f9 = GetAsyncKeyState(0x78);
                    if (Focused() && (f9 & 0x8001) != 0) f9Pressed = true;
                    if (f9Pressed && (f9 & 0x8000) == 0 && Focused() && Neutral()) BeginCountdown(countdownMs);
                }
            }
            // Waiting for the person's Start is not recording time. Keep the
            // button available until Start, F8, game exit or parent shutdown.
            Thread.Sleep(1);
        }
    }
    public static void Run(int pid, string mode, int maxSeconds, int startDelayMs, int countdownMs, bool showStatus, bool waitForCapture, bool pointerMode = false) {
        var app = new QapingDesktopInput { mode=mode, maxSeconds=maxSeconds, delayMs=startDelayMs, countdownMs=countdownMs, captureReady=!waitForCapture, pointerMode=pointerMode };
        try {
            // Use device pixels consistently for cursor capture, client bounds,
            // and the virtual desktop. This affects only the helper thread.
            if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) throw new Exception("Cannot select physical-pixel coordinates");
            if (Marshal.SizeOf(typeof(Input)) != (IntPtr.Size == 8 ? 40 : 28)) throw new Exception("Invalid native INPUT layout");
            if (mode == "probe") { app.Emit(new { @event="ready", backend="win32-rawinput-sendinput", input_size=Marshal.SizeOf(typeof(Input)) }); return; }
            if (maxSeconds < 1 || maxSeconds > 2100 || startDelayMs < -1 || startDelayMs > 120000 || countdownMs < 0 || countdownMs > 30000) throw new Exception("Invalid time limit");
            app.target = Process.GetProcessById(pid);
            // Retain the process handle: later checks refer to this process,
            // never a new game that happens to reuse the PID.
            IntPtr retained = app.target.Handle;
            app.CreateHandle(new CreateParams { Caption="Qaping input receiver", Parent=new IntPtr(-3) });
            if (mode == "record") {
                var devices = new Device[] {
                    new Device { page=1, usage=2, flags=0x100, target=app.Handle },
                    new Device { page=1, usage=6, flags=0x100, target=app.Handle }
                };
                if (!RegisterRawInputDevices(devices, 2, (uint)Marshal.SizeOf(typeof(Device)))) throw new Exception("Raw Input registration failed");
            }
            if (showStatus) {
                app.panel = new StatusPanel(app.target.MainWindowHandle);
                app.panel.SetStatus(mode == "record" ? "Qaping: ready to record" : "Qaping: ready to replay",
                    startDelayMs >= 0 ? "Countdown starting. F8 cancels." : "F9 starts the countdown. F8 cancels.", "", false, false);
                if (startDelayMs < 0) app.panel.Ready(mode, () => {
                    if (app.active || app.preparing || app.startAt >= 0 || (mode == "replay" && !app.loaded)) return;
                    // One focus request, only from the person's Start click.
                    // Never restore focus after a loss during recording/replay.
                    SetForegroundWindow(app.target.MainWindowHandle);
                    app.BeginCountdown(countdownMs);
                });
                app.panel.Show();
                Application.DoEvents();
            }
            Rectangle? client = app.target.MainWindowHandle == IntPtr.Zero ? (Rectangle?)null : app.ClientBounds();
            app.Emit(new { @event="ready", pid=pid, exe=app.target.MainModule.FileName, mode=mode,
                client=client, cursor_visible=(app.CursorState().flags & 1) != 0 });
            if (mode == "record" && startDelayMs >= 0) app.BeginCountdown(startDelayMs);
            GetAsyncKeyState(0x77); GetAsyncKeyState(0x78); // discard transport taps from before this session
            var reader = new Thread(() => { try { string line; while ((line = Console.ReadLine()) != null) app.commands.Enqueue(line); } finally { app.commands.Enqueue("__EOF__"); } });
            reader.IsBackground = true; reader.Start();
            timeBeginPeriod(1);
            app.Loop();
        } catch (Exception ex) { app.Emit(new { @event="error", message=ex.Message }); app.reason="input_error"; }
        finally {
            app.clock.Stop();
            app.ReleaseAll();
            if (app.Handle != IntPtr.Zero) app.DestroyHandle();
            timeEndPeriod(1);
            if (mode != "probe") app.Emit(new { @event="stopped", reason=app.reason, duration_ms=app.Now(), started=app.active, sent=app.next });
            if (app.panel != null) {
                string detail = app.reason == "start_not_ready" ? "Game needs focus and released controls."
                    : app.reason == "capture_error" ? "Video capture failed. Check recorder output."
                    : app.reason == "focus_lost" ? "Game lost focus. Finishing files."
                    : app.reason == "input_error" ? "Input error. Check the recorder output."
                    : app.active ? "Finishing files. Check the recorder output." : "No session recorded.";
                app.panel.SetStatus(app.active ? "Session stopped" : "Did not start", detail, "", true, true);
                var finish = Stopwatch.StartNew();
                while (finish.ElapsedMilliseconds < 1800) { Application.DoEvents(); Thread.Sleep(15); }
                app.panel.Dispose();
            }
            if (app.target != null) app.target.Dispose();
        }
    }
}
