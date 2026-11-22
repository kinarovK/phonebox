using PhoneBox.Agent;
using Xunit;

public sealed class CodexBarSettingsTests
{
    [Fact]
    public void CodexBarSettingsPersistAndStayWithinSupportedRanges()
    {
        var path = Path.Combine(Path.GetTempPath(), "pb-config-" + Guid.NewGuid() + ".json");
        try
        {
            var store = new ConfigStore(path);
            Assert.Null(store.Save("""{"codexBar":{"providers":[],"pageSize":999,"rotateInterval":-1},"pages":[{"template":"codexbar"}]}"""));
            var config = new ConfigStore(path).Get();
            Assert.Empty(config.CodexBar.Providers);
            Assert.Equal(6, config.CodexBar.PageSize);
            Assert.Equal(2, config.CodexBar.RotateInterval);
            Assert.Contains(config.Pages[0].Widgets!, w => w.Type == "quotas");
        }
        finally { File.Delete(path); File.Delete(path + ".bak"); }
    }
}
