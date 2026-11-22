using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using PhoneBox.Agent;

var endpoint = AgentEndpoint.FromArgs(args);
var Port = endpoint.Port;
string[] SameOrigins = [$"http://127.0.0.1:{Port}", $"http://localhost:{Port}"];

// Install scripts ask where the agent belongs (it differs per OS), then copy it there.
if (args.Contains("--print-install-dir")) { Console.WriteLine(AppPaths.InstallDir); return; }

// Single instance: a second launch opens the running instance's settings page and exits.
// After a restart the previous instance may still be shutting down, so wait for it briefly.
var single = new Mutex(false, endpoint.MutexName);
var waitMs = args.Contains("--restart") ? 15_000 : 0;
bool firstInstance;
try { firstInstance = single.WaitOne(waitMs); }
catch (AbandonedMutexException) { firstInstance = true; }
if (!firstInstance)
{
    try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo($"http://127.0.0.1:{Port}/") { UseShellExecute = true }); } catch { }
    return;
}

if (!args.Contains("--config")) AppPaths.EnsureConfig();
// absolute from here on: a bare file name ("--config profile.json") has no folder, and the files kept next to the
// config (the Spotify login, backups) need one
var configPath = Path.GetFullPath(args.SkipWhile(a => a != "--config").Skip(1).FirstOrDefault() ?? AppPaths.ConfigPath);
var configDir = Path.GetDirectoryName(configPath) ?? AppPaths.ConfigDir;
AppPaths.RestrictConfig(configPath);
var configStore = new ConfigStore(configPath);
configStore.PersistGenerated(); // keep the Wi-Fi token stable across restarts
var lanCfg = configStore.Get().Lan;
var lanCert = lanCfg.Enabled && lanCfg.Port != Port ? Lan.Certificate(configDir) : null;
// USB uses the same certificate as Wi-Fi; the agent hands its fingerprint to the app over adb (see UsbLink.cs)
var usbCert = lanCert ?? Lan.Certificate(configDir);
var usb = new UsbLink(UsbLink.FreeLoopbackPort(), Lan.Fingerprint(usbCert));

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory,
});
builder.WebHost.ConfigureKestrel(k =>
{
    // a dictation travels in the query (the phone's transport sends no request bodies): 1000 characters of any script,
    // percent-encoded, fit in 16 KB
    k.Limits.MaxRequestLineSize = 16 * 1024;
    k.Listen(IPAddress.Loopback, Port);
    // USB: the end of the phone's adb reverse tunnel, on a port of its own, over TLS the app pins, with the app's key
    k.Listen(IPAddress.Loopback, usb.Port, l => l.UseHttps(usbCert));
    // Wi-Fi / Tailscale: HTTPS with a pinned self-signed certificate, token required (see Lan.cs).
    if (lanCert is not null) k.Listen(IPAddress.Any, lanCfg.Port, l => l.UseHttps(lanCert));
});
builder.Logging.ClearProviders();
builder.Logging.AddFilter("Microsoft", LogLevel.Warning);
builder.Logging.AddProvider(new FileLoggerProvider());
builder.Logging.AddSimpleConsole(o => { o.SingleLine = true; o.TimestampFormat = "HH:mm:ss "; });
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);

builder.Services.AddSingleton(configStore);
builder.Services.AddSingleton(endpoint);
builder.Services.AddSingleton(usb);
builder.Services.AddSingleton<AudioControl>();
builder.Services.AddSingleton<PairingCodes>();
builder.Services.AddSingleton<PushStore>();
builder.Services.AddSingleton<ApprovalStore>();
AddMonitor<SystemMonitor>(builder.Services);
AddMonitor<QuotaMonitor>(builder.Services);
AddMonitor<ProcessMonitor>(builder.Services);
AddMonitor<SessionMonitor>(builder.Services);
AddMonitor<GitHubMonitor>(builder.Services);
AddMonitor<PingMonitor>(builder.Services);
AddMonitor<AdbReverse>(builder.Services);
AddMonitor<SessionLockMonitor>(builder.Services);
AddMonitor<UpdateService>(builder.Services);
AddMonitor<DockerMonitor>(builder.Services);
builder.Services.AddHostedService<Tray>();

var app = builder.Build();

