using System.Net;
using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PhoneBox.Agent;
using Xunit;

/// <summary>Pushed-data saving, page references, feed addresses and the Claude settings file.</summary>
public sealed class StoreFollowUpTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("phonebox-store-followup-").FullName;

    public void Dispose() { try { Directory.Delete(_dir, recursive: true); } catch { } }

    private static readonly BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;

    // ---- page references ----

    [Fact]
    public void APageReferenceWithStraySpacesFindsItsPage()
    {
        var path = Path.Combine(_dir, "config.json");
        var reference = " Desk + Live ";
        var store = new ConfigStore(path);
        Assert.Null(store.Save(JsonSerializer.Serialize(new
        {
            pages = new[] { new { id = "Desk / Live" }, new { id = "Desk + Live" }, new { id = "kitchen" } },
            display = new { homePage = reference },
            phones = new[] { new { id = "desk", pages = new[] { reference } } },
        })));
        foreach (var config in new[] { store.Get(), new ConfigStore(path).Get() })
        {
            Assert.Equal(["desk-live", "desk-live-2", "kitchen"], config.Pages.Select(p => p.Id));
            Assert.Equal("desk-live-2", config.Display.HomePage);
            Assert.Equal("desk-live-2", string.Join(",", config.PagesFor("desk").Select(p => p.Id)));
        }
    }

    // ---- Claude Code settings file ----

    // The settings file can hold API keys: its replacement and backup are owner-only, whatever the umask.
    [Fact]
    public void ReplacingClaudeSettingsKeepsThemOwnerOnly()
    {
        var path = Path.Combine(_dir, "settings.json");
        File.WriteAllText(path, """{ "env": { "ANTHROPIC_API_KEY": "not-a-real-key" } }""");
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        Assert.Null(ClaudeHook.Configure(true, 18765, 30, path));
        Assert.True(ClaudeHook.Installed(path));
        Assert.Contains("not-a-real-key", File.ReadAllText(path));
        if (OperatingSystem.IsWindows()) return; // Windows keeps the profile's ACLs
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path + ".phonebox.bak"));
    }

    // A hooks value of another shape is the user's to fix: neither installing nor removing may replace or drop it.
    [Theory]
    [InlineData("""{ "hooks": { "PermissionRequest": { "matcher": "*" } } }""")]
    [InlineData("""{ "hooks": ["not", "an", "object"] }""")]
    public void AMalformedHooksValueIsLeftAsItIs(string json)
    {
        var path = Path.Combine(_dir, "settings.json");
        foreach (var install in new[] { false, true })
        {
            File.WriteAllText(path, json);
            Assert.NotNull(ClaudeHook.Configure(install, 18765, 30, path));
            Assert.Equal(json, File.ReadAllText(path));
        }
    }
}
