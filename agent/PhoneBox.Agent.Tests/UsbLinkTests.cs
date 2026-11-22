using Microsoft.AspNetCore.Http;
using PhoneBox.Agent;
using Xunit;

/// <summary>
/// The phone's USB port: every app on the phone can reach the adb reverse tunnel, so only the key the PhoneBox app
/// made opens it, and only for the paths the kept widgets use (never settings, hooks or updates).
/// </summary>
public class UsbLinkTests
{
    private const string Key = "k3Y_0123456789abcdefghijklmnopqrstuvwxyzABCD";
    private const string OtherKey = "Zz9_0123456789abcdefghijklmnopqrstuvwxyzABCD";
    private const string Pin = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    private static UsbLink Linked()
    {
        var usb = new UsbLink(45678, Pin);
        usb.SetKey("FAKE1", Key);
        return usb;
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("Bearer ")]
    [InlineData("Bearer wrong")]
    [InlineData(Key)] // without "Bearer "
    public void ARequestWithoutTheAppsKeyIsRefused(string? authorization)
    {
        var usb = Linked();
        Assert.Equal(UsbLink.Access.Unauthorized, usb.Authorize("GET", "/api/state", "", authorization));
    }

    [Fact]
    public void NoPhoneNoKeyNothingOpens()
    {
        var usb = new UsbLink(45678, Pin);
        Assert.Equal(UsbLink.Access.Unauthorized, usb.Authorize("GET", "/api/state", "", "Bearer " + Key));
    }

    [Theory]
    [InlineData("GET", "/api/config")]
    [InlineData("GET", "/api/state")]
    [InlineData("GET", "/api/stream")]
    [InlineData("GET", "/api/quotas")]
    [InlineData("GET", "/api/work")]
    [InlineData("GET", "/api/work/conversation")]
    [InlineData("GET", "/api/procs")]
    [InlineData("GET", "/api/procs/icon")]
    [InlineData("GET", "/api/procs/detail")]
    [InlineData("GET", "/api/docker")]
    [InlineData("GET", "/api/approvals")]
    [InlineData("POST", "/api/volume")]
    [InlineData("POST", "/api/procs/kill")]
    [InlineData("POST", "/api/approvals/a1")]
    [InlineData("POST", "/api/docker/c0ffee/restart")]
    public void TheAppsKeyOpensThePathsTheKeptWidgetsUse(string method, string path)
    {
        Assert.Equal(UsbLink.Access.Allowed, Linked().Authorize(method, path, "", "Bearer " + Key));
    }

    [Theory]
    [InlineData("GET", "/api/settings")]
    [InlineData("PUT", "/api/settings")]
    [InlineData("GET", "/api/info")]
    [InlineData("GET", "/api/phones")]
    [InlineData("POST", "/api/goto/home")]   // the settings page's "Open on phone" only
    [InlineData("GET", "/api/claude/hook")]
    [InlineData("POST", "/api/codex/hook")]
    [InlineData("POST", "/api/update/apply")]
    [InlineData("GET", "/api/latency")]
    [InlineData("GET", "/settings.html")]
    public void EvenWithTheKeyTheSettingsAndLocalToolsStayLocal(string method, string path)
    {
        Assert.Equal(UsbLink.Access.Forbidden, Linked().Authorize(method, path, "", "Bearer " + Key));
    }

    [Theory]
    // what Wi-Fi and the battery report used: gone with them
    [InlineData("GET", "/api/pair")]
    [InlineData("POST", "/api/pair/claim")]
    [InlineData("GET", "/api/lan")]
    [InlineData("POST", "/api/phone/battery")]
    // an allowed path with the wrong method, or with something more or less after it
    [InlineData("POST", "/api/state")]
    [InlineData("GET", "/api/volume")]
    [InlineData("GET", "/api/procs/kill")]
    [InlineData("DELETE", "/api/approvals/a1")]
    [InlineData("POST", "/api/approvals")]
    [InlineData("POST", "/api/approvals/a1/x")]
    [InlineData("POST", "/api/approvals//")]
    [InlineData("POST", "/api/docker/c0ffee")]
    [InlineData("POST", "/api/docker/c0ffee/restart/x")]
    [InlineData("POST", "/api/docker//restart")]
    [InlineData("GET", "/api/state/x")]
    [InlineData("GET", "/api/statex")]
    [InlineData("GET", "/API/settings")]
    public void NothingBeyondTheListOpens(string method, string path)
    {
        Assert.Equal(UsbLink.Access.Forbidden, Linked().Authorize(method, path, "", "Bearer " + Key));
    }

    [Fact]
    public void KeysAreComparedExactly()
    {
        Assert.True(UsbLink.Matches("Bearer abc123", "abc123"));
        Assert.False(UsbLink.Matches("Bearer abc12", "abc123"));
        Assert.False(UsbLink.Matches("abc123", "abc123"));
        Assert.False(UsbLink.Matches(null, "abc123"));
    }

