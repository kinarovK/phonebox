namespace PhoneBox.Agent;

/// <summary>
/// "Something the phone shows has just changed" (a volume control, a toggle): the live streams send
/// a state at once instead of at the next whole second. Slow-moving numbers (CPU, network) keep the 1 s clock.
/// </summary>
public static class StateSignal
{
    private static long _version;

    /// <summary>Counts pokes; part of the key of the shared state frame, so a poke always means a rebuilt frame.</summary>
    public static long Version => Interlocked.Read(ref _version);

    public static event Action? Changed;

    public static void Poke()
    {
        Interlocked.Increment(ref _version);
        // one subscriber's failure (a stream that just closed) must not stop the others or the code that changed something
        var handlers = Changed;
        if (handlers is null) return;
        foreach (var h in handlers.GetInvocationList().Cast<Action>())
            try { h(); } catch { }
    }
}
