from __future__ import annotations

import hashlib
import os
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / ".site"

ASSET_EXTENSIONS = {".css", ".js"}
HTML_PATTERN = "*.html"
LINK_PATTERN = re.compile(r"(?P<attr>\b(?:href|src))=(?P<quote>[\"'])(?P<url>[^\"']+)(?P=quote)")


def clean_output_dir() -> None:
    if OUTPUT_DIR.exists():
        shutil.rmtree(OUTPUT_DIR)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def copy_site_files() -> None:
    ignore_names = {".git", ".github", ".vscode", ".site", "scripts", "__pycache__"}

    def ignore_filter(_dir: str, names: list[str]) -> set[str]:
        return {name for name in names if name in ignore_names}

    for item in ROOT.iterdir():
        if item.name in ignore_names:
            continue
        target = OUTPUT_DIR / item.name
        if item.is_dir():
            shutil.copytree(item, target, ignore=ignore_filter)
        else:
            shutil.copy2(item, target)


def is_local_asset(url: str) -> bool:
    lowered = url.lower()
    if lowered.startswith(("http://", "https://", "//", "data:", "mailto:", "javascript:", "#")):
        return False
    return True


def append_hash_to_local_assets(html_path: Path) -> None:
    content = html_path.read_text(encoding="utf-8")

    def replace_url(match: re.Match[str]) -> str:
        attr = match.group("attr")
        quote = match.group("quote")
        original_url = match.group("url")

        if not is_local_asset(original_url):
            return match.group(0)

        path_part = original_url.split("?", 1)[0]
        suffix = Path(path_part).suffix.lower()
        if suffix not in ASSET_EXTENSIONS:
            return match.group(0)

        asset_path = (html_path.parent / path_part).resolve()
        if not asset_path.exists() or not asset_path.is_file():
            return match.group(0)

        file_hash = hashlib.md5(asset_path.read_bytes()).hexdigest()[:10]
        versioned_url = f"{path_part}?v={file_hash}"
        return f"{attr}={quote}{versioned_url}{quote}"

    updated = LINK_PATTERN.sub(replace_url, content)
    html_path.write_text(updated, encoding="utf-8")


def process_all_html_files() -> None:
    for html_file in OUTPUT_DIR.rglob(HTML_PATTERN):
        append_hash_to_local_assets(html_file)


def main() -> None:
    clean_output_dir()
    copy_site_files()
    process_all_html_files()
    print(f"Built GitHub Pages artifact at: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
