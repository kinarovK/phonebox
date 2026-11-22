# Slimming plan for the kinarovK/phonebox fork

Goal: a USB-only panel that shows AI coding status and PC stats, with as little code that can control the computer
or talk to the network as possible. Work through the stages in order. **One stage = one commit**, and every stage
must end green:

```powershell
dotnet build agent\PhoneBox.Agent -warnaserror:CS0168,CS0219   # no dead locals left behind
dotnet test  agent\PhoneBox.Agent.Tests
```

For the phone app's JavaScript (`android/app/src/main/assets/www`), also run `node --check` on every changed file
and grep for leftover references to removed widget types. If the Android SDK is installed, `android\gradlew.bat
assembleDebug` after stages that touch Kotlin or the manifest.

Rules for every stage:

- Delete code, don't comment it out. Delete tests that only cover deleted code; adjust tests of kept code that break
  only because a removed config field or endpoint is gone. Never weaken a test of kept code to make it pass.
- When `Config.cs` loses a section, old `config.json` files that still contain it must keep loading (unknown JSON
  properties are ignored; check `ConfigLegacyOptionsTests`).
- Remove the matching parts of `settings.html` (UI sections, i18n keys used only there), `widgets.json`,
  `templates.json`, `config.default*.json`, `Lan.AllowedOverLan` and `AgentConfig.ToPublic()`.
- Code comments and commit messages in English. Stop and ask if a removal would touch a kept feature.

## Keep

| Feature | Widget types | Agent code |
|---|---|---|
| AI quotas | `quotas`, `codexbar`, `quotaring` | `QuotaMonitor*.cs`, `CodexQuota.cs`, `CodexBar.cs`, `ListeningPorts.cs` |
| AI sessions + approvals (Claude Code, Codex; Antigravity, Cursor read-only) | `sessions` | `SessionMonitor*.cs`, `ClaudeHook.cs`, `ClaudeTranscript.cs`, `CodexHook.cs`, `ApprovalStore.cs` |
| GitHub (reviews, PRs, CI status) | `github` | `GitHubMonitor.cs` |
| PC monitoring | `stat`, `gauge`, `chart`, `meters`, `gpu`, `topprocs`, `processes` | `SystemMonitor.cs`, `Gpus.cs`, `WindowsGpu.cs`, `DrmUsage.cs`, `ProcessMonitor.cs`, `PingMonitor.cs`, `JobObject.cs` |
| Clock (without its weather line) | `clock` | — |
| Volume | `volume` | `AudioControl.cs` |
| Docker | `docker` | `DockerMonitor.cs` |
| Phone battery, battery care | `battery`, `chargecare` | `ChargeGuard.cs` (see stage 8) |
| Night mode, display settings | — | `AppearanceConfig.cs`, display/night config |
| Core | — | `Program.cs`, `Config.cs`, `Models.cs`, `Catalog.cs`, `PanelWidgets.cs`, `PushStore.cs` (internal event queue only), `StateFrameCache.cs`, `StateSignal.cs`, `AdbReverse.cs`, `UsbLink.cs`, `UsbDoctor.cs`, `WebViewDoctor.cs`, `PhoneRegistry.cs`, `SessionLockMonitor.cs`, `ScreenSynchronizer.cs`, `RequestTimings.cs`, `Tray.cs`, `UpdateService.cs`, `AppPaths.cs`, `AgentEndpoint.cs`, `BrowserGuard.cs`, `FileLogger.cs`, `ToolProcess.cs`, `IconText.cs` |

The settings page, layout editor, pages, phone registry and translations stay.

## Stage 1 — Control Deck

All 58 Control Deck widgets.

- Agent: `ControlDeck*.cs` (all 13 files), `/api/controls/*` endpoints, the `controls` config section.
- Phone: `widgets/controls.js`, `controls.css`, their imports in `main.js`, the Control Deck category in the editor.
- Tests: `ControlDeck*Tests`, `ControlTasksTests`, `DeckAuditTests`, `HlsRadioTests`, `Radio*Tests`,
  `PortableAudioPlaybackTests`, plus any test left that only covers deleted code.
- `docs/CONTROL-DECK.md`.

## Stage 2 — Media and entertainment

`media`, `spectrum`, `discord`, `steam`, `steam-activity`, `steam-library`, `obs`, `onair`.

- Agent: `MediaMonitor.cs`, `MediaArtworkCache.cs`, `SpectrumAnalyzer.cs`, `SpotifyControl.cs`, `DiscordMonitor.cs`,
  `SteamMonitor.cs`, `SteamLibrary.cs`, `ObsMonitor*.cs`, `PrivacyMonitor.cs`, `CameraActivity.cs`; endpoints
  `/api/media`, `/api/art`, `/api/spectrum`, `/api/discord*`, `/api/steam*`, `/api/obs*`; their config sections and
  the live-stream events they emit.
- Phone: `widgets/spectrum.js`, `widgets/steam-library.js`, and the removed types in `basic.js` / `pc.js`.
- Check that `volume` still works without `MediaMonitor` (it uses `AudioControl`).

## Stage 3 — Shortcuts, input and commands

`shortcuts`, `button`, `command`, `trackpad`, `apps`, `app-console`, `dictate`.

