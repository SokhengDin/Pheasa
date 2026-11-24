<p align="center"><img src="public/logo.svg" alt="Pheasa ភាសា" width="420"></p>

# Pheasa

Real-time speech translation for conversations and video calls. Pheasa listens to your microphone and system audio, transcribes speech with Whisper, translates it (offline or through a cloud API), and shows live subtitles with speaker labels.

## Download

Get the installer for your system from the [Releases page](https://github.com/SokhengDin/Pheasa/releases/latest):

| System | File |
| --- | --- |
| macOS (Apple silicon) | `Pheasa_*_aarch64.dmg` |
| macOS (Intel) | `Pheasa_*_x64.dmg` |
| Windows | `Pheasa_*_x64-setup.exe` or `.msi` |
| Linux | `.AppImage`, `.deb` or `.rpm` |

**Python 3 must be installed** on your machine (python.org, Homebrew, or your package manager).

The builds are not signed with an Apple or Microsoft certificate yet, so the system warns you the first time:

- **macOS:** drag Pheasa to Applications, then run this once in Terminal:
  ```sh
  xattr -cr /Applications/Pheasa.app
  ```
  Or open the app, then go to System Settings → Privacy & Security and click **Open Anyway**.
- **Windows:** click "More info", then "Run anyway".

## Getting started

1. **Models**: download a Whisper model (for example `openai/whisper-tiny`) and press Use.
2. **Translation**: download a Marian model for your language pair (for example `Helsinki-NLP/opus-mt-fr-en`), or choose the cloud backend in Settings.
3. **Settings**: pick your compute device and audio sources.
4. **Live**: choose the languages and press Start. Press Subtitles to open the floating subtitle window.

System audio: Windows works out of the box. On macOS you may need a loopback driver such as [BlackHole](https://github.com/ExistentialAudio/BlackHole). On Linux, pick a "monitor" source in Settings.

## Features

- Live subtitles in a draggable, lockable, always-on-top window
- Around 100 spoken languages (Khmer included), with automatic language detection
- Offline translation (Marian, NLLB, M2M100) or any OpenAI-compatible API
- Speaker labels, and recognition of saved voices across meetings
- Echo removal when you use speakers instead of headphones
- Searchable history, a glossary, and export to SRT, VTT, TXT, Markdown or JSON
- Global shortcuts: Cmd/Ctrl+Shift+Space (start or stop), S (subtitles), L (lock subtitles)

Everything runs on your computer except the cloud translation backend. Saved voices are stored as numbers (embeddings), never as audio.

## Build from source

You need Rust 1.90 or newer, [Bun](https://bun.sh), Python 3.9 or newer with its headers (for example `python3-dev` on Linux), and the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
bun install
bun tauri icon public/app-icon.svg
bun tauri dev                      # add `-- --features cuda` for NVIDIA GPUs
```

To make a release, update the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, then push a tag such as `v0.2.0`. GitHub Actions builds every platform and creates a draft release.

## Contributing

Issues and pull requests are welcome.

## License

[MIT](LICENSE)
