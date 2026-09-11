using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public sealed class QapingRigDesktop : Form {
    sealed class GameChoice {
        public int Pid; public string Exe; public string Title;
        public override string ToString() { return Title + "  (" + Path.GetFileNameWithoutExtension(Exe) + ")"; }
    }
    sealed class SavedChoice {
        public string Id; public string Label; public bool Video;
        public override string ToString() { return Label; }
    }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rectangle);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly ComboBox games = new ComboBox();
    readonly ComboBox mouseMode = new ComboBox();
    readonly ListBox sessions = new ListBox();
    readonly CheckBox video = new CheckBox();
    readonly CheckBox restored = new CheckBox();
    readonly Label status = new Label();
    readonly TextBox details = new TextBox();
    Button record, replay, stop, refresh, import, watch, folder;
    bool busy, closeAfterStop, canWatch;
    readonly Color ink = Color.FromArgb(24, 32, 43);
    readonly Color blue = Color.FromArgb(38, 92, 223);
    void Emit(object value) { Console.Out.WriteLine(json.Serialize(value)); Console.Out.Flush(); }
    static string TextValue(Dictionary<string, object> data, string key) { return data.ContainsKey(key) ? Convert.ToString(data[key]) : ""; }
    static bool Flag(Dictionary<string, object> data, string key) { return data.ContainsKey(key) && data[key] is bool && (bool)data[key]; }
    Label LabelAt(string text, int x, int y, int width, int height, float size) {
        Label label = new Label { Text=text, Location=new Point(x,y), Size=new Size(width,height), Font=new Font("Segoe UI",size), ForeColor=ink };
        Controls.Add(label); return label;
    }
    Button ButtonAt(string text, int x, int y, int width, EventHandler click, bool primary) {
        Button button = new Button { Text=text, Location=new Point(x,y), Size=new Size(width,42), FlatStyle=FlatStyle.Flat, BackColor=primary?blue:Color.White, ForeColor=primary?Color.White:ink, UseVisualStyleBackColor=false };
        button.FlatAppearance.BorderColor=Color.FromArgb(210,216,224); button.Click += click; Controls.Add(button); return button;
    }
    QapingRigDesktop() {
        Text="Qaping Replay"; ClientSize=new Size(800,750); MinimumSize=new Size(816,789); MaximumSize=new Size(816,789);
        StartPosition=FormStartPosition.CenterScreen; BackColor=Color.FromArgb(247,249,252);
        Font=new Font("Segoe UI",10); AutoScaleDimensions=new SizeF(96,96); AutoScaleMode=AutoScaleMode.Dpi;
        LabelAt("Record once. Replay your play.",24,20,744,44,24);
        LabelAt("Choose your game, record a session, then replay it from the same starting point.",26,70,744,38,11);
        LabelAt("YOUR RUNNING GAME",26,114,600,24,9);
        games.Location=new Point(26,140); games.Size=new Size(596,32); games.DropDownStyle=ComboBoxStyle.DropDownList; games.SelectedIndexChanged += delegate { Buttons(); }; Controls.Add(games);
        refresh=ButtonAt("Refresh",636,134,136,delegate { RefreshGames(); },false);
        LabelAt("Moving the mouse…",26,185,180,28,10);
        mouseMode.Location=new Point(210,183); mouseMode.Size=new Size(560,32); mouseMode.DropDownStyle=ComboBoxStyle.DropDownList;
        mouseMode.Items.Add("Turns my view"); mouseMode.Items.Add("Moves a cursor on screen"); mouseMode.SelectedIndex=0; Controls.Add(mouseMode);
        LabelAt("Choose what happens during play. Menus are recorded in both.",26,218,744,28,10);
        video.Text="Include video (free tool downloads once if needed: 161 MB)"; video.Checked=true; video.Location=new Point(26,255); video.Size=new Size(744,30); Controls.Add(video);
        record=ButtonAt("Record new session",26,297,280,delegate { StartSession("record"); },true);
        stop=ButtonAt("Stop",322,297,120,delegate { Emit(new {type="stop"}); },false);
        LabelAt("Pause at your starting point. Click Record, then play after the countdown. F8 stops.",26,351,744,42,10);
        status.Location=new Point(26,394); status.Size=new Size(744,60); status.Font=new Font("Segoe UI",11,FontStyle.Bold); status.ForeColor=blue; status.Text="Opening your session library…"; Controls.Add(status);
        LabelAt("SAVED SESSIONS",26,461,600,24,9);
        sessions.Location=new Point(26,487); sessions.Size=new Size(744,94); sessions.SelectedIndexChanged += delegate { restored.Checked=false; Buttons(); }; Controls.Add(sessions);
        restored.Text="I restored the starting save, camera and pause/menu state."; restored.Location=new Point(26,586); restored.Size=new Size(744,27); restored.CheckedChanged += delegate { Buttons(); }; Controls.Add(restored);
        replay=ButtonAt("Replay selected",26,620,192,delegate { StartSession("replay"); },true);
        watch=ButtonAt("Watch video",230,620,154,delegate { var saved=sessions.SelectedItem as SavedChoice; if(saved!=null) Emit(new {type="watch",session=saved.Id}); },false);
        import=ButtonAt("Import session",396,620,176,delegate { using(var dialog=new OpenFileDialog {Filter="Recorded input (*.kbmscript.json)|*.kbmscript.json|JSON (*.json)|*.json"}) { if(dialog.ShowDialog(this)==DialogResult.OK) Emit(new {type="import",file=dialog.FileName}); } },false);
        folder=ButtonAt("Open recordings",584,620,188,delegate { Emit(new {type="folder"}); },false);
        details.Location=new Point(26,680); details.Size=new Size(744,48); details.Multiline=true; details.ReadOnly=true; details.ScrollBars=ScrollBars.Vertical; details.BackColor=Color.White; details.BorderStyle=BorderStyle.FixedSingle; details.Visible=false; Controls.Add(details);
        var detailLink=new LinkLabel {Text="Show details",Location=new Point(671,461),Size=new Size(100,24)};
        detailLink.Click += delegate { details.Visible=!details.Visible; detailLink.Text=details.Visible?"Hide details":"Show details"; }; Controls.Add(detailLink);
        FormClosing += delegate(object sender, FormClosingEventArgs e) { if(busy) { e.Cancel=true; closeAfterStop=true; Emit(new {type="stop"}); status.Text="Stopping and saving your files…"; } };
        Shown += delegate {
            RefreshGames(); Emit(new {type="ready"});
            var reader=new Thread(delegate() {
                try { string line; while((line=Console.ReadLine())!=null) { string message=line; if(IsDisposed) break; BeginInvoke((Action)delegate { try { Apply(json.Deserialize<Dictionary<string,object>>(message)); } catch(Exception ex) { status.Text=ex.Message; } }); } }
                catch { }
                finally { if(!IsDisposed) try { BeginInvoke((Action)delegate { busy=false; Close(); }); } catch { } }
            }); reader.IsBackground=true; reader.Start();
        };
        Buttons();
    }
    void Buttons() {
        if(record==null || replay==null) return;
        record.Enabled=!busy && games.SelectedItem!=null;
        replay.Enabled=!busy && games.SelectedItem!=null && sessions.SelectedItem!=null && restored.Checked;
        stop.Enabled=busy; refresh.Enabled=!busy; import.Enabled=!busy; folder.Enabled=!busy;
        var selected=sessions.SelectedItem as SavedChoice;
        watch.Enabled=!busy && selected!=null && selected.Video;
        games.Enabled=!busy; sessions.Enabled=!busy; restored.Enabled=!busy; video.Enabled=!busy; mouseMode.Enabled=!busy;
    }
    static List<GameChoice> GameList() {
        var result=new List<GameChoice>();
        foreach(var process in Process.GetProcesses()) {
            using(process) try {
                string name=process.ProcessName.ToLowerInvariant();
                if(process.Id==Process.GetCurrentProcess().Id || process.MainWindowHandle==IntPtr.Zero || String.IsNullOrWhiteSpace(process.MainWindowTitle)) continue;
                if(name=="powershell" || name=="pwsh" || name=="cmd" || name=="windowsterminal" || name=="conhost" || name.StartsWith("qaping-desktop-")) continue;
                result.Add(new GameChoice {Pid=process.Id,Exe=process.MainModule.FileName,Title=process.MainWindowTitle});
            } catch { }
        }
        result.Sort(delegate(GameChoice a,GameChoice b) { return String.Compare(a.Title,b.Title,StringComparison.OrdinalIgnoreCase); }); return result;
    }
    void RefreshGames() {
        var previous=games.SelectedItem as GameChoice;
        games.Items.Clear(); foreach(var game in GameList()) games.Items.Add(game);
        if(previous!=null) foreach(GameChoice game in games.Items) if(game.Pid==previous.Pid) games.SelectedItem=game;
        if(games.Items.Count==1) games.SelectedIndex=0;
        if(games.Items.Count==0) status.Text="Open your game, then click Refresh.";
        Buttons();
    }
    void StartSession(string mode) {
        var game=games.SelectedItem as GameChoice; var saved=sessions.SelectedItem as SavedChoice;
        if(game==null || busy) return;
        busy=true; canWatch=false; details.Clear(); status.Text="Preparing your session…"; Buttons();
        Emit(new {type="start",mode=mode,pid=game.Pid,exe=game.Exe,title=game.Title,video=video.Checked,mouseMode=mouseMode.SelectedIndex==1?"pointer":"auto",session=saved==null?null:saved.Id,restored=restored.Checked});
    }
    void Apply(Dictionary<string,object> data) {
        string type=TextValue(data,"type");
        if(type=="focus") {
            bool okay=false; string error="";
            try {
                using(var game=Process.GetProcessById(Convert.ToInt32(data["pid"]))) {
                    if(!String.Equals(game.MainModule.FileName,TextValue(data,"exe"),StringComparison.OrdinalIgnoreCase)) throw new Exception("The game restarted. Refresh the game list.");
                    IntPtr window=game.MainWindowHandle;
                    if(window==IntPtr.Zero) throw new Exception("The game has no visible window yet.");
                    if(IsIconic(window)) ShowWindow(window,9);
                    Rect rectangle; int width=Convert.ToInt32(data["width"]),height=Convert.ToInt32(data["height"]);
                    if(width>0) {
                        if(!GetClientRect(window,out rectangle)) throw new Exception("Cannot read the game window size.");
                        int currentWidth=rectangle.Right-rectangle.Left,currentHeight=rectangle.Bottom-rectangle.Top;
                        if(Flag(data,"normalized")) {
                            if(currentHeight<1 || Math.Abs((double)currentWidth*height/(currentHeight*(double)width)-1)>.01) throw new Exception("Restore the recorded aspect ratio before Replay. Pointer mode scales size, but needs the same proportions.");
                        } else if(currentWidth!=width || currentHeight!=height) throw new Exception("Restore the game's recorded window size ("+width+" × "+height+") before Replay.");
                    }
                    WindowState=FormWindowState.Minimized;
                    okay=SetForegroundWindow(window);
                    if(!okay) throw new Exception("Bring the game to the foreground, then try again.");
                }
            } catch(Exception ex) { error=ex.Message; }
            Emit(new {type="focused",id=TextValue(data,"id"),ok=okay,error=error}); return;
        }
        if(type=="progress") { details.AppendText(TextValue(data,"text").Replace("\r\n","\n").Replace("\n","\r\n")); return; }
        if(type!="state") return;
        busy=Flag(data,"busy"); status.Text=TextValue(data,"message");
        if(data.ContainsKey("details")) details.Text=TextValue(data,"details").Replace("\r\n","\n").Replace("\n","\r\n");
        if(data.ContainsKey("canWatch")) canWatch=Flag(data,"canWatch");
        if(!busy && data.ContainsKey("sessions")) {
            var old=sessions.SelectedItem as SavedChoice;
            sessions.Items.Clear();
            foreach(var item in (IEnumerable)data["sessions"]) { var row=(Dictionary<string,object>)item; var choice=new SavedChoice {Id=TextValue(row,"id"),Label=TextValue(row,"label"),Video=Flag(row,"hasVideo")}; sessions.Items.Add(choice); if(old!=null && old.Id==choice.Id) sessions.SelectedItem=choice; }
            if(sessions.SelectedIndex<0 && sessions.Items.Count>0) sessions.SelectedIndex=0;
        }
        Buttons();
        if(!busy && closeAfterStop) { Close(); return; }
        if(Flag(data,"finished")) { restored.Checked=false; WindowState=FormWindowState.Normal; Activate(); }
    }
    [STAThread] public static void Main(string[] args) {
        Console.SetIn(new StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false)));
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(),new UTF8Encoding(false)) { AutoFlush=true });
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        if(args.Length>0 && args[0]=="--probe") { Console.WriteLine("{\"desktop\":true,\"games\":"+GameList().Count+"}"); return; }
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new QapingRigDesktop());
    }
}
