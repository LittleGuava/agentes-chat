// The Windows desktop helper (ADR 0201 section 4). Compiled by Windows PowerShell 5.1's Add-Type
// when it starts (C# 5, .NET Framework 4.8): `desktop-helper-win.ts` holds the command and the types
// of what it reads and answers. It speaks ADR 0062's JSON lines: one request a line on stdin, one
// reply a line on stdout, nothing anywhere else, and never what it was sent to type.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace AgentesDesktop
{
    public class HelperError : Exception
    {
        public readonly string Code;
        public HelperError(string code, string message) : base(message) { Code = code; }
    }

    internal static class Native
    {
        public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public InputUnion u; }

        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr lparam);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hwnd, StringBuilder name, int max);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr hwnd, int index);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool IsProcessDPIAware();
        [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformationW(IntPtr obj, int index, StringBuilder info, int length, out int needed);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
    }

    /** One parsed input step: everything is checked before any of them runs. */
    internal class Step
    {
        public string Kind;
        public int[] Numbers;
        public int Button = 1;
        public int Count = 1;
        public int Dx;
        public int Dy;
        public string Text;
        public string Key;
    }

    public static class Helper
    {
        const int WINDOW_MS = 2000;
        const int NODE_MAX = 4000;
        const int TEXT_MAX = 4000;
        const int TEXT_READS = 20;
        // Marks the helper's own input, so a hook can tell the person's input from the agent's (ADR 0201 section 3).
        static readonly IntPtr MARK = new IntPtr(0x41474E54);

        static JavaScriptSerializer json;
        static bool dry;
        static bool dpiAware;
        static Dictionary<string, AutomationElement> known = new Dictionary<string, AutomationElement>();
        static readonly Dictionary<int, string> processNames = new Dictionary<int, string>();
        static readonly Dictionary<long, Task<Tree>> pending = new Dictionary<long, Task<Tree>>();

        public static int Run(TextReader input, bool dryRun)
        {
            dry = dryRun;
            dpiAware = Native.SetProcessDpiAwarenessContext(new IntPtr(-4)) || Native.SetProcessDPIAware() || Native.IsProcessDPIAware();
            json = new JavaScriptSerializer();
            json.MaxJsonLength = int.MaxValue;
            json.RecursionLimit = 32;
            var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            output.NewLine = "\n";
            output.AutoFlush = true;
            string line;
            while ((line = input.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                output.WriteLine(Handle(line));
            }
            return 0;
        }

        static string Handle(string line)
        {
            object id = null;
            try
            {
                Dictionary<string, object> request = null;
                try { request = json.DeserializeObject(line) as Dictionary<string, object>; }
                catch (Exception) { request = null; }
                if (request == null) throw new HelperError("bad_request", "not a JSON object");
                object idValue;
                if (!request.TryGetValue("id", out idValue) || !IsInt(idValue)) throw new HelperError("bad_request", "no id");
                id = Convert.ToInt64(idValue);
                object data;
                switch (Str(request, "op", false))
                {
                    case "hello": data = Hello(); break;
                    case "snapshot": data = Snapshot(request); break;
                    case "extents": data = Extents(request); break;
                    case "input": data = Input(request); break;
                    case "capture": data = Capture(request); break;
                    case "apps": data = Apps(); break;
                    default: throw new HelperError("bad_request", "unknown op");
                }
                var reply = new Dictionary<string, object>();
                reply["id"] = id;
                reply["ok"] = true;
                reply["data"] = data;
                return json.Serialize(reply);
            }
            catch (HelperError e) { return Fail(id, e.Code, e.Message); }
            catch (Exception e) { return Fail(id, "internal", e.GetType().Name); }
        }

        static string Fail(object id, string code, string error)
        {
            var reply = new Dictionary<string, object>();
            reply["id"] = id;
            reply["ok"] = false;
            reply["code"] = code;
            reply["error"] = error;
            return json.Serialize(reply);
        }

        // ---- reading requests

        static bool IsInt(object v) { return v is int || v is long; }

        static string Str(Dictionary<string, object> d, string key, bool optional)
        {
            object v;
            if (!d.TryGetValue(key, out v) || v == null)
            {
                if (optional) return null;
                throw new HelperError("bad_request", key + " is missing");
            }
            var s = v as string;
            if (s == null) throw new HelperError("bad_request", key + " is not text");
            return s;
        }

        static int Int(Dictionary<string, object> d, string key, int fallback, int min, int max)
        {
            object v;
            if (!d.TryGetValue(key, out v) || v == null) return fallback;
            if (!IsInt(v)) throw new HelperError("bad_request", key + " is not a whole number");
            long n = Convert.ToInt64(v);
            if (n < min || n > max) throw new HelperError("bad_request", key + " is out of range");
            return (int)n;
        }

        static IList List(object v, string key)
        {
            var list = v as IList;
            if (list == null || v is string) throw new HelperError("bad_request", key + " is not a list");
            return list;
        }

        /** Whole numbers within screen coordinates by default; pids pass their own range. */
        static int[] Ints(object v, string key, int length, long min = -100000, long max = 100000)
        {
            var list = List(v, key);
            if (length > 0 && list.Count != length) throw new HelperError("bad_request", key + " has the wrong length");
            var out_ = new int[list.Count];
            for (int i = 0; i < list.Count; i++)
            {
                if (!IsInt(list[i])) throw new HelperError("bad_request", key + " holds a non-integer");
                long n = Convert.ToInt64(list[i]);
                if (n < min || n > max) throw new HelperError("bad_request", key + " is out of range");
                out_[i] = (int)n;
            }
            return out_;
        }

        static string KeyOf(IList node)
        {
            if (node == null || node.Count != 2 || !(node[0] is string) || !(node[1] is string))
                throw new HelperError("bad_request", "an element is [bus, path]");
            return (string)node[0] + " " + (string)node[1];
        }

        // ---- the desktop

        static string DesktopName()
        {
            IntPtr desk = Native.OpenInputDesktop(0, false, 0x0001);
            if (desk == IntPtr.Zero) return null;
            try
            {
                var name = new StringBuilder(256);
                int needed;
                return Native.GetUserObjectInformationW(desk, 2, name, name.Capacity * 2, out needed) ? name.ToString() : null;
            }
            finally { Native.CloseDesktop(desk); }
        }

        static bool Locked() { return DesktopName() != "Default"; }

        static int[] Screen() { return new int[] { Native.GetSystemMetrics(0), Native.GetSystemMetrics(1) }; }

        static object Hello()
        {
            var hello = new Dictionary<string, object>();
            int[] screen = Screen();
            bool a11y = false;
            try { a11y = AutomationElement.RootElement != null; }
            catch (Exception) { a11y = false; }
            bool locked = Locked();
            hello["screen"] = screen[0] > 0 && screen[1] > 0 ? screen : null;
            hello["a11y"] = a11y;
            hello["damage"] = false;
            hello["runtime"] = ".NET Framework " + Environment.Version;
            hello["dpiAware"] = dpiAware;
            hello["locked"] = locked;
            hello["dry"] = dry;
            hello["missing"] = new string[0];
            if (!a11y) hello["problem"] = "UI Automation didn't answer";
            else if (locked) hello["problem"] = "the screen is locked";
            return hello;
        }

        internal class Win
        {
            public IntPtr Hwnd;
            public int Pid;
            public string Class;
            public string Title;
            public bool Topmost;
            public bool Tool;
            public int[] Box;
        }

        static string ProcessName(int pid)
        {
            string name;
            if (processNames.TryGetValue(pid, out name)) return name;
            try { name = Process.GetProcessById(pid).ProcessName; }
            catch (Exception) { name = ""; }
            processNames[pid] = name;
            return name;
        }

        /** Visible, uncloaked, unminimized top-level windows with a size, top to bottom. */
        static List<Win> TopWindows()
        {
            var wins = new List<Win>();
            Native.EnumProc proc = delegate (IntPtr h, IntPtr l)
            {
                if (!Native.IsWindowVisible(h) || Native.IsIconic(h)) return true;
                int cloaked;
                if (Native.DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
                Native.RECT r;
                if (Native.DwmGetWindowAttribute(h, 9, out r, 16) != 0 && !Native.GetWindowRect(h, out r)) return true;
                if (r.Right <= r.Left || r.Bottom <= r.Top) return true;
                var cls = new StringBuilder(256);
                Native.GetClassNameW(h, cls, cls.Capacity);
                int length = Native.GetWindowTextLengthW(h);
                var title = new StringBuilder(Math.Max(length + 1, 1));
                if (length > 0) Native.GetWindowTextW(h, title, title.Capacity);
                uint pid;
                Native.GetWindowThreadProcessId(h, out pid);
                int ex = Native.GetWindowLongW(h, -20);
                var w = new Win();
                w.Hwnd = h;
                w.Pid = (int)pid;
                w.Class = cls.ToString();
                w.Title = title.ToString();
                w.Topmost = (ex & 0x8) != 0;
                w.Tool = (ex & 0x80) != 0;
                w.Box = new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
                wins.Add(w);
                return true;
            };
            Native.EnumWindows(proc, IntPtr.Zero);
            GC.KeepAlive(proc);
            return wins;
        }

        static List<object> WindowsOut(List<Win> topToBottom)
        {
            IntPtr active = Native.GetForegroundWindow();
            var out_ = new List<object>();
            for (int i = topToBottom.Count - 1; i >= 0; i--)
            {
                Win w = topToBottom[i];
                var d = new Dictionary<string, object>();
                d["hwnd"] = w.Hwnd.ToInt64();
                d["stack"] = out_.Count;
                d["active"] = w.Hwnd == active;
                d["topmost"] = w.Topmost;
                d["tool"] = w.Tool;
                d["className"] = w.Class;
                d["process"] = ProcessName(w.Pid);
                d["title"] = w.Title;
                d["pid"] = w.Pid > 0 ? (object)w.Pid : null;
                d["box"] = w.Box;
                out_.Add(d);
            }
            return out_;
        }

        static bool IsDock(Win w) { return w.Class == "Shell_TrayWnd" || w.Class == "Shell_SecondaryTrayWnd"; }

        static CacheRequest TreeRequest()
        {
            var cr = new CacheRequest();
            cr.TreeFilter = Automation.ControlViewCondition;
            cr.TreeScope = TreeScope.Element | TreeScope.Descendants;
            cr.AutomationElementMode = AutomationElementMode.Full;
            AutomationProperty[] props = {
                AutomationElement.ControlTypeProperty, AutomationElement.NameProperty,
                AutomationElement.BoundingRectangleProperty, AutomationElement.IsOffscreenProperty,
                AutomationElement.IsEnabledProperty, AutomationElement.HasKeyboardFocusProperty,
                AutomationElement.IsPasswordProperty, AutomationElement.NativeWindowHandleProperty,
                AutomationElement.IsValuePatternAvailableProperty, AutomationElement.IsTogglePatternAvailableProperty,
                AutomationElement.IsExpandCollapsePatternAvailableProperty, AutomationElement.IsSelectionItemPatternAvailableProperty,
                AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsTextPatternAvailableProperty,
                ValuePattern.ValueProperty, ValuePattern.IsReadOnlyProperty, TogglePattern.ToggleStateProperty,
                ExpandCollapsePattern.ExpandCollapseStateProperty, SelectionItemPattern.IsSelectedProperty,
            };
            foreach (var p in props) cr.Add(p);
            return cr;
        }

        static object Cached(AutomationElement e, AutomationProperty p)
        {
            object v = e.GetCachedPropertyValue(p, true);
            return v == AutomationElement.NotSupported ? null : v;
        }

        static string RuntimeId(AutomationElement e)
        {
            int[] id = e.GetRuntimeId();
            var parts = new string[id.Length];
            for (int i = 0; i < id.Length; i++) parts[i] = id[i].ToString();
            return string.Join(".", parts);
        }

        static int[] BoxOf(object rect)
        {
            if (!(rect is System.Windows.Rect)) return null;
            var r = (System.Windows.Rect)rect;
            if (r.IsEmpty || r.Width <= 0 || r.Height <= 0) return null;
            return new int[] { (int)Math.Round(r.X), (int)Math.Round(r.Y), (int)Math.Round(r.Width), (int)Math.Round(r.Height) };
        }

        internal class Tree
        {
            public List<object> Nodes = new List<object>();
            public Dictionary<string, AutomationElement> Elements = new Dictionary<string, AutomationElement>();
            public int TextReads;
        }

        static readonly Dictionary<ControlType, string> TYPES = new Dictionary<ControlType, string>();

        static string TypeName(ControlType t)
        {
            string name;
            lock (TYPES)
            {
                if (TYPES.TryGetValue(t, out name)) return name;
                name = t.ProgrammaticName;
                int dot = name.LastIndexOf('.');
                if (dot >= 0) name = name.Substring(dot + 1);
                TYPES[t] = name;
                return name;
            }
        }

        static void Walk(AutomationElement e, string parent, int index, string bus, HashSet<long> otherTops, int textMax, Tree tree)
        {
            if (tree.Nodes.Count >= NODE_MAX) return;
            string id = RuntimeId(e);
            if (tree.Elements.ContainsKey(bus + " " + id)) return;
            var ct = Cached(e, AutomationElement.ControlTypeProperty) as ControlType;
            string type = ct != null ? TypeName(ct) : "Custom";
            var kids = e.CachedChildren;
            var n = new Dictionary<string, object>();
            n["id"] = id;
            n["parent"] = parent;
            n["index"] = index;
            n["children"] = kids.Count;
            n["type"] = type;
            n["name"] = (Cached(e, AutomationElement.NameProperty) as string) ?? "";
            n["box"] = BoxOf(Cached(e, AutomationElement.BoundingRectangleProperty));
            n["offscreen"] = true.Equals(Cached(e, AutomationElement.IsOffscreenProperty));
            n["enabled"] = !false.Equals(Cached(e, AutomationElement.IsEnabledProperty));
            n["focused"] = true.Equals(Cached(e, AutomationElement.HasKeyboardFocusProperty));
            bool password = true.Equals(Cached(e, AutomationElement.IsPasswordProperty));
            n["password"] = password;
            var patterns = new List<string>();
            if (true.Equals(Cached(e, AutomationElement.IsInvokePatternAvailableProperty))) patterns.Add("Invoke");
            bool hasValue = true.Equals(Cached(e, AutomationElement.IsValuePatternAvailableProperty));
            if (hasValue) patterns.Add("Value");
            bool hasText = true.Equals(Cached(e, AutomationElement.IsTextPatternAvailableProperty));
            if (hasText) patterns.Add("Text");
            if (true.Equals(Cached(e, AutomationElement.IsTogglePatternAvailableProperty)))
            {
                patterns.Add("Toggle");
                object state = Cached(e, TogglePattern.ToggleStateProperty);
                if (state is ToggleState)
                {
                    var s = (ToggleState)state;
                    n["toggle"] = s == ToggleState.On ? "on" : s == ToggleState.Off ? "off" : "indeterminate";
                }
            }
            if (true.Equals(Cached(e, AutomationElement.IsExpandCollapsePatternAvailableProperty)))
            {
                patterns.Add("ExpandCollapse");
                object state = Cached(e, ExpandCollapsePattern.ExpandCollapseStateProperty);
                if (state is ExpandCollapseState)
                {
                    var s = (ExpandCollapseState)state;
                    n["expand"] = s == ExpandCollapseState.Collapsed ? "collapsed" : s == ExpandCollapseState.Expanded ? "expanded" : s == ExpandCollapseState.PartiallyExpanded ? "partial" : "leaf";
                }
            }
            if (true.Equals(Cached(e, AutomationElement.IsSelectionItemPatternAvailableProperty)))
            {
                patterns.Add("SelectionItem");
                n["selected"] = true.Equals(Cached(e, SelectionItemPattern.IsSelectedProperty));
            }
            n["patterns"] = patterns;
            if (hasValue) n["readOnly"] = !false.Equals(Cached(e, ValuePattern.IsReadOnlyProperty));
            bool readable = type == "Edit" || type == "Document" || type == "ComboBox" || type == "Spinner";
            if (readable && !password && textMax > 0)
            {
                string text = hasValue ? Cached(e, ValuePattern.ValueProperty) as string : null;
                if (string.IsNullOrEmpty(text) && hasText && tree.TextReads < TEXT_READS && !true.Equals(n["offscreen"]))
                {
                    tree.TextReads++;
                    try
                    {
                        var tp = e.GetCurrentPattern(TextPattern.Pattern) as TextPattern;
                        if (tp != null) text = tp.DocumentRange.GetText(textMax);
                    }
                    catch (Exception) { text = null; }
                }
                if (!string.IsNullOrEmpty(text)) n["value"] = text.Length > textMax ? text.Substring(0, textMax) : text;
            }
            tree.Nodes.Add(n);
            tree.Elements[bus + " " + id] = e;
            for (int i = 0; i < kids.Count; i++)
            {
                AutomationElement kid = kids[i];
                object handle = Cached(kid, AutomationElement.NativeWindowHandleProperty);
                // Another top-level window (a dialog the app owns) is read as its own window, not twice.
                if (handle is int && (int)handle != 0 && otherTops.Contains((long)(int)handle)) continue;
                Walk(kid, id, i, bus, otherTops, textMax, tree);
            }
        }

        static Tree ReadWindow(IntPtr hwnd, string bus, HashSet<long> otherTops, int textMax)
        {
            var tree = new Tree();
            AutomationElement root;
            using (TreeRequest().Activate()) { root = AutomationElement.FromHandle(hwnd); }
            Walk(root, null, -1, bus, otherTops, textMax, tree);
            return tree;
        }

        static object Snapshot(Dictionary<string, object> request)
        {
            var started = Stopwatch.StartNew();
            string scope = Str(request, "scope", true) ?? "front";
            if (scope != "front" && scope != "all") throw new HelperError("bad_request", "scope is front or all");
            int textMax = Int(request, "textMax", TEXT_MAX, 0, TEXT_MAX);
            var skip = new HashSet<int>();
            object skipValue;
            if (request.TryGetValue("skip", out skipValue) && skipValue != null)
                foreach (int pid in Ints(skipValue, "skip", 0, 0, int.MaxValue)) skip.Add(pid);
            if (Locked()) throw new HelperError("unavailable", "the screen is locked");

            List<Win> wins = TopWindows();
            IntPtr active = Native.GetForegroundWindow();
            int activeAt = wins.FindIndex(delegate (Win w) { return w.Hwnd == active; });
            var read = new List<Win>();
            for (int i = 0; i < wins.Count; i++)
            {
                Win w = wins[i];
                bool front = scope == "all" || IsDock(w) || i <= Math.Max(activeAt, 0);
                if (front && !skip.Contains(w.Pid)) read.Add(w);
            }
            var tops = new HashSet<long>();
            foreach (Win w in wins) tops.Add(w.Hwnd.ToInt64());

            var apps = new Dictionary<int, Dictionary<string, object>>();
            var order = new List<int>();
            var elements = new Dictionary<string, AutomationElement>();
            // Every window is read at once, under one deadline. A read that missed an earlier deadline
            // is still running (UI Automation can't be cancelled): it is waited on again, never doubled.
            var tasks = new List<Task<Tree>>();
            foreach (Win w in read)
            {
                long hwnd = w.Hwnd.ToInt64();
                Task<Tree> task;
                if (!pending.TryGetValue(hwnd, out task) || task.IsCompleted)
                {
                    var others = new HashSet<long>(tops);
                    others.Remove(hwnd);
                    string bus = "uia:" + w.Pid;
                    IntPtr handle = w.Hwnd;
                    task = Task.Factory.StartNew(() => ReadWindow(handle, bus, others, textMax), TaskCreationOptions.LongRunning);
                    pending[hwnd] = task;
                }
                tasks.Add(task);
            }
            var deadline = Stopwatch.StartNew();
            foreach (var task in tasks)
            {
                int left = WINDOW_MS - (int)deadline.ElapsedMilliseconds;
                try { task.Wait(Math.Max(left, 0)); }
                catch (AggregateException) { }
            }
            for (int i = 0; i < read.Count; i++)
            {
                Win w = read[i];
                Task<Tree> task = tasks[i];
                if (task.IsCompleted) pending.Remove(w.Hwnd.ToInt64());
                Dictionary<string, object> app;
                if (!apps.TryGetValue(w.Pid, out app))
                {
                    app = new Dictionary<string, object>();
                    app["pid"] = w.Pid;
                    app["name"] = ProcessName(w.Pid);
                    app["nodes"] = new List<object>();
                    apps[w.Pid] = app;
                    order.Add(w.Pid);
                }
                if (!task.IsCompleted) { app["error"] = "didn't answer"; continue; }
                if (task.IsFaulted || task.IsCanceled) { if (!app.ContainsKey("error")) app["error"] = "no tree"; continue; }
                ((List<object>)app["nodes"]).AddRange(task.Result.Nodes);
                foreach (var pair in task.Result.Elements) elements[pair.Key] = pair.Value;
            }
            known = elements;
            var appsOut = new List<object>();
            foreach (int pid in order)
            {
                var app = apps[pid];
                if (((List<object>)app["nodes"]).Count == 0) app.Remove("nodes");
                appsOut.Add(app);
            }
            var snap = new Dictionary<string, object>();
            snap["screen"] = Screen();
            snap["windows"] = WindowsOut(wins);
            snap["apps"] = appsOut;
            snap["ms"] = (int)started.ElapsedMilliseconds;
            return snap;
        }

        static object Extents(Dictionary<string, object> request)
        {
            object nodes;
            if (!request.TryGetValue("nodes", out nodes)) throw new HelperError("bad_request", "nodes is missing");
            var boxes = new Dictionary<string, object>();
            foreach (object node in List(nodes, "nodes"))
            {
                string key = KeyOf(node as IList);
                AutomationElement e;
                int[] box = null;
                if (known.TryGetValue(key, out e))
                {
                    try { box = BoxOf(e.Current.BoundingRectangle); }
                    catch (Exception) { box = null; }
                }
                boxes[key] = box;
            }
            var reply = new Dictionary<string, object>();
            reply["boxes"] = boxes;
            reply["windows"] = WindowsOut(TopWindows());
            return reply;
        }

        // ---- input

        static readonly string[] STEP_KINDS = { "move", "click", "drag", "keys", "type", "fill", "scroll", "activate", "launch", "open", "pause" };
        static readonly HashSet<string> EXTRAS = new HashSet<string>(new string[] { "button", "count", "dx", "dy", "text" });

        static Step ParseStep(object value)
        {
            var d = value as Dictionary<string, object>;
            if (d == null) throw new HelperError("bad_request", "a step is an object");
            string kind = null;
            foreach (string k in d.Keys)
            {
                if (Array.IndexOf(STEP_KINDS, k) >= 0)
                {
                    if (kind != null) throw new HelperError("bad_request", "a step does one thing");
                    kind = k;
                }
                else if (!EXTRAS.Contains(k)) throw new HelperError("bad_request", "a step has an unknown field");
            }
            if (kind == null) throw new HelperError("bad_request", "a step names what it does");
            var s = new Step();
            s.Kind = kind;
            object v = d[kind];
            switch (kind)
            {
                case "move": s.Numbers = Ints(v, kind, 2); break;
                case "click":
                    s.Numbers = Ints(v, kind, 2);
                    s.Button = Int(d, "button", 1, 1, 3);
                    s.Count = Int(d, "count", 1, 1, 3);
                    break;
                case "drag": s.Numbers = Ints(v, kind, 4); break;
                case "keys":
                    s.Numbers = Ints(v, kind, 0);
                    if (s.Numbers.Length < 1 || s.Numbers.Length > 6) throw new HelperError("bad_request", "a chord has 1 to 6 keys");
                    foreach (int k in s.Numbers) if (k < 1 || k > 254) throw new HelperError("bad_request", "a key is a virtual-key code");
                    break;
                case "type":
                    s.Text = v as string;
                    if (s.Text == null) throw new HelperError("bad_request", "type takes text");
                    break;
                case "fill":
                    s.Key = KeyOf(v as IList);
                    s.Text = Str(d, "text", false);
                    break;
                case "scroll":
                    s.Numbers = Ints(v, kind, 2);
                    s.Dx = Int(d, "dx", 0, -100, 100);
                    s.Dy = Int(d, "dy", 0, -100, 100);
                    break;
                case "activate":
                    if (!IsInt(v)) throw new HelperError("bad_request", "activate takes a window handle");
                    s.Key = Convert.ToInt64(v).ToString();
                    break;
                case "launch":
                case "open":
                    s.Text = v as string;
                    if (string.IsNullOrEmpty(s.Text) || s.Text.IndexOf('\0') >= 0) throw new HelperError("bad_request", kind + " takes a name");
                    if (kind == "open" && !Path.IsPathRooted(s.Text)) throw new HelperError("bad_request", "open takes an absolute path");
                    break;
                case "pause":
                    if (!IsInt(v)) throw new HelperError("bad_request", "pause takes milliseconds");
                    long ms = Convert.ToInt64(v);
                    if (ms < 0 || ms > 10000) throw new HelperError("bad_request", "pause is at most 10 s");
                    s.Numbers = new int[] { (int)ms };
                    break;
            }
            return s;
        }

        static object Input(Dictionary<string, object> request)
        {
            object stepsValue;
            if (!request.TryGetValue("steps", out stepsValue)) throw new HelperError("bad_request", "steps is missing");
            var steps = new List<Step>();
            foreach (object v in List(stepsValue, "steps")) steps.Add(ParseStep(v));
            int windowMs = 0, quietMs = 0, capMs = 2000;
            object settleValue;
            bool settle = request.TryGetValue("settle", out settleValue) && settleValue != null;
            if (settle)
            {
                var st = settleValue as Dictionary<string, object>;
                if (st == null) throw new HelperError("bad_request", "settle is an object");
                capMs = Int(st, "capMs", 2000, 0, 15000);
                quietMs = Int(st, "quietMs", 120, 0, 5000);
                windowMs = Int(st, "windowMs", 0, 0, 15000);
            }
            if (!dry && Locked()) throw new HelperError("unavailable", "the screen is locked");
            var started = Stopwatch.StartNew();
            var sent = new List<string>();
            IntPtr before = Native.GetForegroundWindow();
            foreach (Step s in steps) Do(s, sent);
            var reply = new Dictionary<string, object>();
            if (settle)
            {
                var wait = Stopwatch.StartNew();
                if (windowMs > 0)
                    while (wait.ElapsedMilliseconds < Math.Min(windowMs, capMs) && Native.GetForegroundWindow() == before) Thread.Sleep(50);
                int left = capMs - (int)wait.ElapsedMilliseconds;
                if (left > 0) Thread.Sleep(Math.Min(quietMs, left));
            }
            reply["ms"] = (int)started.ElapsedMilliseconds;
            if (dry) reply["sent"] = sent;
            return reply;
        }

        static Native.INPUT Mouse(uint flags, int dx, int dy, uint data)
        {
            var i = new Native.INPUT();
            i.type = 0;
            i.u.mi.dx = dx;
            i.u.mi.dy = dy;
            i.u.mi.mouseData = data;
            i.u.mi.dwFlags = flags;
            i.u.mi.dwExtraInfo = MARK;
            return i;
        }

        static Native.INPUT Key(ushort vk, ushort scan, uint flags)
        {
            var i = new Native.INPUT();
            i.type = 1;
            i.u.ki.wVk = vk;
            i.u.ki.wScan = scan;
            i.u.ki.dwFlags = flags;
            i.u.ki.dwExtraInfo = MARK;
            return i;
        }

        static void Send(List<Native.INPUT> inputs)
        {
            if (inputs.Count == 0) return;
            uint taken = Native.SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(Native.INPUT)));
            // Windows refuses input to an elevated window or the secure desktop (UIPI): fewer events taken.
            if (taken != inputs.Count) throw new HelperError("failed", "Windows didn't take the input");
        }

        static Native.INPUT MoveTo(int x, int y)
        {
            int[] screen = Screen();
            int nx = (int)Math.Round(x * 65535.0 / Math.Max(screen[0] - 1, 1));
            int ny = (int)Math.Round(y * 65535.0 / Math.Max(screen[1] - 1, 1));
            return Mouse(0x0001 | 0x8000, nx, ny, 0);
        }

        static bool Extended(int vk)
        {
            return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0x6F || vk == 0x90 || vk == 0xA3 || vk == 0xA5;
        }

        static void Tap(List<Native.INPUT> inputs, int vk)
        {
            inputs.Add(Key((ushort)vk, 0, Extended(vk) ? 1u : 0u));
            inputs.Add(Key((ushort)vk, 0, (Extended(vk) ? 1u : 0u) | 0x2));
        }

        static void Do(Step s, List<string> sent)
        {
            var inputs = new List<Native.INPUT>();
            int[] n = s.Numbers;
            switch (s.Kind)
            {
                case "move":
                    if (dry) { sent.Add("move " + n[0] + "," + n[1]); return; }
                    inputs.Add(MoveTo(n[0], n[1]));
                    break;
                case "click":
                    if (dry) { sent.Add("click " + n[0] + "," + n[1] + " button " + s.Button + " x" + s.Count); return; }
                    uint down = s.Button == 1 ? 0x0002u : s.Button == 2 ? 0x0020u : 0x0008u;
                    inputs.Add(MoveTo(n[0], n[1]));
                    for (int c = 0; c < s.Count; c++)
                    {
                        inputs.Add(Mouse(down, 0, 0, 0));
                        inputs.Add(Mouse(down << 1, 0, 0, 0));
                    }
                    break;
                case "drag":
                    if (dry) { sent.Add("drag " + n[0] + "," + n[1] + " to " + n[2] + "," + n[3]); return; }
                    inputs.Add(MoveTo(n[0], n[1]));
                    inputs.Add(Mouse(0x0002, 0, 0, 0));
                    Send(inputs);
                    inputs.Clear();
                    for (int k = 1; k <= 10; k++)
                    {
                        Thread.Sleep(15);
                        Send(new List<Native.INPUT> { MoveTo(n[0] + (n[2] - n[0]) * k / 10, n[1] + (n[3] - n[1]) * k / 10) });
                    }
                    inputs.Add(Mouse(0x0004, 0, 0, 0));
                    break;
                case "keys":
                    if (dry) { sent.Add("chord " + n.Length); return; }
                    for (int k = 0; k < n.Length; k++) inputs.Add(Key((ushort)n[k], 0, Extended(n[k]) ? 1u : 0u));
                    for (int k = n.Length - 1; k >= 0; k--) inputs.Add(Key((ushort)n[k], 0, (Extended(n[k]) ? 1u : 0u) | 0x2));
                    break;
                case "type":
                    int letters = 0, returns = 0, tabs = 0;
                    for (int c = 0; c < s.Text.Length; c++)
                    {
                        char ch = s.Text[c];
                        if (ch == '\r') continue;
                        if (ch == '\n') { returns++; if (!dry) Tap(inputs, 0x0D); }
                        else if (ch == '\t') { tabs++; if (!dry) Tap(inputs, 0x09); }
                        else
                        {
                            if (!char.IsLowSurrogate(ch)) letters++;
                            if (!dry)
                            {
                                // Unicode key events: any letter as written, no keyboard layout and no clipboard.
                                inputs.Add(Key(0, ch, 0x0004));
                                inputs.Add(Key(0, ch, 0x0004 | 0x0002));
                            }
                        }
                        if (!dry && inputs.Count >= 64) { Send(inputs); inputs.Clear(); Thread.Sleep(5); }
                    }
                    if (dry)
                    {
                        string said = "unicode " + letters;
                        if (returns > 0) said += " + return " + returns;
                        if (tabs > 0) said += " + tab " + tabs;
                        sent.Add(said);
                        return;
                    }
                    break;
                case "fill":
                    AutomationElement e;
                    if (!known.TryGetValue(s.Key, out e)) throw new HelperError("stale", "the element is gone");
                    if (dry) { sent.Add("fill 1"); return; }
                    try
                    {
                        var vp = e.GetCurrentPattern(ValuePattern.Pattern) as ValuePattern;
                        if (vp == null || vp.Current.IsReadOnly) throw new HelperError("failed", "the element takes no text");
                        vp.SetValue(s.Text);
                        if (vp.Current.Value != s.Text) throw new HelperError("mismatch", "the text didn't come out as written");
                    }
                    catch (ElementNotAvailableException) { throw new HelperError("stale", "the element is gone"); }
                    catch (InvalidOperationException) { throw new HelperError("failed", "the element takes no text"); }
                    return;
                case "scroll":
                    if (dry) { sent.Add("scroll " + n[0] + "," + n[1]); return; }
                    inputs.Add(MoveTo(n[0], n[1]));
                    if (s.Dy != 0) inputs.Add(Mouse(0x0800, 0, 0, unchecked((uint)(-s.Dy * 120))));
                    if (s.Dx != 0) inputs.Add(Mouse(0x1000, 0, 0, unchecked((uint)(s.Dx * 120))));
                    break;
                case "activate":
                    var hwnd = new IntPtr(long.Parse(s.Key));
                    if (!Native.IsWindow(hwnd)) throw new HelperError("stale", "the window is gone");
                    if (dry) { sent.Add("activate 1"); return; }
                    if (Native.IsIconic(hwnd)) Native.ShowWindow(hwnd, 9);
                    // Windows lets the process that sent the last input bring a window forward.
                    Tap(inputs, 0x12);
                    Send(inputs);
                    inputs.Clear();
                    Native.SetForegroundWindow(hwnd);
                    Thread.Sleep(50);
                    if (Native.GetForegroundWindow() != hwnd) throw new HelperError("failed", "the window didn't come forward");
                    return;
                case "launch":
                    string shortcut = ShortcutPath(s.Text);
                    if (shortcut == null) throw new HelperError("failed", "no such app");
                    if (dry) { sent.Add("launch 1"); return; }
                    Start(shortcut);
                    return;
                case "open":
                    if (dry) { sent.Add("open 1"); return; }
                    if (!File.Exists(s.Text) && !Directory.Exists(s.Text)) throw new HelperError("failed", "no such file");
                    Start(s.Text);
                    return;
                case "pause":
                    if (dry) sent.Add("pause");
                    Thread.Sleep(n[0]);
                    return;
            }
            Send(inputs);
        }

        static void Start(string path)
        {
            try
            {
                var info = new ProcessStartInfo(path);
                info.UseShellExecute = true;
                Process.Start(info);
            }
            catch (Exception) { throw new HelperError("failed", "it didn't start"); }
        }

        // ---- apps: the Start menu's shortcuts

        static string[][] StartMenus()
        {
            return new string[][] {
                new string[] { "common", Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu), "Programs") },
                new string[] { "user", Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs") },
            };
        }

        static bool IsShortcut(string path)
        {
            string ext = Path.GetExtension(path).ToLowerInvariant();
            return ext == ".lnk" || ext == ".url" || ext == ".appref-ms";
        }

        /** A Start menu shortcut by its id (`user:Accessories\Notepad.lnk`), only inside the Start menus. */
        static string ShortcutPath(string id)
        {
            int colon = id.IndexOf(':');
            if (colon <= 0) return null;
            string place = id.Substring(0, colon), rel = id.Substring(colon + 1);
            if (rel.Contains("..") || Path.IsPathRooted(rel) || !IsShortcut(rel)) return null;
            foreach (string[] menu in StartMenus())
            {
                if (menu[0] != place) continue;
                string full = Path.GetFullPath(Path.Combine(menu[1], rel));
                if (full.StartsWith(menu[1] + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) && File.Exists(full)) return full;
            }
            return null;
        }

        static object Apps()
        {
            var apps = new List<object>();
            foreach (string[] menu in StartMenus())
            {
                if (!Directory.Exists(menu[1])) continue;
                string[] files;
                try { files = Directory.GetFiles(menu[1], "*", SearchOption.AllDirectories); }
                catch (Exception) { continue; }
                foreach (string file in files)
                {
                    if (!IsShortcut(file)) continue;
                    var app = new Dictionary<string, object>();
                    app["id"] = menu[0] + ":" + file.Substring(menu[1].Length + 1);
                    app["name"] = Path.GetFileNameWithoutExtension(file);
                    app["generic"] = null;
                    app["keywords"] = new string[0];
                    apps.Add(app);
                }
            }
            return apps;
        }

        // ---- capture

        static object Capture(Dictionary<string, object> request)
        {
            int quality = Int(request, "quality", 70, 1, 100);
            int[] screen = Screen();
            int x = 0, y = 0, w = screen[0], h = screen[1];
            object regionValue;
            bool region = request.TryGetValue("region", out regionValue) && regionValue != null;
            if (region)
            {
                var r = regionValue as Dictionary<string, object>;
                if (r == null) throw new HelperError("bad_request", "region is an object");
                int rx = Int(r, "x", 0, -100000, 100000), ry = Int(r, "y", 0, -100000, 100000);
                int rw = Int(r, "width", 0, 0, 100000), rh = Int(r, "height", 0, 0, 100000);
                x = Math.Max(rx, 0);
                y = Math.Max(ry, 0);
                w = Math.Min(rx + rw, screen[0]) - x;
                h = Math.Min(ry + rh, screen[1]) - y;
                if (w <= 0 || h <= 0) throw new HelperError("bad_request", "the region is off the screen");
            }
            if (Locked()) throw new HelperError("unavailable", "the screen is locked");
            byte[] jpeg;
            using (var bitmap = new Bitmap(w, h, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(bitmap)) g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
                ImageCodecInfo codec = null;
                foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") codec = c;
                var options = new EncoderParameters(1);
                options.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                using (var ms = new MemoryStream())
                {
                    bitmap.Save(ms, codec, options);
                    jpeg = ms.ToArray();
                }
            }
            var reply = new Dictionary<string, object>();
            reply["jpeg"] = Convert.ToBase64String(jpeg);
            reply["width"] = w;
            reply["height"] = h;
            if (region)
            {
                var r = new Dictionary<string, object>();
                r["x"] = x; r["y"] = y; r["width"] = w; r["height"] = h;
                reply["region"] = r;
            }
            else reply["region"] = null;
            return reply;
        }
    }
}
