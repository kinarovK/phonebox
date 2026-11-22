using System.Text.Json;
using PhoneBox.Agent;
using Xunit;

/// <summary>Rule conditions (days, hours, pushed value comparisons) and the charge guard's decisions.</summary>
public class UsbDoctorTests
{
    private const long Now = 1_000_000_000;
    private static PhoneBatteryReport R(bool plugged, string? usb, long ageMs = 0, string? source = null) => new(60, plugged, null, Now - ageMs, source, usb);

    [Fact]
    public void ChargingWithoutDataBlamesTheCable() =>
        Assert.Contains("only carries power", UsbDoctor.Diagnose(R(true, "none", source: "ac"), false, Now));

    [Fact]
    public void WirelessChargingWithoutUsbDoesNotBlameACable()
    {
        Assert.Contains("only carries power", UsbDoctor.Diagnose(R(true, "none", source: "usb"), false, Now));
        var actual = UsbDoctor.Diagnose(R(true, "none", source: "wireless"), false, Now);
        Assert.True(actual is null, $"EXPECTED: no diagnosis | ACTUAL: {actual}");
        Assert.Contains("USB debugging is off", UsbDoctor.Diagnose(R(true, "connected", source: "wireless"), false, Now));
    }

    [Theory]
    [InlineData(0, true)]
    [InlineData(-1, false)]
    [InlineData(-300_000, false)]
    public void BatteryReportsFromBeforeAClockRollbackDoNotRaiseADiagnosis(long ageMs, bool expected)
    {
        var actual = UsbDoctor.Diagnose(R(true, "none", ageMs, "ac"), false, Now) is not null;
        Assert.True(expected == actual, $"EXPECTED: diagnosis={expected} | ACTUAL: diagnosis={actual}");
    }

    [Fact]
    public void ConnectedWithAdbButUnseenBlamesThePort() =>
        Assert.Contains("adb does not see it", UsbDoctor.Diagnose(R(true, "connected,configured,adb"), false, Now));

    [Fact]
    public void ConnectedWithoutAdbAsksForDebugging() =>
        Assert.Contains("USB debugging is off", UsbDoctor.Diagnose(R(true, "connected,configured"), false, Now));

    [Theory]
    [InlineData(true, "none", 0, true)]                 // adb sees the phone: nothing to explain
    [InlineData(false, "none", 0, false)]               // unplugged
    [InlineData(true, null, 0, false)]                  // an older app without the USB report
    [InlineData(true, "none", 3 * 60_000, false)]       // stale report
    public void StaysQuiet(bool plugged, string? usb, long ageMs, bool adbSees) =>
        Assert.Null(UsbDoctor.Diagnose(R(plugged, usb, ageMs), adbSees, Now));

    [Fact]
    public void NoReportNoDiagnosis() => Assert.Null(UsbDoctor.Diagnose(null, false, Now));
}

public class UpdateServiceTests
{
    [Theory]
    [InlineData("https://api.github.com/repos/ersinkoc/phonebox/releases/latest", true)]
    [InlineData("https://API.github.com/repos/x/y/releases/assets/1", true)]
    [InlineData("http://api.github.com/repos/x/y", false)]                      // never over plain HTTP
    [InlineData("https://github.com/x/y/releases/download/v1/a.zip", false)]
    [InlineData("https://api.github.com.evil.example/repos", false)]
    [InlineData("https://release-assets.githubusercontent.com/x", false)]
    [InlineData("not a url", false)]
    public void TokenOnlyGoesToTheGitHubApi(string url, bool expected) => Assert.Equal(expected, UpdateService.IsGitHubApi(url));

    [Fact]
    public void TimeoutsAndHttpErrorsAreTransientButOurCancellationIsNot()
    {
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        Assert.True(UpdateService.Transient(new HttpRequestException("504"), CancellationToken.None));
        Assert.True(UpdateService.Transient(new TaskCanceledException("HttpClient.Timeout"), CancellationToken.None));
        Assert.False(UpdateService.Transient(new TaskCanceledException(), cancelled.Token));
        Assert.False(UpdateService.Transient(new InvalidOperationException(), CancellationToken.None));
    }
}

/// <summary>F1 (audit 2026-11-08): other sites must not reach the local API through GET requests without an Origin.</summary>
public class BrowserGuardTests
{
    [Theory]
    [InlineData("cross-site", "no-cors", "GET", "/api/widget/devops/command", true)]   // <img src> on another site
    [InlineData("same-site", "cors", "GET", "/api/settings", true)]                     // another port on localhost
    [InlineData("cross-site", "navigate", "GET", "/api/widget/p/w", true)]             // a link straight to the API
    [InlineData("cross-site", "navigate", "POST", "/", true)]                          // a form posted from another site
    [InlineData("cross-site", "navigate", "GET", "/", false)]                          // a link to the settings page
    [InlineData("same-origin", "cors", "GET", "/api/settings", false)]                 // the settings page itself
    [InlineData("none", "navigate", "GET", "/", false)]                                // typed into the address bar
    [InlineData(null, null, "GET", "/api/state", false)]                               // the phone's USB proxy, curl, hooks
    public void ForeignBrowserRequestsAreRefused(string? site, string? mode, string method, string path, bool foreign) =>
        Assert.Equal(foreign, BrowserGuard.IsForeign(site, mode, method, new Microsoft.AspNetCore.Http.PathString(path)));
}
