# kinarovK/phonebox fork

A personal fork of [ersinkoc/phonebox](https://github.com/ersinkoc/phonebox) (MIT).

## Differences from upstream

- **Updates**: automatic installs are off by default, and the update check points at this fork
  (`UpdateConfig.DefaultRepo = "kinarovK/phonebox"`). An agent built from this fork must never replace itself with
  an upstream release. The Wi-Fi pairing APK link uses the configured repo too.
- Planned: trimming integrations that are not used.

Still pointing at upstream on purpose: the QR pairing page (`ersinkoc.github.io/phonebox/pair`, used only for Wi-Fi
pairing without USB), `setup.ps1` / `setup.sh` (they download upstream releases; use `scripts/install.ps1` instead)
and `scripts/release.ps1`.

## Build and test (Windows)

Requirements: .NET 10 SDK, adb (platform tools), and for the phone app JDK 17+ and the Android SDK
(Android Studio installs both).

```powershell
winget install Microsoft.DotNet.SDK.10 Google.PlatformTools
cd D:\AI\phonebox\phonebox
dotnet test agent\PhoneBox.Agent.Tests
```

Phone app signed with your own key (otherwise the debug key is used):

```powershell
keytool -genkeypair -v -keystore D:\keys\phonebox.jks -alias phonebox -keyalg RSA -keysize 4096 -validity 10000
$env:PHONEBOX_STORE_FILE = 'D:\keys\phonebox.jks'
$env:PHONEBOX_STORE_PASSWORD = '<store password>'
$env:PHONEBOX_KEY_ALIAS = 'phonebox'
$env:PHONEBOX_KEY_PASSWORD = '<key password>'
.\scripts\install.ps1 -Apk -Autostart
```

Keep the keystore outside the repository and back it up: an app signed with a different key cannot update the
installed one.

## Pulling upstream changes

```powershell
git remote add upstream https://github.com/ersinkoc/phonebox.git   # once
git fetch upstream
git merge upstream/main
```

After a merge, check that `UpdateConfig` and `settings.html` still default to this fork.
