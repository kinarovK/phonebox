using System.Text.Json;

namespace PhoneBox.Agent;

/// <param name="Kind">approval | approval-done</param>
public sealed record PanelEvent(long Seq, string Kind, JsonElement? Data, long At);

/// <summary>
/// A short queue of events for the phone: the agent emits them, the phone reads them with its state (or gets them at
/// once over the live stream). Kept in memory only.
/// </summary>
public sealed class PushStore
{
    private const int MaxEvents = 50;

    private readonly Lock _evLock = new();
    private readonly LinkedList<PanelEvent> _events = new();
    private long _seq;

    /// <summary>Last event number, so a freshly started phone does not replay old events.</summary>
    public long Seq => Interlocked.Read(ref _seq);

    /// <summary>Raised after an event is queued, so live streams can deliver it right away.</summary>
    public event Action? Emitted;

    public PanelEvent Emit(string kind, JsonElement? data = null)
    {
        PanelEvent e;
        lock (_evLock)
        {
            e = new PanelEvent(++_seq, kind, data?.Clone(), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            _events.AddLast(e);
            while (_events.Count > MaxEvents) _events.RemoveFirst();
        }
        Emitted?.Invoke();
        return e;
    }

    /// <summary>Events after <paramref name="seq"/>, at most a minute old (a phone that was away does not get a flood).</summary>
    public IReadOnlyList<PanelEvent> Since(long seq)
    {
        var cutoff = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 60_000;
        lock (_evLock) return _events.Where(e => e.Seq > seq && e.At > cutoff).ToList();
    }
}
