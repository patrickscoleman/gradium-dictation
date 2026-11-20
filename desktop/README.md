# gradium-dictation, the desktop tool

Hold a key, speak, release: your words land in whatever app you're in.
Everything about it, and the web demo beside it, is in the
[repository's README](../README.md).

```bash
pipx install "git+https://github.com/patrickscoleman/gradium-dictation#subdirectory=desktop"
export GRADIUM_API_KEY=gd_...
dictate listen
```

To work on it: `cd desktop && pip install -e ".[dev]" && pytest`.
