namespace PhoneBox.Agent;

/// <param name="Source">What the phone charges from: "usb", "ac", "wireless" or null (older app).</param>
/// <param name="Usb">The phone's own view of its USB link: "connected", "configured", "adb" (comma-separated), "none", or null.</param>
public sealed record PhoneBatteryReport(int Level, bool Plugged, double? Temp, long At, string? Source = null, string? Usb = null);

/// <summary>
/// The phone's latest battery report (it sends one every half minute over USB). Battery care only shows the level;
/// nothing on this computer switches the phone's power. USB setup reads the phone's own view of its USB link from it.
/// </summary>
public static class ChargeGuard
{
    private static PhoneBatteryReport? _report;

    /// <summary>Called by the phone (POST /api/phone/battery).</summary>
    public static void Report(int level, bool plugged, double? temp, string? source = null, string? usb = null) =>
        _report = new PhoneBatteryReport(Math.Clamp(level, 0, 100), plugged, temp, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            string.IsNullOrWhiteSpace(source) ? null : source.Trim().ToLowerInvariant(), string.IsNullOrWhiteSpace(usb) ? null : usb.Trim().ToLowerInvariant());

    /// <summary>The phone's latest report, or null.</summary>
    public static PhoneBatteryReport? LastReport => _report;
}