// The panel in a desktop browser (the layout editor's live preview, /panel/) calls the API as /agent/api/..., the same
// path the phone uses; on the local port that is simply /api/... Routing runs after this, so it sees the new path.
app.Use((ctx, next) =>
{
    if (ctx.Connection.LocalPort == Port && ctx.Request.Path.StartsWithSegments("/agent/api", out var rest))
        ctx.Request.Path = "/api" + rest;
    return next(ctx);
});

// How long each kind of request takes (GET /api/latency, local only), and a log line for the slow ones: tells a slow
// control action (osascript on a busy computer...) from a slow phone or network. The live stream is long by design.
var timings = new RequestTimings();
app.Use(async (ctx, next) =>
{
    if (!ctx.Request.Path.StartsWithSegments("/api") || ctx.Request.Path.StartsWithSegments("/api/stream")) { await next(ctx); return; }
    var started = System.Diagnostics.Stopwatch.GetTimestamp();
    try { await next(ctx); }
    finally
    {
        var ms = (long)System.Diagnostics.Stopwatch.GetElapsedTime(started).TotalMilliseconds;
        // only a request that matched an endpoint (routing has run by now), so unknown paths cannot add rows
        if (RequestTimings.RouteOf(ctx.GetEndpoint(), ctx.Request.Method) is { } route)
        {
            timings.Add(route, ms);
            if (ms >= RequestTimings.SlowMs && ctx.Request.Method != "GET") app.Logger.LogInformation("slow request: {Route} took {Ms} ms", route, ms);
        }
    }
});
app.MapGet("/api/latency", () => Results.Json(timings.Summary()));