- Agent: `Shortcuts.cs`, `ShortcutIcons.cs`, `ShortcutIconUploads.cs`, `KeySender.cs`, `MacroFlow.cs`, `Clipboard.cs`,
  `CommandRunner.cs`, `AppCatalog.cs`, `AppConsole.cs`, `TrackpadHandler.cs`, `Dictation.cs`, `WakeOnLan.cs`;
  endpoints `/api/run`, `/api/shortcuts*`, `/api/settings/shortcut-icon`, `/api/apps*`, `/api/console*`,
  `/api/dictate`, `/api/trackpad`, `/api/wake*`, `/api/widget/{page}/{widget}` (command output).
- **Exception:** if stage 8 keeps battery care with commands, `ChargeGuard` needs a way to run two configured
  commands. Do stage 8's decision first, or leave `ChargeGuard`'s switching as is and finish it in stage 8.
- Phone: `widgets/console.js`, `widgets/dictate.js`, `Dictation.kt`, `WakePacket.kt`, the `RECORD_AUDIO` permission in
  `AndroidManifest.xml`.

## Stage 4 — Web, data and personal widgets

Everything left from the Time, Personal, Weather & sky and Web & data categories except `clock` and `battery`:
`analog`, `worldclock`, `calendar`, `agenda`, `progress`, `countdown`, `pomodoro`, `timer`, `stopwatch`,
`wordclock`, `nextup`, `weather`, `forecast`, `sun`, `air`, `moon`, `note`, `checklist`, `counter`, `breathe`, `quote`,
`label`, `photos`, `batteries`, `rules`, `html`, `ha`, `push`, `inbox`, `feeds`, `hackernews`, `exchange`, `crypto`,
`image`, `camera`, `stack`.

- Agent: `CalendarMonitor.cs`, `FeedMonitor.cs`, `HomeAssistant.cs` (see stage 8), `CameraFeeds.cs`, `PhotoFrame.cs`,
  `ImmichPhotos.cs`, `WidgetFeedProxy.cs`, `BatteryMonitor*.cs`, `RuleEngine.cs`, `NoteEdit.cs`, `StackWidgets.cs`;
  the webhook endpoints (`/api/push*`, `/api/notify`, `/api/goto`, `/api/refresh`) while `PushStore` stays as the
  internal event queue; `/api/calendar`, `/api/feeds*`, `/api/photos*`, `/api/camera`, `/api/ha*`, `/api/batteries`,
  `/api/rules*`, `/api/proxy`, `/api/widget/.../note`.
- Phone: `widgets/time.js`, `widgets/sky.js`, `widgets/web.js`, `widgets/photos.js`, `widgets/camera.js`,
  `widgets/stack.js`, the removed types in `basic.js` / `pc.js`, the clock's weather line and every weather fetch
  (Open-Meteo) in `main.js`.
- `ToPublic()` must no longer contain weather, calendar or feed settings.

## Stage 5 — Wi-Fi and Tailscale

USB only from now on.

- Agent: the Wi-Fi listener in `Program.cs` (`lanCert`, the `IPAddress.Any` listen, its branch in the auth
  middleware), `Pairing.cs` (`PairingCodes`), `/api/pair*`, `/api/lan`, `/api/phones` if it only serves Wi-Fi, the
  `lan` config section, the `pcswitch` widget.
- Keep the path allow-list, but move it from `Lan.cs` to `UsbLink.cs` (or a small `PhoneApi.cs`) and **trim it to the
  paths the kept widgets use**. This is the main security gain of the whole plan: list every remaining path and why
  the phone needs it in the commit message.
- Phone: Wi-Fi/QR pairing in `AgentLink.kt` and `MainActivity.kt` may stay for now (it never connects without the
  agent's Wi-Fi port); remove it if it is self-contained.
- `UsbDoctor.cs` exists to explain Wi-Fi-only phones; keep it only if USB setup still uses it.

## Stage 6 — Other AI tools

- Remove OpenCode (`OpenCode*.cs`, `opencode` config, `OpenCode*Tests`) and WorkBuddy (`WorkBuddy.cs`,
  `WorkBuddyNamesTests`; `ClaudeHook.ProjectName` falls back to the folder name).
- Keep Claude Code, Codex, Antigravity and Cursor in `sessions`.

## Stage 7 — Catalog, defaults and docs

- `widgets.json`: only the kept types. `templates.json`: delete templates that are left with no widgets, rebuild the
  default pages from the kept widgets (an "AI" page and a "PC" page).
- `config.default*.json`, `README.md`, `PRIVACY.md` (the connection table must match what is left), `FORK.md`
  (list what was removed).
- Remove `docs/*` pages for removed features; `.github/workflows` stay disabled in the fork.

## Stage 8 — Battery care (decision pending)

`ChargeGuard` switches the charger through Home Assistant or two shortcuts. Choose one:

- **A. Commands:** keep two settings fields, a charge-on and a charge-off command, run directly by `ChargeGuard`
  (`ProcessStartInfo`, no shell, no phone input), and remove the Home Assistant path.
- **B. Home Assistant:** keep `HomeAssistant.cs` for this one switch only, without the `ha` widget or `/api/ha*`.
- **C. None:** remove the switching; `chargecare` and `battery` only show the level.

## Done when

- `dotnet test` is green, the app builds, and the phone shows the kept widgets over USB.
- `grep -rn` finds no references to removed widget types, endpoints or classes.
- The trimmed allow-list is the only way the phone reaches the agent.