    [Fact]
    public void TheCertificateStaysInTheConfigFolderAndIsRecreatedWhenCorrupt()
    {
        var dir = Directory.CreateTempSubdirectory("phonebox-cert-").FullName;
        try
        {
            var certPath = Path.Combine(dir, "lan-cert.pfx");
            File.WriteAllText(certPath, "corrupt");
            using var first = AgentCert.Load(dir);
            Assert.True(File.Exists(certPath));
            var fp = AgentCert.Fingerprint(first);
            using var second = AgentCert.Load(dir);
            Assert.Equal(fp, AgentCert.Fingerprint(second));
            if (!OperatingSystem.IsWindows())
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(certPath));
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void AWebPageCannotUseTheTunnelEvenWithTheKey()
    {
        Assert.Equal(UsbLink.Access.Forbidden, Linked().Authorize("GET", "/api/state", "http://127.0.0.1:8765", "Bearer " + Key));
    }

    [Fact]
    public void EachPhoneUsesItsOwnKeyAndAnUnpluggedPhonesKeyStopsWorking()
    {
        var usb = Linked();
        usb.SetKey("FAKE2", OtherKey);
        Assert.Equal(UsbLink.Access.Allowed, usb.Authorize("GET", "/api/state", "", "Bearer " + OtherKey));
        usb.Retain(["FAKE1"]);
        Assert.False(usb.HasKey("FAKE2"));
        Assert.Equal(UsbLink.Access.Unauthorized, usb.Authorize("GET", "/api/state", "", "Bearer " + OtherKey));
        Assert.Equal(UsbLink.Access.Allowed, usb.Authorize("GET", "/api/state", "", "Bearer " + Key));
    }

    [Fact]
    public void AnUnknownKeyAsksTheAgentToReadTheKeysAgainOnce()
    {
        var usb = Linked();
        Assert.False(usb.TakeUnknownKey());
        usb.Authorize("GET", "/api/state", "", "Bearer " + OtherKey);
        Assert.True(usb.TakeUnknownKey());
        Assert.False(usb.TakeUnknownKey());
        usb.Authorize("GET", "/api/state", "", "Bearer " + Key);
        Assert.False(usb.TakeUnknownKey());
    }

    [Fact]
    public void TheKeyIsReadFromTheContentQueryOutput()
    {
        Assert.Equal(Key, UsbLink.ParseKey($"Row: 0 key={Key}\n"));
        Assert.Equal(Key, UsbLink.ParseKey($"Row: 0 key={Key}\r\n"));
        Assert.Null(UsbLink.ParseKey("No result found.\n"));
        Assert.Null(UsbLink.ParseKey("Error while accessing provider:net.oxog.phonebox.deskpanel.usb\njava.lang.SecurityException"));
        Assert.Null(UsbLink.ParseKey("Row: 0 key=short\n"));
        Assert.Null(UsbLink.ParseKey($"Row: 0 key={Key} extra\n"));
    }

    private const string Owned = "Packages:\n  Package [net.oxog.phonebox.deskpanel] (1a2b3c):\n    versionName=0.9.24\n"
        + "ContentProvider Authorities:\n  [net.oxog.phonebox.deskpanel.usb]:\n    Provider{3ec2f24 net.oxog.phonebox.deskpanel/.UsbKeyProvider}\n"
        + "      applicationInfo=ApplicationInfo{a39b11a net.oxog.phonebox.deskpanel}\n";

    [Fact]
    public void TheKeyIsTrustedOnlyFromTheAppsOwnProvider()
    {
        Assert.True(UsbLink.OwnsKeyProvider(Owned));
        Assert.True(UsbLink.OwnsKeyProvider(Owned.Replace("\n", "\r\n")));
        Assert.True(UsbLink.OwnsKeyProvider(Owned.Replace("/.UsbKeyProvider", "/net.oxog.phonebox.deskpanel.UsbKeyProvider")));
        // an older PhoneBox without the provider: the name may belong to another app, so no key is read
        Assert.False(UsbLink.OwnsKeyProvider("Packages:\n  Package [net.oxog.phonebox.deskpanel] (1a2b3c):\n    versionName=0.9.23\n"));
        // another package's provider under the same name, or another class
        Assert.False(UsbLink.OwnsKeyProvider(Owned.Replace("Provider{3ec2f24 net.oxog.phonebox.deskpanel/", "Provider{3ec2f24 com.evil.app/")));
        Assert.False(UsbLink.OwnsKeyProvider(Owned.Replace("UsbKeyProvider}", "Other}")));
        Assert.False(UsbLink.OwnsKeyProvider(Owned.Replace("[net.oxog.phonebox.deskpanel.usb]", "[net.oxog.phonebox.deskpanel.usb2]")));
        Assert.False(UsbLink.OwnsKeyProvider(""));
    }

    [Fact]
    public void TheAppVersionIsReadFromDumpsys()
    {
        const string dump = "Packages:\n  Package [net.oxog.phonebox.deskpanel] (1a2b3c):\n    versionCode=43 minSdk=21 targetSdk=35\n    versionName=0.9.22\n";
        Assert.Equal("0.9.22", UsbLink.ParseVersionName(dump));
        Assert.Null(UsbLink.ParseVersionName("Unable to find package: net.oxog.phonebox.deskpanel"));
    }

    [Fact]
    public void TheTunnelGetsAFreeLoopbackPortOfItsOwn()
    {
        var port = UsbLink.FreeLoopbackPort();
        Assert.InRange(port, 1024, 65535);
    }
}
