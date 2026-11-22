using System.Text;
using System.Text.Json;
using PhoneBox.Agent;
using Xunit;

public sealed class IconEncodingTests
{
    [Theory]
    [InlineData("\u00e2\u0152\u00a8\u00ef\u00b8\u008f", "\u2328\ufe0f")]
    [InlineData("\u00e2\u0161\u2122\u00ef\u00b8\u008f", "\u2699\ufe0f")]
    [InlineData("\u00e2\u0153\u201a\u00ef\u00b8\u008f", "\u2702\ufe0f")]
    [InlineData("\u00e2\u0153\u00b3\u00ef\u00b8\u008f", "\u2733\ufe0f")]
    public void KnownDoubleEncodedIconsAreRecoveredWithoutReencodingOtherText(string broken, string expected)
    {
        using var f = new Fixture(new AgentConfig { Pages = [new() { Id = "p", Title = "Türkçe — 日本語", Icon = broken, Widgets = [new() { Type = "stat" }] }] });
        var config = f.Store.Get();
        Assert.Equal(expected, config.Pages.Single().Icon);
        Assert.Equal("Türkçe — 日本語", config.Pages.Single().Title);
    }

    [Fact]
    public void SavedIconStringsSurviveAnsiReadingAndKeepOtherUnicodeText()
    {
        const string symbols = "\u2328\ufe0f \u2699\ufe0f \u2702\ufe0f \u2733\ufe0f 🏠";
        using var f = new Fixture(new AgentConfig { Pages = [new() { Id = "p", Icon = symbols, Title = "Türkçe", Widgets = [new() { Type = "stat" }] }] });
        Assert.Null(f.Store.Save(JsonSerializer.Serialize(f.Store.Get())));
        var bytes = File.ReadAllBytes(f.Path);
        Assert.False(bytes.AsSpan().StartsWith(Encoding.UTF8.GetPreamble()));
        var ansi = JsonSerializer.Deserialize<AgentConfig>(Encoding.Latin1.GetString(bytes), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        Assert.Equal(symbols, ansi.Pages.Single().Icon);
        Assert.Equal("Türkçe", new ConfigStore(f.Path).Get().Pages.Single().Title);
    }

    [Fact]
    public void ExistingBrokenIconsArePersistedOnceWithAnOriginalBackup()
    {
        using var f = new Fixture(new AgentConfig { Pages = [new() { Id = "p", Icon = "\u00e2\u0152\u00a8\u00ef\u00b8\u008f", Widgets = [new() { Type = "stat" }] }] });
        var before = File.ReadAllBytes(f.Path);
        f.Store.PersistGenerated();
        Assert.Equal("\u2328\ufe0f", new ConfigStore(f.Path).Get().Pages.Single().Icon);
        Assert.Equal(before, File.ReadAllBytes(f.Path + ".bak"));
        var after = File.ReadAllBytes(f.Path); f.Store.PersistGenerated();
        Assert.Equal(after, File.ReadAllBytes(f.Path));
    }

    [Fact]
    public void Latin1AndRepeatedAnsiCorruptionAreRecoveredByExactMatchOnly()
    {
        foreach (var icon in new[] { "⌨️", "⚙️", "✂️", "✳️" })
        {
            var broken = icon;
            for (var pass = 0; pass < 2; pass++)
            {
                broken = Encoding.Latin1.GetString(Encoding.UTF8.GetBytes(broken));
                Assert.Equal(icon, IconText.Repair(broken));
            }
            Assert.Equal("custom " + broken, IconText.Repair("custom " + broken));
        }
    }

    [Fact]
    public void ValidEmojiAndCustomIconTextAreUnchanged()
    {
        foreach (var icon in new[] { "⌨️", "⚙️", "✂️", "✳️", "🏠", "DB", "İş", "â custom", "λ" })
        {
            using var f = new Fixture(new AgentConfig { Pages = [new() { Id = "p", Icon = icon, Widgets = [new() { Type = "stat" }] }] });
            Assert.Equal(icon, f.Store.Get().Pages.Single().Icon);
        }
    }

    private sealed class Fixture : IDisposable
    {
        private readonly string _dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "phonebox-icons-" + Guid.NewGuid().ToString("N"));
        public string Path => System.IO.Path.Combine(_dir, "config.json");
        public ConfigStore Store { get; }
        public Fixture(AgentConfig config) { Directory.CreateDirectory(_dir); File.WriteAllText(Path, JsonSerializer.Serialize(config)); Store = new(Path); }
        public void Dispose() { if (!System.IO.Path.GetFullPath(_dir).StartsWith(System.IO.Path.GetFullPath(System.IO.Path.GetTempPath()), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException(); Directory.Delete(_dir, true); }
    }
}
