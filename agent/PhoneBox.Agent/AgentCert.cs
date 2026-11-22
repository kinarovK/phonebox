using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace PhoneBox.Agent;

/// <summary>
/// The self-signed TLS certificate of the phone's USB port. The agent writes its SHA-256 fingerprint to the app over adb
/// and the app trusts only that exact certificate (pinning), see <see cref="UsbLink"/>.
/// </summary>
public static class AgentCert
{
    /// <summary>Loads the certificate, creating it on first use. The file keeps the name it had when Wi-Fi used it too.</summary>
    public static X509Certificate2 Load(string? configDir = null)
    {
        var dir = string.IsNullOrEmpty(configDir) ? AppPaths.ConfigDir : configDir;
        var certPath = Path.Combine(dir, "lan-cert.pfx");
        if (File.Exists(certPath))
        {
            AppPaths.RestrictToOwner(certPath);
            try { return X509CertificateLoader.LoadPkcs12FromFile(certPath, null, X509KeyStorageFlags.UserKeySet | X509KeyStorageFlags.Exportable); }
            catch { /* corrupt: recreate below */ }
        }
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var req = new CertificateRequest($"CN=PhoneBox agent ({Environment.MachineName})", key, HashAlgorithmName.SHA256);
        req.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, false));
        req.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, false));
        req.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid("1.3.6.1.5.5.7.3.1")], false)); // server auth
        using var cert = req.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(20));
        Directory.CreateDirectory(dir);
        using (var dst = AppPaths.CreatePrivate(certPath)) dst.Write(cert.Export(X509ContentType.Pfx));
        // Re-import so Windows TLS (SChannel) gets a persisted key.
        return X509CertificateLoader.LoadPkcs12FromFile(certPath, null, X509KeyStorageFlags.UserKeySet | X509KeyStorageFlags.Exportable);
    }

    public static string Fingerprint(X509Certificate2 cert) => Convert.ToHexString(SHA256.HashData(cert.RawData)).ToLowerInvariant();
}
