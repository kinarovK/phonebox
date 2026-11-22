using PhoneBox.Agent;
using Xunit;

public sealed class ConfigLegacyOptionsTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "phonebox-legacy-" + Guid.NewGuid().ToString("N"));

    public ConfigLegacyOptionsTests() => Directory.CreateDirectory(_dir);
    public void Dispose() => Directory.Delete(_dir, recursive: true);

    [Theory]
    [InlineData("[\"cpu\",42,\"ram\"]")]
    [InlineData("[false,\"cpu\",{},null,[],\"ram\"]")]
    [InlineData("[\"cpu\",\"ram\"]")]
    public void LegacyHomeKeepsStringTilesAndSkipsOtherJsonTypes(string tiles)
    {
        var store = new ConfigStore(Path.Combine(_dir, "config.json"));
        Assert.Null(store.Save("{\"pages\":[{\"type\":\"home\",\"options\":{\"tiles\":" + tiles + "}}]}"));
        Assert.Equal(["cpu", "ram"], store.Get().Pages.Single().Widgets!
            .Where(w => w.Type == "stat").Select(w => w.Str("metric")));
    }

    [Theory]
    [InlineData("\"three\"")]
    [InlineData("null")]
    [InlineData("true")]
    [InlineData("{}")]
    [InlineData("[]")]
    [InlineData("2.5")]
    [InlineData("2147483648")]
    public void LegacyDeckIgnoresColumnsThatAreNotAnInteger(string columns)
    {
        var store = new ConfigStore(Path.Combine(_dir, "config.json"));
        Assert.Null(store.Save("{\"pages\":[{\"type\":\"deck\",\"options\":{\"columns\":" + columns + "}}]}"));
        Assert.Equal(4, store.Get().Pages.Single().Widgets!.Single(w => w.Type == "shortcuts").Int("columns"));
    }

    [Fact]
    public void ConfigFromBeforeTheControlDeckRemovalStillLoads()
    {
        // the removed Control Deck kept its bindings in "controls" and its widgets on ordinary pages
        var path = Path.Combine(_dir, "config.json");
        File.WriteAllText(path, """
            {"controls":{"allowListening":true,"spotifyClientId":"abc","actions":[{"id":"r1","kind":"radio","target":"https://example.com/live.mp3"}],
              "profiles":[{"id":"p","levels":[{"kind":"device","id":"spk","volume":40,"muted":false}],"actions":[null]}]},
             "night":{"start":"01:15"},
             "pages":[{"id":"p","enabled":true,"widgets":[{"type":"audio-mixer","x":0,"y":0,"w":6,"h":3},{"type":"clock","x":6,"y":0,"w":6,"h":3}]}]}
            """);
        var store = new ConfigStore(path);
        Assert.Equal("01:15", store.Get().Night.Start);
        Assert.Equal(["clock"], store.Get().Pages.Single().Widgets!.Select(w => w.Type));
    }

    [Fact]
    public void LegacyDeckPreservesNumericColumns()
    {
        var store = new ConfigStore(Path.Combine(_dir, "config.json"));
        Assert.Null(store.Save("""{"pages":[{"type":"deck","options":{"columns":3}}]}"""));
        Assert.Equal(3, store.Get().Pages.Single().Widgets!.Single(w => w.Type == "shortcuts").Int("columns"));
    }
}
