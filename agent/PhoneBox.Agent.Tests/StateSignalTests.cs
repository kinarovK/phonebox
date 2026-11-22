using PhoneBox.Agent;
using Xunit;

public sealed class StateSignalTests
{
    [Fact]
    public void APokeWakesSubscribersAndBumpsTheVersion()
    {
        var woken = 0;
        void On() => Interlocked.Increment(ref woken);
        StateSignal.Changed += On;
        try
        {
            var before = StateSignal.Version;
            StateSignal.Poke();
            StateSignal.Poke();
            // at least: other tests running in parallel poke the same global signal too
            Assert.True(woken >= 2, $"woken {woken} times");
            Assert.True(StateSignal.Version >= before + 2);
        }
        finally { StateSignal.Changed -= On; }
    }

    [Fact]
    public void ASubscriberThatThrowsDoesNotStopThePokeOrTheCaller()
    {
        var reached = false;
        void Bad() => throw new InvalidOperationException("boom");
        void Good() => reached = true;
        StateSignal.Changed += Bad;
        StateSignal.Changed += Good;
        try { StateSignal.Poke(); }
        finally { StateSignal.Changed -= Bad; StateSignal.Changed -= Good; }
        Assert.True(reached);
    }
}
