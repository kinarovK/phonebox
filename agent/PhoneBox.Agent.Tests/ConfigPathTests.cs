using PhoneBox.Agent;
using Xunit;

public sealed class ConfigPathTests
{
    [Fact]
    public void ABareRelativeConfigFilenameIsWritten()
    {
        var path = $"phonebox-config-{Guid.NewGuid():N}.json";
        try
        {
            var store = new ConfigStore(path);
            store.PersistGenerated();
            Assert.True(File.Exists(path));
            Assert.Equal(store.Get().Pages.Count, new ConfigStore(path).Get().Pages.Count);
        }
        finally { File.Delete(path); }
    }
}
