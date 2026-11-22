namespace PhoneBox.Agent;

// Data shared by the Windows and the Linux / macOS implementations.

public sealed record AudioSnapshot(int Volume, bool Muted, bool CanControl = true);
