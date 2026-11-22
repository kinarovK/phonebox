using System.Text.Json;
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
    public void ConfigFromBeforeTheShortcutsAndCommandsRemovalStillLoads()
    {
        // shortcuts, the app console and battery care's switching had their own sections, rules could run a shortcut,
        // and the old fixed "deck" page, shortcut widgets and command widgets sat on pages
        var path = Path.Combine(_dir, "config.json");
        File.WriteAllText(path, """
            {"shortcuts":[{"id":"t","label":"Terminal","cmd":"wt.exe","args":"--token secret"}],
             "console":{"profiles":[{"id":"ps","label":"Photoshop","apps":"Photoshop","keys":[{"keys":"ctrl+z"}]}]},
             "charge":{"enabled":true,"min":40,"max":80,"method":"shortcuts","onShortcut":"t","offShortcut":"t"},
             "night":{"start":"01:15"},
             "rules":[{"id":"run","when":"cpu-above","then":"shortcut","shortcut":"t"},{"id":"say","when":"cpu-above","then":"notify"}],
             "pages":[{"id":"keys","type":"deck"},
                      {"id":"p","enabled":true,"widgets":[{"type":"shortcuts","x":0,"y":0,"w":6,"h":3},{"type":"command","x":6,"y":0,"w":6,"h":3,"options":{"command":"secret.ps1"}},
                      {"type":"clock","x":0,"y":3,"w":12,"h":3}]}]}
            """);
        var store = new ConfigStore(path);
        var config = store.Get();
        Assert.Equal("01:15", config.Night.Start);
        Assert.Equal(["clock"], config.Pages.Single(p => p.Id == "p").Widgets!.Select(w => w.Type));
        Assert.Equal(["say"], config.Rules.Select(r => r.Id));
        Assert.DoesNotContain("secret", JsonSerializer.Serialize(config.ToPublic()));
    }

    [Fact]
    public void ConfigFromBeforeTheMediaAndEntertainmentRemovalStillLoads()
    {
        // OBS, Discord and Steam had their own sections, the widgets sat on pages, and rules could react to media,
        // the microphone, the camera and OBS
        var path = Path.Combine(_dir, "config.json");
        File.WriteAllText(path, """
            {"obs":{"enabled":true,"url":"ws://127.0.0.1:4455","password":"p"},
             "discord":{"enabled":true,"clientId":"1","clientSecret":"s","allowControl":true},
             "steam":{"enabled":true,"steamId":"76561198000000001","apiKey":"k"},
             "night":{"start":"01:15"},
             "rules":[{"id":"m","when":"media-playing","then":"notify"},{"id":"o","when":"obs-live","then":"notify"},
                      {"id":"c","when":"cpu-above","then":"notify"}],
             "pages":[{"id":"p","enabled":true,"widgets":[{"type":"media","x":0,"y":0,"w":6,"h":3},{"type":"steam-library","x":6,"y":0,"w":6,"h":3},
                      {"type":"clock","x":0,"y":3,"w":12,"h":3}]}]}
            """);
        var store = new ConfigStore(path);
        Assert.Equal("01:15", store.Get().Night.Start);
        Assert.Equal(["clock"], store.Get().Pages.Single().Widgets!.Select(w => w.Type));
        Assert.Equal(["c"], store.Get().Rules.Select(r => r.Id));
    }
}
