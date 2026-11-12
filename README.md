# DangDang_internet

This project starts as an independent, public **Chrome Manifest V3 extension** based on an earlier private companion-AI project. The previous Git history is intentionally not included.

## Features
- Conversational LLM clients using configurable OpenAI-compatible API endpoints
- Side panel and floating companion with moods, animation, and play actions
- Page awareness, local history, PDF/HWPX document utilities, optional work mode

## Install locally
1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the folder containing `manifest.json`.
4. Open the extension's settings and configure the LLM provider and **your own** API key.

## Security
- No API keys or credentials are shipped with this source snapshot.
- Do not put keys, personal data, private tests, or internal screenshots in commits.
- Browser page content can be sent to an external LLM depending on the extension settings. Check privacy controls before enabling page awareness.
- This is the initial source import, **not** a new feature-complete internet release; endpoint defaults and permissions should be reviewed before distribution to end users.

## Contributing
Fork this repository, create a feature branch, and open a pull request. Do not include credentials, generated screenshots with personal data, or private files.

## License
MIT. See `LICENSE` for original copyright and license terms.