// Security:
//  - Local port 8765 listens on 127.0.0.1 only; the Host check blocks DNS rebinding. From browsers only the settings
//    page itself (same origin) is accepted (no CSRF).
//  - The phone's USB tunnel ends on a port of its own (UsbLink): every app on the phone can reach the tunnel, so it
//    is TLS with the certificate the app pins (handed over adb), needs the key the PhoneBox app made (read over adb),
//    and serves only the phone API.
//  - The optional Wi-Fi port only serves the phone API, only over TLS, and only with the paired token.
app.UseWebSockets();
app.UseRouting();
app.Use(async (ctx, next) =>
{
    var origin = ctx.Request.Headers.Origin.ToString();
    if (ctx.Connection.LocalPort == usb.Port && ctx.Request.IsHttps)
    {
        // the phone over USB: only with its app's key, and only the paths the phone uses
        var access = usb.Authorize(ctx.Request.Method, ctx.Request.Path, origin, ctx.Request.Headers.Authorization);
        if (access != UsbLink.Access.Allowed)
        {
            ctx.Response.StatusCode = access == UsbLink.Access.Unauthorized ? StatusCodes.Status401Unauthorized : StatusCodes.Status403Forbidden;
            return;
        }
    }
    else if (lanCert is not null && ctx.Connection.LocalPort == lanCfg.Port && ctx.Request.IsHttps)
    {
        // The phone's key opens the panel API.
        var lan = configStore.Get().Lan;
        var access = Lan.AuthorizeRequest(lan, ctx.Request.Method, ctx.Request.Path, origin, ctx.Request.Headers.Authorization);
        if (access == Lan.LanAccess.Denied)
        {
            ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
        if (access is Lan.LanAccess.PairingClaim)
        {
            // pairing claims must not touch phone registry, app version or "phone connected" updates
            ctx.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>()!.MaxRequestBodySize = 1024;
            ctx.Response.Headers.CacheControl = "no-store";
            await next();
            return;
        }
    }
    else
    {
        var host = ctx.Request.Host.Host;
        if ((host != "127.0.0.1" && host != "localhost") || (origin != "" && !SameOrigins.Contains(origin))
            || BrowserGuard.IsForeign(ctx.Request.Headers["Sec-Fetch-Site"], ctx.Request.Headers["Sec-Fetch-Mode"], ctx.Request.Method, ctx.Request.Path))
        {
            ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
    }
    if (ctx.Request.Path.StartsWithSegments("/api/state") && ctx.Request.Headers.ContainsKey("X-PhoneBox-App"))
        Interlocked.Exchange(ref ApprovalStore.PhoneLastSeen, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    if (ctx.Request.Headers.TryGetValue("X-PhoneBox-Device", out var device))
    {
        var problem = PhoneRegistry.Touch(device.ToString(), ctx.Request.Headers["X-PhoneBox-Model"].ToString(),
            ctx.Connection.LocalPort == usb.Port ? "USB" : ctx.Connection.LocalPort == Port ? "local" : "Wi-Fi", ctx.Request.Headers["X-PhoneBox-WebView"].ToString());
        if (problem is not null) app.Logger.LogWarning("WebView: {Problem}", problem);
    }
    if (ctx.Request.Headers.TryGetValue("X-PhoneBox-App", out var appVersion) && appVersion.ToString().Length is > 0 and < 32)
        UpdateService.AppVersion = appVersion.ToString();
    ctx.Response.Headers.CacheControl = "no-store";
    // only the panel may be framed, and only by the settings page itself (the live preview)
    ctx.Response.Headers["X-Frame-Options"] = ctx.Request.Path.StartsWithSegments("/panel") ? "SAMEORIGIN" : "DENY";
    await next();
});

// ---------------------------------------------------------------- Wi-Fi pairing (local / USB only)
// The phone calls this through the USB tunnel and stores everything it needs to connect over Wi-Fi.
app.MapGet("/api/pair", (ConfigStore cfg) =>
{
    var lan = cfg.Get().Lan;
    if (!lan.Enabled || lanCert is null) return Results.Json(new { enabled = false, pc = Environment.MachineName });
    return Results.Json(new
    {
        enabled = true,
        pc = Environment.MachineName,
        port = lanCfg.Port,
        token = lan.Token,
        fingerprint = Lan.Fingerprint(lanCert),
        hosts = Lan.Addresses(),
    });
});

// Pairing without USB (see PairingCodes). Start and cancel are local only (settings page); the phone claims over Wi-Fi.
app.MapPost("/api/pair/start", (ConfigStore cfg, PairingCodes codes) =>
{
    if (!cfg.Get().Lan.Enabled || lanCert is null)
        return Results.Json(new { enabled = false, configured = cfg.Get().Lan.Enabled });
    var (code, expiresAt, attempt) = codes.Start(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    var hosts = Lan.Addresses();
    var fingerprint = Lan.Fingerprint(lanCert);
    var link = PairingCodes.Link(Environment.MachineName, fingerprint, lanCfg.Port, hosts, code);
    var apk = $"https://github.com/{cfg.Get().Updates.Repo}/releases/download/v{AppPaths.Version}/PhoneBox-{AppPaths.Version}.apk";
    return Results.Json(new
    {
        enabled = true,
        pc = Environment.MachineName,
        hosts,
        port = lanCfg.Port,
        expiresAt,
        claims = codes.Claims,
        attempt,
        check = PairingCodes.Check(fingerprint),
        link,
        qr = PairingCodes.Svg(link),
        app = apk,
        appQr = PairingCodes.Svg(apk),
    });
});
app.MapPost("/api/pair/cancel", (long attempt, PairingCodes codes) => { codes.Cancel(attempt); return Results.Ok(); });
app.MapGet("/api/pair/status", (PairingCodes codes) => Results.Json(new { claims = codes.Claims }));
app.MapPost("/api/pair/claim", (HttpRequest req, ConfigStore cfg, PairingCodes codes) =>
    ClaimPairingAsync(req, cfg, codes, lanCert, lanCfg.Port, app.Logger));

app.MapGet("/api/lan", (ConfigStore cfg) => Results.Json(new
{
    configured = cfg.Get().Lan.Enabled,
    active = lanCert is not null,
    port = lanCfg.Port,
    restartNeeded = cfg.Get().Lan.Enabled != (lanCert is not null) || (lanCert is not null && cfg.Get().Lan.Port != lanCfg.Port),
    hosts = Lan.Addresses(),
    fingerprint = lanCert is null ? null : Lan.Fingerprint(lanCert),
}));

app.MapGet("/api/update", (UpdateService upd, ConfigStore cfg) => Results.Json(new { status = upd.Status(), auto = cfg.Get().Updates.Auto, installed = UpdateService.RunningInstalled }));
// Settings › General: install the phone app on a phone that does not have it yet (local only).
app.MapPost("/api/phone/install", async (UpdateService upd) =>
    await upd.InstallAppAsync() is { } error ? Results.BadRequest(new { error }) : Results.Ok(new { ok = true }));
app.MapPost("/api/update/check", async (UpdateService upd) => { await upd.CheckAsync(); return Results.Json(upd.Status()); });
app.MapPost("/api/update/apply", (UpdateService upd) => { _ = Task.Run(() => upd.ApplyAsync()); return Results.Accepted(); });

app.MapPost("/api/restart", (IHostApplicationLifetime life) =>
{
    AppRestart.Requested = true;
    life.StopApplication();
    return Results.Ok();
});

// ---------------------------------------------------------------- settings UI (browser)
app.MapGet("/", () =>
{
    using var s = AppPaths.Resource("settings.html")!;
    using var r = new StreamReader(s);
    return Results.Content(r.ReadToEnd(), "text/html; charset=utf-8");
});
// The phone's panel (embedded at build time) for the live preview in the layout editor; local port only.
app.MapGet("/panel/{*file}", (string? file, HttpRequest req) =>
{
    if (string.IsNullOrEmpty(file) && !req.Path.Value!.EndsWith('/')) return Results.Redirect("/panel/" + req.QueryString);
    file = string.IsNullOrEmpty(file) ? "index.html" : file;
    // index.html, main.js, style.css… and the widget modules in widgets/
    if (!System.Text.RegularExpressions.Regex.IsMatch(file, @"^(widgets/)?[A-Za-z0-9_.-]+$") || file.Contains("..")) return Results.NotFound();
    var type = Path.GetExtension(file) switch
    {
        ".html" => "text/html; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        _ => "application/octet-stream",
    };
    return AppPaths.Resource("www/" + file) is { } s ? Results.Stream(s, type) : Results.NotFound();
});
app.MapGet("/favicon.ico", () => AppPaths.Resource("phonebox.ico") is { } s ? Results.Stream(s, "image/x-icon") : Results.NotFound());

// The version lets the settings page save only over what it loaded (X-Config-Version, see ConfigStore.Save).
app.MapGet("/api/settings", (HttpRequest req, ConfigStore cfg, HttpResponse res) =>
{
    var json = JsonSerializer.Serialize(cfg.Get(), ConfigStore.WriteOpts);
    res.Headers["X-Config-Version"] = cfg.Version.ToString();
    return Results.Text(json, "application/json; charset=utf-8");
});

app.MapPut("/api/settings", async (HttpRequest req, ConfigStore cfg, ILogger<Program> log) =>
{
    if (req.ContentType?.StartsWith("application/json") != true) return Results.StatusCode(415);
    using var r = new StreamReader(req.Body);
    long? expected = long.TryParse(req.Headers["X-Config-Version"], out var v) ? v : null; // scripts may leave it out
    var body = await r.ReadToEndAsync();
    if (LanPortCollidesWithLocal(body, Port))
        return Results.BadRequest(new { error = $"Wi-Fi port cannot be the same as the local port ({Port})" });
    string? err;
    long savedVersion;
    err = cfg.Save(body, expected, out savedVersion);
    if (err == ConfigStore.Conflict) return Results.Json(new { error = err }, statusCode: StatusCodes.Status409Conflict);
    if (err is not null) return Results.BadRequest(new { error = err });
    log.LogInformation("settings saved");
    return Results.Ok(new { version = savedVersion.ToString(CultureInfo.InvariantCulture) });
});

app.MapGet("/api/info", (AdbReverse adb, ConfigStore cfg) => Results.Json(new
{
    version = AppPaths.Version,
    os = AppPaths.Os,
    configPath = cfg.Path,
    logPath = AppPaths.LogPath,
    adb = AdbReverse.FindAdb(cfg.Get().AdbPath),
    // USB (adb) or a live stream from the phone in the last few seconds, which covers Wi-Fi / Tailscale too
    connected = adb.Connected || ApprovalStore.PhoneConnected,
    via = adb.Connected ? "USB" : ApprovalStore.PhoneConnected ? "Wi-Fi" : null,
    devices = adb.AllDevices,
    appMissing = adb.MissingApp,
    usbProblem = adb.UsbProblem,
    webviewProblem = WebViewDoctor.DiagnoseRecent(PhoneRegistry.All(), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()),
}));

app.MapPost("/api/phone/open", async (AdbReverse adb) => { await adb.OpenPanelAsync(); return Results.Ok(); });

// Widget types and page templates for the settings page's layout editor.
app.MapGet("/api/catalog", () => Results.Text($"{{\"cols\":{Catalog.Cols},\"rows\":{Catalog.Rows},\"widgets\":{Catalog.WidgetsJson},\"templates\":{Catalog.TemplatesJson}}}",
    "application/json; charset=utf-8"));

// ---------------------------------------------------------------- phone panel API
object State(IServiceProvider sp, long? ev)
{
    var upd = sp.GetRequiredService<UpdateService>();
    var push = sp.GetRequiredService<PushStore>();
    return new
    {
        update = upd.Status() is { } u && (u.AppUpdate || u.AgentUpdate) ? new { latest = u.Latest, app = u.AppUpdate, agent = u.AgentUpdate } : null,
        ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        host = Environment.MachineName,
        os = AppPaths.Os, // the Trackpad's gesture vibration is only for the computers that act on a gesture (macOS)
        cfgVersion = sp.GetRequiredService<ConfigStore>().Version.ToString(),
        evSeq = push.Seq,
        events = ev is { } since ? push.Since(since) : [],
        pc = sp.GetRequiredService<SystemMonitor>().Snapshot(),
        audio = sp.GetRequiredService<AudioControl>().Snapshot(),
        ping = sp.GetRequiredService<PingMonitor>().Snapshot(),
    };
}

// Docker / Podman containers (Docker widget); start / stop / restart only if a widget allows it.
app.MapGet("/api/docker", async (DockerMonitor docker, CancellationToken ct) =>
    Results.Json(new { snapshot = await docker.SnapshotAsync(ct), control = docker.ControlAllowed() }));
app.MapPost("/api/docker/{id}/{action}", async (string id, string action, DockerMonitor docker) =>
    await docker.ActAsync(id, action) is { } error ? Results.BadRequest(new { error }) : Results.Ok(new { ok = true }));

// Settings › General › Ping & network: the connected adapters to pick from (local only, not on the Wi-Fi list)
app.MapGet("/api/network/adapters", (ConfigStore cfg) => Results.Json(SystemMonitor.Adapters(cfg.Get().Ping.Adapters)));

// The phone reports its battery; USB setup reads its view of the USB link (UsbDoctor).
app.MapPost("/api/phone/battery", (int level, bool plugged, double? temp, string? source, string? usb) => { ChargeGuard.Report(level, plugged, temp, source, usb); return Results.Ok(); });
app.MapGet("/api/state", (long? ev, HttpContext ctx) => Results.Json(State(ctx.RequestServices, ev)));

// Live stream (server-sent events) for the phone: "state" every second, "event" as soon as one happens, "work" when it
// changes. The Android shell keeps one connection open instead of polling; the panel falls back to polling without it.
// One "state" frame for all open streams: they wake on the same second (below), so the state is built and serialized once
// per tick, not once per phone. Everything State() reads is a singleton, so the root provider will do.
var stateFrames = new StateFrameCache(() => State(app.Services, null), new JsonSerializerOptions(JsonSerializerDefaults.Web));
app.MapGet("/api/stream", async (HttpContext ctx, PushStore push, SessionMonitor sessions, GitHubMonitor gh, ILogger<Program> log) =>
{
    var ct = ctx.RequestAborted;
    var isPhone = ctx.Request.Headers.ContainsKey("X-PhoneBox-App");
    var via = ctx.Connection.LocalPort == usb.Port ? "USB" : ctx.Connection.LocalPort == Port ? "local" : "Wi-Fi";
    log.LogInformation("live stream opened ({Who}, {Via})", isPhone ? "phone" : "other client", via);
    ctx.Response.ContentType = "text/event-stream";
    ctx.Response.Headers["X-Accel-Buffering"] = "no";
    var opts = new JsonSerializerOptions(JsonSerializerDefaults.Web);
    async Task Send(string name, object data)
    {
        await ctx.Response.WriteAsync($"event: {name}\ndata: {JsonSerializer.Serialize(data, opts)}\n\n", ct);
        await ctx.Response.Body.FlushAsync(ct);
    }
    using var wake = new SemaphoreSlim(0);
    var poked = 0;
    void OnEmit() { try { wake.Release(); } catch (ObjectDisposedException) { } }
    // something the phone shows just changed (see StateSignal): send a state now, not at the next whole second
    void OnPoke() { Volatile.Write(ref poked, 1); OnEmit(); }
    push.Emitted += OnEmit;
    StateSignal.Changed += OnPoke;
    try
    {
        var seq = push.Seq;
        var lastWork = "";
        var next = 0L;
        var lastState = 0L;
        var tick = 0;
        while (!ct.IsCancellationRequested)
        {
            foreach (var e in push.Since(seq)) { await Send("event", e); seq = e.Seq; }
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var tickDue = now >= next;
            var pokeDue = Volatile.Read(ref poked) == 1 && now - lastState >= 100;
            if (tickDue || pokeDue)
            {
                Volatile.Write(ref poked, 0); // before the frame is built: a change during the build is answered by the next pass
                if (isPhone) Interlocked.Exchange(ref ApprovalStore.PhoneLastSeen, now);
                await ctx.Response.WriteAsync(stateFrames.Get(push.Seq, StateSignal.Version), ct);
                await ctx.Response.Body.FlushAsync(ct);
                lastState = now;
            }
            if (tickDue)
            {
                if (tick++ % 2 == 0)
                {
                    var work = WorkFeed.Build(sessions, gh);
                    var json = JsonSerializer.Serialize(work, opts);
                    if (json != lastWork) { lastWork = json; await Send("work", work); }
                }
                next = (now / 1000 + 1) * 1000; // the next whole second, the same for every stream (see stateFrames)
            }
            var waitMs = next - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            // a change that arrived within 100 ms of the last state waits out the rest of that gap
            if (Volatile.Read(ref poked) == 1) waitMs = Math.Min(waitMs, lastState + 100 - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            await wake.WaitAsync(TimeSpan.FromMilliseconds(Math.Max(5, waitMs)), ct);
        }
    }
    catch (OperationCanceledException) { }
    catch (IOException) { }
    finally
    {
        push.Emitted -= OnEmit;
        StateSignal.Changed -= OnPoke;
        log.LogInformation("live stream closed ({Via})", via);
    }
});

// Claude Code PermissionRequest hook (local only): waits for Allow / Deny from the phone, prints nothing otherwise.
app.MapPost(ClaudeHook.Endpoint, async (HttpRequest req, ConfigStore cfg, ApprovalStore approvals, SessionMonitor sessions) =>
{
    JsonElement input;
    try { input = (await JsonDocument.ParseAsync(req.Body)).RootElement.Clone(); }
    catch (JsonException) { return Results.Text(""); }
    var output = await ClaudeHook.HandleAsync(input, cfg, approvals, sessions, req.HttpContext.RequestAborted);
    return output is null ? Results.Text("") : Results.Json(output);
});
app.MapGet("/api/claude/hook", () => Results.Json(new { installed = ClaudeHook.Installed(), path = ClaudeHook.SettingsPath }));
app.MapPost("/api/claude/hook", (ConfigStore cfg) => ClaudeHook.Configure(true, Port, cfg.Get().Claude.TimeoutSec) is { } err ? Results.BadRequest(new { error = err }) : Results.Ok());
app.MapDelete("/api/claude/hook", (ConfigStore cfg) => ClaudeHook.Configure(false, Port, cfg.Get().Claude.TimeoutSec) is { } err ? Results.BadRequest(new { error = err }) : Results.Ok());

// The recent messages and steps of one running Claude Code session, for the phone's session details. Off until the user
// turns on Settings › Claude Code › "Show the conversation on the phone"; only a session the monitor currently sees.
app.MapGet("/api/work/conversation", (string id, ConfigStore cfg, SessionMonitor sessions) =>
{
    return Results.Json(ClaudeTranscript.ForPhone(cfg.Get().Claude.ShareConversation, sessions.Snapshot(), id));
});

// Codex uses the same PermissionRequest decision contract, through ~/.codex/hooks.json.
app.MapPost(CodexHook.Endpoint, async (HttpRequest req, ConfigStore cfg, ApprovalStore approvals, SessionMonitor sessions) =>
{
    JsonElement input;
    try { input = (await JsonDocument.ParseAsync(req.Body)).RootElement.Clone(); }
    catch (JsonException) { return Results.Text(""); }
    var output = await CodexHook.HandleAsync(input, cfg, approvals, sessions, req.HttpContext.RequestAborted);
    return output is null ? Results.Text("") : Results.Json(output);
});
app.MapGet("/api/codex/hook", () => Results.Json(new { installed = CodexHook.Installed(), path = CodexHook.HooksPath }));
app.MapPost("/api/codex/hook", (ConfigStore cfg) => CodexHook.Configure(true, Port, cfg.Get().Claude.TimeoutSec) is { } err ? Results.BadRequest(new { error = err }) : Results.Ok());
app.MapDelete("/api/codex/hook", (ConfigStore cfg) => CodexHook.Configure(false, Port, cfg.Get().Claude.TimeoutSec) is { } err ? Results.BadRequest(new { error = err }) : Results.Ok());

// Permission prompts waiting for the phone (posted by an AI coding agent hook).
app.MapGet("/api/approvals", (ApprovalStore a) => Results.Json(new { items = a.Snapshot() }));
app.MapPost("/api/approvals/{id}", (string id, string decision, ApprovalStore a) =>
    a.Decide(id, decision) ? Results.Ok() : Results.NotFound());

app.MapGet("/api/config", (ConfigStore cfg, HttpRequest req) =>
    Results.Json(new { version = cfg.Version.ToString(), config = cfg.Get().ToPublic(req.Headers["X-PhoneBox-Device"].ToString()) }));

// Phones that have talked to this agent, with their settings (Settings › Phones).
app.MapGet("/api/phones", (ConfigStore cfg) =>
{
    var c = cfg.Get();
    var seen = PhoneRegistry.All().ToDictionary(p => p.Id);
    var ids = seen.Keys.Union(c.Phones.Select(p => p.Id));
    return Results.Json(ids.Select(id => new
    {
        id,
        model = seen.TryGetValue(id, out var s) ? s.Model : null,
        lastSeen = s?.LastSeen,
        via = s?.Via,
        webView = s?.WebView,
        webviewProblem = s is null ? null : WebViewDoctor.Diagnose(s.WebView, s.Model),
        name = c.Phones.FirstOrDefault(p => p.Id == id)?.Name,
        pages = c.Phones.FirstOrDefault(p => p.Id == id)?.Pages,
    }).OrderByDescending(p => p.lastSeen ?? 0));
});

app.MapPost("/api/volume", (int? level, string? op, AudioControl audio) =>
{
    var ok = op switch
    {
        "mute" => audio.ToggleMute(),
        "up" => audio.Step(+5),
        "down" => audio.Step(-5),
        _ when level is { } l => audio.SetVolume(l),
        _ => false,
    };
    if (ok) StateSignal.Poke(); // the phone's other screens and widgets see it now, not at the next second
    return ok ? Results.Json(audio.Current()) : Results.BadRequest();
});

app.MapGet("/api/quotas", (QuotaMonitor q) => Results.Json(new { providers = q.Snapshot(), overview = q.Overview() }));

app.MapGet("/api/work", (SessionMonitor s, GitHubMonitor gh) => Results.Json(WorkFeed.Build(s, gh)));


app.MapGet("/api/procs", (ProcessMonitor procs, int? top) =>
{
    var all = procs.Snapshot();
    return Results.Json(new { total = all.Sum(g => g.Count), groupCount = all.Count, groups = all.Take(Math.Clamp(top ?? 40, 1, 200)) });
});

app.MapGet("/api/procs/icon", (string name, ProcessMonitor procs) =>
    procs.Icon(name) is { } png ? Results.File(png, "image/png") : Results.NotFound());

app.MapGet("/api/procs/detail", (string name, ProcessMonitor procs) => Results.Json(procs.Detail(name)));

// ?name=X ends every instance of X; ?pid=N ends one process together with its children.
app.MapPost("/api/procs/kill", (string? name, int? pid, ProcessMonitor procs, ConfigStore cfg) =>
{
    if (!cfg.Get().AllowKill())
        return Results.Json(new KillResult(0, 0, "Terminating processes is disabled in the settings"), statusCode: 403);
    var r = pid is { } id ? procs.KillPid(id) : procs.Kill(name ?? "");
    return r.Killed > 0 ? Results.Json(r) : Results.Json(r, statusCode: 409);
});

app.Lifetime.ApplicationStarted.Register(() =>
    app.Logger.LogInformation("PhoneBox agent {Version} ready on http://127.0.0.1:{Port}, phone USB port {UsbPort} (config: {Path})",
        AppPaths.Version, Port, usb.Port, configPath));

app.Run();

// Restart requested from the settings page (e.g. Wi-Fi turned on): hand over to a fresh instance.
single.ReleaseMutex();
single.Dispose();
if (AppRestart.Requested && Environment.ProcessPath is { } exe)
{
    if (AppRestart.ServiceManaged(Environment.GetEnvironmentVariable, Environment.ProcessId, AppRestart.ParentName)) Environment.ExitCode = AppRestart.ServiceRestartCode;
    else System.Diagnostics.Process.Start(AppRestart.StartInfo(exe, args));
}

static void AddMonitor<T>(IServiceCollection s) where T : class, IHostedService
{
    s.AddSingleton<T>();
    s.AddHostedService(sp => sp.GetRequiredService<T>());
}

/// <summary>Body of POST /api/pair/claim.</summary>
internal sealed record PairClaim(string? Code);

public partial class Program
{
    internal static bool LanPortCollidesWithLocal(string json, int localPort)
    {
        try
        {
            using var doc = JsonDocument.Parse(json, new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return false;
            // ConfigStore.Save deserializes a repeated member (in any letter case) last-wins, so the last "lan" is the
            // one that gets saved; a last one that is not an object leaves Wi-Fi off
            var collides = false;
            foreach (var prop in doc.RootElement.EnumerateObject())
            {
                if (!prop.Name.Equals("lan", StringComparison.OrdinalIgnoreCase)) continue;
                collides = false;
                if (prop.Value.ValueKind != JsonValueKind.Object) continue;
                var enabled = false;
                var port = 8766;
                foreach (var lp in prop.Value.EnumerateObject())
                {
                    if (lp.Name.Equals("enabled", StringComparison.OrdinalIgnoreCase) && lp.Value.ValueKind is JsonValueKind.True or JsonValueKind.False)
                        enabled = lp.Value.GetBoolean();
                    else if (lp.Name.Equals("port", StringComparison.OrdinalIgnoreCase) && lp.Value.ValueKind == JsonValueKind.Number && lp.Value.TryGetInt32(out var p))
                        port = Math.Clamp(p, 1024, 65535);
                }
                collides = enabled && port == localPort;
            }
            return collides;
        }
        catch (JsonException) { }
        return false;
    }

    /// <summary>
    /// POST /api/pair/claim. Wi-Fi is checked again once the body has arrived, with the settings that answer the claim:
    /// a claim still waiting for its body when Wi-Fi is turned off is refused and does not use up the code.
    /// </summary>
    internal static async Task<IResult> ClaimPairingAsync(HttpRequest req, ConfigStore cfg, PairingCodes codes,
        System.Security.Cryptography.X509Certificates.X509Certificate2? lanCert, int lanPort, ILogger log)
    {
        if (!cfg.Get().Lan.Enabled || lanCert is null || req.ContentLength is > 1024) return Results.StatusCode(StatusCodes.Status403Forbidden);
        var code = await PairingCodes.ReadClaimCodeAsync(req);
        var lan = cfg.Get().Lan;
        if (!lan.Enabled || code is null || !codes.Claim(code, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()))
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        log.LogInformation("phone paired over Wi-Fi ({Model})", req.Headers["X-PhoneBox-Model"].ToString());
        return Results.Json(new
        {
            enabled = true,
            pc = Environment.MachineName,
            port = lanPort,
            token = lan.Token,
            fingerprint = Lan.Fingerprint(lanCert),
            hosts = Lan.Addresses(),
        });
    }
}

